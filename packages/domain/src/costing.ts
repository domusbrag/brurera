import type Decimal from "decimal.js";
import {
  COST_SCALE,
  D,
  NORMALIZED_QUANTITY_SCALE,
  PERCENTAGE_SCALE,
  RECIPE_QUANTITY_SCALE,
  toFixedString,
} from "./decimal";
import { areUnitsCompatible, convertQuantity, type UnitForConversion } from "./units";

/*
 * Costo teórico de recetas. Funciones puras: reciben todos los datos explícitos
 * (cantidades, unidades, costos de referencia) y devuelven resultados explícitos.
 * No acceden a la base ni dependen de React.
 *
 * Semántica:
 * - `referenceCost` es dinero por UNIDAD BASE de la materia prima ($850/kg).
 * - Costo de un ingrediente = cantidad convertida a la unidad base × referenceCost.
 * - Costo del lote = Σ costos de ingredientes.
 * - `yieldQuantity` es la producción ÚTIL final esperada: el costo del lote se
 *   reparte sobre ese rendimiento. La merma % es informativa y NO se aplica otra vez.
 * - Si a algún ingrediente le falta el costo de referencia, el resultado es
 *   INCOMPLETE y no hay total, costo unitario ni margen: nunca se asume costo 0.
 */

export const COST_SOURCES = [
  "MANUAL_REFERENCE",
  "PURCHASE_MOVING_AVERAGE",
  "SUPPLIER_QUOTE",
  "OTHER",
] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export const COST_STATUSES = ["COMPLETE", "INCOMPLETE"] as const;
export type CostStatus = (typeof COST_STATUSES)[number];

/** Unidad con símbolo, para poder describir los resultados. */
export interface CostingUnit extends UnitForConversion {
  symbol: string;
}

export interface UnitRef {
  id: string;
  code: string;
  symbol: string;
}

const unitRef = (u: CostingUnit): UnitRef => ({ id: u.id, code: u.code, symbol: u.symbol });

export type RecipeIssueCode =
  | "QUANTITY_NOT_POSITIVE"
  | "YIELD_NOT_POSITIVE"
  | "WASTE_OUT_OF_RANGE"
  | "INCOMPATIBLE_INGREDIENT_UNIT"
  | "INCOMPATIBLE_YIELD_UNIT"
  | "DUPLICATE_INGREDIENT"
  | "NO_INGREDIENTS";

export interface RecipeIssue {
  /** Campo afectado, p. ej. "yieldUnitId" o "ingredients.2.unitId". */
  path: string;
  code: RecipeIssueCode;
  message: string;
}

/** Error de validación de una receta (lo traduce la API a 422). */
export class RecipeValidationError extends Error {
  constructor(readonly issues: RecipeIssue[]) {
    super(issues.map((i) => i.message).join("; "));
    this.name = "RecipeValidationError";
  }
}

/* ---------- Ingrediente ---------- */

export interface IngredientCostInput {
  rawMaterialId: string;
  rawMaterialCode: string;
  rawMaterialName: string;
  /** Cantidad en `unit` (decimal string). */
  quantity: Decimal.Value;
  unit: CostingUnit;
  /** Unidad base de la materia prima. */
  baseUnit: CostingUnit;
  /** Costo por unidad base; null si la materia prima no tiene costo cargado. */
  referenceCost: Decimal.Value | null;
  costSource: CostSource | null;
}

export interface IngredientCostLine {
  rawMaterialId: string;
  rawMaterialCode: string;
  rawMaterialName: string;
  quantity: Decimal;
  unit: UnitRef;
  normalizedQuantity: Decimal;
  baseUnit: UnitRef;
  referenceCost: Decimal | null;
  costSource: CostSource | null;
  /** null si falta el costo de referencia. */
  cost: Decimal | null;
}

