import {
  RecipeValidationError,
  calculateCostVariation,
  calculateRecipeCost,
  calculateGrossMargin,
  diffRecipeVersions,
  findEffectiveVersion,
  recipeCostToWire,
  toFixedString,
  validateRecipeVersion,
  type RecipeCostInput,
  type RecipeCostResult,
  type RecipeIssue,
} from "@bakery/domain";
import {
  products,
  recipeCostSnapshotLines,
  recipeCostSnapshots,
  recipeIngredients,
  recipeVersions,
  recipes,
  unitsOfMeasure,
  users,
  type Database,
  type Transaction,
} from "@bakery/database";
import type {
  CostSnapshotDto,
  CreateRecipeInput,
  Page,
  RecipeDto,
  RecipeIngredientInput,
  RecipeListItemDto,
  RecipeProductDto,
  RecipeVersionCostDto,
  RecipeVersionDiffDto,
  RecipeVersionDto,
  RecipeVersionInput,
  RecipeVersionSummaryDto,
  TheoreticalCostDto,
  UpdateRecipeVersionInput,
} from "@bakery/shared";
import type {
  createRecipeVersionSchema,
  publishRecipeVersionSchema,
  recipeListQuerySchema,
  updateRecipeSchema,
} from "@bakery/shared";
import { and, asc, count, desc, eq, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { likePattern, pageWindow, toPage } from "../../lib/listing.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";
import {
  companyCurrency,
  currentCostOf,
  loadIngredients,
  loadProduct,
  loadRawMaterials,
  loadUnits,
  toCostInputs,
  unitOrThrow,
  type IngredientRow,
  type ProductRow,
  type RawMaterialRow,
  type RecipeRow,
  type UnitRow,
  type VersionRow,
} from "./recipes.data.js";

type Db = Database | Transaction;
type ListQuery = z.infer<typeof recipeListQuerySchema>;
type UpdateRecipeInput = z.infer<typeof updateRecipeSchema>;
type CreateVersionInput = z.infer<typeof createRecipeVersionSchema>;
type PublishInput = z.infer<typeof publishRecipeVersionSchema>;

/* ---------- Errores de negocio ---------- */

const recipeExists = () =>
  new AppError(
    409,
    "RECIPE_ALREADY_EXISTS",
    "El producto ya tiene una receta activa. Creá una nueva versión de esa receta.",
    [{ path: "productId", message: "Ya tiene receta activa" }],
  );
const draftExists = () =>
  new AppError(
    409,
    "DRAFT_ALREADY_EXISTS",
    "La receta ya tiene un borrador en curso. Editalo o descartalo antes de crear otro.",
  );
const immutable = (status: string) =>
  new AppError(
    409,
    "RECIPE_VERSION_IMMUTABLE",
    status === "ACTIVE"
      ? "La versión vigente no se modifica. Creá una nueva versión."
      : "Una versión archivada no se modifica.",
  );
const recipeInactive = () =>
  new AppError(409, "RECIPE_INACTIVE", "La receta está desactivada. Reactivala para modificarla.");

function invalidRecipe(issues: RecipeIssue[]): AppError {
  return new AppError(
    422,
    "RECIPE_INVALID",
    issues[0]?.message ?? "Receta inválida",
    issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
  );
}

/* ---------- Mapeo a DTOs ---------- */

const creator = alias(users, "creator");
const publisher = alias(users, "publisher");

function selectVersions(db: Db) {
  return db
    .select({
      v: recipeVersions,
      unit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
      creator: { id: creator.id, displayName: creator.displayName },
      publisher: { id: publisher.id, displayName: publisher.displayName },
      snapshot: {
        status: recipeCostSnapshots.completenessStatus,
        currency: recipeCostSnapshots.currencyCode,
        totalCost: recipeCostSnapshots.totalCost,
        unitCost: recipeCostSnapshots.unitCost,
        saleUnitSymbol: recipeCostSnapshots.saleUnitSymbol,
      },
    })
    .from(recipeVersions)
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, recipeVersions.yieldUnitId))
    .leftJoin(creator, eq(creator.id, recipeVersions.createdByUserId))
    .leftJoin(publisher, eq(publisher.id, recipeVersions.publishedByUserId))
    .leftJoin(recipeCostSnapshots, eq(recipeCostSnapshots.recipeVersionId, recipeVersions.id));
}

type VersionSelectRow = Awaited<ReturnType<ReturnType<typeof selectVersions>["execute"]>>[number];

function toSummary(row: VersionSelectRow): RecipeVersionSummaryDto {
  const { v } = row;
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    status: v.status,
    yieldQuantity: v.yieldQuantity,
    yieldUnit: row.unit,
    wastePercentage: v.wastePercentage,
    createdAt: v.createdAt.toISOString(),
    createdBy: row.creator,
    effectiveFrom: v.effectiveFrom?.toISOString() ?? null,
    publishedAt: v.publishedAt?.toISOString() ?? null,
    publishedBy: row.publisher,
    archivedAt: v.archivedAt?.toISOString() ?? null,
    snapshot: row.snapshot,
  };
}

function toProductDto(product: ProductRow, units: Map<string, UnitRow>): RecipeProductDto {
  const unit = unitOrThrow(units, product.saleUnitId);
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    active: product.active,
    saleUnit: { id: unit.id, code: unit.code, symbol: unit.symbol },
    salePrice: product.salePrice,
  };
}

