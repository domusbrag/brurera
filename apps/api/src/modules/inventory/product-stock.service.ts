import { D } from "@bakery/domain";
import {
  productInventoryCostHistory,
  productInventoryCosts,
  productLotBalances,
  productionOrders,
  products,
  recipeVersions,
  recipes,
  stockBalances,
  unitsOfMeasure,
  users,
  warehouses,
  type Database,
  type Transaction,
} from "@bakery/database";
import type {
  Page,
  ProductCostDto,
  ProductCostHistoryEntryDto,
  ProductStockDetailDto,
  ProductStockItemDto,
  costHistoryQuerySchema,
  productStockQuerySchema,
} from "@bakery/shared";
import { and, asc, count, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { OperationContext } from "../../lib/context.js";
import { invalidReference, notFound } from "../../lib/db-errors.js";
import { likePattern, pageWindow, toPage } from "../../lib/listing.js";
import { loadProfile } from "../lots/lots.data.js";
import { lotSummaries } from "../lots/lots.service.js";
import { companyCurrency } from "../recipes/recipes.data.js";
import { fixedMoney, fixedQty } from "./ledger.js";
import { qualified } from "../../lib/sql.js";

/*
 * Stock de productos terminados (Fase 4). Entra por una producción completada
 * (PRODUCTION_OUTPUT) y, desde Fase 4.5, vive por lote: cambia de conservación
 * por transformación y sale por merma de lote. La valorización es COSTO
 * MATERIAL (sin mano de obra ni indirectos) y requiere inventory.cost.read.
 */

type Db = Database | Transaction;

const companyQty = sql<string>`coalesce(${productInventoryCosts.quantity}, 0)`;
const costJoin = and(
  eq(productInventoryCosts.companyId, products.companyId),
  eq(productInventoryCosts.productId, products.id),
);

export async function listProductStock(
  db: Database,
  ctx: OperationContext,
  query: z.infer<typeof productStockQuerySchema>,
  canSeeCosts: boolean,
): Promise<Page<ProductStockItemDto>> {
  let warehouse: { id: string; code: string; name: string } | null = null;
  if (query.warehouseId) {
    const [row] = await db
      .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
      .from(warehouses)
      .where(and(eq(warehouses.companyId, ctx.companyId), eq(warehouses.id, query.warehouseId)));
    if (!row) throw invalidReference("warehouseId", "Depósito inexistente");
    warehouse = row;
  }
  const where = and(
    eq(products.companyId, ctx.companyId),
    // Productos con control de stock activos, o cualquiera que todavía tenga existencia.
    or(and(eq(products.controlsStock, true), eq(products.active, true)), sql`${companyQty} > 0`),
    query.search
      ? or(
          ilike(products.name, likePattern(query.search)),
          ilike(products.internalCode, likePattern(query.search)),
        )
      : undefined,
    query.stock === "in_stock"
      ? warehouse
        ? sql`coalesce(${stockBalances.quantity}, 0) > 0`
        : sql`${companyQty} > 0`
      : undefined,
  );
  const balanceJoin = and(
    eq(stockBalances.companyId, products.companyId),
    eq(stockBalances.productId, products.id),
    eq(stockBalances.warehouseId, query.warehouseId ?? sql`null`),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: products.id,
        code: products.internalCode,
        name: products.name,
        active: products.active,
        unit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
        companyQuantity: companyQty,
        warehouseQuantity: sql<string>`coalesce(${stockBalances.quantity}, 0)`,
        averageMaterialCost: productInventoryCosts.averageMaterialCost,
        inventoryValue: sql<string>`coalesce(${productInventoryCosts.inventoryValue}, 0)`,
        // Valor del depósito = Σ valor de sus lotes (identificación específica, ADR-057).
        warehouseValue: sql<string>`(select coalesce(sum(plb.inventory_value), 0) from ${productLotBalances} plb where plb.company_id = ${qualified(products.companyId)} and plb.product_id = ${qualified(products.id)} and plb.warehouse_id = ${query.warehouseId ?? sql`null`})`,
        warehouseCount: sql<number>`(select count(*)::int from ${stockBalances} sb where sb.company_id = ${qualified(products.companyId)} and sb.product_id = ${qualified(products.id)} and sb.quantity > 0)`,
        lastProduction: sql<{
          id: string;
          code: string;
          completedAt: string;
        } | null>`(select json_build_object('id', po.id, 'code', po.internal_code, 'completedAt', po.completed_at) from ${productionOrders} po where po.company_id = ${qualified(products.companyId)} and po.product_id = ${qualified(products.id)} and po.status = 'COMPLETED' order by po.completed_at desc limit 1)`,
      })
      .from(products)
      .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.saleUnitId))
      .leftJoin(productInventoryCosts, costJoin)
      .leftJoin(stockBalances, balanceJoin)
      .where(where)
      .orderBy(asc(products.name), asc(products.internalCode))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: count() })
      .from(products)
      .leftJoin(productInventoryCosts, costJoin)
      .leftJoin(stockBalances, balanceJoin)
      .where(where),
  ]);
  const summaries = await lotSummaries(
    db,
    ctx,
    rows.map((r) => r.id),
    warehouse?.id ?? null,
  );
  const items = rows.map((r): ProductStockItemDto => {
    const quantity = warehouse ? r.warehouseQuantity : r.companyQuantity;
    const value = warehouse ? fixedMoney(r.warehouseValue) : fixedMoney(r.inventoryValue);
    return {
      id: r.id,
      product: { id: r.id, code: r.code, name: r.name, active: r.active },
      saleUnit: r.unit,
      warehouse,
      quantity: fixedQty(quantity),
      companyQuantity: fixedQty(r.companyQuantity),
      warehouseCount: r.warehouseCount,
      lastProduction: r.lastProduction
        ? {
            id: r.lastProduction.id,
            code: r.lastProduction.code,
            completedAt: new Date(r.lastProduction.completedAt).toISOString(),
          }
        : null,
      averageMaterialCost: canSeeCosts ? r.averageMaterialCost : null,
      inventoryValue: canSeeCosts ? value : null,
      lots: summaries.get(r.id)!,
    };
  });
  return toPage(items, total?.n ?? 0, query);
}

