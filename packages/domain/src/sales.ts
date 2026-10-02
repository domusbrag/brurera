import type Decimal from "decimal.js";
import { COST_SCALE, D, toFixedString } from "./decimal";
import {
  allocateFefo,
  matchesConservation,
  type LotWithCommitment,
  type RequestedConservation,
} from "./orders";
import { compareFefo, lotEligibilityAt, type LotForAvailability } from "./lots";

/*
 * Ventas, precios, margen, cobros y cuenta corriente (Fase 5B, ADR-057 a 061).
 *
 * - PRICE (lo que cobramos) y COST (valor material real de los lotes) son
 *   independientes: cambiar uno nunca cambia el otro.
 * - El costo de una venta de producto terminado es la suma del valor retirado de
 *   los lotes físicamente consumidos (identificación específica), nunca el costo
 *   teórico de la receta ni un promedio.
 * - El promedio de stock (valor / cantidad) es una métrica derivada.
 * - Cuenta corriente con signo: positivo = el cliente debe; negativo = crédito a
 *   favor del cliente.
 */

export const MONEY_SCALE = 2;
/** Porcentajes de margen: 4 decimales guardados, 2 mostrados. */
export const MARGIN_PERCENTAGE_SCALE = 4;

export type SaleErrorCode =
  | "DISCOUNT_EXCEEDS_AMOUNT"
  | "PAYMENT_EXCEEDS_SALE_BALANCE"
  | "INSUFFICIENT_FREE_PRODUCT_STOCK"
  | "DELIVERY_EXCEEDS_PENDING"
  | "AMOUNT_NOT_POSITIVE";

export class SaleError extends Error {
  constructor(
    readonly code: SaleErrorCode,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = "SaleError";
  }
}

const money2 = (v: Decimal.Value) => new D(new D(v).toFixed(MONEY_SCALE, D.ROUND_HALF_UP));
const money6 = (v: Decimal.Value) => new D(toFixedString(v, COST_SCALE));

/** Redondeo de dinero a 2 decimales (ROUND_HALF_UP). */
export function roundMoney(v: Decimal.Value): Decimal {
  return money2(v);
}

/* ---------- Precios ---------- */

export const PRICE_SOURCES = [
  "ORDER_QUOTE",
  "CUSTOMER_PRICE_LIST",
  "DEFAULT_PRICE_LIST",
  "PRODUCT_PRICE",
  "MANUAL",
] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export interface PriceCandidates {
  /** 1. Precio explícitamente acordado / congelado (cotización del pedido). */
  agreed?: Decimal.Value | null;
  /** 2. Lista de precios asignada al cliente (si tiene el producto). */
  customerList?: Decimal.Value | null;
  /** 3. Lista de precios default de la empresa (si tiene el producto). */
  defaultList?: Decimal.Value | null;
  /** 4. Precio del producto. */
  productPrice: Decimal.Value;
}

/**
 * Precio unitario vigente según la prioridad de Fase 5B: acordado → lista del
 * cliente → lista default de la empresa → precio del producto.
 */
export function resolveUnitPrice(c: PriceCandidates): { unitPrice: Decimal; source: PriceSource } {
  if (c.agreed !== undefined && c.agreed !== null) {
    return { unitPrice: money2(c.agreed), source: "ORDER_QUOTE" };
  }
  if (c.customerList !== undefined && c.customerList !== null) {
    return { unitPrice: money2(c.customerList), source: "CUSTOMER_PRICE_LIST" };
  }
  if (c.defaultList !== undefined && c.defaultList !== null) {
    return { unitPrice: money2(c.defaultList), source: "DEFAULT_PRICE_LIST" };
  }
  return { unitPrice: money2(c.productPrice), source: "PRODUCT_PRICE" };
}

export interface LineAmounts {
  gross: Decimal;
  discount: Decimal;
  net: Decimal;
}

/**
 * Importes de una línea: bruto = round2(cantidad × precio), neto = bruto −
 * descuento (importe). El descuento no puede superar el bruto.
 */