const ownedRecipe = (ctx: OperationContext, id: string): SQL | undefined =>
  and(eq(recipes.companyId, ctx.companyId), eq(recipes.id, id));
const ownedVersion = (ctx: OperationContext, id: string): SQL | undefined =>
  and(eq(recipeVersions.companyId, ctx.companyId), eq(recipeVersions.id, id));

async function findRecipe(db: Db, ctx: OperationContext, id: string, lock = false) {
  const query = db.select().from(recipes).where(ownedRecipe(ctx, id));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Receta");
  return row;
}

async function findVersion(db: Db, ctx: OperationContext, id: string, lock = false) {
  const query = db.select().from(recipeVersions).where(ownedVersion(ctx, id));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Versión");
  return row;
}

async function productOf(db: Db, ctx: OperationContext, recipe: RecipeRow): Promise<ProductRow> {
  const product = await loadProduct(db, ctx, recipe.productId);
  if (!product) throw new Error("Receta sin producto en la empresa");
  return product;
}

/* ---------- Validación de una formulación ---------- */

interface ValidatedVersion {
  yieldQuantity: string;
  yieldUnitId: string;
  wastePercentage: string | null;
  instructions: string | null;
  ingredients: RecipeIngredientInput[];
}

/**
 * Valida referencias (empresa, activas) y reglas de dominio (unidades
 * compatibles, cantidades, merma). Una materia prima o unidad de otra empresa
 * se informa igual que una inexistente.
 */
async function validateFormulation(
  db: Db,
  ctx: OperationContext,
  product: ProductRow,
  version: ValidatedVersion,
  { forPublish = false }: { forPublish?: boolean } = {},
): Promise<{ units: Map<string, UnitRow>; materials: Map<string, RawMaterialRow> }> {
  const units = await loadUnits(db, ctx);
  const yieldUnit = units.get(version.yieldUnitId);
  if (!yieldUnit || !yieldUnit.active) {
    throw invalidReference("yieldUnitId", "Unidad inexistente o inactiva");
  }
  const materials = await loadRawMaterials(
    db,
    ctx,
    version.ingredients.map((i) => i.rawMaterialId),
  );
  version.ingredients.forEach((ing, index) => {
    const material = materials.get(ing.rawMaterialId);
    if (!material || !material.active) {
      throw invalidReference(
        `ingredients.${index}.rawMaterialId`,
        "Materia prima inexistente o inactiva",
      );
    }
    const unit = units.get(ing.unitId);
    if (!unit || !unit.active) {
      throw invalidReference(`ingredients.${index}.unitId`, "Unidad inexistente o inactiva");
    }
  });
  const issues = validateRecipeVersion(
    {
      yieldQuantity: version.yieldQuantity,
      yieldUnit,
      saleUnit: unitOrThrow(units, product.saleUnitId),
      wastePercentage: version.wastePercentage,
      ingredients: version.ingredients.map((ing) => {
        const material = materials.get(ing.rawMaterialId)!;
        return {
          rawMaterialId: material.id,
          rawMaterialName: material.name,
          quantity: ing.quantity,
          unit: unitOrThrow(units, ing.unitId),
          baseUnit: unitOrThrow(units, material.baseUnitId),
        };
      }),
    },
    { forPublish },
  );
  if (issues.length > 0) throw invalidRecipe(issues);
  return { units, materials };
}

async function insertIngredients(
  tx: Transaction,
  ctx: OperationContext,
  versionId: string,
  ingredients: readonly Pick<IngredientRow, "rawMaterialId" | "quantity" | "unitId" | "notes">[],
) {
  if (ingredients.length === 0) return;
  await tx.insert(recipeIngredients).values(
    ingredients.map((ing, index) => ({
      companyId: ctx.companyId,
      recipeVersionId: versionId,
      rawMaterialId: ing.rawMaterialId,
      quantity: ing.quantity,
      unitId: ing.unitId,
      notes: ing.notes,
      sortOrder: index,
    })),
  );
}

/** Reserva el próximo número de versión (bloquea la fila de la receta hasta el commit). */
async function nextVersionNumber(tx: Transaction, recipeId: string): Promise<number> {
  const [row] = await tx
    .update(recipes)
    .set({ lastVersionNumber: sql`${recipes.lastVersionNumber} + 1` })
    .where(eq(recipes.id, recipeId))
    .returning({ n: recipes.lastVersionNumber });
  if (!row) throw new Error("Receta inexistente al numerar la versión");
  return row.n;
}

async function insertDraft(
  tx: Transaction,
  ctx: OperationContext,
  recipeId: string,
  version: ValidatedVersion,
): Promise<VersionRow> {
  const versionNumber = await nextVersionNumber(tx, recipeId);
  const [row] = await mapUniqueViolations(
    tx
      .insert(recipeVersions)
      .values({
        companyId: ctx.companyId,
        recipeId,
        versionNumber,
        status: "DRAFT",
        yieldQuantity: version.yieldQuantity,
        yieldUnitId: version.yieldUnitId,
        wastePercentage: version.wastePercentage,
        instructions: version.instructions,
        createdByUserId: ctx.userId,
      })
      .returning(),
    { recipe_versions_one_draft_uq: draftExists },
  );
  if (!row) throw new Error("Alta de versión sin fila");
  await insertIngredients(tx, ctx, row.id, version.ingredients);
  return row;
}

/* ---------- Recetas ---------- */

