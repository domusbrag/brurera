import {
  allocateCode,
  categories,
  companies,
  rawMaterialInventoryCosts,
  rawMaterials,
  recipeIngredients,
  suppliers,
  unitsOfMeasure,
  type Database,
  type Transaction,
} from "@bakery/database";
import { D } from "@bakery/domain";
import type { ListQuery, Page, RawMaterialDto, ReferenceCostInput } from "@bakery/shared";
import { type createRawMaterialSchema, type updateRawMaterialSchema } from "@bakery/shared";
import { and, asc, count, eq, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { codeTaken, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { activeCondition, pageWindow, searchCondition, toPage } from "../../lib/listing.js";
import { assertCategory, assertSupplier, assertUnit } from "../../lib/references.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";
import { withEffectiveCost } from "../recipes/recipes.data.js";

type CreateInput = z.infer<typeof createRawMaterialSchema>;
type UpdateInput = z.infer<typeof updateRawMaterialSchema>;

function selectRawMaterials(db: Database | Transaction) {
  return db
    .select({
      m: rawMaterials,
      category: { id: categories.id, name: categories.name },
      unit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
      supplier: { id: suppliers.id, code: suppliers.internalCode, legalName: suppliers.legalName },
      movingAverageCost: rawMaterialInventoryCosts.movingAverageCost,
    })
    .from(rawMaterials)
    .innerJoin(categories, eq(categories.id, rawMaterials.categoryId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, rawMaterials.baseUnitId))
    .leftJoin(suppliers, eq(suppliers.id, rawMaterials.preferredSupplierId))
    .leftJoin(
      rawMaterialInventoryCosts,
      and(
        eq(rawMaterialInventoryCosts.companyId, rawMaterials.companyId),
        eq(rawMaterialInventoryCosts.rawMaterialId, rawMaterials.id),
      ),
    );
}

type SelectedRow = Awaited<ReturnType<ReturnType<typeof selectRawMaterials>["execute"]>>[number];

function toDto({ m, category, unit, supplier, movingAverageCost }: SelectedRow): RawMaterialDto {
  const effective = withEffectiveCost({
    referenceCost: m.referenceCost,
    referenceCostSource: m.referenceCostSource,
    movingAverageCost,
  });
  return {
    id: m.id,
    code: m.internalCode,
    name: m.name,
    description: m.description,
    category,
    baseUnit: unit,
    minimumStock: m.minimumStock,
    preferredSupplier: supplier,
    referenceCost: m.referenceCost,
    referenceCostSource: m.referenceCostSource,
    referenceCostUpdatedAt: m.referenceCostUpdatedAt?.toISOString() ?? null,
    movingAverageCost,
    effectiveCost: effective.effectiveCost,
    effectiveCostSource: effective.effectiveCostSource,
    active: m.active,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

const owned = (ctx: OperationContext, id: string): SQL | undefined =>
  and(eq(rawMaterials.companyId, ctx.companyId), eq(rawMaterials.id, id));

export async function listRawMaterials(
  db: Database,
  ctx: OperationContext,
  query: ListQuery & { categoryId?: string },
): Promise<Page<RawMaterialDto>> {
  const where = and(
    eq(rawMaterials.companyId, ctx.companyId),
    query.categoryId ? eq(rawMaterials.categoryId, query.categoryId) : undefined,
    activeCondition(rawMaterials.active, query.status),
    searchCondition(query.search, [rawMaterials.internalCode, rawMaterials.name]),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    selectRawMaterials(db)
      .where(where)
      .orderBy(asc(rawMaterials.name), asc(rawMaterials.internalCode))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(rawMaterials).where(where),
  ]);
  return toPage(rows.map(toDto), total?.n ?? 0, query);
}

export async function getRawMaterial(
  db: Database | Transaction,
  ctx: OperationContext,
  id: string,
) {
  const [row] = await selectRawMaterials(db).where(owned(ctx, id));
  if (!row) throw notFound("Materia prima");
  return toDto(row);
}

async function assertReferences(tx: Transaction, ctx: OperationContext, input: UpdateInput) {
  if (input.categoryId) await assertCategory(tx, ctx, input.categoryId, "RAW_MATERIAL");
  if (input.baseUnitId)
    await assertUnit(tx, ctx, input.baseUnitId, { field: "baseUnitId", rootOnly: true });
  if (input.preferredSupplierId) await assertSupplier(tx, ctx, input.preferredSupplierId);
}

async function isCodeTaken(tx: Transaction, ctx: OperationContext, code: string) {
  const rows = await tx
    .select({ id: rawMaterials.id })
    .from(rawMaterials)
    .where(and(eq(rawMaterials.companyId, ctx.companyId), eq(rawMaterials.internalCode, code)))
    .limit(1);
  return rows.length > 0;
}

export async function createRawMaterial(db: Database, ctx: OperationContext, input: CreateInput) {
  return db.transaction(async (tx) => {
    await assertReferences(tx, ctx, input);
    const { code: manualCode, ...fields } = input;
    const code =
      manualCode ??
      (await allocateCode(tx, ctx.companyId, "RAW_MATERIAL", (c) => isCodeTaken(tx, ctx, c)));
    const [row] = await mapUniqueViolations(
      tx
        .insert(rawMaterials)
        .values({
          ...fields,
          companyId: ctx.companyId,
          internalCode: code,
          referenceCostSource: "MANUAL_REFERENCE",
          referenceCostUpdatedAt: fields.referenceCost === null ? null : new Date(),
        })
        .returning(),
      { raw_materials_company_code_uq: () => codeTaken(code) },
    );
    if (!row) throw new Error("Alta de materia prima sin fila");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "RAW_MATERIAL_CREATED",
      entityType: "raw_material",
      entityId: row.id,
      metadata: { code: row.internalCode, name: row.name, referenceCost: row.referenceCost },
    });
    return getRawMaterial(tx, ctx, row.id);
  });
}

export async function updateRawMaterial(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: UpdateInput,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(rawMaterials).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Materia prima");
    if (input.baseUnitId && input.baseUnitId !== before.baseUnitId) {
      await assertNotUsedInRecipes(tx, ctx, id);
    }
    // Solo se validan las referencias que cambian: conservar una categoría hoy
    // inactiva no bloquea editar otros datos.
    await assertReferences(tx, ctx, {
      categoryId: input.categoryId !== before.categoryId ? input.categoryId : undefined,
      baseUnitId: input.baseUnitId !== before.baseUnitId ? input.baseUnitId : undefined,
      preferredSupplierId:
        input.preferredSupplierId !== before.preferredSupplierId
          ? input.preferredSupplierId
          : undefined,
    });
    const [after] = await tx.update(rawMaterials).set(input).where(owned(ctx, id)).returning();
    if (!after) throw notFound("Materia prima");
    const changes = diffChanges(before, after, Object.keys(input));
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "RAW_MATERIAL_UPDATED",
        entityType: "raw_material",
        entityId: id,
        metadata: { code: after.internalCode, changes },
      });
    }
    return getRawMaterial(tx, ctx, id);
  });
}