/** Costo de un ingrediente: cantidad normalizada a la unidad base × costo de referencia. */
export function calculateIngredientCost(input: IngredientCostInput): IngredientCostLine {
  const quantity = new D(input.quantity);
  if (!quantity.gt(0)) {
    throw new RecipeValidationError([
      {
        path: "quantity",
        code: "QUANTITY_NOT_POSITIVE",
        message: `La cantidad de ${input.rawMaterialName} debe ser mayor que cero`,
      },
    ]);
  }
  if (!areUnitsCompatible(input.unit, input.baseUnit)) {
    throw new RecipeValidationError([
      {
        path: "unitId",
        code: "INCOMPATIBLE_INGREDIENT_UNIT",
        message: `${input.rawMaterialName} se mide en ${input.baseUnit.symbol}: no se puede expresar en ${input.unit.symbol}`,
      },
    ]);
  }
  const normalizedQuantity = convertQuantity(quantity, input.unit, input.baseUnit);
  const referenceCost = input.referenceCost === null ? null : new D(input.referenceCost);
  return {
    rawMaterialId: input.rawMaterialId,
    rawMaterialCode: input.rawMaterialCode,
    rawMaterialName: input.rawMaterialName,
    quantity,
    unit: unitRef(input.unit),
    normalizedQuantity,
    baseUnit: unitRef(input.baseUnit),
    referenceCost,
    costSource: referenceCost === null ? null : input.costSource,
    cost: referenceCost === null ? null : normalizedQuantity.times(referenceCost),
  };
}

/* ---------- Rendimiento, costo unitario y margen ---------- */

/** Rendimiento expresado en la unidad de venta del producto. Lanza si no hay conversión válida. */
export function normalizeRecipeYield(
  yieldQuantity: Decimal.Value,
  yieldUnit: CostingUnit,
  saleUnit: CostingUnit,
): Decimal {
  const quantity = new D(yieldQuantity);
  if (!quantity.gt(0)) {
    throw new RecipeValidationError([
      {
        path: "yieldQuantity",
        code: "YIELD_NOT_POSITIVE",
        message: "El rendimiento debe ser mayor que cero",
      },
    ]);
  }
  if (!areUnitsCompatible(yieldUnit, saleUnit)) {
    throw new RecipeValidationError([
      {
        path: "yieldUnitId",
        code: "INCOMPATIBLE_YIELD_UNIT",
        message: `El producto se vende en ${saleUnit.symbol}: el rendimiento no puede expresarse en ${yieldUnit.symbol}`,
      },
    ]);
  }
  return convertQuantity(quantity, yieldUnit, saleUnit);
}

/** Costo por unidad de venta = costo del lote / rendimiento normalizado. */
export function calculateUnitCost(
  totalCost: Decimal.Value,
  normalizedYield: Decimal.Value,
): Decimal {
  const yieldValue = new D(normalizedYield);
  if (!yieldValue.gt(0)) throw new RangeError("El rendimiento normalizado debe ser positivo");
  return new D(totalCost).dividedBy(yieldValue);
}

export interface GrossMargin {
  salePrice: Decimal;
  amount: Decimal;
  /** null si el precio de venta es 0 (el porcentaje no está definido). */
  percentage: Decimal | null;
}

/**
 * Margen bruto teórico: precio de venta − costo teórico unitario. No es ganancia
 * neta: no incluye mano de obra, energía, alquiler, impuestos ni otros indirectos.
 */
export function calculateGrossMargin(
  salePrice: Decimal.Value,
  unitCost: Decimal.Value,
): GrossMargin {
  const price = new D(salePrice);
  const amount = price.minus(unitCost);
  return {
    salePrice: price,
    amount,
    percentage: price.gt(0) ? amount.dividedBy(price).times(100) : null,
  };
}

export interface CostVariation {
  amount: Decimal;
  /** null si el valor anterior es 0. */
  percentage: Decimal | null;
}

/** Variación entre un costo anterior (p. ej. el del snapshot) y el actual. */
export function calculateCostVariation(
  previous: Decimal.Value,
  current: Decimal.Value,
): CostVariation {
  const before = new D(previous);
  const amount = new D(current).minus(before);
  return { amount, percentage: before.isZero() ? null : amount.dividedBy(before).times(100) };
}

/* ---------- Receta ---------- */

export interface RecipeCostInput {
  currency: string;
  yieldQuantity: Decimal.Value;
  yieldUnit: CostingUnit;
  saleUnit: CostingUnit;
  /** Precio de venta del producto por unidad de venta (para el margen); opcional. */
  salePrice?: Decimal.Value | null;
  ingredients: IngredientCostInput[];
}