export async function listRecipes(
  db: Database,
  ctx: OperationContext,
  query: ListQuery,
): Promise<Page<RecipeListItemDto>> {
  const pattern = query.search ? likePattern(query.search) : undefined;
  const where = and(
    eq(recipes.companyId, ctx.companyId),
    query.status === "all" ? undefined : eq(recipes.active, query.status === "active"),
    query.productId ? eq(recipes.productId, query.productId) : undefined,
    pattern
      ? or(
          ilike(recipes.name, pattern),
          ilike(products.name, pattern),
          ilike(products.internalCode, pattern),
        )
      : undefined,
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        r: recipes,
        product: {
          id: products.id,
          code: products.internalCode,
          name: products.name,
          active: products.active,
          saleUnitId: products.saleUnitId,
          salePrice: products.salePrice,
        },
      })
      .from(recipes)
      .innerJoin(products, eq(products.id, recipes.productId))
      .where(where)
      .orderBy(asc(products.name), asc(recipes.name))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: count() })
      .from(recipes)
      .innerJoin(products, eq(products.id, recipes.productId))
      .where(where),
  ]);
  if (rows.length === 0) return toPage([], total?.n ?? 0, query);

  const units = await loadUnits(db, ctx);
  const currency = await companyCurrency(db, ctx);
  const versions = await db
    .select()
    .from(recipeVersions)
    .where(
      and(
        eq(recipeVersions.companyId, ctx.companyId),
        inArray(
          recipeVersions.recipeId,
          rows.map((r) => r.r.id),
        ),
        inArray(recipeVersions.status, ["ACTIVE", "DRAFT"]),
      ),
    );
  const active = new Map(versions.filter((v) => v.status === "ACTIVE").map((v) => [v.recipeId, v]));
  const drafts = new Map(versions.filter((v) => v.status === "DRAFT").map((v) => [v.recipeId, v]));
  const ingredients = await loadIngredients(
    db,
    ctx,
    [...active.values()].map((v) => v.id),
  );
  const materials = await loadRawMaterials(
    db,
    ctx,
    ingredients.map((i) => i.rawMaterialId),
  );

  const items = rows.map(({ r, product }): RecipeListItemDto => {
    const saleUnit = unitOrThrow(units, product.saleUnitId);
    const activeVersion = active.get(r.id);
    const draft = drafts.get(r.id);
    let currentCost: RecipeListItemDto["currentCost"] = null;
    if (activeVersion) {
      const cost = recipeCostToWire(
        calculateCostFor(activeVersion, product, units, currency, ingredients, materials),
      );
      currentCost = {
        status: cost.status,
        currency,
        unitCost: cost.unitCost,
        missingCount: cost.missingCosts.length,
      };
    }
    return {
      id: r.id,
      name: r.name,
      active: r.active,
      product: {
        id: product.id,
        code: product.code,
        name: product.name,
        saleUnit: { id: saleUnit.id, code: saleUnit.code, symbol: saleUnit.symbol },
      },
      activeVersion: activeVersion
        ? {
            id: activeVersion.id,
            versionNumber: activeVersion.versionNumber,
            yieldQuantity: activeVersion.yieldQuantity,
            yieldUnit: (({ id, code, symbol }) => ({ id, code, symbol }))(
              unitOrThrow(units, activeVersion.yieldUnitId),
            ),
            publishedAt: activeVersion.publishedAt?.toISOString() ?? null,
          }
        : null,
      draftVersion: draft ? { id: draft.id, versionNumber: draft.versionNumber } : null,
      currentCost,
      updatedAt: latest(r.updatedAt, activeVersion?.updatedAt, draft?.updatedAt).toISOString(),
    };
  });
  return toPage(items, total?.n ?? 0, query);
}

function latest(...dates: (Date | undefined)[]): Date {
  return new Date(Math.max(...dates.filter((d): d is Date => !!d).map((d) => d.getTime())));
}

function calculateCostFor(
  version: VersionRow,
  product: ProductRow,
  units: Map<string, UnitRow>,
  currency: string,
  allIngredients: readonly IngredientRow[],
  materials: Map<string, RawMaterialRow>,
): RecipeCostResult {
  return calculateRecipeCostSafe({
    currency,
    yieldQuantity: version.yieldQuantity,
    yieldUnit: unitOrThrow(units, version.yieldUnitId),
    saleUnit: unitOrThrow(units, product.saleUnitId),
    salePrice: product.salePrice,
    ingredients: toCostInputs(
      allIngredients.filter((i) => i.recipeVersionId === version.id),
      materials,
      units,
    ),
  });
}

/** Igual que el dominio; un problema de datos se informa como 422, no como 500. */
function calculateRecipeCostSafe(input: RecipeCostInput): RecipeCostResult {
  try {
    return calculateRecipeCost(input);
  } catch (err) {
    if (err instanceof RecipeValidationError) throw invalidRecipe(err.issues);
    throw err;
  }
}

export async function getRecipe(db: Db, ctx: OperationContext, id: string): Promise<RecipeDto> {
  const recipe = await findRecipe(db, ctx, id);
  const product = await productOf(db, ctx, recipe);
  const units = await loadUnits(db, ctx);
  const versions = (
    await selectVersions(db)
      .where(and(eq(recipeVersions.companyId, ctx.companyId), eq(recipeVersions.recipeId, id)))
      .orderBy(desc(recipeVersions.versionNumber))
  ).map(toSummary);
  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    active: recipe.active,
    product: toProductDto(product, units),
    activeVersionId: versions.find((v) => v.status === "ACTIVE")?.id ?? null,
    draftVersionId: versions.find((v) => v.status === "DRAFT")?.id ?? null,
    versions,
    createdAt: recipe.createdAt.toISOString(),
    updatedAt: recipe.updatedAt.toISOString(),
  };
}

