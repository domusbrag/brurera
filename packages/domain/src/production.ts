import type Decimal from "decimal.js";
import type { CostSource, CostStatus, CostingUnit } from "./costing";
import { COST_SCALE, D, toFixedString } from "./decimal";
import { areUnitsCompatible, convertQuantity } from "./units";

/*
 * Producción (Fase 4). Funciones puras con decimal.js: máquina de estados de la
 * orden, escalado de la receta, costo esperado, consumos y salida reales,
 * variaciones, rendimiento, costo material real y faltantes de stock.
 *
 * Unidades:
 * - La salida del producto se normaliza a su UNIDAD DE VENTA (stock del producto).
 * - Cada consumo se normaliza a la UNIDAD BASE de la materia prima (stock de la MP).
 * Nunca se convierte entre dimensiones distintas (masa ↔ volumen).
 */

/* ---------- Estados ---------- */

export const PRODUCTION_STATUSES = [
  "DRAFT",
  "PLANNED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number];

/** Transiciones permitidas. COMPLETED y CANCELLED son terminales. */
export const PRODUCTION_TRANSITIONS: Readonly<
  Record<ProductionStatus, readonly ProductionStatus[]>
> = {
  DRAFT: ["PLANNED", "CANCELLED"],
  PLANNED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: ProductionStatus, to: ProductionStatus): boolean {
  return PRODUCTION_TRANSITIONS[from].includes(to);
}

export const PRODUCTION_LINE_TYPES = ["RECIPE", "EXTRA"] as const;
export type ProductionLineType = (typeof PRODUCTION_LINE_TYPES)[number];

export type ProductionErrorCode =
  | "INVALID_PRODUCTION_TRANSITION"
  | "QUANTITY_NOT_POSITIVE"
  | "QUANTITY_NEGATIVE"
  | "INCOMPATIBLE_OUTPUT_UNIT"
  | "INCOMPATIBLE_CONSUMPTION_UNIT"
  | "INCOMPATIBLE_YIELD_UNIT"
  | "NO_INGREDIENTS";

/** Error de regla de producción (la API lo traduce a 409/422 con el mismo código). */
export class ProductionError extends Error {
  constructor(
    readonly code: ProductionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProductionError";
  }
}

export function assertTransition(from: ProductionStatus, to: ProductionStatus): void {
  if (!canTransition(from, to)) {
    throw new ProductionError(
      "INVALID_PRODUCTION_TRANSITION",
      `Una orden ${from} no puede pasar a ${to}`,
    );
  }
}

/* ---------- Normalización ---------- */

/**
 * Salida (planificada o real) expresada en la unidad de venta del producto.
 * Debe ser > 0 y de una unidad compatible (100 kg, 96.000 g → 96 kg).
 */
export function normalizeOutput(
  quantity: Decimal.Value,
  unit: CostingUnit,
  saleUnit: CostingUnit,
): Decimal {
  const q = new D(quantity);
  if (!q.gt(0)) {
    throw new ProductionError("QUANTITY_NOT_POSITIVE", "La cantidad debe ser mayor que cero");
  }
  if (!areUnitsCompatible(unit, saleUnit)) {
    throw new ProductionError(
      "INCOMPATIBLE_OUTPUT_UNIT",
      `El producto se mide en ${saleUnit.symbol}: no se puede expresar en ${unit.symbol}`,
    );
  }
  return convertQuantity(q, unit, saleUnit);
}

/**
 * Consumo real expresado en la unidad base de la materia prima (1.950 g → 1,95 kg).
 * Admite 0 (un ingrediente que finalmente no se usó); nunca negativo.
 */
export function normalizeConsumption(
  quantity: Decimal.Value,
  unit: CostingUnit,
  baseUnit: CostingUnit,
  materialName = "la materia prima",
): Decimal {
  const q = new D(quantity);
  if (q.lt(0)) {
    throw new ProductionError("QUANTITY_NEGATIVE", "El consumo no puede ser negativo");
  }
  if (!areUnitsCompatible(unit, baseUnit)) {
    throw new ProductionError(
      "INCOMPATIBLE_CONSUMPTION_UNIT",
      `${materialName} se mide en ${baseUnit.symbol}: no se puede expresar en ${unit.symbol}`,
    );
  }
  return convertQuantity(q, unit, baseUnit);
}

/* ---------- Escalado de la receta ---------- */

/** scaleFactor = salida planificada normalizada / rendimiento de la receta normalizado. */
export function scaleFactor(
  plannedOutputNormalized: Decimal.Value,
  recipeYieldNormalized: Decimal.Value,
): Decimal {
  const yieldValue = new D(recipeYieldNormalized);
  if (!yieldValue.gt(0)) throw new RangeError("El rendimiento de la receta debe ser positivo");
  return new D(plannedOutputNormalized).dividedBy(yieldValue);
}

export interface PlanIngredientInput {
  recipeIngredientId: string | null;
  rawMaterialId: string;
  rawMaterialCode: string;
  rawMaterialName: string;
  /** Cantidad de la receta (para su rendimiento), en `unit`. */
  quantity: Decimal.Value;
  unit: CostingUnit;
  baseUnit: CostingUnit;
  /** Costo efectivo por unidad base (promedio → referencia); null si no hay ninguno. */
  effectiveCost: Decimal.Value | null;
  costSource: CostSource | null;
}

export interface PlanLine {
  recipeIngredientId: string | null;
  rawMaterialId: string;
  rawMaterialCode: string;
  rawMaterialName: string;
  /** Cantidad escalada en la unidad de la receta. */
  plannedQuantity: Decimal;
  unit: CostingUnit;
  /** Cantidad escalada en la unidad base de la materia prima. */
  plannedNormalized: Decimal;
  baseUnit: CostingUnit;
  unitCost: Decimal | null;
  costSource: CostSource | null;
  /** Costo esperado de la línea (6 decimales); null si falta el costo. */
  plannedCost: Decimal | null;
}

export interface ProductionPlanInput {
  plannedOutputQuantity: Decimal.Value;
  plannedOutputUnit: CostingUnit;
  saleUnit: CostingUnit;
  recipeYieldQuantity: Decimal.Value;
  recipeYieldUnit: CostingUnit;
  ingredients: readonly PlanIngredientInput[];
}

export interface ProductionPlan {
  plannedOutputNormalized: Decimal;
  recipeYieldNormalized: Decimal;
  scaleFactor: Decimal;
  lines: PlanLine[];
  costStatus: CostStatus;
  missingCosts: { rawMaterialId: string; rawMaterialName: string }[];
  /** Σ costos esperados de las líneas; null si el costo está incompleto. */
  plannedMaterialCost: Decimal | null;
  /** Costo esperado por unidad de venta; null si está incompleto. */
  plannedUnitMaterialCost: Decimal | null;
}

/**
 * Plan de consumo de una orden: escala cada ingrediente de la versión de receta
 * y valoriza con el costo efectivo actual (congelado al planificar).
 *   Receta 100 kg → 75 kg harina; orden 200 kg → scaleFactor 2 → 150 kg harina.
 */
export function planProduction(input: ProductionPlanInput): ProductionPlan {
  const plannedOutputNormalized = normalizeOutput(
    input.plannedOutputQuantity,
    input.plannedOutputUnit,
    input.saleUnit,
  );
  const yieldQty = new D(input.recipeYieldQuantity);
  if (!yieldQty.gt(0)) throw new RangeError("El rendimiento de la receta debe ser positivo");
  if (!areUnitsCompatible(input.recipeYieldUnit, input.saleUnit)) {
    throw new ProductionError(
      "INCOMPATIBLE_YIELD_UNIT",
      `La receta rinde en ${input.recipeYieldUnit.symbol} y el producto se mide en ${input.saleUnit.symbol}`,
    );
  }
  if (input.ingredients.length === 0) {
    throw new ProductionError("NO_INGREDIENTS", "La versión de receta no tiene ingredientes");
  }
  const recipeYieldNormalized = convertQuantity(yieldQty, input.recipeYieldUnit, input.saleUnit);
  const factor = scaleFactor(plannedOutputNormalized, recipeYieldNormalized);
  const lines = input.ingredients.map((ing): PlanLine => {
    if (!areUnitsCompatible(ing.unit, ing.baseUnit)) {
      throw new ProductionError(
        "INCOMPATIBLE_CONSUMPTION_UNIT",
        `${ing.rawMaterialName} se mide en ${ing.baseUnit.symbol}: no se puede expresar en ${ing.unit.symbol}`,
      );
    }
    const plannedQuantity = new D(ing.quantity).times(factor);
    const plannedNormalized = convertQuantity(plannedQuantity, ing.unit, ing.baseUnit);
    const unitCost = ing.effectiveCost === null ? null : new D(ing.effectiveCost);
    return {
      recipeIngredientId: ing.recipeIngredientId,
      rawMaterialId: ing.rawMaterialId,
      rawMaterialCode: ing.rawMaterialCode,
      rawMaterialName: ing.rawMaterialName,
      plannedQuantity,
      unit: ing.unit,
      plannedNormalized,
      baseUnit: ing.baseUnit,
      unitCost,
      costSource: unitCost === null ? null : ing.costSource,
      plannedCost:
        unitCost === null
          ? null
          : new D(toFixedString(plannedNormalized.times(unitCost), COST_SCALE)),
    };
  });
  const missingCosts = lines
    .filter((l) => l.plannedCost === null)
    .map((l) => ({ rawMaterialId: l.rawMaterialId, rawMaterialName: l.rawMaterialName }));
  const complete = missingCosts.length === 0;
  // Suma de las líneas ya redondeadas: el total coincide con lo que muestra la tabla.
  const total = complete ? lines.reduce((s, l) => s.plus(l.plannedCost!), new D(0)) : null;
  return {
    plannedOutputNormalized,
    recipeYieldNormalized,
    scaleFactor: factor,
    lines,
    costStatus: complete ? "COMPLETE" : "INCOMPLETE",
    missingCosts,
    plannedMaterialCost: total,
    plannedUnitMaterialCost: total === null ? null : total.dividedBy(plannedOutputNormalized),
  };
}

/* ---------- Variaciones y rendimiento ---------- */

export interface QuantityVariance {
  /** real − planificado (con signo). */
  quantity: Decimal;
  /** % sobre lo planificado; null si no había plan (consumo extra) o el plan era 0. */
  percentage: Decimal | null;
}

/** Variación de un consumo: 75 kg plan, 77,5 kg real → +2,5 kg / +3,33 %. */
export function consumptionVariance(
  planned: Decimal.Value | null,
  actual: Decimal.Value,
): QuantityVariance {
  const real = new D(actual);
  if (planned === null) return { quantity: real, percentage: null };
  const plan = new D(planned);
  const quantity = real.minus(plan);
  return { quantity, percentage: plan.isZero() ? null : quantity.dividedBy(plan).times(100) };
}

export interface OutputPerformance {
  /** actualOutput − plannedOutput. */
  variance: Decimal;
  /** variación % sobre lo planificado. */
  variancePercentage: Decimal;
  /** actualOutput / plannedOutput × 100. */
  yieldPerformance: Decimal;
}

/**
 * Rendimiento real del lote: 100 kg plan, 96 kg real → −4 kg, −4 %, 96 %.
 * La merma teórica de la receta es sólo referencia: no se descuenta de nuevo.
 */
export function outputPerformance(
  plannedOutput: Decimal.Value,
  actualOutput: Decimal.Value,
): OutputPerformance {
  const plan = new D(plannedOutput);
  if (!plan.gt(0)) throw new RangeError("La salida planificada debe ser positiva");
  const real = new D(actualOutput);
  const variance = real.minus(plan);
  return {
    variance,
    variancePercentage: variance.dividedBy(plan).times(100),
    yieldPerformance: real.dividedBy(plan).times(100),
  };
}

/* ---------- Costos reales ---------- */

/**
 * Costo material real del lote = Σ valores (absolutos) de los movimientos de
 * consumo. Se suma lo que efectivamente salió del inventario, ya redondeado
 * por movimiento: así el valor que entra al producto es el que salió de las MP.
 */
export function actualMaterialCost(consumptionValues: readonly Decimal.Value[]): Decimal {
  return consumptionValues.reduce<Decimal>((sum, v) => sum.plus(new D(v).abs()), new D(0));
}

/** Costo material por unidad = costo real / salida real normalizada (77.400 / 96 = 806,25). */
export function actualUnitMaterialCost(
  totalCost: Decimal.Value,
  actualOutputNormalized: Decimal.Value,
): Decimal {
  const output = new D(actualOutputNormalized);
  if (!output.gt(0)) {
    throw new ProductionError("QUANTITY_NOT_POSITIVE", "La salida real debe ser mayor que cero");
  }
  return new D(totalCost).dividedBy(output);
}

/* ---------- Disponibilidad ---------- */

export interface MaterialRequirement {
  rawMaterialId: string;
  rawMaterialName: string;
  /** Requerido en unidad base. */
  required: Decimal.Value;
}

export interface MaterialShortage {
  rawMaterialId: string;
  rawMaterialName: string;
  required: Decimal;
  available: Decimal;
  missing: Decimal;
}

/**
 * Agrega los requerimientos por materia prima (una MP puede aparecer en una línea
 * de receta y en un extra) y devuelve las que no alcanzan con lo disponible.
 */
export function aggregateRequirements(
  lines: readonly MaterialRequirement[],
): Map<string, { rawMaterialName: string; required: Decimal }> {
  const byMaterial = new Map<string, { rawMaterialName: string; required: Decimal }>();
  for (const line of lines) {
    const prev = byMaterial.get(line.rawMaterialId);
    byMaterial.set(line.rawMaterialId, {
      rawMaterialName: line.rawMaterialName,
      required: (prev?.required ?? new D(0)).plus(line.required),
    });
  }
  return byMaterial;
}

export function findShortages(
  lines: readonly MaterialRequirement[],
  available: ReadonlyMap<string, Decimal.Value>,
): MaterialShortage[] {
  const shortages: MaterialShortage[] = [];
  for (const [rawMaterialId, req] of aggregateRequirements(lines)) {
    const have = new D(available.get(rawMaterialId) ?? 0);
    if (req.required.gt(have)) {
      shortages.push({
        rawMaterialId,
        rawMaterialName: req.rawMaterialName,
        required: req.required,
        available: have,
        missing: req.required.minus(have),
      });
    }
  }
  return shortages.sort((a, b) => a.rawMaterialName.localeCompare(b.rawMaterialName));
}

/* ---------- Lote ---------- */

/** Código de lote sugerido: LOT-20261001-001 (fecha programada + correlativo del día). */
export function formatBatchCode(scheduledFor: string, sequence: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledFor)) throw new RangeError("Fecha inválida");
  if (!Number.isInteger(sequence) || sequence < 1) throw new RangeError("Secuencia inválida");
  return `LOT-${scheduledFor.replace(/-/g, "")}-${String(sequence).padStart(3, "0")}`;
}
