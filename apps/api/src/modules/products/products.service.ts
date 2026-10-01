import { areUnitsCompatible } from "@bakery/domain";
import {
  allocateCode,
  categories,
  products,
  recipeVersions,
  recipes,
  unitsOfMeasure,
  type Database,
  type Transaction,
} from "@bakery/database";
import type { ListQuery, Page, ProductDto } from "@bakery/shared";
import { type createProductSchema, type updateProductSchema } from "@bakery/shared";
import { and, asc, count, eq, inArray, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { codeTaken, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { activeCondition, pageWindow, searchCondition, toPage } from "../../lib/listing.js";
import { assertCategory, assertUnit } from "../../lib/references.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";

type CreateInput = z.infer<typeof createProductSchema>;
type UpdateInput = z.infer<typeof updateProductSchema>;

function selectProducts(db: Database | Transaction) {
  return db
    .select({
      p: products,
      category: { id: categories.id, name: categories.name },
      unit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
    })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.saleUnitId));
}

type SelectedRow = Awaited<ReturnType<ReturnType<typeof selectProducts>["execute"]>>[number];

/** Sin costo: el costo teórico de un producto se deriva de su receta (módulo recipes). */
function toDto({ p, category, unit }: SelectedRow): ProductDto {
  return {
    id: p.id,
    code: p.internalCode,
    name: p.name,
    description: p.description,
    category,
    saleUnit: unit,
    salePrice: p.salePrice,
    controlsStock: p.controlsStock,
    imageUrl: p.imageUrl,
    active: p.active,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

const owned = (ctx: OperationContext, id: string): SQL | undefined =>
  and(eq(products.companyId, ctx.companyId), eq(products.id, id));

export async function listProducts(
  db: Database,
  ctx: OperationContext,
  query: ListQuery & { categoryId?: string },
): Promise<Page<ProductDto>> {
  const where = and(
    eq(products.companyId, ctx.companyId),
    query.categoryId ? eq(products.categoryId, query.categoryId) : undefined,
    activeCondition(products.active, query.status),
    searchCondition(query.search, [products.internalCode, products.name]),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    selectProducts(db)
      .where(where)
      .orderBy(asc(products.name), asc(products.internalCode))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(products).where(where),
  ]);
  return toPage(rows.map(toDto), total?.n ?? 0, query);
}

export async function getProduct(db: Database | Transaction, ctx: OperationContext, id: string) {
  const [row] = await selectProducts(db).where(owned(ctx, id));
  if (!row) throw notFound("Producto");
  return toDto(row);
}

async function assertReferences(tx: Transaction, ctx: OperationContext, input: UpdateInput) {
  if (input.categoryId) await assertCategory(tx, ctx, input.categoryId, "PRODUCT");
  if (input.saleUnitId) await assertUnit(tx, ctx, input.saleUnitId, { field: "saleUnitId" });
}

async function isCodeTaken(tx: Transaction, ctx: OperationContext, code: string) {
  const rows = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.companyId, ctx.companyId), eq(products.internalCode, code)))
    .limit(1);
  return rows.length > 0;
}

export async function createProduct(db: Database, ctx: OperationContext, input: CreateInput) {
  return db.transaction(async (tx) => {
    await assertReferences(tx, ctx, input);
    const { code: manualCode, ...fields } = input;
    const code =
      manualCode ??
      (await allocateCode(tx, ctx.companyId, "PRODUCT", (c) => isCodeTaken(tx, ctx, c)));
    const [row] = await mapUniqueViolations(
      tx
        .insert(products)
        .values({ ...fields, companyId: ctx.companyId, internalCode: code })
        .returning(),
      { products_company_code_uq: () => codeTaken(code) },
    );
    if (!row) throw new Error("Alta de producto sin fila");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRODUCT_CREATED",
      entityType: "product",
      entityId: row.id,
      metadata: { code: row.internalCode, name: row.name },
    });
    return getProduct(tx, ctx, row.id);
  });
}

export async function updateProduct(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: UpdateInput,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(products).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Producto");
    // Solo se validan las referencias que cambian: conservar una categoría hoy
    // inactiva no bloquea editar otros datos.
    await assertReferences(tx, ctx, {
      categoryId: input.categoryId !== before.categoryId ? input.categoryId : undefined,
      saleUnitId: input.saleUnitId !== before.saleUnitId ? input.saleUnitId : undefined,
    });
    if (input.saleUnitId && input.saleUnitId !== before.saleUnitId) {
      await assertSaleUnitFitsRecipes(tx, ctx, id, input.saleUnitId);
    }
    const [after] = await tx.update(products).set(input).where(owned(ctx, id)).returning();
    if (!after) throw notFound("Producto");
    const changes = diffChanges(before, after, Object.keys(input));
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "PRODUCT_UPDATED",
        entityType: "product",
        entityId: id,
        metadata: { code: after.internalCode, changes },
      });
    }
    return getProduct(tx, ctx, id);
  });
}

export async function setProductActive(
  db: Database,
  ctx: OperationContext,
  id: string,
  active: boolean,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(products).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Producto");
    if (before.active !== active) {
      await tx.update(products).set({ active }).where(owned(ctx, id));
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: active ? "PRODUCT_REACTIVATED" : "PRODUCT_DEACTIVATED",
        entityType: "product",
        entityId: id,
        metadata: { code: before.internalCode },
      });
    }
    return getProduct(tx, ctx, id);
  });
}

/**
 * La unidad de venta puede cambiar a otra de la misma dimensión (kg → g), pero no
 * a una en la que el rendimiento de una receta vigente o en borrador no se pueda
 * expresar (kg → unidad): el costo por unidad de venta dejaría de tener sentido.
 */
async function assertSaleUnitFitsRecipes(
  tx: Transaction,
  ctx: OperationContext,
  productId: string,
  saleUnitId: string,
) {
  const yieldUnits = await tx
    .select({
      id: unitsOfMeasure.id,
      code: unitsOfMeasure.code,
      dimension: unitsOfMeasure.dimension,
      baseUnitId: unitsOfMeasure.baseUnitId,
      conversionFactor: unitsOfMeasure.conversionFactor,
    })
    .from(recipeVersions)
    .innerJoin(recipes, eq(recipes.id, recipeVersions.recipeId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, recipeVersions.yieldUnitId))
    .where(
      and(
        eq(recipes.companyId, ctx.companyId),
        eq(recipes.productId, productId),
        inArray(recipeVersions.status, ["DRAFT", "ACTIVE"]),
      ),
    );
  if (yieldUnits.length === 0) return;
  const [target] = await tx
    .select({
      id: unitsOfMeasure.id,
      code: unitsOfMeasure.code,
      dimension: unitsOfMeasure.dimension,
      baseUnitId: unitsOfMeasure.baseUnitId,
      conversionFactor: unitsOfMeasure.conversionFactor,
    })
    .from(unitsOfMeasure)
    .where(and(eq(unitsOfMeasure.companyId, ctx.companyId), eq(unitsOfMeasure.id, saleUnitId)));
  if (!target || yieldUnits.some((u) => !areUnitsCompatible(u, target))) {
    throw new AppError(
      409,
      "SALE_UNIT_INCOMPATIBLE_WITH_RECIPE",
      "El producto tiene una receta cuyo rendimiento no se puede expresar en esa unidad. Elegí una unidad de la misma magnitud.",
      [{ path: "saleUnitId", message: "Incompatible con el rendimiento de la receta" }],
    );
  }
}