export interface RecipeCostResult {
  status: CostStatus;
  currency: string;
  ingredients: IngredientCostLine[];
  missingCosts: { rawMaterialId: string; rawMaterialCode: string; rawMaterialName: string }[];
  /** Costo del lote; null si el costo está incompleto. */
  totalCost: Decimal | null;
  yieldQuantity: Decimal;
  yieldUnit: UnitRef;
  normalizedYield: Decimal;
  saleUnit: UnitRef;
  /** Costo por unidad de venta; null si el costo está incompleto. */
  unitCost: Decimal | null;
  /** Precio de venta del producto (por unidad de venta), si se indicó. */
  salePrice: Decimal | null;
  /** null si el costo está incompleto o no se indicó precio. */
  grossMargin: GrossMargin | null;
}

/**
 * Costo teórico de una versión de receta:
 *   TOTAL = Σ (cantidad normalizada × costo de referencia)
 *   UNITARIO = TOTAL / rendimiento normalizado a la unidad de venta
 * Sin redondeos intermedios.
 */
export function calculateRecipeCost(input: RecipeCostInput): RecipeCostResult {
  const normalizedYield = normalizeRecipeYield(
    input.yieldQuantity,
    input.yieldUnit,
    input.saleUnit,
  );
  const ingredients = input.ingredients.map(calculateIngredientCost);
  const missingCosts = ingredients
    .filter((line) => line.cost === null)
    .map(({ rawMaterialId, rawMaterialCode, rawMaterialName }) => ({
      rawMaterialId,
      rawMaterialCode,
      rawMaterialName,
    }));
  const complete = missingCosts.length === 0 && ingredients.length > 0;
  const totalCost = complete
    ? ingredients.reduce((sum, line) => sum.plus(line.cost!), new D(0))
    : null;
  const unitCost = totalCost === null ? null : calculateUnitCost(totalCost, normalizedYield);
  return {
    status: complete ? "COMPLETE" : "INCOMPLETE",
    currency: input.currency,
    ingredients,
    missingCosts,
    totalCost,
    yieldQuantity: new D(input.yieldQuantity),
    yieldUnit: unitRef(input.yieldUnit),
    normalizedYield,
    saleUnit: unitRef(input.saleUnit),
    unitCost,
    salePrice:
      input.salePrice === null || input.salePrice === undefined ? null : new D(input.salePrice),
    grossMargin:
      unitCost !== null && input.salePrice !== null && input.salePrice !== undefined
        ? calculateGrossMargin(input.salePrice, unitCost)
        : null,
  };
}

/* ---------- Validación estructural ---------- */

export interface RecipeVersionForValidation {
  yieldQuantity: Decimal.Value;
  yieldUnit: CostingUnit;
  saleUnit: CostingUnit;
  wastePercentage: Decimal.Value | null;
  ingredients: {
    rawMaterialId: string;
    rawMaterialName: string;
    quantity: Decimal.Value;
    unit: CostingUnit;
    baseUnit: CostingUnit;
  }[];
}

/**
 * Valida una formulación sin calcular costos. `forPublish` exige además al menos
 * un ingrediente (un borrador puede guardarse vacío). Devuelve la lista de problemas.
 */
export function validateRecipeVersion(
  version: RecipeVersionForValidation,
  { forPublish = false }: { forPublish?: boolean } = {},
): RecipeIssue[] {
  const issues: RecipeIssue[] = [];
  if (!new D(version.yieldQuantity).gt(0)) {
    issues.push({
      path: "yieldQuantity",
      code: "YIELD_NOT_POSITIVE",
      message: "El rendimiento debe ser mayor que cero",
    });
  }
  if (!areUnitsCompatible(version.yieldUnit, version.saleUnit)) {
    issues.push({
      path: "yieldUnitId",
      code: "INCOMPATIBLE_YIELD_UNIT",
      message: `El producto se vende en ${version.saleUnit.symbol}: el rendimiento no puede expresarse en ${version.yieldUnit.symbol}`,
    });
  }
  if (version.wastePercentage !== null) {
    const waste = new D(version.wastePercentage);
    if (waste.lt(0) || waste.gte(100)) {
      issues.push({
        path: "wastePercentage",
        code: "WASTE_OUT_OF_RANGE",
        message: "La merma debe ser mayor o igual a 0 y menor que 100",
      });
    }
  }
  const seen = new Set<string>();
  version.ingredients.forEach((ing, index) => {
    if (seen.has(ing.rawMaterialId)) {
      issues.push({
        path: `ingredients.${index}.rawMaterialId`,
        code: "DUPLICATE_INGREDIENT",
        message: `${ing.rawMaterialName} está repetida: sumá las cantidades en una sola línea`,
      });
    }
    seen.add(ing.rawMaterialId);
    if (!new D(ing.quantity).gt(0)) {
      issues.push({
        path: `ingredients.${index}.quantity`,
        code: "QUANTITY_NOT_POSITIVE",
        message: `La cantidad de ${ing.rawMaterialName} debe ser mayor que cero`,
      });
    }
    if (!areUnitsCompatible(ing.unit, ing.baseUnit)) {
      issues.push({
        path: `ingredients.${index}.unitId`,
        code: "INCOMPATIBLE_INGREDIENT_UNIT",
        message: `${ing.rawMaterialName} se mide en ${ing.baseUnit.symbol}: no se puede expresar en ${ing.unit.symbol}`,
      });
    }
  });
  if (forPublish && version.ingredients.length === 0) {
    issues.push({
      path: "ingredients",
      code: "NO_INGREDIENTS",
      message: "La receta necesita al menos un ingrediente para publicarse",
    });
  }
  return issues;
}

