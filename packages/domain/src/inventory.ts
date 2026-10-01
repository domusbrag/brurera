import type Decimal from "decimal.js";
import type { CostSource } from "./costing";
import { COST_SCALE, D, NORMALIZED_QUANTITY_SCALE, toFixedString } from "./decimal";
import { areUnitsCompatible, convertQuantity, type UnitForConversion } from "./units";

/*
 * Inventario y compras (Fase 3). Funciones puras con decimal.js: conversión de
 * presentaciones de compra, importes de línea, costo de adquisición, promedio
 * ponderado móvil, estado de stock mínimo y selección del costo efectivo para
 * recetas. No acceden a la base.
 *
 * Convención de signo (única): un movimiento de stock guarda la cantidad CON
 * signo en la unidad base de la materia prima. Ingresos (stock inicial,
 * recepción, ajuste positivo) > 0; salidas (ajuste negativo, merma) < 0.
 */

export const STOCK_MOVEMENT_TYPES = [
  "INITIAL_STOCK",
  "PURCHASE_RECEIPT",
  "ADJUSTMENT_POSITIVE",
  "ADJUSTMENT_NEGATIVE",
  "WASTE",
  "PRODUCTION_CONSUMPTION",
  "PRODUCTION_OUTPUT",
  "LOT_TRANSFORMATION_OUT",
  "LOT_TRANSFORMATION_IN",
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/**
 * Reservados para fases siguientes (ventas). No tienen flujo ni valor en la
 * base todavía: se agregarán al enum cuando exista la operación.
 */
export const RESERVED_STOCK_MOVEMENT_TYPES = ["SALE", "RETURN"] as const;

export const INBOUND_MOVEMENT_TYPES: readonly StockMovementType[] = [
  "INITIAL_STOCK",
  "PURCHASE_RECEIPT",
  "ADJUSTMENT_POSITIVE",
  "PRODUCTION_OUTPUT",
  "LOT_TRANSFORMATION_IN",
];
export const OUTBOUND_MOVEMENT_TYPES: readonly StockMovementType[] = [
  "ADJUSTMENT_NEGATIVE",
  "WASTE",
  "PRODUCTION_CONSUMPTION",
  "LOT_TRANSFORMATION_OUT",
];

/** +1 si el tipo ingresa stock, −1 si lo saca. */
export function movementSign(type: StockMovementType): 1 | -1 {
  return INBOUND_MOVEMENT_TYPES.includes(type) ? 1 : -1;
}

/**
 * Cantidad con signo para un movimiento a partir de una cantidad positiva
 * ingresada por el usuario. Lanza si la cantidad no es positiva.
 */
export function signedQuantity(type: StockMovementType, quantity: Decimal.Value): Decimal {
  const q = new D(quantity);
  if (!q.gt(0))
    throw new InventoryError("QUANTITY_NOT_POSITIVE", "La cantidad debe ser mayor que cero");
  return movementSign(type) === 1 ? q : q.negated();
}

export type InventoryErrorCode =
  | "QUANTITY_NOT_POSITIVE"
  | "INSUFFICIENT_STOCK"
  | "VALUATION_COST_REQUIRED"
  | "NEGATIVE_COST"
  | "INCOMPATIBLE_PRESENTATION_UNIT"
  | "INCOMPATIBLE_PURCHASE_UNIT"
  | "DISCOUNT_EXCEEDS_GROSS";

/** Error de regla de inventario (la API lo traduce a 409/422 con el mismo código). */
export class InventoryError extends Error {
  constructor(
    readonly code: InventoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InventoryError";
  }
}

/* ---------- Presentaciones y conversión a unidad base ---------- */

export interface PresentationForConversion {
  /** Cantidad de la materia prima que contiene 1 unidad de compra (25). */
  containedQuantity: Decimal.Value;
  /** Unidad de esa cantidad (kg); debe ser compatible con la unidad base. */
  containedUnit: UnitForConversion;
}

/**
 * Cuántas unidades base equivalen a 1 unidad de compra.
 * - Con presentación: lo que contiene la presentación, expresado en la unidad base
 *   (Bolsa 25 kg de harina en kg → 25; Paquete 500 g de levadura en kg → 0,5).
 * - Sin presentación: la unidad de compra debe ser compatible con la base (g → kg).
 * La equivalencia pertenece a materia prima + presentación: no existe una
 * conversión universal de "bolsa".
 */
export function baseQuantityPerPurchaseUnit(args: {
  baseUnit: UnitForConversion;
  purchaseUnit: UnitForConversion;
  presentation: PresentationForConversion | null;
}): Decimal {
  const { baseUnit, purchaseUnit, presentation } = args;
  if (presentation) {
    if (!areUnitsCompatible(presentation.containedUnit, baseUnit)) {
      throw new InventoryError(
        "INCOMPATIBLE_PRESENTATION_UNIT",
        `La presentación contiene ${presentation.containedUnit.code}, incompatible con la unidad base ${baseUnit.code}`,
      );
    }
    const contained = new D(presentation.containedQuantity);
    if (!contained.gt(0)) {
      throw new InventoryError(
        "QUANTITY_NOT_POSITIVE",
        "El contenido de la presentación debe ser mayor que cero",
      );
    }
    return convertQuantity(contained, presentation.containedUnit, baseUnit);
  }
  if (!areUnitsCompatible(purchaseUnit, baseUnit)) {
    throw new InventoryError(
      "INCOMPATIBLE_PURCHASE_UNIT",
      `Sin presentación, la unidad de compra ${purchaseUnit.code} debe ser compatible con ${baseUnit.code}. Creá una presentación (p. ej. "Bolsa 25 kg").`,
    );
  }
  return convertQuantity(1, purchaseUnit, baseUnit);
}

/** Cantidad comercial → cantidad de inventario (4 bolsas × 25 kg = 100 kg). */
export function toBaseQuantity(quantity: Decimal.Value, perPurchaseUnit: Decimal.Value): Decimal {
  return new D(quantity).times(perPurchaseUnit);
}

/* ---------- Importes de compra ---------- */

export interface PurchaseLineAmounts {
  gross: Decimal;
  discount: Decimal;
  /** Bruto − descuento: es lo que se valoriza en inventario. */
  net: Decimal;
}

/** Importes de una línea: bruto = cantidad × precio; neto = bruto − descuento. */
export function calculatePurchaseLineAmounts(args: {
  quantity: Decimal.Value;
  unitPrice: Decimal.Value;
  discountAmount?: Decimal.Value | null;
}): PurchaseLineAmounts {
  const quantity = new D(args.quantity);
  const unitPrice = new D(args.unitPrice);
  const discount = new D(args.discountAmount ?? 0);
  if (!quantity.gt(0)) {
    throw new InventoryError("QUANTITY_NOT_POSITIVE", "La cantidad debe ser mayor que cero");
  }
  if (unitPrice.lt(0) || discount.lt(0)) {
    throw new InventoryError("NEGATIVE_COST", "Precio y descuento no pueden ser negativos");
  }
  const gross = quantity.times(unitPrice);
  if (discount.gt(gross)) {
    throw new InventoryError("DISCOUNT_EXCEEDS_GROSS", "El descuento no puede superar el importe");
  }
  return { gross, discount, net: gross.minus(discount) };
}

export interface PurchaseTotals {
  subtotal: Decimal;
  discountTotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
}

/**
 * Totales de cabecera. `taxTotal` es informativo (impuestos recuperables): se
 * suma al total comercial pero NO forma parte del costo de inventario.
 */
export function calculatePurchaseTotals(
  lines: readonly Pick<PurchaseLineAmounts, "gross" | "discount">[],
  taxTotal: Decimal.Value | null = 0,
): PurchaseTotals {
  const subtotal = lines.reduce((sum, l) => sum.plus(l.gross), new D(0));
  const discountTotal = lines.reduce((sum, l) => sum.plus(l.discount), new D(0));
  const tax = new D(taxTotal ?? 0);
  return { subtotal, discountTotal, taxTotal: tax, total: subtotal.minus(discountTotal).plus(tax) };
}

/**
 * Costo de adquisición por unidad base = neto de la línea / cantidad base pedida
 * (4 bolsas × $20.000 = $80.000 / 100 kg = $800/kg). Sin impuestos.
 */
export function acquisitionUnitCost(
  netAmount: Decimal.Value,
  baseQuantity: Decimal.Value,
): Decimal {
  const qty = new D(baseQuantity);
  if (!qty.gt(0)) throw new InventoryError("QUANTITY_NOT_POSITIVE", "Cantidad base inválida");
  return new D(netAmount).dividedBy(qty);
}

/* ---------- Promedio ponderado móvil ---------- */

/** Estado de costo de una materia prima a nivel empresa. */
export interface InventoryCostState {
  quantity: Decimal.Value;
  inventoryValue: Decimal.Value;
  /** null si nunca hubo un ingreso valorizado. */
  movingAverageCost: Decimal.Value | null;
}

export interface CostedMovement {
  /** Cantidad con signo aplicada. */
  quantity: Decimal;
  /** Costo por unidad base con que se valorizó el movimiento (6 decimales). */
  unitCost: Decimal;
  /** Valor con signo que entra (+) o sale (−) del inventario (6 decimales). */
  totalValue: Decimal;
  before: { quantity: Decimal; inventoryValue: Decimal; movingAverageCost: Decimal | null };
  after: { quantity: Decimal; inventoryValue: Decimal; movingAverageCost: Decimal | null };
  averageChanged: boolean;
}

const money6 = (v: Decimal.Value) => new D(toFixedString(v, COST_SCALE));
const qty10 = (v: Decimal.Value) => new D(toFixedString(v, NORMALIZED_QUANTITY_SCALE));

function snapshotState(state: InventoryCostState) {
  return {
    quantity: new D(state.quantity),
    inventoryValue: new D(state.inventoryValue),
    movingAverageCost: state.movingAverageCost === null ? null : new D(state.movingAverageCost),
  };
}

/**
 * Ingreso valorizado (stock inicial, recepción, ajuste positivo con costo,
 * salida de producción):
 *   OldValue = valor de inventario vigente (≈ OldQty × OldAverage)
 *   NewQty = OldQty + Qty
 *   NewAverage = (OldValue + Qty × UnitCost) / NewQty
 * Si OldQty = 0, NewAverage = UnitCost: no se arrastra un promedio sin existencia.
 * El promedio se redondea a 6 decimales (HALF_UP); el valor es la suma exacta.
 *
 * `opts.totalValue` (producción): el ingreso vale EXACTAMENTE ese importe (el
 * costo material real del lote) en lugar de Qty × UnitCost redondeado; así el
 * valor que sale de las materias primas es el que entra al producto.
 */
export function applyInbound(
  state: InventoryCostState,
  quantity: Decimal.Value,
  unitCost: Decimal.Value,
  opts: { totalValue?: Decimal.Value } = {},
): CostedMovement {
  const before = snapshotState(state);
  const qty = qty10(quantity);
  if (!qty.gt(0))
    throw new InventoryError("QUANTITY_NOT_POSITIVE", "La cantidad debe ser mayor que cero");
  const cost = money6(unitCost);
  if (cost.lt(0)) throw new InventoryError("NEGATIVE_COST", "El costo no puede ser negativo");
  const incomingValue =
    opts.totalValue === undefined ? money6(qty.times(cost)) : money6(opts.totalValue);
  if (incomingValue.lt(0))
    throw new InventoryError("NEGATIVE_COST", "El valor no puede ser negativo");
  const newQty = before.quantity.plus(qty);
  const oldValue = before.quantity.isZero() ? new D(0) : before.inventoryValue;
  const newValue = oldValue.plus(incomingValue);
  const newAverage = before.quantity.isZero()
    ? opts.totalValue === undefined
      ? cost
      : money6(incomingValue.dividedBy(qty))
    : money6(newValue.dividedBy(newQty));
  return {
    quantity: qty,
    unitCost: cost,
    totalValue: incomingValue,
    before,
    after: { quantity: newQty, inventoryValue: newValue, movingAverageCost: newAverage },
    averageChanged: before.movingAverageCost === null || !before.movingAverageCost.eq(newAverage),
  };
}

/**
 * Salida (merma, ajuste negativo): NO cambia el promedio. Saca Qty × Average del
 * valor. Si la existencia queda en 0, el valor queda en 0 (el residuo de
 * redondeo lo absorbe esta salida). Falla con INSUFFICIENT_STOCK si no alcanza.
 */
export function applyOutbound(state: InventoryCostState, quantity: Decimal.Value): CostedMovement {
  const before = snapshotState(state);
  const qty = qty10(quantity);
  if (!qty.gt(0))
    throw new InventoryError("QUANTITY_NOT_POSITIVE", "La cantidad debe ser mayor que cero");
  if (qty.gt(before.quantity)) {
    throw new InventoryError(
      "INSUFFICIENT_STOCK",
      "No hay stock suficiente: la operación dejaría stock negativo",
    );
  }
  const average = before.movingAverageCost ?? new D(0);
  const newQty = before.quantity.minus(qty);
  const outgoing = newQty.isZero() ? before.inventoryValue : money6(qty.times(average));
  return {
    quantity: qty.negated(),
    unitCost: average,
    totalValue: outgoing.negated(),
    before,
    after: {
      quantity: newQty,
      inventoryValue: before.inventoryValue.minus(outgoing),
      movingAverageCost: before.movingAverageCost,
    },
    averageChanged: false,
  };
}

/**
 * Costo con que se valoriza un ajuste positivo. Si se indica, se usa ese. Si no,
 * el promedio vigente; sin promedio, el costo es obligatorio. El stock inicial
 * exige siempre un costo explícito.
 */
export function positiveAdjustmentCost(
  type: "INITIAL_STOCK" | "ADJUSTMENT_POSITIVE",
  explicitCost: Decimal.Value | null | undefined,
  movingAverageCost: Decimal.Value | null,
): Decimal {
  if (explicitCost !== null && explicitCost !== undefined) return new D(explicitCost);
  if (type === "ADJUSTMENT_POSITIVE" && movingAverageCost !== null) return new D(movingAverageCost);
  throw new InventoryError(
    "VALUATION_COST_REQUIRED",
    type === "INITIAL_STOCK"
      ? "El stock inicial necesita un costo unitario de valorización"
      : "Sin costo promedio vigente: indicá el costo unitario de valorización",
  );
}

/** Saldo de un depósito luego de un movimiento con signo; falla si quedaría negativo. */
export function nextBalance(current: Decimal.Value, signedQty: Decimal.Value): Decimal {
  const next = new D(current).plus(signedQty);
  if (next.lt(0)) {
    throw new InventoryError(
      "INSUFFICIENT_STOCK",
      "No hay stock suficiente en el depósito: la operación dejaría stock negativo",
    );
  }
  return next;
}

/* ---------- Stock mínimo ---------- */

export const STOCK_STATUSES = ["OK", "LOW", "OUT_OF_STOCK"] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** OUT_OF_STOCK si no hay existencia; LOW si está por debajo del mínimo (> 0); si no OK. */
export function stockStatus(quantity: Decimal.Value, minimumStock: Decimal.Value): StockStatus {
  const q = new D(quantity);
  if (q.lte(0)) return "OUT_OF_STOCK";
  const min = new D(minimumStock);
  return min.gt(0) && q.lt(min) ? "LOW" : "OK";
}

/** Faltante para llegar al mínimo (0 si no falta). */
export function shortage(quantity: Decimal.Value, minimumStock: Decimal.Value): Decimal {
  const missing = new D(minimumStock).minus(quantity);
  return missing.gt(0) ? missing : new D(0);
}

/* ---------- Costo efectivo para recetas ---------- */

export interface EffectiveCost {
  cost: Decimal | null;
  source: CostSource | null;
}

/**
 * Costo por unidad base que usan las recetas. Prioridad explícita:
 *   1. promedio ponderado móvil de inventario, si existe → PURCHASE_MOVING_AVERAGE;
 *   2. si no, el costo de referencia manual → MANUAL_REFERENCE;
 *   3. si no, sin costo (la receta queda INCOMPLETE; nunca se asume 0).
 * El costo de referencia manual se conserva siempre: sólo deja de usarse.
 */
export function selectEffectiveCost(args: {
  movingAverageCost: Decimal.Value | null;
  referenceCost: Decimal.Value | null;
  referenceCostSource?: CostSource;
}): EffectiveCost {
  if (args.movingAverageCost !== null) {
    return { cost: new D(args.movingAverageCost), source: "PURCHASE_MOVING_AVERAGE" };
  }
  if (args.referenceCost !== null) {
    return {
      cost: new D(args.referenceCost),
      source: args.referenceCostSource ?? "MANUAL_REFERENCE",
    };
  }
  return { cost: null, source: null };
}