async function findProduct(db: Db, ctx: OperationContext, id: string) {
  const [row] = await db
    .select({
      p: products,
      unit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
    })
    .from(products)
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.saleUnitId))
    .where(and(eq(products.companyId, ctx.companyId), eq(products.id, id)));
  if (!row) throw notFound("Producto");
  return row;
}

async function costRow(db: Db, ctx: OperationContext, productId: string) {
  const [row] = await db
    .select()
    .from(productInventoryCosts)
    .where(
      and(
        eq(productInventoryCosts.companyId, ctx.companyId),
        eq(productInventoryCosts.productId, productId),
      ),
    );
  return row ?? null;
}

export async function getProductStock(
  db: Database,
  ctx: OperationContext,
  productId: string,
  canSeeCosts: boolean,
): Promise<ProductStockDetailDto> {
  const { p, unit } = await findProduct(db, ctx, productId);
  const cost = await costRow(db, ctx, productId);
  const currency = await companyCurrency(db, ctx);
  const byWarehouse = await db
    .select({
      warehouse: { id: warehouses.id, code: warehouses.code, name: warehouses.name },
      quantity: stockBalances.quantity,
    })
    .from(stockBalances)
    .innerJoin(warehouses, eq(warehouses.id, stockBalances.warehouseId))
    .where(and(eq(stockBalances.companyId, ctx.companyId), eq(stockBalances.productId, productId)))
    .orderBy(asc(warehouses.name));
  const recent = await db
    .select({
      id: productionOrders.id,
      code: productionOrders.internalCode,
      batchCode: productionOrders.batchCode,
      completedAt: productionOrders.completedAt,
      quantity: productionOrders.actualOutputNormalized,
      unitCost: productionOrders.actualUnitMaterialCost,
    })
    .from(productionOrders)
    .where(
      and(
        eq(productionOrders.companyId, ctx.companyId),
        eq(productionOrders.productId, productId),
        eq(productionOrders.status, "COMPLETED"),
      ),
    )
    .orderBy(desc(productionOrders.completedAt))
    .limit(10);
  const [recipe] = await db
    .select({ id: recipes.id, name: recipes.name })
    .from(recipes)
    .where(
      and(
        eq(recipes.companyId, ctx.companyId),
        eq(recipes.productId, productId),
        eq(recipes.active, true),
      ),
    );
  const [activeVersion] = recipe
    ? await db
        .select({ id: recipeVersions.id, versionNumber: recipeVersions.versionNumber })
        .from(recipeVersions)
        .where(and(eq(recipeVersions.recipeId, recipe.id), eq(recipeVersions.status, "ACTIVE")))
    : [];
  const average = cost?.averageMaterialCost ?? null;
  const summary = (await lotSummaries(db, ctx, [productId], null)).get(productId)!;
  const profile = await loadProfile(db, ctx, productId);
  const margin =
    canSeeCosts && average !== null
      ? (() => {
          const amount = new D(p.salePrice).minus(average);
          return {
            amount: fixedMoney(amount),
            percentage: new D(p.salePrice).isZero()
              ? null
              : amount.dividedBy(p.salePrice).times(100).toFixed(2),
          };
        })()
      : null;
  return {
    product: {
      id: p.id,
      code: p.internalCode,
      name: p.name,
      active: p.active,
      controlsStock: p.controlsStock,
      salePrice: p.salePrice,
    },
    saleUnit: unit,
    currency,
    quantity: fixedQty(cost?.quantity ?? 0),
    byWarehouse: byWarehouse.map((b) => ({
      warehouse: b.warehouse,
      quantity: fixedQty(b.quantity),
    })),
    averageMaterialCost: canSeeCosts ? average : null,
    inventoryValue: canSeeCosts ? fixedMoney(cost?.inventoryValue ?? 0) : null,
    theoreticalMargin: margin,
    recentProductions: recent.map((r) => ({
      id: r.id,
      code: r.code,
      batchCode: r.batchCode,
      completedAt: r.completedAt!.toISOString(),
      quantity: r.quantity!,
      unitCost: canSeeCosts ? r.unitCost : null,
    })),
    activeRecipe: recipe
      ? {
          recipeId: recipe.id,
          name: recipe.name,
          versionId: activeVersion?.id ?? null,
          versionNumber: activeVersion?.versionNumber ?? null,
        }
      : null,
    lots: summary,
    nearExpiryMinutes: profile.nearExpiryMinutes,
    conservationConfigured: profile.configured,
    canSeeCosts,
  };
}

