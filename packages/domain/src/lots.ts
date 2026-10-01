import type Decimal from "decimal.js";
import { COST_SCALE, D, NORMALIZED_QUANTITY_SCALE, toFixedString } from "./decimal";
import { InventoryError, type CostedMovement, type InventoryCostState } from "./inventory";

/*
 * Lotes de producto terminado, conservación y vida útil (Fase 4.5). Funciones
 * puras: no acceden a la base.
 *
 * - La vida útil NO es un dato del producto: pertenece a un lote producido en un
 *   momento concreto y bajo un estado de conservación concreto. Los minutos de
 *   vida útil por estado los configura cada empresa (perfil de conservación);
 *   el software no inventa reglas sanitarias.
 * - Conservación (FRESH, FROZEN…) y calidad (AVAILABLE, BLOCKED) son ejes
 *   distintos. "Agotado" es derivado (saldo 0); el lote no se borra.
 * - Stock físico ≠ stock elegible: un lote existe físicamente aunque a la fecha
 *   pedida ya no sea utilizable.
 */

export const CONSERVATION_STATES = ["FRESH", "REFRIGERATED", "FROZEN", "THAWED"] as const;
export type ConservationState = (typeof CONSERVATION_STATES)[number];

export const LOT_QUALITY_STATUSES = ["AVAILABLE", "BLOCKED"] as const;
export type LotQualityStatus = (typeof LOT_QUALITY_STATUSES)[number];

/** Motivos de merma de producto terminado (sobre un lote). */
export const PRODUCT_WASTE_REASONS = ["EXPIRED", "DAMAGED", "QUALITY", "OTHER"] as const;
export type ProductWasteReason = (typeof PRODUCT_WASTE_REASONS)[number];

/** Por qué un lote no es elegible en un momento dado. */
export const LOT_INELIGIBILITY_REASONS = ["DEPLETED", "BLOCKED", "EXPIRED"] as const;
export type LotIneligibilityReason = (typeof LOT_INELIGIBILITY_REASONS)[number];

export type LotErrorCode =
  | "TRANSFORMATION_NOT_ALLOWED"
  | "CONSERVATION_STATE_DISABLED"
  | "INSUFFICIENT_LOT_QUANTITY"
  | "QUANTITY_NOT_POSITIVE"
  | "INVALID_SHELF_LIFE"
  | "INITIAL_STATE_NOT_ALLOWED";

/** Error de regla de lotes (la API lo traduce a 409/422 con el mismo código). */
export class LotError extends Error {
  constructor(
    readonly code: LotErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LotError";
  }
}

/* ---------- Transiciones de conservación ---------- */

/**
 * Transiciones permitidas en el MVP. Deliberadamente una tabla y no un motor:
 *   FRESH → FROZEN, REFRIGERATED → FROZEN, FROZEN → THAWED.
 * No hay recongelado (THAWED → FROZEN) ni vuelta a fresco.
 */
export const CONSERVATION_TRANSITIONS: Readonly<
  Record<ConservationState, readonly ConservationState[]>
> = {
  FRESH: ["FROZEN"],
  REFRIGERATED: ["FROZEN"],
  FROZEN: ["THAWED"],
  THAWED: [],
};

export function canTransform(from: ConservationState, to: ConservationState): boolean {
  return CONSERVATION_TRANSITIONS[from].includes(to);
}

/** Valida una transformación; lanza TRANSFORMATION_NOT_ALLOWED con un mensaje de negocio. */
export function assertTransformation(from: ConservationState, to: ConservationState): void {
  if (canTransform(from, to)) return;
  const message =
    from === "THAWED" && to === "FROZEN"
      ? "Un lote descongelado no puede volver a congelarse."
      : `No se puede pasar de ${CONSERVATION_LABELS[from].toLowerCase()} a ${CONSERVATION_LABELS[to].toLowerCase()}.`;
  throw new LotError("TRANSFORMATION_NOT_ALLOWED", message);
}

export const CONSERVATION_LABELS: Readonly<Record<ConservationState, string>> = {
  FRESH: "Fresco",
  REFRIGERATED: "Refrigerado",
  FROZEN: "Congelado",
  THAWED: "Descongelado",
};

/* ---------- Vida útil ---------- */

export const SHELF_LIFE_UNITS = ["HOURS", "DAYS"] as const;
export type ShelfLifeUnit = (typeof SHELF_LIFE_UNITS)[number];

const MINUTES_PER: Record<ShelfLifeUnit, number> = { HOURS: 60, DAYS: 1440 };
/** Tope de vida útil: 10 años (evita desbordes y errores de tipeo absurdos). */
export const MAX_SHELF_LIFE_MINUTES = 10 * 366 * 1440;