export function lineAmounts(args: {
  quantity: Decimal.Value;
  unitPrice: Decimal.Value;
  discountAmount?: Decimal.Value | null;
}): LineAmounts {
  const gross = money2(new D(args.quantity).times(args.unitPrice));
  const discount = money2(args.discountAmount ?? 0);
  if (discount.lt(0)) {
    throw new SaleError("DISCOUNT_EXCEEDS_AMOUNT", "El descuento no puede ser negativo.");
  }
  if (discount.gt(gross)) {
    throw new SaleError(
      "DISCOUNT_EXCEEDS_AMOUNT",
      `El descuento (${discount.toFixed(2)}) supera el importe de la línea (${gross.toFixed(2)}).`,
    );
  }
  return { gross, discount, net: gross.minus(discount) };
}

export function totals(lines: readonly LineAmounts[]): {
  subtotal: Decimal;
  discountTotal: Decimal;
  total: Decimal;
} {
  const subtotal = lines.reduce((s, l) => s.plus(l.gross), new D(0));
  const discountTotal = lines.reduce((s, l) => s.plus(l.discount), new D(0));
  return { subtotal, discountTotal, total: subtotal.minus(discountTotal) };
}

/**
 * ¿El precio o el descuento cargados difieren de lo acordado / resuelto? Un
 * override exige permiso y motivo.
 */
export function isPriceOverride(args: {
  unitPrice: Decimal.Value;
  discountAmount?: Decimal.Value | null;
  agreedUnitPrice: Decimal.Value;
  agreedDiscountAmount?: Decimal.Value | null;
}): boolean {
  return (
    !money2(args.unitPrice).eq(money2(args.agreedUnitPrice)) ||
    !money2(args.discountAmount ?? 0).eq(money2(args.agreedDiscountAmount ?? 0))
  );
}

/* ---------- Margen sobre costo material ---------- */

export interface MaterialMargin {
  amount: Decimal;
  /** null si el neto es 0 (no hay base para el porcentaje). */
  percentage: Decimal | null;
}

/** Margen = neto − costo material; % = margen / neto × 100 (si neto > 0). */
export function materialMargin(net: Decimal.Value, materialCost: Decimal.Value): MaterialMargin {
  const n = new D(net);
  const amount = money6(n.minus(materialCost));
  const percentage = n.gt(0)
    ? new D(amount.dividedBy(n).times(100).toFixed(MARGIN_PERCENTAGE_SCALE, D.ROUND_HALF_UP))
    : null;
  return { amount, percentage };
}

/* ---------- Costo por lote y valorización derivada ---------- */

/** Costo material de una venta = Σ valor retirado de cada lote (identificación específica). */
export function saleMaterialCost(allocations: readonly { materialCost: Decimal.Value }[]): Decimal {
  return money6(allocations.reduce((s, a) => s.plus(a.materialCost), new D(0)));
}

/**
 * Costo promedio informativo del stock remanente: valor / cantidad (6
 * decimales, half-up); null sin stock. Es una MÉTRICA DERIVADA, no el costo de
 * una venta.
 */
export function averageMaterialCost(
  quantity: Decimal.Value,
  inventoryValue: Decimal.Value,
): Decimal | null {
  const q = new D(quantity);
  if (!q.gt(0)) return null;
  return money6(new D(inventoryValue).dividedBy(q));
}

/* ---------- Asignación de lotes a una línea de venta ---------- */

export interface ReservationForSale<T extends LotForAvailability> {
  id: string;
  lot: T;
  /** Reservado − entregado. */
  remaining: Decimal.Value;
}

export interface SaleAllocation<T> {
  lot: T;
  quantity: Decimal;
  /** Reserva del pedido que se cumple (null = stock libre). */
  reservationId: string | null;
}