export async function listVersions(db: Db, ctx: OperationContext, recipeId: string) {
  return (await getRecipe(db, ctx, recipeId)).versions;
}

const draftInput = (v: RecipeVersionInput): ValidatedVersion => ({
  yieldQuantity: v.yieldQuantity,
  yieldUnitId: v.yieldUnitId,
  wastePercentage: v.wastePercentage,
  instructions: v.instructions,
  ingredients: v.ingredients,
});

export async function createRecipe(db: Database, ctx: OperationContext, input: CreateRecipeInput) {
  return db.transaction(async (tx) => {
    const product = await loadProduct(tx, ctx, input.productId);
    if (!product || !product.active) {
      throw invalidReference("productId", "Producto inexistente o inactivo");
    }
    const [existing] = await tx
      .select({ id: recipes.id })
      .from(recipes)
      .where(
        and(
          eq(recipes.companyId, ctx.companyId),
          eq(recipes.productId, product.id),
          eq(recipes.active, true),
        ),
      );
    if (existing) throw recipeExists();
    const version = draftInput(input.version);
    await validateFormulation(tx, ctx, product, version);
    const [recipe] = await mapUniqueViolations(
      tx
        .insert(recipes)
        .values({
          companyId: ctx.companyId,
          productId: product.id,
          name: input.name ?? product.name,
          description: input.description,
        })
        .returning(),
      { recipes_one_active_per_product_uq: recipeExists },
    );
    if (!recipe) throw new Error("Alta de receta sin fila");
    const draft = await insertDraft(tx, ctx, recipe.id, version);
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "RECIPE_CREATED",
      entityType: "recipe",
      entityId: recipe.id,
      metadata: { name: recipe.name, productCode: product.code, productName: product.name },
    });
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "RECIPE_VERSION_CREATED",
      entityType: "recipe",
      entityId: recipe.id,
      metadata: {
        versionId: draft.id,
        versionNumber: draft.versionNumber,
        ingredients: version.ingredients.length,
      },
    });
    return getRecipe(tx, ctx, recipe.id);
  });
}

export async function updateRecipe(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: UpdateRecipeInput,
) {
  return db.transaction(async (tx) => {
    const before = await findRecipe(tx, ctx, id, true);
    const [after] = await tx.update(recipes).set(input).where(ownedRecipe(ctx, id)).returning();
    if (!after) throw notFound("Receta");
    const changes = diffChanges(before, after, Object.keys(input));
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "RECIPE_UPDATED",
        entityType: "recipe",
        entityId: id,
        metadata: { changes },
      });
    }
    return getRecipe(tx, ctx, id);
  });
}

export async function setRecipeActive(
  db: Database,
  ctx: OperationContext,
  id: string,
  active: boolean,
) {
  return db.transaction(async (tx) => {
    const before = await findRecipe(tx, ctx, id, true);
    if (before.active !== active) {
      await mapUniqueViolations(tx.update(recipes).set({ active }).where(ownedRecipe(ctx, id)), {
        recipes_one_active_per_product_uq: recipeExists,
      });
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: active ? "RECIPE_REACTIVATED" : "RECIPE_DEACTIVATED",
        entityType: "recipe",
        entityId: id,
        metadata: { name: before.name },
      });
    }
    return getRecipe(tx, ctx, id);
  });
}

/* ---------- Versiones ---------- */

export async function getVersion(
  db: Db,
  ctx: OperationContext,
  id: string,
): Promise<RecipeVersionDto> {
  const [row] = await selectVersions(db).where(ownedVersion(ctx, id));
  if (!row) throw notFound("Versión");
  const recipe = await findRecipe(db, ctx, row.v.recipeId);
  const product = await productOf(db, ctx, recipe);
  const units = await loadUnits(db, ctx);
  const ingredients = await loadIngredients(db, ctx, [id]);
  const materials = await loadRawMaterials(
    db,
    ctx,
    ingredients.map((i) => i.rawMaterialId),
  );
  const ref = (u: UnitRow) => ({ id: u.id, code: u.code, symbol: u.symbol });
  return {
    ...toSummary(row),
    recipe: { id: recipe.id, name: recipe.name, active: recipe.active },
    product: toProductDto(product, units),
    instructions: row.v.instructions,
    ingredients: ingredients.map((ing) => {
      const m = materials.get(ing.rawMaterialId)!;
      return {
        id: ing.id,
        rawMaterial: {
          id: m.id,
          code: m.code,
          name: m.name,
          active: m.active,
          baseUnit: ref(unitOrThrow(units, m.baseUnitId)),
          referenceCost: m.referenceCost,
          referenceCostSource: m.referenceCostSource,
        },
        quantity: ing.quantity,
        unit: ref(unitOrThrow(units, ing.unitId)),
        sortOrder: ing.sortOrder,
        notes: ing.notes,
      };
    }),
  };
}