/* ---------- Serialización (wire / persistencia) ---------- */

export interface IngredientCostLineWire {
  rawMaterialId: string;
  rawMaterialCode: string;
  rawMaterialName: string;
  quantity: string;
  unit: UnitRef;
  normalizedQuantity: string;
  baseUnit: UnitRef;
  referenceCost: string | null;
  costSource: CostSource | null;
  cost: string | null;
}

export interface RecipeCostWire {
  status: CostStatus;
  currency: string;
  ingredients: IngredientCostLineWire[];
  missingCosts: RecipeCostResult["missingCosts"];
  totalCost: string | null;
  yieldQuantity: string;
  yieldUnit: UnitRef;
  normalizedYield: string;
  saleUnit: UnitRef;
  unitCost: string | null;
  salePrice: string | null;
  grossMargin: { salePrice: string; amount: string; percentage: string | null } | null;
}

const fixed = (value: Decimal | null, scale: number) =>
  value === null ? null : toFixedString(value, scale);

/**
 * Convierte el resultado a strings con la escala de persistencia (único punto de
 * redondeo antes de guardar o enviar): dinero a 6 decimales, cantidades
 * normalizadas a 10, porcentajes a 4. La UI redondea después a 2 para mostrar.
 */
export function recipeCostToWire(result: RecipeCostResult): RecipeCostWire {
  return {
    status: result.status,
    currency: result.currency,
    ingredients: result.ingredients.map((line) => ({
      rawMaterialId: line.rawMaterialId,
      rawMaterialCode: line.rawMaterialCode,
      rawMaterialName: line.rawMaterialName,
      quantity: toFixedString(line.quantity, RECIPE_QUANTITY_SCALE),
      unit: line.unit,
      normalizedQuantity: toFixedString(line.normalizedQuantity, NORMALIZED_QUANTITY_SCALE),
      baseUnit: line.baseUnit,
      referenceCost: fixed(line.referenceCost, COST_SCALE),
      costSource: line.costSource,
      cost: fixed(line.cost, COST_SCALE),
    })),
    missingCosts: result.missingCosts,
    totalCost: fixed(result.totalCost, COST_SCALE),
    yieldQuantity: toFixedString(result.yieldQuantity, RECIPE_QUANTITY_SCALE),
    yieldUnit: result.yieldUnit,
    normalizedYield: toFixedString(result.normalizedYield, NORMALIZED_QUANTITY_SCALE),
    saleUnit: result.saleUnit,
    unitCost: fixed(result.unitCost, COST_SCALE),
    salePrice: fixed(result.salePrice, COST_SCALE),
    grossMargin: result.grossMargin
      ? {
          salePrice: toFixedString(result.grossMargin.salePrice, COST_SCALE),
          amount: toFixedString(result.grossMargin.amount, COST_SCALE),
          percentage: fixed(result.grossMargin.percentage, PERCENTAGE_SCALE),
        }
      : null,
  };
}

/* ---------- Diferencias entre versiones ---------- */

export interface VersionForDiff {
  yieldQuantity: Decimal.Value;
  yieldUnit: CostingUnit;
  wastePercentage: Decimal.Value | null;
  instructions: string | null;
  ingredients: {
    rawMaterialId: string;
    rawMaterialName: string;
    quantity: Decimal.Value;
    unit: CostingUnit;
    baseUnit: CostingUnit;
  }[];
}