/**
 * Lotes que satisfacen una línea de venta en `at`:
 * 1. las reservas ACTIVAS de la línea del pedido (lo prometido, en orden FEFO de
 *    sus lotes y sólo si siguen utilizables), sin rehacer FEFO global;
 * 2. lo que falte, stock LIBRE FEFO (físico − reservas activas de todos los
 *    pedidos), con la conservación pedida.
 * Nunca toma stock comprometido con otro pedido. `missing` > 0 = no alcanza.
 */
export function allocateSaleLine<T extends LotWithCommitment>(args: {
  quantity: Decimal.Value;
  reservations: readonly ReservationForSale<T>[];
  freeLots: readonly T[];
  at: Date;
  requested?: RequestedConservation;
}): { allocations: SaleAllocation<T>[]; fromReservations: Decimal; missing: Decimal } {
  let remaining = new D(args.quantity);
  const allocations: SaleAllocation<T>[] = [];
  const reservations = [...args.reservations].sort((a, b) => compareFefo(a.lot, b.lot));
  for (const r of reservations) {
    if (!remaining.gt(0)) break;
    if (!lotEligibilityAt(r.lot, args.at).eligible) continue;
    const take = D.min(remaining, new D(r.remaining), new D(r.lot.quantity));
    if (!take.gt(0)) continue;
    allocations.push({ lot: r.lot, quantity: take, reservationId: r.id });
    remaining = remaining.minus(take);
  }
  const fromReservations = new D(args.quantity).minus(remaining);
  if (remaining.gt(0)) {
    const fefo = allocateFefo(args.freeLots, remaining, args.at, args.requested ?? "ANY");
    for (const a of fefo.allocations) {
      allocations.push({ lot: a.lot, quantity: a.quantity, reservationId: null });
    }
    remaining = fefo.missing;
  }
  return { allocations, fromReservations, missing: remaining };
}

/** Stock libre vendible ahora de un producto (lotes elegibles − comprometido). */
export function freeSellableQuantity<T extends LotWithCommitment>(
  lots: readonly T[],
  at: Date,
  requested: RequestedConservation = "ANY",
): Decimal {
  return lots.reduce((s, lot) => {
    if (!lotEligibilityAt(lot, at).eligible) return s;
    if (!matchesConservation(requested, lot.conservationState)) return s;
    const free = new D(lot.quantity).minus(lot.committed);
    return free.gt(0) ? s.plus(free) : s;
  }, new D(0));
}

/* ---------- Entregas del pedido ---------- */

/** Pendiente de entregar de una línea; falla si la entrega lo supera. */
export function assertDeliverable(args: {
  ordered: Decimal.Value;
  delivered: Decimal.Value;
  quantity: Decimal.Value;
  product?: string;
  unit?: string;
}): Decimal {
  const pending = D.max(new D(args.ordered).minus(args.delivered), 0);
  if (new D(args.quantity).gt(pending)) {
    const what = args.product ? ` de ${args.product}` : "";
    const unit = args.unit ? ` ${args.unit}` : "";
    throw new SaleError(
      "DELIVERY_EXCEEDS_PENDING",
      `Quedan ${pending.toString()}${unit}${what} por entregar: no se puede entregar ${new D(args.quantity).toString()}${unit}.`,
      { pending: pending.toString() },
    );
  }
  return pending;
}

/** Estado de entrega del pedido según lo entregado por línea. */
export function orderDeliveryStatus(
  lines: readonly { ordered: Decimal.Value; delivered: Decimal.Value }[],
): "PARTIALLY_DELIVERED" | "DELIVERED" {
  return lines.every((l) => !new D(l.delivered).lt(l.ordered)) ? "DELIVERED" : "PARTIALLY_DELIVERED";
}

/* ---------- Cobros ---------- */