/**
 * Nueva versión (DRAFT): copia de `copyFromVersionId`, o de la última versión,
 * o (si la receta no tiene ninguna) desde `version`. Copia ingredientes,
 * cantidades, unidades, rendimiento, merma e instrucciones con ids nuevos; nunca
 * el snapshot de costo.
 */
export async function createVersion(
  db: Database,
  ctx: OperationContext,
  recipeId: string,
  input: CreateVersionInput,
) {
  return db.transaction(async (tx) => {
    const recipe = await findRecipe(tx, ctx, recipeId, true);
    if (!recipe.active) throw recipeInactive();
    const [draft] = await tx
      .select({ id: recipeVersions.id })
      .from(recipeVersions)
      .where(and(eq(recipeVersions.recipeId, recipeId), eq(recipeVersions.status, "DRAFT")));
    if (draft) throw draftExists();

    let source: VersionRow | undefined;
    if (input.copyFromVersionId) {
      source = await findVersion(tx, ctx, input.copyFromVersionId);
      if (source.recipeId !== recipeId) {
        throw invalidReference("copyFromVersionId", "La versión no es de esta receta");
      }
    } else if (!input.version) {
      [source] = await tx
        .select()
        .from(recipeVersions)
        .where(eq(recipeVersions.recipeId, recipeId))
        .orderBy(desc(recipeVersions.versionNumber))
        .limit(1);
      if (!source) {
        throw new AppError(
          422,
          "VALIDATION_ERROR",
          "La receta no tiene versiones para copiar: indicá rendimiento e ingredientes",
          [{ path: "version", message: "Obligatorio" }],
        );
      }
    }

    let row: VersionRow;
    if (source) {
      const ingredients = await loadIngredients(tx, ctx, [source.id]);
      row = await insertDraft(tx, ctx, recipeId, {
        yieldQuantity: source.yieldQuantity,
        yieldUnitId: source.yieldUnitId,
        wastePercentage: source.wastePercentage,
        instructions: source.instructions,
        ingredients: [],
      });
      await insertIngredients(tx, ctx, row.id, ingredients);
    } else {
      const product = await productOf(tx, ctx, recipe);
      const version = draftInput(input.version!);
      await validateFormulation(tx, ctx, product, version);
      row = await insertDraft(tx, ctx, recipeId, version);
    }
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "RECIPE_VERSION_CREATED",
      entityType: "recipe",
      entityId: recipeId,
      metadata: {
        versionId: row.id,
        versionNumber: row.versionNumber,
        copiedFromVersion: source?.versionNumber ?? null,
      },
    });
    return getVersion(tx, ctx, row.id);
  });
}

export async function duplicateVersion(db: Database, ctx: OperationContext, versionId: string) {
  const version = await findVersion(db, ctx, versionId);
  return createVersion(db, ctx, version.recipeId, { copyFromVersionId: versionId });
}

/** Edita un borrador. `ingredients`, si viene, reemplaza la lista completa. */
export async function updateVersion(
  db: Database,
  ctx: OperationContext,
  versionId: string,
  input: UpdateRecipeVersionInput,
) {
  return db.transaction(async (tx) => {
    const before = await findVersion(tx, ctx, versionId, true);
    if (before.status !== "DRAFT") throw immutable(before.status);
    const recipe = await findRecipe(tx, ctx, before.recipeId);
    if (!recipe.active) throw recipeInactive();
    const product = await productOf(tx, ctx, recipe);
    const currentIngredients = await loadIngredients(tx, ctx, [versionId]);
    const merged: ValidatedVersion = {
      yieldQuantity: input.yieldQuantity ?? before.yieldQuantity,
      yieldUnitId: input.yieldUnitId ?? before.yieldUnitId,
      wastePercentage:
        input.wastePercentage !== undefined ? input.wastePercentage : before.wastePercentage,
      instructions: input.instructions !== undefined ? input.instructions : before.instructions,
      ingredients:
        input.ingredients ??
        currentIngredients.map((i) => ({
          rawMaterialId: i.rawMaterialId,
          quantity: i.quantity,
          unitId: i.unitId,
          notes: i.notes,
        })),
    };
    const { units, materials } = await validateFormulation(tx, ctx, product, merged);
    const [after] = await tx
      .update(recipeVersions)
      .set({
        yieldQuantity: merged.yieldQuantity,
        yieldUnitId: merged.yieldUnitId,
        wastePercentage: merged.wastePercentage,
        instructions: merged.instructions,
      })
      .where(ownedVersion(ctx, versionId))
      .returning();
    if (!after) throw notFound("Versión");
    if (input.ingredients) {
      await tx.delete(recipeIngredients).where(eq(recipeIngredients.recipeVersionId, versionId));
      await insertIngredients(tx, ctx, versionId, input.ingredients);
    }
    const allMaterials = new Map([
      ...materials,
      ...(await loadRawMaterials(
        tx,
        ctx,
        currentIngredients.map((i) => i.rawMaterialId),
      )),
    ]);
    const toDiff = (v: ValidatedVersion) => ({
      yieldQuantity: v.yieldQuantity,
      yieldUnit: unitOrThrow(units, v.yieldUnitId),
      wastePercentage: v.wastePercentage,
      instructions: v.instructions,
      ingredients: v.ingredients.map((i) => {
        const m = allMaterials.get(i.rawMaterialId)!;
        return {
          rawMaterialId: m.id,
          rawMaterialName: m.name,
          quantity: i.quantity,
          unit: unitOrThrow(units, i.unitId),
          baseUnit: unitOrThrow(units, m.baseUnitId),
        };
      }),
    });
    const diff = diffRecipeVersions(
      toDiff({
        yieldQuantity: before.yieldQuantity,
        yieldUnitId: before.yieldUnitId,
        wastePercentage: before.wastePercentage,
        instructions: before.instructions,
        ingredients: currentIngredients.map((i) => ({ ...i })),
      }),
      toDiff(merged),
    );
    if (diff.hasChanges) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "RECIPE_VERSION_UPDATED",
        entityType: "recipe",
        entityId: recipe.id,
        metadata: {
          versionId,
          versionNumber: after.versionNumber,
          added: diff.added.map((i) => i.rawMaterialName),
          removed: diff.removed.map((i) => i.rawMaterialName),
          changed: diff.changed.map((i) => i.rawMaterialName),
          yield: diff.yield,
          waste: diff.waste,
          instructionsChanged: diff.instructionsChanged,
        },
      });
    }
    return getVersion(tx, ctx, versionId);
  });
}