/** Costo promedio material del producto y su historial (inventory.cost.read). */
export async function getProductCost(
  db: Database,
  ctx: OperationContext,
  productId: string,
  query: z.infer<typeof costHistoryQuerySchema>,
): Promise<{ cost: ProductCostDto; history: Page<ProductCostHistoryEntryDto> }> {
  const { p, unit } = await findProduct(db, ctx, productId);
  const cost = await costRow(db, ctx, productId);
  const where = and(
    eq(productInventoryCostHistory.companyId, ctx.companyId),
    eq(productInventoryCostHistory.productId, productId),
  );
  const [rows, [total]] = await Promise.all([
    db
      .select({
        h: productInventoryCostHistory,
        actor: { id: users.id, displayName: users.displayName },
        order: { id: productionOrders.id, code: productionOrders.internalCode },
      })
      .from(productInventoryCostHistory)
      .leftJoin(users, eq(users.id, productInventoryCostHistory.actorUserId))
      .leftJoin(
        productionOrders,
        and(
          isNotNull(productInventoryCostHistory.productionOrderId),
          eq(productionOrders.id, productInventoryCostHistory.productionOrderId),
        ),
      )
      .where(where)
      .orderBy(desc(productInventoryCostHistory.movementSequence))
      .limit(pageWindow(query).limit)
      .offset(pageWindow(query).offset),
    db.select({ n: count() }).from(productInventoryCostHistory).where(where),
  ]);
  return {
    cost: {
      product: { id: p.id, code: p.internalCode, name: p.name },
      saleUnit: unit,
      currency: await companyCurrency(db, ctx),
      quantity: fixedQty(cost?.quantity ?? 0),
      inventoryValue: fixedMoney(cost?.inventoryValue ?? 0),
      averageMaterialCost: cost?.averageMaterialCost ?? null,
      lastUpdatedAt: cost?.lastUpdatedAt?.toISOString() ?? null,
    },
    history: toPage(
      rows.map(({ h, actor, order }): ProductCostHistoryEntryDto => ({
        id: h.id,
        createdAt: h.createdAt.toISOString(),
        movementId: h.movementId,
        productionOrder: order?.id ? { id: order.id, code: order.code } : null,
        quantityBefore: h.quantityBefore,
        quantityAfter: h.quantityAfter,
        valueBefore: h.valueBefore,
        valueAfter: h.valueAfter,
        averageBefore: h.averageBefore,
        averageAfter: h.averageAfter,
        batchQuantity: h.batchQuantity,
        batchUnitCost: h.batchUnitCost,
        batchValue: h.batchValue,
        averageChanged: h.averageBefore !== h.averageAfter,
        actor: actor?.id ? { id: actor.id, displayName: actor.displayName } : null,
      })),
      total?.n ?? 0,
      query,
    ),
  };
}