export async function setRawMaterialActive(
  db: Database,
  ctx: OperationContext,
  id: string,
  active: boolean,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(rawMaterials).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Materia prima");
    if (before.active !== active) {
      await tx.update(rawMaterials).set({ active }).where(owned(ctx, id));
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: active ? "RAW_MATERIAL_REACTIVATED" : "RAW_MATERIAL_DEACTIVATED",
        entityType: "raw_material",
        entityId: id,
        metadata: { code: before.internalCode },
      });
    }
    return getRawMaterial(tx, ctx, id);
  });
}

/**
 * Cambiar la unidad base de una materia prima usada en recetas cambiaría el
 * significado de sus cantidades y de su costo de referencia ($/kg → $/l).
 */
async function assertNotUsedInRecipes(tx: Transaction, ctx: OperationContext, id: string) {
  const [used] = await tx
    .select({ id: recipeIngredients.id })
    .from(recipeIngredients)
    .where(
      and(eq(recipeIngredients.companyId, ctx.companyId), eq(recipeIngredients.rawMaterialId, id)),
    )
    .limit(1);
  if (used) {
    throw new AppError(
      409,
      "RAW_MATERIAL_IN_USE",
      "La materia prima se usa en recetas: no se puede cambiar su unidad base. Creá una materia prima nueva.",
      [{ path: "baseUnitId", message: "En uso en recetas" }],
    );
  }
}

/**
 * Carga o cambia el costo de referencia (dinero por unidad base). No toca
 * recetas ni snapshots: el costo teórico ACTUAL lo refleja al recalcular, los
 * snapshots de publicación conservan el valor con que se calcularon.
 */
export async function setReferenceCost(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: ReferenceCostInput,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(rawMaterials).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Materia prima");
    const unchanged =
      before.referenceCost === null || input.referenceCost === null
        ? before.referenceCost === input.referenceCost
        : new D(before.referenceCost).eq(input.referenceCost);
    if (!unchanged) {
      const [after] = await tx
        .update(rawMaterials)
        .set({
          referenceCost: input.referenceCost,
          referenceCostSource: "MANUAL_REFERENCE",
          referenceCostUpdatedAt: new Date(),
        })
        .where(owned(ctx, id))
        .returning();
      if (!after) throw notFound("Materia prima");
      const [unit] = await tx
        .select({ symbol: unitsOfMeasure.symbol })
        .from(unitsOfMeasure)
        .where(eq(unitsOfMeasure.id, after.baseUnitId));
      const [company] = await tx
        .select({ currency: companies.currencyCode })
        .from(companies)
        .where(eq(companies.id, ctx.companyId));
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "RAW_MATERIAL_REFERENCE_COST_CHANGED",
        entityType: "raw_material",
        entityId: id,
        metadata: {
          code: after.internalCode,
          name: after.name,
          currency: company?.currency ?? null,
          perUnit: unit?.symbol ?? null,
          source: after.referenceCostSource,
          changes: { referenceCost: { from: before.referenceCost, to: after.referenceCost } },
        },
      });
    }
    return getRawMaterial(tx, ctx, id);
  });
}