export interface QuantityRef {
  quantity: string;
  unit: UnitRef;
}

export interface RecipeVersionDiff {
  added: ({ rawMaterialId: string; rawMaterialName: string } & QuantityRef)[];
  removed: ({ rawMaterialId: string; rawMaterialName: string } & QuantityRef)[];
  changed: { rawMaterialId: string; rawMaterialName: string; from: QuantityRef; to: QuantityRef }[];
  yield: { from: QuantityRef; to: QuantityRef } | null;
  waste: { from: string | null; to: string | null } | null;
  instructionsChanged: boolean;
  hasChanges: boolean;
}

const qref = (quantity: Decimal.Value, unit: CostingUnit): QuantityRef => ({
  quantity: new D(quantity).toFixed(),
  unit: unitRef(unit),
});

/** Misma cantidad física: se compara en la raíz (750 g == 0,75 kg no es un cambio). */
function sameAmount(
  a: Decimal.Value,
  aUnit: CostingUnit,
  b: Decimal.Value,
  bUnit: CostingUnit,
): boolean {
  if (!areUnitsCompatible(aUnit, bUnit)) return false;
  return convertQuantity(a, aUnit, bUnit).eq(new D(b));
}

/** Ingredientes agregados, quitados y modificados; rendimiento, merma e instrucciones. */
export function diffRecipeVersions(from: VersionForDiff, to: VersionForDiff): RecipeVersionDiff {
  const before = new Map(from.ingredients.map((i) => [i.rawMaterialId, i]));
  const after = new Map(to.ingredients.map((i) => [i.rawMaterialId, i]));
  const added = to.ingredients
    .filter((i) => !before.has(i.rawMaterialId))
    .map((i) => ({
      rawMaterialId: i.rawMaterialId,
      rawMaterialName: i.rawMaterialName,
      ...qref(i.quantity, i.unit),
    }));
  const removed = from.ingredients
    .filter((i) => !after.has(i.rawMaterialId))
    .map((i) => ({
      rawMaterialId: i.rawMaterialId,
      rawMaterialName: i.rawMaterialName,
      ...qref(i.quantity, i.unit),
    }));
  const changed = to.ingredients.flatMap((i) => {
    const prev = before.get(i.rawMaterialId);
    if (!prev || sameAmount(prev.quantity, prev.unit, i.quantity, i.unit)) return [];
    return [
      {
        rawMaterialId: i.rawMaterialId,
        rawMaterialName: i.rawMaterialName,
        from: qref(prev.quantity, prev.unit),
        to: qref(i.quantity, i.unit),
      },
    ];
  });
  const yieldChange = sameAmount(from.yieldQuantity, from.yieldUnit, to.yieldQuantity, to.yieldUnit)
    ? null
    : { from: qref(from.yieldQuantity, from.yieldUnit), to: qref(to.yieldQuantity, to.yieldUnit) };
  const wasteFrom = from.wastePercentage === null ? null : new D(from.wastePercentage).toFixed();
  const wasteTo = to.wastePercentage === null ? null : new D(to.wastePercentage).toFixed();
  const waste = wasteFrom === wasteTo ? null : { from: wasteFrom, to: wasteTo };
  const instructionsChanged = (from.instructions ?? "").trim() !== (to.instructions ?? "").trim();
  return {
    added,
    removed,
    changed,
    yield: yieldChange,
    waste,
    instructionsChanged,
    hasChanges:
      added.length + removed.length + changed.length > 0 ||
      yieldChange !== null ||
      waste !== null ||
      instructionsChanged,
  };
}

/* ---------- Vigencia ---------- */

export interface VersionValidity {
  id: string;
  effectiveFrom: Date | null;
  archivedAt: Date | null;
}

/**
 * Versión vigente en un instante: publicada (effectiveFrom <= at) y no archivada
 * todavía (archivedAt > at o nula). Los borradores no tienen vigencia.
 */
export function findEffectiveVersion<T extends VersionValidity>(
  versions: readonly T[],
  at: Date,
): T | null {
  const time = at.getTime();
  return (
    versions.find(
      (v) =>
        v.effectiveFrom !== null &&
        v.effectiveFrom.getTime() <= time &&
        (v.archivedAt === null || v.archivedAt.getTime() > time),
    ) ?? null
  );
}