/**
 * Publica un borrador en UNA transacción: valida ingredientes, unidades,
 * rendimiento y empresa; calcula el costo con los costos de referencia actuales;
 * guarda el snapshot; archiva la versión vigente anterior; activa la nueva y
 * audita. Cualquier falla revierte todo.
 */
export async function publishVersion(
  db: Database,
  ctx: OperationContext,
  versionId: string,
  input: PublishInput,
) {
  return db.transaction(async (tx) => {
    // Lock de la receta primero: serializa publicaciones concurrentes de la misma receta.
    const peek = await findVersion(tx, ctx, versionId);
    const recipe = await findRecipe(tx, ctx, peek.recipeId, true);
    const version = await findVersion(tx, ctx, versionId, true);
    if (version.status !== "DRAFT") throw immutable(version.status);
    if (!recipe.active) throw recipeInactive();
    const product = await productOf(tx, ctx, recipe);
    if (!product.active) {
      throw new AppError(409, "PRODUCT_INACTIVE", "El producto está desactivado.");
    }

    // 1-4. Ingredientes, unidades, rendimiento y empresa.
    const ingredients = await loadIngredients(tx, ctx, [versionId]);
    const { units, materials } = await validateFormulation(
      tx,
      ctx,
      product,
      {
        yieldQuantity: version.yieldQuantity,
        yieldUnitId: version.yieldUnitId,
        wastePercentage: version.wastePercentage,
        instructions: version.instructions,
        ingredients: ingredients.map((i) => ({ ...i })),
      },
      { forPublish: true },
    );

    // 5. Costo con los costos de referencia vigentes.
    const currency = await companyCurrency(tx, ctx);
    const cost = calculateRecipeCostSafe({
      currency,
      yieldQuantity: version.yieldQuantity,
      yieldUnit: unitOrThrow(units, version.yieldUnitId),
      saleUnit: unitOrThrow(units, product.saleUnitId),
      salePrice: product.salePrice,
      ingredients: toCostInputs(ingredients, materials, units),
    });
    if (cost.status === "INCOMPLETE" && !input.acknowledgeIncompleteCost) {
      throw new AppError(
        409,
        "COST_INCOMPLETE_CONFIRMATION_REQUIRED",
        `Costo teórico incompleto: falta el costo de ${cost.missingCosts.map((m) => m.rawMaterialName).join(", ")}. Confirmá para publicar igual.`,
        cost.missingCosts.map((m) => ({ path: "ingredients", message: m.rawMaterialName })),
      );
    }
    const wire = recipeCostToWire(cost);
    const now = new Date();

    // 6. Snapshot inmutable (cabecera + desglose).
    const yieldUnit = unitOrThrow(units, version.yieldUnitId);
    const saleUnit = unitOrThrow(units, product.saleUnitId);
    const [snapshot] = await tx
      .insert(recipeCostSnapshots)
      .values({
        companyId: ctx.companyId,
        recipeVersionId: versionId,
        calculatedAt: now,
        currencyCode: currency,
        completenessStatus: wire.status,
        totalCost: wire.totalCost,
        yieldQuantity: wire.yieldQuantity,
        yieldUnitCode: yieldUnit.code,
        yieldUnitSymbol: yieldUnit.symbol,
        normalizedYield: wire.normalizedYield,
        saleUnitCode: saleUnit.code,
        saleUnitSymbol: saleUnit.symbol,
        unitCost: wire.unitCost,
        salePrice: product.salePrice,
      })
      .returning({ id: recipeCostSnapshots.id });
    if (!snapshot) throw new Error("Snapshot sin fila");
    if (wire.ingredients.length > 0) {
      await tx.insert(recipeCostSnapshotLines).values(
        wire.ingredients.map((line, index) => ({
          companyId: ctx.companyId,
          snapshotId: snapshot.id,
          sortOrder: index,
          rawMaterialId: line.rawMaterialId,
          rawMaterialCode: line.rawMaterialCode,
          rawMaterialName: line.rawMaterialName,
          quantity: line.quantity,
          unitCode: line.unit.code,
          unitSymbol: line.unit.symbol,
          normalizedQuantity: line.normalizedQuantity,
          baseUnitCode: line.baseUnit.code,
          baseUnitSymbol: line.baseUnit.symbol,
          referenceCost: line.referenceCost,
          costSource: line.costSource,
          ingredientCost: line.cost,
        })),
      );
    }

    // 7. Archivar la versión vigente anterior (antes de activar: índice "una ACTIVE").
    const archived = await tx
      .update(recipeVersions)
      .set({ status: "ARCHIVED", archivedAt: now })
      .where(and(eq(recipeVersions.recipeId, recipe.id), eq(recipeVersions.status, "ACTIVE")))
      .returning({ id: recipeVersions.id, versionNumber: recipeVersions.versionNumber });
    for (const prev of archived) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "RECIPE_VERSION_ARCHIVED",
        entityType: "recipe",
        entityId: recipe.id,
        metadata: {
          versionId: prev.id,
          versionNumber: prev.versionNumber,
          replacedByVersion: version.versionNumber,
        },
      });
    }

    // 8. Activar la nueva versión.
    await mapUniqueViolations(
      tx
        .update(recipeVersions)
        .set({
          status: "ACTIVE",
          publishedAt: now,
          effectiveFrom: now,
          publishedByUserId: ctx.userId,
        })
        .where(ownedVersion(ctx, versionId)),
      {
        recipe_versions_one_active_uq: () =>
          new AppError(409, "CONCURRENT_PUBLISH", "Otra publicación de esta receta está en curso."),
      },
    );

    // 9. Auditar.
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "RECIPE_VERSION_PUBLISHED",
      entityType: "recipe",
      entityId: recipe.id,
      metadata: {
        versionId,
        versionNumber: version.versionNumber,
        archivedVersions: archived.map((a) => a.versionNumber),
        costStatus: wire.status,
        currency,
        totalCost: wire.totalCost,
        unitCost: wire.unitCost,
        perUnit: saleUnit.symbol,
        missingCosts: wire.missingCosts.map((m) => m.rawMaterialName),
      },
    });
    return getVersion(tx, ctx, versionId);
  });
}

