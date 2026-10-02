import type Decimal from "decimal.js";
import type { CostingUnit } from "./costing";
import { D } from "./decimal";
import {
  CONSERVATION_LABELS,
  lotEligibilityAt,
  sortFefo,
  type ConservationState,
  type LotForAvailability,
} from "./lots";
import { planProduction } from "./production";

/*
 * Pedidos de clientes, demanda comprometida y necesidades (Fase 5A). Funciones
 * puras: no acceden a la base.
 *
 * Cuatro cantidades que NO deben confundirse (ADR-050):
 *   PHYSICAL  = lo que existe físicamente;
 *   ELIGIBLE  = lo físico que será utilizable en la fecha pedida (y con la
 *               conservación pedida);
 *   COMMITTED = lo elegible ya reservado por pedidos confirmados;
 *   AVAILABLE = ELIGIBLE − COMMITTED: lo único que un pedido nuevo puede reservar.
 *
 * Una reserva NO mueve stock: compromete comercialmente cantidad de un LOTE.
 * La materia prima nunca se reserva: sólo se proyecta su demanda.
 */

/* ---------- Estados del pedido ---------- */

export const ORDER_STATUSES = [
  "DRAFT",
  "CONFIRMED",
  "IN_PREPARATION",
  "READY",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
  "CANCELLED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Transiciones permitidas. La entrega se registra con la venta (Fase 5B):
 * READY → PARTIALLY_DELIVERED → DELIVERED. DELIVERED y CANCELLED son terminales.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  DRAFT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["IN_PREPARATION", "READY", "CANCELLED"],
  IN_PREPARATION: ["READY", "CANCELLED"],
  READY: ["IN_PREPARATION", "PARTIALLY_DELIVERED", "DELIVERED", "CANCELLED"],
  PARTIALLY_DELIVERED: ["DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

/** Estados que comprometen stock y generan demanda (DRAFT y CANCELLED no). */
export const DEMAND_STATUSES = [
  "CONFIRMED",
  "IN_PREPARATION",
  "READY",
  "PARTIALLY_DELIVERED",
] as const;

/** Estados desde los que se puede registrar una entrega (venta desde pedido). */
export const DELIVERABLE_STATUSES = ["READY", "PARTIALLY_DELIVERED"] as const;

export function isDemandStatus(status: OrderStatus): boolean {
  return (DEMAND_STATUSES as readonly string[]).includes(status);
}

export const COVERAGE_STATUSES = [
  "FULLY_COVERED",
  "PARTIALLY_COVERED",
  "NOT_COVERED",
  "NEEDS_REPLAN",
] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const ORDER_PRIORITIES = ["NORMAL", "HIGH", "URGENT"] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

export type OrderErrorCode = "INVALID_ORDER_TRANSITION" | "ORDER_NOT_FULLY_COVERED";

/** Error de regla de pedidos (la API lo traduce a 409 con el mismo código). */
export class OrderError extends Error {
  constructor(
    readonly code: OrderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrderError";
  }
}

const STATUS_WORDS: Record<OrderStatus, string> = {
  DRAFT: "en borrador",
  CONFIRMED: "confirmado",
  IN_PREPARATION: "en preparación",
  READY: "listo",
  PARTIALLY_DELIVERED: "entregado parcialmente",
  DELIVERED: "entregado",
  CANCELLED: "cancelado",
};

export function canOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (canOrderTransition(from, to)) return;
  throw new OrderError(
    "INVALID_ORDER_TRANSITION",
    `Un pedido ${STATUS_WORDS[from]} no puede pasar a ${STATUS_WORDS[to]}.`,
  );
}

/* ---------- Conservación pedida ---------- */

export const REQUESTED_CONSERVATIONS = [
  "ANY",
  "FRESH",
  "REFRIGERATED",
  "FROZEN",
  "THAWED",
] as const;
export type RequestedConservation = (typeof REQUESTED_CONSERVATIONS)[number];

/** ANY acepta cualquier lote comercialmente válido; un estado concreto, sólo ese. */
export function matchesConservation(
  requested: RequestedConservation,
  state: ConservationState,
): boolean {
  return requested === "ANY" || requested === state;
}

/* ---------- Disponibilidad con compromisos ---------- */

export interface LotWithCommitment extends LotForAvailability {
  /** Σ reservas ACTIVAS sobre el lote (de cualquier pedido). */
  committed: Decimal.Value;
}

export type OrderIneligibilityReason = "EXPIRED" | "BLOCKED" | "CONSERVATION_MISMATCH";

export interface LotCommitmentView<T> {
  lot: T;
  physical: Decimal;
  committed: Decimal;
  /** max(0, físico − comprometido) si es elegible; 0 si no. */
  available: Decimal;
  eligible: boolean;
  reason: OrderIneligibilityReason | null;
}

export interface OrderAvailability<T> {
  requestedAt: Date;
  physicalQuantity: Decimal;
  eligibleQuantity: Decimal;
  committedQuantity: Decimal;
  availableQuantity: Decimal;
  ineligibleQuantity: Decimal;
  ineligibleByReason: Record<OrderIneligibilityReason, Decimal>;
  /** Disponible en lotes sin vida útil configurada (se cuenta, pero se advierte). */
  shelfLifeUnknownAvailable: Decimal;
  /** Lotes con saldo, en orden FEFO. */
  lots: LotCommitmentView<T>[];
}

/**
 * Disponibilidad de un producto para una fecha y una conservación pedida,
 * descontando lo ya comprometido por otros pedidos. Reutiliza la elegibilidad
 * y el orden FEFO de Fase 4.5 (lotEligibilityAt, sortFefo).
 *   700 físicos (300 frescos que vencen antes + 400 congelados), 100 comprometidos
 *   → elegible 400, disponible 300.
 */
export function availabilityForOrder<T extends LotWithCommitment>(
  lots: readonly T[],
  requestedAt: Date,
  requested: RequestedConservation = "ANY",
): OrderAvailability<T> {
  const zero = () => new D(0);
  const result: OrderAvailability<T> = {
    requestedAt,
    physicalQuantity: zero(),
    eligibleQuantity: zero(),
    committedQuantity: zero(),
    availableQuantity: zero(),
    ineligibleQuantity: zero(),
    ineligibleByReason: { EXPIRED: zero(), BLOCKED: zero(), CONSERVATION_MISMATCH: zero() },
    shelfLifeUnknownAvailable: zero(),
    lots: [],
  };
  for (const lot of sortFefo(lots.filter((l) => new D(l.quantity).gt(0)))) {
    const physical = new D(lot.quantity);
    const committed = D.min(new D(lot.committed), physical);
    const base = lotEligibilityAt(lot, requestedAt);
    const reason: OrderIneligibilityReason | null = !base.eligible
      ? (base.reason as "EXPIRED" | "BLOCKED")
      : matchesConservation(requested, lot.conservationState)
        ? null
        : "CONSERVATION_MISMATCH";
    const eligible = reason === null;
    const available = eligible ? physical.minus(committed) : zero();
    result.physicalQuantity = result.physicalQuantity.plus(physical);
    if (eligible) {
      result.eligibleQuantity = result.eligibleQuantity.plus(physical);
      result.committedQuantity = result.committedQuantity.plus(committed);
      result.availableQuantity = result.availableQuantity.plus(available);
      if (lot.usableUntil === null) {
        result.shelfLifeUnknownAvailable = result.shelfLifeUnknownAvailable.plus(available);
      }
    } else {
      result.ineligibleQuantity = result.ineligibleQuantity.plus(physical);
      result.ineligibleByReason[reason] = result.ineligibleByReason[reason].plus(physical);
    }
    result.lots.push({ lot, physical, committed, available, eligible, reason });
  }
  return result;
}

export interface Allocation<T> {
  lot: T;
  quantity: Decimal;
}

/**
 * Reserva FEFO: entre los lotes elegibles para `at`, con la conservación pedida
 * y cantidad libre (físico − comprometido), toma primero el que vence antes.
 * Nunca reserva más que lo libre de cada lote. Lo que no alcanza es `missing`
 * (a producir): un pedido NO falla por falta de stock, se confirma con faltante.
 */
export function allocateFefo<T extends LotWithCommitment>(
  lots: readonly T[],
  quantity: Decimal.Value,
  at: Date,
  requested: RequestedConservation = "ANY",
): { allocations: Allocation<T>[]; reserved: Decimal; missing: Decimal } {
  let remaining = new D(quantity);
  const allocations: Allocation<T>[] = [];
  for (const view of availabilityForOrder(lots, at, requested).lots) {
    if (!remaining.gt(0)) break;
    if (!view.eligible || !view.available.gt(0)) continue;
    const take = D.min(remaining, view.available);
    allocations.push({ lot: view.lot, quantity: take });
    remaining = remaining.minus(take);
  }
  const reserved = allocations.reduce((s, a) => s.plus(a.quantity), new D(0));
  return { allocations, reserved, missing: D.max(remaining, 0) };
}

/** Producción requerida de una línea = pedido − reservado (nunca negativa). */
export function requiredProduction(requested: Decimal.Value, reserved: Decimal.Value): Decimal {
  return D.max(new D(requested).minus(reserved), 0);
}

/**
 * Cobertura de un plan: todo reservado → FULLY_COVERED; nada reservado →
 * NOT_COVERED; si no, PARTIALLY_COVERED. NEEDS_REPLAN no sale del cálculo: lo
 * impone un hecho posterior (lote bloqueado o mermado) sobre un plan existente.
 */
export function planCoverage(
  lines: readonly { requested: Decimal.Value; reserved: Decimal.Value }[],
): Exclude<CoverageStatus, "NEEDS_REPLAN"> {
  if (lines.length === 0) return "NOT_COVERED";
  const full = lines.every((l) => !new D(l.reserved).lt(l.requested));
  if (full) return "FULLY_COVERED";
  const any = lines.some((l) => new D(l.reserved).gt(0));
  return any ? "PARTIALLY_COVERED" : "NOT_COVERED";
}

/** READY exige cobertura completa: todas las líneas reservadas por su cantidad. */
export function assertReadyAllowed(
  coverage: CoverageStatus,
  lines: readonly { requested: Decimal.Value; reserved: Decimal.Value }[],
): void {
  if (coverage !== "FULLY_COVERED" || planCoverage(lines) !== "FULLY_COVERED") {
    throw new OrderError(
      "ORDER_NOT_FULLY_COVERED",
      "Sólo un pedido con todo su producto reservado puede marcarse como listo.",
    );
  }
}

/* ---------- Necesidad de materias primas ---------- */

export interface RecipeExpansionInput {
  /** Cantidad a producir en la unidad de venta del producto. */
  quantity: Decimal.Value;
  saleUnit: CostingUnit;
  recipeYieldQuantity: Decimal.Value;
  recipeYieldUnit: CostingUnit;
  ingredients: readonly {
    rawMaterialId: string;
    rawMaterialCode: string;
    rawMaterialName: string;
    quantity: Decimal.Value;
    unit: CostingUnit;
    baseUnit: CostingUnit;
  }[];
}

/**
 * Materias primas necesarias para producir `quantity`, con el MISMO escalado
 * que Producción (planProduction): receta 100 kg → 75 kg harina + 0,8 kg sal;
 * faltan 200 kg → 150 kg harina + 1,6 kg sal. Cantidades en unidad base.
 */
export function expandRecipe(input: RecipeExpansionInput) {
  const plan = planProduction({
    plannedOutputQuantity: input.quantity,
    plannedOutputUnit: input.saleUnit,
    saleUnit: input.saleUnit,
    recipeYieldQuantity: input.recipeYieldQuantity,
    recipeYieldUnit: input.recipeYieldUnit,
    ingredients: input.ingredients.map((i) => ({
      recipeIngredientId: null,
      rawMaterialId: i.rawMaterialId,
      rawMaterialCode: i.rawMaterialCode,
      rawMaterialName: i.rawMaterialName,
      quantity: i.quantity,
      unit: i.unit,
      baseUnit: i.baseUnit,
      effectiveCost: null,
      costSource: null,
    })),
  });
  // Una materia prima puede figurar más de una vez en la receta: se suma.
  const byMaterial = new Map<string, { rawMaterialId: string; required: Decimal }>();
  for (const line of plan.lines) {
    const prev = byMaterial.get(line.rawMaterialId);
    byMaterial.set(line.rawMaterialId, {
      rawMaterialId: line.rawMaterialId,
      required: (prev?.required ?? new D(0)).plus(line.plannedNormalized),
    });
  }
  return { scaleFactor: plan.scaleFactor, materials: [...byMaterial.values()] };
}

export interface MaterialDemandEntry {
  rawMaterialId: string;
  /** Cantidad requerida en unidad base. */
  quantity: Decimal.Value;
}

export interface MaterialDemandLine {
  rawMaterialId: string;
  currentStock: Decimal;
  openOrderDemand: Decimal;
  availableAfterDemand: Decimal;
  shortage: Decimal;
}

/**
 * Demanda global: suma la necesidad de TODOS los pedidos con demanda y la
 * compara con el stock. Pedido A 7 kg + pedido B 5 kg con 10 kg de stock →
 * demanda 12, faltante proyectado 2 (nunca "alcanza" a cada uno por separado).
 */
export function aggregateMaterialDemand(
  stock: ReadonlyMap<string, Decimal.Value>,
  demand: readonly MaterialDemandEntry[],
): MaterialDemandLine[] {
  const totals = new Map<string, Decimal>();
  for (const d of demand) {
    totals.set(d.rawMaterialId, (totals.get(d.rawMaterialId) ?? new D(0)).plus(d.quantity));
  }
  return [...totals.entries()].map(([rawMaterialId, openOrderDemand]) => {
    const currentStock = new D(stock.get(rawMaterialId) ?? 0);
    const availableAfterDemand = currentStock.minus(openOrderDemand);
    return {
      rawMaterialId,
      currentStock,
      openOrderDemand,
      availableAfterDemand,
      shortage: D.max(availableAfterDemand.negated(), 0),
    };
  });
}

/* ---------- Invalidación por calidad o merma ---------- */

const PRIORITY_RANK: Record<OrderPriority, number> = { NORMAL: 0, HIGH: 1, URGENT: 2 };

export interface ActiveReservation {
  id: string;
  quantity: Decimal.Value;
  priority: OrderPriority;
  requestedAt: Date;
  reservedAt: Date;
}

/**
 * Qué reservas de un lote dejan de estar cubiertas cuando su saldo baja a
 * `newBalance` (merma). Se sacrifican primero las de menor prioridad, después
 * las de entrega más lejana (más tiempo para replanificar) y las más nuevas.
 * Cada reserva afectada se INVALIDA; si parte de ella sigue cubierta, `keep`
 * indica cuánto se vuelve a reservar (reducción controlada, sin borrar historia).
 */
export function reservationsToInvalidate<T extends ActiveReservation>(
  reservations: readonly T[],
  newBalance: Decimal.Value,
): { reservation: T; keep: Decimal }[] {
  const committed = reservations.reduce((s, r) => s.plus(r.quantity), new D(0));
  let excess = committed.minus(newBalance);
  if (!excess.gt(0)) return [];
  const order = [...reservations].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      b.requestedAt.getTime() - a.requestedAt.getTime() ||
      b.reservedAt.getTime() - a.reservedAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const result: { reservation: T; keep: Decimal }[] = [];
  for (const reservation of order) {
    if (!excess.gt(0)) break;
    const q = new D(reservation.quantity);
    const take = D.min(q, excess);
    result.push({ reservation, keep: q.minus(take) });
    excess = excess.minus(take);
  }
  return result;
}

/** Máximo que puede transformarse (congelar/descongelar) de un lote: lo no comprometido. */
export function freeLotQuantity(balance: Decimal.Value, committed: Decimal.Value): Decimal {
  return D.max(new D(balance).minus(committed), 0);
}

/** Texto de la conservación pedida ("Congelado", "Indistinto"). */
export function requestedConservationLabel(requested: RequestedConservation): string {
  return requested === "ANY" ? "Indistinto" : CONSERVATION_LABELS[requested];
}
