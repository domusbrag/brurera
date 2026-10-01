import {
  calculateRecipeCost,
  type CostingUnit,
  type IngredientCostInput,
  type RecipeCostResult,
} from "@bakery/domain";
import {
  companies,
  products,
  rawMaterials,
  recipeIngredients,
  type recipeVersions,
  type recipes,
  unitsOfMeasure,
  type Database,
  type Transaction,
} from "@bakery/database";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { OperationContext } from "../../lib/context.js";

/*
 * Lectura de los datos que el dominio de costos necesita. Todo filtrado por la
 * empresa de la sesión: el cálculo nunca ve filas de otra empresa.
 */

type Db = Database | Transaction;

export type UnitRow = CostingUnit & { active: boolean };

/** Todas las unidades de la empresa (tabla chica), indexadas por id. */
export async function loadUnits(db: Db, ctx: OperationContext): Promise<Map<string, UnitRow>> {
  const rows = await db
    .select({
      id: unitsOfMeasure.id,
      code: unitsOfMeasure.code,
      symbol: unitsOfMeasure.symbol,
      dimension: unitsOfMeasure.dimension,
      baseUnitId: unitsOfMeasure.baseUnitId,
      conversionFactor: unitsOfMeasure.conversionFactor,
      active: unitsOfMeasure.active,
    })
    .from(unitsOfMeasure)
    .where(eq(unitsOfMeasure.companyId, ctx.companyId));
  return new Map(rows.map((u) => [u.id, u]));
}

export function unitOrThrow(units: Map<string, UnitRow>, id: string): UnitRow {
  const unit = units.get(id);
  if (!unit) throw new Error(`Unidad ${id} inexistente en la empresa`);
  return unit;
}

export async function companyCurrency(db: Db, ctx: OperationContext): Promise<string> {
  const [row] = await db
    .select({ currency: companies.currencyCode })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  return row?.currency ?? "ARS";
}

export interface RawMaterialRow {
  id: string;
  code: string;
  name: string;
  active: boolean;
  baseUnitId: string;
  referenceCost: string | null;
  referenceCostSource: "MANUAL_REFERENCE" | "PURCHASE_MOVING_AVERAGE" | "SUPPLIER_QUOTE" | "OTHER";
}

/** Materias primas de la empresa por id (las de otra empresa simplemente no aparecen). */
export async function loadRawMaterials(
  db: Db,
  ctx: OperationContext,
  ids: readonly string[],
): Promise<Map<string, RawMaterialRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: rawMaterials.id,
      code: rawMaterials.internalCode,
      name: rawMaterials.name,
      active: rawMaterials.active,
      baseUnitId: rawMaterials.baseUnitId,
      referenceCost: rawMaterials.referenceCost,
      referenceCostSource: rawMaterials.referenceCostSource,
    })
    .from(rawMaterials)
    .where(and(eq(rawMaterials.companyId, ctx.companyId), inArray(rawMaterials.id, [...ids])));
  return new Map(rows.map((r) => [r.id, r]));
}

export interface IngredientRow {
  id: string;
  recipeVersionId: string;
  rawMaterialId: string;
  quantity: string;
  unitId: string;
  sortOrder: number;
  notes: string | null;
}

export async function loadIngredients(
  db: Db,
  ctx: OperationContext,
  versionIds: readonly string[],
): Promise<IngredientRow[]> {
  if (versionIds.length === 0) return [];
  return db
    .select({
      id: recipeIngredients.id,
      recipeVersionId: recipeIngredients.recipeVersionId,
      rawMaterialId: recipeIngredients.rawMaterialId,
      quantity: recipeIngredients.quantity,
      unitId: recipeIngredients.unitId,
      sortOrder: recipeIngredients.sortOrder,
      notes: recipeIngredients.notes,
    })
    .from(recipeIngredients)
    .where(
      and(
        eq(recipeIngredients.companyId, ctx.companyId),
        inArray(recipeIngredients.recipeVersionId, [...versionIds]),
      ),
    )
    .orderBy(asc(recipeIngredients.sortOrder), asc(recipeIngredients.createdAt));
}

export type VersionRow = typeof recipeVersions.$inferSelect;
export type RecipeRow = typeof recipes.$inferSelect;

export interface ProductRow {
  id: string;
  code: string;
  name: string;
  active: boolean;
  saleUnitId: string;
  salePrice: string;
}

export async function loadProduct(
  db: Db,
  ctx: OperationContext,
  productId: string,
): Promise<ProductRow | undefined> {
  const [row] = await db
    .select({
      id: products.id,
      code: products.internalCode,
      name: products.name,
      active: products.active,
      saleUnitId: products.saleUnitId,
      salePrice: products.salePrice,
    })
    .from(products)
    .where(and(eq(products.companyId, ctx.companyId), eq(products.id, productId)));
  return row;
}

/** Entrada del dominio a partir de ingredientes persistidos y costos de referencia ACTUALES. */
export function toCostInputs(
  ingredients: readonly IngredientRow[],
  materials: Map<string, RawMaterialRow>,
  units: Map<string, UnitRow>,
): IngredientCostInput[] {
  return ingredients.map((ing) => {
    const material = materials.get(ing.rawMaterialId);
    if (!material) throw new Error(`Materia prima ${ing.rawMaterialId} fuera de la empresa`);
    return {
      rawMaterialId: material.id,
      rawMaterialCode: material.code,
      rawMaterialName: material.name,
      quantity: ing.quantity,
      unit: unitOrThrow(units, ing.unitId),
      baseUnit: unitOrThrow(units, material.baseUnitId),
      referenceCost: material.referenceCost,
      costSource: material.referenceCost === null ? null : material.referenceCostSource,
    };
  });
}

/**
 * Costo teórico ACTUAL de una versión: su composición (inmutable si está
 * publicada) valorizada con los costos de referencia de hoy.
 */
export async function currentCostOf(
  db: Db,
  ctx: OperationContext,
  version: Pick<VersionRow, "id" | "yieldQuantity" | "yieldUnitId">,
  product: ProductRow,
  cache?: { units?: Map<string, UnitRow>; currency?: string },
): Promise<RecipeCostResult> {
  const units = cache?.units ?? (await loadUnits(db, ctx));
  const currency = cache?.currency ?? (await companyCurrency(db, ctx));
  const ingredients = await loadIngredients(db, ctx, [version.id]);
  const materials = await loadRawMaterials(
    db,
    ctx,
    ingredients.map((i) => i.rawMaterialId),
  );
  return calculateRecipeCost({
    currency,
    yieldQuantity: version.yieldQuantity,
    yieldUnit: unitOrThrow(units, version.yieldUnitId),
    saleUnit: unitOrThrow(units, product.saleUnitId),
    salePrice: product.salePrice,
    ingredients: toCostInputs(ingredients, materials, units),
  });
}