/** Retira la versión vigente sin reemplazo (la receta queda sin versión vigente). */
export async function archiveVersion(db: Database, ctx: OperationContext, versionId: string) {
  return db.transaction(async (tx) => {
    const version = await findVersion(tx, ctx, versionId, true);
    if (version.status !== "ACTIVE") {
      throw new AppError(409, "RECIPE_VERSION_NOT_ACTIVE", "Sólo se archiva la versión vigente.");
    }
    await tx
      .update(recipeVersions)
      .set({ status: "ARCHIVED", archivedAt: new Date() })
      .where(ownedVersion(ctx, versionId));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "RECIPE_VERSION_ARCHIVED",
      entityType: "recipe",
      entityId: version.recipeId,
      metadata: { versionId, versionNumber: version.versionNumber, replacedByVersion: null },
    });
    return getVersion(tx, ctx, versionId);
  });
}

/** Descarta un borrador nunca publicado (se borra con sus ingredientes). */
export async function discardVersion(db: Database, ctx: OperationContext, versionId: string) {
  return db.transaction(async (tx) => {
    const version = await findVersion(tx, ctx, versionId, true);
    if (version.status !== "DRAFT") throw immutable(version.status);
    await tx.delete(recipeVersions).where(ownedVersion(ctx, versionId));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "RECIPE_VERSION_DISCARDED",
      entityType: "recipe",
      entityId: version.recipeId,
      metadata: { versionId, versionNumber: version.versionNumber },
    });
    return getRecipe(tx, ctx, version.recipeId);
  });
}

/* ---------- Costos ---------- */

async function loadSnapshot(
  db: Db,
  ctx: OperationContext,
  versionId: string,
): Promise<CostSnapshotDto | null> {
  const [s] = await db
    .select()
    .from(recipeCostSnapshots)
    .where(
      and(
        eq(recipeCostSnapshots.companyId, ctx.companyId),
        eq(recipeCostSnapshots.recipeVersionId, versionId),
      ),
    );
  if (!s) return null;
  const lines = await db
    .select()
    .from(recipeCostSnapshotLines)
    .where(eq(recipeCostSnapshotLines.snapshotId, s.id))
    .orderBy(asc(recipeCostSnapshotLines.sortOrder));
  const margin =
    s.unitCost !== null && s.salePrice !== null
      ? calculateGrossMargin(s.salePrice, s.unitCost)
      : null;
  return {
    id: s.id,
    calculatedAt: s.calculatedAt.toISOString(),
    currency: s.currencyCode,
    status: s.completenessStatus,
    totalCost: s.totalCost,
    yieldQuantity: s.yieldQuantity,
    yieldUnit: { code: s.yieldUnitCode, symbol: s.yieldUnitSymbol },
    normalizedYield: s.normalizedYield,
    saleUnit: { code: s.saleUnitCode, symbol: s.saleUnitSymbol },
    unitCost: s.unitCost,
    salePrice: s.salePrice,
    grossMargin: margin
      ? {
          amount: toFixedString(margin.amount, 6),
          percentage: margin.percentage === null ? null : toFixedString(margin.percentage, 4),
        }
      : null,
    lines: lines.map((l) => ({
      rawMaterialId: l.rawMaterialId,
      rawMaterialCode: l.rawMaterialCode,
      rawMaterialName: l.rawMaterialName,
      quantity: l.quantity,
      unit: { code: l.unitCode, symbol: l.unitSymbol },
      normalizedQuantity: l.normalizedQuantity,
      baseUnit: { code: l.baseUnitCode, symbol: l.baseUnitSymbol },
      referenceCost: l.referenceCost,
      costSource: l.costSource,
      ingredientCost: l.ingredientCost,
    })),
  };
}