export const PAYMENT_STATUSES = ["UNPAID", "PARTIALLY_PAID", "PAID"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Estado de cobro derivado de Σ aplicaciones (no del saldo global del
 * cliente): nada aplicado → UNPAID; parcial → PARTIALLY_PAID; total → PAID
 * (una venta de total 0 queda PAID: no hay nada que cobrar).
 */
export function derivePaymentStatus(total: Decimal.Value, applied: Decimal.Value): PaymentStatus {
  const t = new D(total);
  const a = new D(applied);
  if (!a.lt(t)) return "PAID";
  if (a.isZero()) return "UNPAID";
  return "PARTIALLY_PAID";
}

/** Pendiente de cobro de una venta. */
export function saleBalanceDue(total: Decimal.Value, applied: Decimal.Value): Decimal {
  return D.max(new D(total).minus(applied), 0);
}

/** Una aplicación no puede superar el pendiente de la venta. */
export function assertApplicationFits(args: {
  total: Decimal.Value;
  applied: Decimal.Value;
  amount: Decimal.Value;
}): void {
  const amount = money2(args.amount);
  if (!amount.gt(0)) {
    throw new SaleError("AMOUNT_NOT_POSITIVE", "El monto debe ser mayor que cero.");
  }
  const due = saleBalanceDue(args.total, args.applied);
  if (amount.gt(due)) {
    throw new SaleError(
      "PAYMENT_EXCEEDS_SALE_BALANCE",
      `El pendiente de la venta es ${due.toFixed(2)}: no se puede aplicar ${amount.toFixed(2)}.`,
      { pending: due.toFixed(2) },
    );
  }
}

/**
 * Aplicación automática de señas al postear una venta del pedido: en el orden
 * dado (más viejas primero) hasta min(disponible, total de la venta). El
 * excedente de las señas queda como crédito a favor del cliente.
 */
export function allocateAdvances<T extends { id: string; available: Decimal.Value }>(
  advances: readonly T[],
  saleTotal: Decimal.Value,
): { advance: T; amount: Decimal }[] {
  let due = new D(saleTotal);
  const result: { advance: T; amount: Decimal }[] = [];
  for (const advance of advances) {
    if (!due.gt(0)) break;
    const available = new D(advance.available);
    if (!available.gt(0)) continue;
    const amount = D.min(available, due);
    result.push({ advance, amount });
    due = due.minus(amount);
  }
  return result;
}

/* ---------- Cuenta corriente ---------- */

export type AccountBalanceKind = "DEBT" | "NONE" | "CREDIT";

/** Lectura de negocio del saldo con signo: "Debe $X", "Sin saldo", "Crédito a favor $X". */
export function accountBalanceView(balance: Decimal.Value): {
  kind: AccountBalanceKind;
  amount: Decimal;
} {
  const b = new D(balance);
  if (b.gt(0)) return { kind: "DEBT", amount: b };
  if (b.lt(0)) return { kind: "CREDIT", amount: b.abs() };
  return { kind: "NONE", amount: new D(0) };
}

/** Debe / Haber de un movimiento con signo (positivo = Debe, negativo = Haber). */
export function debitCredit(signedAmount: Decimal.Value): {
  debit: Decimal | null;
  credit: Decimal | null;
} {
  const v = new D(signedAmount);
  return v.gte(0) ? { debit: v, credit: null } : { debit: null, credit: v.abs() };
}

/**
 * Límite de crédito (advertencia, no bloqueo en el MVP): saldo proyectado =
 * saldo actual + total de la venta − cobro inicial. Excede si supera el límite.
 */
export function creditLimitCheck(args: {
  creditLimit: Decimal.Value | null;
  currentBalance: Decimal.Value;
  saleTotal: Decimal.Value;
  initialPayment?: Decimal.Value | null;
}): { projectedBalance: Decimal; exceeded: boolean; excess: Decimal } {
  const projectedBalance = new D(args.currentBalance)
    .plus(args.saleTotal)
    .minus(args.initialPayment ?? 0);
  if (args.creditLimit === null) {
    return { projectedBalance, exceeded: false, excess: new D(0) };
  }
  const excess = projectedBalance.minus(args.creditLimit);
  return { projectedBalance, exceeded: excess.gt(0), excess: D.max(excess, 0) };
}