/** Convierte una duración ingresada en horas o días a minutos enteros (semántica exacta). */
export function shelfLifeToMinutes(value: Decimal.Value, unit: ShelfLifeUnit): number {
  const minutes = new D(value).times(MINUTES_PER[unit]);
  if (!minutes.isInteger() || minutes.lte(0) || minutes.gt(MAX_SHELF_LIFE_MINUTES)) {
    throw new LotError(
      "INVALID_SHELF_LIFE",
      "La vida útil debe ser mayor que cero y expresarse en minutos enteros (máximo 10 años).",
    );
  }
  return minutes.toNumber();
}

/** Mejor forma de mostrar minutos: días si son exactos, si no horas (con decimales). */
export function describeShelfLife(minutes: number): { value: string; unit: ShelfLifeUnit } {
  if (minutes % MINUTES_PER.DAYS === 0) {
    return { value: String(minutes / MINUTES_PER.DAYS), unit: "DAYS" };
  }
  return {
    value: new D(minutes).dividedBy(MINUTES_PER.HOURS).toDecimalPlaces(4).toString(),
    unit: "HOURS",
  };
}

/** Utilizable hasta = momento del cambio de estado (o producción) + vida útil del estado. */
export function calculateUsableUntil(stateChangedAt: Date, shelfLifeMinutes: number): Date {
  if (!Number.isInteger(shelfLifeMinutes) || shelfLifeMinutes <= 0) {
    throw new LotError("INVALID_SHELF_LIFE", "La vida útil debe ser un entero positivo de minutos");
  }
  return new Date(stateChangedAt.getTime() + shelfLifeMinutes * 60_000);
}

/* ---------- Perfil de conservación ---------- */

export interface ConservationProfileEntry {
  state: ConservationState;
  enabled: boolean;
  shelfLifeMinutes: number | null;
  allowedAsInitial: boolean;
}

/**
 * Estado y vida útil con que nace un lote de producción.
 * - Si se pide un estado, debe estar habilitado y permitido como inicial.
 * - Si no, el estado inicial por defecto del producto; sin configuración, FRESH
 *   con vida útil desconocida (null): el sistema no inventa una.
 */
export function resolveInitialConservation(args: {
  profile: readonly ConservationProfileEntry[];
  defaultInitialState: ConservationState | null;
  requested?: ConservationState | null;
}): { state: ConservationState; shelfLifeMinutes: number | null } {
  const { profile, defaultInitialState, requested } = args;
  const configured = profile.some((p) => p.enabled);
  if (!configured) {
    if (requested && requested !== "FRESH") {
      throw new LotError(
        "INITIAL_STATE_NOT_ALLOWED",
        "El producto no tiene conservación configurada: sólo puede producirse fresco.",
      );
    }
    return { state: "FRESH", shelfLifeMinutes: null };
  }
  const state =
    requested ??
    defaultInitialState ??
    (profile.find((p) => p.state === "FRESH" && p.enabled && p.allowedAsInitial)
      ? "FRESH"
      : (profile.find((p) => p.enabled && p.allowedAsInitial)?.state ?? null));
  const entry = state ? profile.find((p) => p.state === state) : undefined;
  if (!state || !entry || !entry.enabled || !entry.allowedAsInitial) {
    throw new LotError(
      "INITIAL_STATE_NOT_ALLOWED",
      state
        ? `${CONSERVATION_LABELS[state]} no está habilitado como estado inicial de este producto.`
        : "El producto no tiene ningún estado inicial habilitado.",
    );
  }
  return { state, shelfLifeMinutes: entry.shelfLifeMinutes };
}

/** Estado destino de una transformación: transición válida y estado habilitado en el perfil. */
export function resolveTransformation(args: {
  from: ConservationState;
  to: ConservationState;
  profile: readonly ConservationProfileEntry[];
}): { shelfLifeMinutes: number | null } {
  assertTransformation(args.from, args.to);
  const entry = args.profile.find((p) => p.state === args.to);
  if (!entry || !entry.enabled) {
    throw new LotError(
      "CONSERVATION_STATE_DISABLED",
      `El producto no admite el estado ${CONSERVATION_LABELS[args.to].toLowerCase()}.`,
    );
  }
  return { shelfLifeMinutes: entry.shelfLifeMinutes };
}

/* ---------- Cantidades y valor de lote ---------- */

const qty10 = (v: Decimal.Value) => new D(toFixedString(v, NORMALIZED_QUANTITY_SCALE));
const money6 = (v: Decimal.Value) => new D(toFixedString(v, COST_SCALE));

/**
 * Valor que sale de un lote al retirar `quantity`. Si se retira todo, el valor
 * remanente exacto (absorbe el redondeo); si no, cantidad × costo unitario del
 * lote, sin superar el remanente. Falla con INSUFFICIENT_LOT_QUANTITY.
 */