/**
 * Costo de una versión: el snapshot de publicación (inmutable) y el costo
 * teórico ACTUAL (misma composición, costos de referencia de hoy), con la
 * variación del costo unitario entre ambos.
 */
export async function getVersionCost(
  db: Db,
  ctx: OperationContext,
  versionId: string,
): Promise<RecipeVersionCostDto> {
  const version = await findVersion(db, ctx, versionId);
  const recipe = await findRecipe(db, ctx, version.recipeId);
  const product = await productOf(db, ctx, recipe);
  let current: TheoreticalCostDto;
  try {
    current = recipeCostToWire(await currentCostOf(db, ctx, version, product));
  } catch (err) {
    if (err instanceof RecipeValidationError) throw invalidRecipe(err.issues);
    throw err;
  }
  const snapshot = await loadSnapshot(db, ctx, versionId);
  const variation =
    snapshot?.unitCost && current.unitCost
      ? calculateCostVariation(snapshot.unitCost, current.unitCost)
      : null;
  return {
    version: { id: version.id, versionNumber: version.versionNumber, status: version.status },
    snapshot,
    current,
    unitCostVariation: variation
      ? {
          amount: toFixedString(variation.amount, 6),
          percentage: variation.percentage === null ? null : toFixedString(variation.percentage, 4),
        }
      : null,
  };
}

/** Costo actual de la versión vigente de una receta. */
export async function getRecipeCurrentCost(db: Db, ctx: OperationContext, recipeId: string) {
  await findRecipe(db, ctx, recipeId);
  const [active] = await db
    .select({ id: recipeVersions.id })
    .from(recipeVersions)
    .where(
      and(
        eq(recipeVersions.companyId, ctx.companyId),
        eq(recipeVersions.recipeId, recipeId),
        eq(recipeVersions.status, "ACTIVE"),
      ),
    );
  if (!active) {
    throw new AppError(404, "NO_ACTIVE_VERSION", "La receta no tiene una versión vigente.");
  }
  return getVersionCost(db, ctx, active.id);
}

/** Versión vigente en un instante (historia: effective_from ≤ at < archived_at). */
export async function getEffectiveVersion(
  db: Db,
  ctx: OperationContext,
  recipeId: string,
  at: Date,
): Promise<RecipeVersionSummaryDto> {
  await findRecipe(db, ctx, recipeId);
  const rows = await selectVersions(db).where(
    and(eq(recipeVersions.companyId, ctx.companyId), eq(recipeVersions.recipeId, recipeId)),
  );
  const found = findEffectiveVersion(
    rows.map((r) => ({
      id: r.v.id,
      effectiveFrom: r.v.effectiveFrom,
      archivedAt: r.v.archivedAt,
      row: r,
    })),
    at,
  );
  if (!found) {
    throw new AppError(404, "NO_EFFECTIVE_VERSION", "No había una versión vigente en ese momento.");
  }
  return toSummary(found.row);
}

/** Diferencias de una versión contra otra (por defecto, la versión anterior). */
export async function getVersionDiff(
  db: Db,
  ctx: OperationContext,
  versionId: string,
  againstId: string | undefined,
): Promise<RecipeVersionDiffDto> {
  const to = await findVersion(db, ctx, versionId);
  let from: VersionRow | undefined;
  if (againstId) {
    from = await findVersion(db, ctx, againstId);
    if (from.recipeId !== to.recipeId) {
      throw invalidReference("against", "La versión no es de esta receta");
    }
  } else {
    [from] = await db
      .select()
      .from(recipeVersions)
      .where(
        and(
          eq(recipeVersions.recipeId, to.recipeId),
          lt(recipeVersions.versionNumber, to.versionNumber),
        ),
      )
      .orderBy(desc(recipeVersions.versionNumber))
      .limit(1);
  }
  const versionIds = from ? [from.id, to.id] : [to.id];
  const units = await loadUnits(db, ctx);
  const ingredients = await loadIngredients(db, ctx, versionIds);
  const materials = await loadRawMaterials(
    db,
    ctx,
    ingredients.map((i) => i.rawMaterialId),
  );
  const forDiff = (v: VersionRow) => ({
    yieldQuantity: v.yieldQuantity,
    yieldUnit: unitOrThrow(units, v.yieldUnitId),
    wastePercentage: v.wastePercentage,
    instructions: v.instructions,
    ingredients: ingredients
      .filter((i) => i.recipeVersionId === v.id)
      .map((i) => {
        const m = materials.get(i.rawMaterialId)!;
        return {
          rawMaterialId: m.id,
          rawMaterialName: m.name,
          quantity: i.quantity,
          unit: unitOrThrow(units, i.unitId),
          baseUnit: unitOrThrow(units, m.baseUnitId),
        };
      }),
  });
  const empty = {
    yieldQuantity: to.yieldQuantity,
    yieldUnit: unitOrThrow(units, to.yieldUnitId),
    wastePercentage: to.wastePercentage,
    instructions: to.instructions,
    ingredients: [],
  };
  const diff = diffRecipeVersions(from ? forDiff(from) : empty, forDiff(to));
  return {
    from: from ? { id: from.id, versionNumber: from.versionNumber } : null,
    to: { id: to.id, versionNumber: to.versionNumber },
    ...diff,
  };
}