export function lotOutflow(args: {
  lotQuantity: Decimal.Value;
  lotValue: Decimal.Value;
  unitCost: Decimal.Value;
  quantity: Decimal.Value;
}): { quantity: Decimal; value: Decimal; remainingQuantity: Decimal; remainingValue: Decimal } {
  const available = new D(args.lotQuantity);
  const lotValue = new D(args.lotValue);
  const q = qty10(args.quantity);
  if (!q.gt(0)) {
    throw new LotError("QUANTITY_NOT_POSITIVE", "La cantidad debe ser mayor que cero");
  }
  if (q.gt(available)) {
    throw new LotError(
      "INSUFFICIENT_LOT_QUANTITY",
      `El lote tiene ${available.toString()} disponibles: no alcanza para ${q.toString()}.`,
    );
  }
  const remainingQuantity = available.minus(q);
  const value = remainingQuantity.isZero()
    ? lotValue
    : D.min(money6(q.times(args.unitCost)), lotValue);
  return { quantity: q, value, remainingQuantity, remainingValue: lotValue.minus(value) };
}

/**
 * Aplica al costo agregado del producto un movimiento de lote (transformación o
 * merma) con valor dado: cambia cantidad y valor, NUNCA el promedio móvil (igual
 * criterio que el resto de las salidas). El promedio sólo se recalcula al
 * ingresar producción nueva.
 */
export function applyLotMovement(
  state: InventoryCostState,
  signedQuantity: Decimal.Value,
  signedValue: Decimal.Value,
): CostedMovement {
  const before = {
    quantity: new D(state.quantity),
    inventoryValue: new D(state.inventoryValue),
    movingAverageCost: state.movingAverageCost === null ? null : new D(state.movingAverageCost),
  };
  const quantity = qty10(signedQuantity);
  const value = money6(signedValue);
  const afterQty = before.quantity.plus(quantity);
  const afterValue = before.inventoryValue.plus(value);
  if (afterQty.lt(0) || afterValue.lt(0)) {
    throw new InventoryError(
      "INSUFFICIENT_STOCK",
      "No hay stock suficiente: la operación dejaría stock negativo",
    );
  }
  const unitCost = quantity.isZero() ? new D(0) : value.abs().dividedBy(quantity.abs());
  return {
    quantity,
    unitCost: money6(unitCost),
    totalValue: value,
    before,
    after: {
      quantity: afterQty,
      inventoryValue: afterValue,
      movingAverageCost: before.movingAverageCost,
    },
    averageChanged: false,
  };
}

/* ---------- Elegibilidad, FEFO y disponibilidad ---------- */

export interface LotForAvailability {
  id: string;
  code: string;
  conservationState: ConservationState;
  qualityStatus: LotQualityStatus;
  quantity: Decimal.Value;
  producedAt: Date;
  usableUntil: Date | null;
}

export interface LotEligibility {
  eligible: boolean;
  reason: LotIneligibilityReason | null;
}

/**
 * ¿El lote se puede usar en `at`? Agotado, bloqueado o vencido (at > usableUntil)
 * no son elegibles. Sin vida útil configurada (usableUntil null) no se excluye:
 * el sistema no inventa un vencimiento, pero lo informa (`shelfLifeUnknown`).
 */
export function lotEligibilityAt(lot: LotForAvailability, at: Date): LotEligibility {
  if (!new D(lot.quantity).gt(0)) return { eligible: false, reason: "DEPLETED" };
  if (lot.qualityStatus === "BLOCKED") return { eligible: false, reason: "BLOCKED" };
  if (lot.usableUntil !== null && at.getTime() > lot.usableUntil.getTime()) {
    return { eligible: false, reason: "EXPIRED" };
  }
  return { eligible: true, reason: null };
}

/** ¿Vence dentro de la ventana [at, at + threshold]? (sólo lotes todavía utilizables). */
export function isNearExpiry(lot: LotForAvailability, at: Date, thresholdMinutes: number): boolean {
  if (lot.usableUntil === null || !lotEligibilityAt(lot, at).eligible) return false;
  return lot.usableUntil.getTime() - at.getTime() <= thresholdMinutes * 60_000;
}

/**
 * FEFO (First Expire, First Out): primero el que vence antes; sin vencimiento
 * conocido, al final; a igual vencimiento, el producido antes; luego por código.
 * No es FIFO: un congelado más viejo puede ir después de un fresco más nuevo.
 */
export function compareFefo(a: LotForAvailability, b: LotForAvailability): number {
  const ua = a.usableUntil?.getTime() ?? Number.POSITIVE_INFINITY;
  const ub = b.usableUntil?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ua !== ub) return ua < ub ? -1 : 1;
  const pa = a.producedAt.getTime();
  const pb = b.producedAt.getTime();
  if (pa !== pb) return pa < pb ? -1 : 1;
  return a.code.localeCompare(b.code);
}

export function sortFefo<T extends LotForAvailability>(lots: readonly T[]): T[] {
  return [...lots].sort(compareFefo);
}

export type ConservationBreakdown = Record<ConservationState, Decimal>;

export interface AvailabilityAt<T extends LotForAvailability> {
  requestedAt: Date;
  physicalQuantity: Decimal;
  eligibleQuantity: Decimal;
  ineligibleQuantity: Decimal;
  /** Cantidad no elegible por razón (vencido, bloqueado). */
  ineligibleByReason: Record<Exclude<LotIneligibilityReason, "DEPLETED">, Decimal>;
  /** Stock físico por conservación. */
  physicalByState: ConservationBreakdown;
  /** Stock elegible por conservación. */
  eligibleByState: ConservationBreakdown;
  /** Cantidad elegible de lotes sin vida útil configurada. */
  shelfLifeUnknownQuantity: Decimal;
  /** Lotes con saldo, en orden FEFO, con su elegibilidad en `requestedAt`. */
  lots: (T & LotEligibility)[];
}

const emptyBreakdown = (): ConservationBreakdown => ({
  FRESH: new D(0),
  REFRIGERATED: new D(0),
  FROZEN: new D(0),
  THAWED: new D(0),
});

/**
 * Núcleo de `calculateProductAvailabilityAt`: dado el conjunto de lotes de un
 * producto (ya filtrado por depósito si corresponde) y un momento, qué cantidad
 * existe y qué cantidad es utilizable en ese momento. No descuenta reservas:
 * stock comprometido llega en Fase 5A.
 */
export function calculateAvailabilityAt<T extends LotForAvailability>(
  lots: readonly T[],
  requestedAt: Date,
): AvailabilityAt<T> {
  const withStock = sortFefo(lots.filter((l) => new D(l.quantity).gt(0)));
  const result: AvailabilityAt<T> = {
    requestedAt,
    physicalQuantity: new D(0),
    eligibleQuantity: new D(0),
    ineligibleQuantity: new D(0),
    ineligibleByReason: { BLOCKED: new D(0), EXPIRED: new D(0) },
    physicalByState: emptyBreakdown(),
    eligibleByState: emptyBreakdown(),
    shelfLifeUnknownQuantity: new D(0),
    lots: [],
  };
  for (const lot of withStock) {
    const q = new D(lot.quantity);
    const eligibility = lotEligibilityAt(lot, requestedAt);
    result.physicalQuantity = result.physicalQuantity.plus(q);
    result.physicalByState[lot.conservationState] =
      result.physicalByState[lot.conservationState].plus(q);
    if (eligibility.eligible) {
      result.eligibleQuantity = result.eligibleQuantity.plus(q);
      result.eligibleByState[lot.conservationState] =
        result.eligibleByState[lot.conservationState].plus(q);
      if (lot.usableUntil === null) {
        result.shelfLifeUnknownQuantity = result.shelfLifeUnknownQuantity.plus(q);
      }
    } else {
      result.ineligibleQuantity = result.ineligibleQuantity.plus(q);
      const reason = eligibility.reason as "BLOCKED" | "EXPIRED";
      result.ineligibleByReason[reason] = result.ineligibleByReason[reason].plus(q);
    }
    result.lots.push({ ...lot, ...eligibility });
  }
  return result;
}

/**
 * Recomendación FEFO para cubrir `quantity` en `at` (sólo lotes elegibles). No
 * asigna ni reserva nada: la venta real llega en Fase 5B.
 */
export function recommendFefo<T extends LotForAvailability>(
  lots: readonly T[],
  quantity: Decimal.Value,
  at: Date,
): { allocations: { lot: T; quantity: Decimal }[]; missing: Decimal } {
  let remaining = new D(quantity);
  const allocations: { lot: T; quantity: Decimal }[] = [];
  for (const lot of sortFefo(lots)) {
    if (!remaining.gt(0)) break;
    if (!lotEligibilityAt(lot, at).eligible) continue;
    const take = D.min(remaining, lot.quantity);
    allocations.push({ lot, quantity: take });
    remaining = remaining.minus(take);
  }
  return { allocations, missing: D.max(remaining, 0) };
}

/** Código de un lote hijo: código del padre + "." + número de hijo (LOT-…-005.1, .2…). */
export function childLotCode(parentCode: string, childNumber: number): string {
  if (!Number.isInteger(childNumber) || childNumber < 1) throw new RangeError("Número inválido");
  return `${parentCode}.${childNumber}`;
}
