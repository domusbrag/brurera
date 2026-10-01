import {
  D,
  positiveAdjustmentCost,
  selectEffectiveCost,
  shortage,
  stockStatus,
  type StockMovementType,
} from "@bakery/domain";
import {
  inventoryCostHistory,
  productLots,
  productionOrders,
  products,
  purchaseReceipts,
  purchases,
  rawMaterialInventoryCosts,
  rawMaterials,
  stockBalances,
  stockMovements,
  suppliers,
  unitsOfMeasure,
  users,
  warehouses,
  type Database,
  type Transaction,
} from "@bakery/database";
import type {
  AdjustmentInput,
  CostHistoryEntryDto,
  InitialStockInput,
  InventoryCostDto,
  InventoryDetailDto,
  InventoryItemDto,
  LowStockItemDto,
  Page,
  StockMovementDto,
  StockOperationResultDto,
  WasteInput,
  costHistoryQuerySchema,
  inventoryListQuerySchema,
  lowStockQuerySchema,
  movementListQuerySchema,
} from "@bakery/shared";
import { and, asc, count, desc, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { likePattern, pageWindow, toPage } from "../../lib/listing.js";
import { recordAudit } from "../audit/audit.service.js";
import { companyCurrency } from "../recipes/recipes.data.js";
import {
  fixedMoney,
  fixedQty,
  inventoryError,
  lockMaterialCosts,
  postStockMovement,
} from "./ledger.js";

/*
 * Consultas y operaciones manuales de inventario. Ninguna función escribe un
 * saldo: stock inicial, ajustes y mermas generan un movimiento por el ledger.
 * `canSeeCosts` (permiso inventory.cost.read) decide si se informa la
 * valorización (promedio, valores, historial).
 */

type Db = Database | Transaction;

/* ---------- Listado de stock ---------- */

const companyQty = sql<string>`coalesce(${rawMaterialInventoryCosts.quantity}, 0)`;

function statusCondition(filter: z.infer<typeof inventoryListQuerySchema>["stockStatus"]) {
  // Mismas reglas que stockStatus() de @bakery/domain, expresadas en SQL para filtrar y paginar.
  switch (filter) {
    case "OUT_OF_STOCK":
      return sql`${companyQty} <= 0`;
    case "LOW":
      return sql`${companyQty} > 0 and ${rawMaterials.minimumStock} > 0 and ${companyQty} < ${rawMaterials.minimumStock}`;
    case "OK":
      return sql`${companyQty} > 0 and not (${rawMaterials.minimumStock} > 0 and ${companyQty} < ${rawMaterials.minimumStock})`;
    case "below_minimum":
      return sql`${rawMaterials.minimumStock} > 0 and ${companyQty} < ${rawMaterials.minimumStock}`;
    default:
      return undefined;
  }
}

export async function listInventory(
  db: Database,
  ctx: OperationContext,
  query: z.infer<typeof inventoryListQuerySchema>,
  canSeeCosts: boolean,
): Promise<Page<InventoryItemDto>> {
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
    eq(rawMaterials.companyId, ctx.companyId),
    // Activas, o inactivas que todavía tienen existencia (no se esconde stock).
    or(eq(rawMaterials.active, true), sql`${companyQty} > 0`),
    query.search
      ? or(
          ilike(rawMaterials.name, likePattern(query.search)),
          ilike(rawMaterials.internalCode, likePattern(query.search)),
        )
      : undefined,
    statusCondition(query.stockStatus),
  );
  const balanceJoin = and(
    eq(stockBalances.companyId, rawMaterials.companyId),
    eq(stockBalances.rawMaterialId, rawMaterials.id),
    eq(stockBalances.warehouseId, query.warehouseId ?? sql`null`),
  );
  const { limit, offset } = pageWindow(query);
  const base = () =>
    db
      .select({
        id: rawMaterials.id,
        code: rawMaterials.internalCode,
        name: rawMaterials.name,
        active: rawMaterials.active,
        minimumStock: rawMaterials.minimumStock,
        unit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
        companyQuantity: companyQty,
        warehouseQuantity: sql<string>`coalesce(${stockBalances.quantity}, 0)`,
        movingAverageCost: rawMaterialInventoryCosts.movingAverageCost,
        inventoryValue: sql<string>`coalesce(${rawMaterialInventoryCosts.inventoryValue}, 0)`,
        warehouseCount: sql<number>`(select count(*)::int from ${stockBalances} sb where sb.company_id = ${rawMaterials.companyId} and sb.raw_material_id = ${rawMaterials.id} and sb.quantity > 0)`,
      })
      .from(rawMaterials)
      .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, rawMaterials.baseUnitId))
      .leftJoin(
        rawMaterialInventoryCosts,
        and(
          eq(rawMaterialInventoryCosts.companyId, rawMaterials.companyId),
          eq(rawMaterialInventoryCosts.rawMaterialId, rawMaterials.id),
        ),
      )
      .leftJoin(stockBalances, balanceJoin);
  const [rows, [total]] = await Promise.all([
    base()
      .where(where)
      .orderBy(asc(rawMaterials.name), asc(rawMaterials.internalCode))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: count() })
      .from(rawMaterials)
      .leftJoin(
        rawMaterialInventoryCosts,
        and(
          eq(rawMaterialInventoryCosts.companyId, rawMaterials.companyId),
          eq(rawMaterialInventoryCosts.rawMaterialId, rawMaterials.id),
        ),
      )
      .where(where),
  ]);
  const items = rows.map((r): InventoryItemDto => {
    const quantity = warehouse ? r.warehouseQuantity : r.companyQuantity;
    const value =
      r.movingAverageCost === null
        ? null
        : warehouse
          ? fixedMoney(new D(quantity).times(r.movingAverageCost))
          : fixedMoney(r.inventoryValue);
    return {
      id: r.id,
      rawMaterial: { id: r.id, code: r.code, name: r.name, active: r.active },
      baseUnit: r.unit,
      warehouse,
      quantity: fixedQty(quantity),
      companyQuantity: fixedQty(r.companyQuantity),
      minimumStock: r.minimumStock,
      status: stockStatus(r.companyQuantity, r.minimumStock),
      warehouseCount: r.warehouseCount,
      movingAverageCost: canSeeCosts ? r.movingAverageCost : null,
      inventoryValue: canSeeCosts ? value : null,
    };
  });
  return toPage(items, total?.n ?? 0, query);
}

/* ---------- Detalle por materia prima ---------- */

async function findMaterial(db: Db, ctx: OperationContext, id: string) {
  const [row] = await db
    .select({
      m: rawMaterials,
      unit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
      supplier: { id: suppliers.id, legal: suppliers.legalName, trade: suppliers.tradeName },
    })
    .from(rawMaterials)
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, rawMaterials.baseUnitId))
    .leftJoin(suppliers, eq(suppliers.id, rawMaterials.preferredSupplierId))
    .where(and(eq(rawMaterials.companyId, ctx.companyId), eq(rawMaterials.id, id)));
  if (!row) throw notFound("Materia prima");
  return row;
}

async function costRow(db: Db, ctx: OperationContext, rawMaterialId: string) {
  const [row] = await db
    .select()
    .from(rawMaterialInventoryCosts)
    .where(
      and(
        eq(rawMaterialInventoryCosts.companyId, ctx.companyId),
        eq(rawMaterialInventoryCosts.rawMaterialId, rawMaterialId),
      ),
    );
  return row ?? null;
}

export async function getInventoryDetail(
  db: Db,
  ctx: OperationContext,
  rawMaterialId: string,
  canSeeCosts: boolean,
): Promise<InventoryDetailDto> {
  const { m, unit, supplier } = await findMaterial(db, ctx, rawMaterialId);
  const cost = await costRow(db, ctx, rawMaterialId);
  const balances = await db
    .select({
      id: warehouses.id,
      code: warehouses.code,
      name: warehouses.name,
      quantity: stockBalances.quantity,
    })
    .from(stockBalances)
    .innerJoin(warehouses, eq(warehouses.id, stockBalances.warehouseId))
    .where(
      and(
        eq(stockBalances.companyId, ctx.companyId),
        eq(stockBalances.rawMaterialId, rawMaterialId),
      ),
    )
    .orderBy(asc(warehouses.name));
  const [last] = await db
    .select({
      receiptId: purchaseReceipts.id,
      receiptNumber: purchaseReceipts.internalNumber,
      purchaseId: purchases.id,
      purchaseNumber: purchases.internalNumber,
      supplierLegal: suppliers.legalName,
      supplierTrade: suppliers.tradeName,
      receivedAt: stockMovements.occurredAt,
      unitCost: stockMovements.unitCost,
    })
    .from(stockMovements)
    .innerJoin(purchaseReceipts, eq(purchaseReceipts.id, stockMovements.referenceId))
    .innerJoin(purchases, eq(purchases.id, purchaseReceipts.purchaseId))
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(
      and(
        eq(stockMovements.companyId, ctx.companyId),
        eq(stockMovements.rawMaterialId, rawMaterialId),
        eq(stockMovements.movementType, "PURCHASE_RECEIPT"),
      ),
    )
    .orderBy(desc(stockMovements.sequence))
    .limit(1);
  const quantity = cost?.quantity ?? "0";
  const effective = selectEffectiveCost({
    movingAverageCost: cost?.movingAverageCost ?? null,
    referenceCost: m.referenceCost,
    referenceCostSource: m.referenceCostSource,
  });
  return {
    rawMaterial: {
      id: m.id,
      code: m.internalCode,
      name: m.name,
      active: m.active,
      minimumStock: m.minimumStock,
      preferredSupplier: supplier
        ? { id: supplier.id, name: supplier.trade ?? supplier.legal }
        : null,
    },
    baseUnit: unit,
    currency: await companyCurrency(db, ctx),
    quantity: fixedQty(quantity),
    status: stockStatus(quantity, m.minimumStock),
    shortage: shortage(quantity, m.minimumStock).toFixed(),
    byWarehouse: balances.map((b) => ({
      warehouse: { id: b.id, code: b.code, name: b.name },
      quantity: fixedQty(b.quantity),
    })),
    movingAverageCost: canSeeCosts ? (cost?.movingAverageCost ?? null) : null,
    inventoryValue: canSeeCosts ? fixedMoney(cost?.inventoryValue ?? "0") : null,
    referenceCost: m.referenceCost,
    effectiveCost: effective.cost === null ? null : fixedMoney(effective.cost),
    effectiveCostSource: effective.source,
    lastPurchase: last
      ? {
          receiptId: last.receiptId,
          receiptNumber: last.receiptNumber,
          purchaseId: last.purchaseId,
          purchaseNumber: last.purchaseNumber,
          supplierName: last.supplierTrade ?? last.supplierLegal,
          receivedAt: last.receivedAt.toISOString(),
          unitCost: canSeeCosts ? last.unitCost : null,
        }
      : null,
    canSeeCosts,
  };
}

/* ---------- Movimientos ---------- */

function referenceLabel(
  type: string | null,
  id: string | null,
  receiptNumber: string | null,
  purchaseNumber: string | null,
  productionCode: string | null = null,
  lotCode: string | null = null,
): StockMovementDto["reference"] {
  if (!type || !id) return null;
  if (type === "PRODUCT_LOT_TRANSFORMATION") {
    return { type, id, label: lotCode ? `Transformación → ${lotCode}` : "Transformación de lote" };
  }
  if (type === "PRODUCT_LOT") {
    return { type, id, label: lotCode ? `Lote ${lotCode}` : "Lote" };
  }
  if (type === "PRODUCTION_ORDER") {
    return { type, id, label: productionCode ?? "Orden de producción" };
  }
  if (type === "PURCHASE_RECEIPT") {
    return {
      type,
      id,
      label: receiptNumber
        ? `${receiptNumber}${purchaseNumber ? ` · ${purchaseNumber}` : ""}`
        : "Recepción",
    };
  }
  return { type, id, label: type };
}

export async function selectMovements(
  db: Db,
  ctx: OperationContext,
  where: SQL | undefined,
  canSeeCosts: boolean,
  window: { limit: number; offset: number },
): Promise<StockMovementDto[]> {
  const rows = await db
    .select({
      mv: stockMovements,
      material: { id: rawMaterials.id, code: rawMaterials.internalCode, name: rawMaterials.name },
      product: { id: products.id, code: products.internalCode, name: products.name },
      productionCode: productionOrders.internalCode,
      lot: { id: productLots.id, code: productLots.lotCode },
      // Lote referenciado por una transformación (el hijo) o una merma de lote.
      referenceLotCode: sql<
        string | null
      >`(case when ${stockMovements.referenceType} in ('PRODUCT_LOT_TRANSFORMATION', 'PRODUCT_LOT')
        then (select rl.lot_code from product_lots rl where rl.id = ${stockMovements.referenceId}) end)`,
      warehouse: { id: warehouses.id, code: warehouses.code, name: warehouses.name },
      unit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
      actor: { id: users.id, displayName: users.displayName },
      receiptNumber: purchaseReceipts.internalNumber,
      purchaseNumber: purchases.internalNumber,
      purchaseId: purchases.id,
    })
    .from(stockMovements)
    .leftJoin(rawMaterials, eq(rawMaterials.id, stockMovements.rawMaterialId))
    .leftJoin(products, eq(products.id, stockMovements.productId))
    .leftJoin(productLots, eq(productLots.id, stockMovements.productLotId))
    .innerJoin(warehouses, eq(warehouses.id, stockMovements.warehouseId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, stockMovements.baseUnitId))
    .leftJoin(users, eq(users.id, stockMovements.actorUserId))
    .leftJoin(
      purchaseReceipts,
      and(
        eq(stockMovements.referenceType, "PURCHASE_RECEIPT"),
        eq(purchaseReceipts.id, stockMovements.referenceId),
      ),
    )
    .leftJoin(purchases, eq(purchases.id, purchaseReceipts.purchaseId))
    .leftJoin(
      productionOrders,
      and(
        eq(stockMovements.referenceType, "PRODUCTION_ORDER"),
        eq(productionOrders.id, stockMovements.referenceId),
      ),
    )
    .where(and(eq(stockMovements.companyId, ctx.companyId), where))
    .orderBy(desc(stockMovements.sequence))
    .limit(window.limit)
    .offset(window.offset);
  return rows.map((r) => {
    const reference = referenceLabel(
      r.mv.referenceType,
      r.mv.referenceId,
      r.receiptNumber,
      r.purchaseNumber,
      r.productionCode,
      r.referenceLotCode,
    );
    const rawMaterial = r.material?.id ? r.material : null;
    const product = r.product?.id ? r.product : null;
    return {
      id: r.mv.id,
      sequence: r.mv.sequence,
      occurredAt: r.mv.occurredAt.toISOString(),
      createdAt: r.mv.createdAt.toISOString(),
      movementType: r.mv.movementType,
      itemType: r.mv.itemType,
      item: (rawMaterial ?? product)!,
      rawMaterial,
      product,
      warehouse: r.warehouse,
      quantity: r.mv.quantity,
      baseUnit: r.unit,
      balanceAfter: r.mv.balanceAfter,
      productLot: r.lot?.id ? { id: r.lot.id, code: r.lot.code } : null,
      unitCost: canSeeCosts ? r.mv.unitCost : null,
      totalValue: canSeeCosts ? r.mv.totalValue : null,
      reason: r.mv.reason,
      notes: r.mv.notes,
      // Para recepciones, el vínculo útil es la compra (allí se ven sus recepciones).
      reference:
        reference && r.purchaseId
          ? { ...reference, id: r.purchaseId, type: "PURCHASE" }
          : reference,
      actor: r.actor?.id ? { id: r.actor.id, displayName: r.actor.displayName } : null,
    };
  });
}

export async function listMovements(
  db: Database,
  ctx: OperationContext,
  query: z.infer<typeof movementListQuerySchema>,
  canSeeCosts: boolean,
): Promise<Page<StockMovementDto>> {
  const where = and(
    query.rawMaterialId ? eq(stockMovements.rawMaterialId, query.rawMaterialId) : undefined,
    query.productId ? eq(stockMovements.productId, query.productId) : undefined,
    query.itemType ? eq(stockMovements.itemType, query.itemType) : undefined,
    query.warehouseId ? eq(stockMovements.warehouseId, query.warehouseId) : undefined,
    query.movementType ? eq(stockMovements.movementType, query.movementType) : undefined,
    query.referenceId ? eq(stockMovements.referenceId, query.referenceId) : undefined,
    query.from ? gte(stockMovements.occurredAt, new Date(`${query.from}T00:00:00Z`)) : undefined,
    query.to
      ? lt(stockMovements.occurredAt, new Date(Date.parse(`${query.to}T00:00:00Z`) + 86_400_000))
      : undefined,
    query.search
      ? or(
          ilike(rawMaterials.name, likePattern(query.search)),
          ilike(rawMaterials.internalCode, likePattern(query.search)),
          ilike(products.name, likePattern(query.search)),
          ilike(products.internalCode, likePattern(query.search)),
        )
      : undefined,
  );
  const [items, [total]] = await Promise.all([
    selectMovements(db, ctx, where, canSeeCosts, pageWindow(query)),
    db
      .select({ n: count() })
      .from(stockMovements)
      .leftJoin(rawMaterials, eq(rawMaterials.id, stockMovements.rawMaterialId))
      .leftJoin(products, eq(products.id, stockMovements.productId))
      .where(and(eq(stockMovements.companyId, ctx.companyId), where)),
  ]);
  return toPage(items, total?.n ?? 0, query);
}

/* ---------- Stock bajo mínimo ---------- */

export async function listLowStock(
  db: Database,
  ctx: OperationContext,
  query: z.infer<typeof lowStockQuerySchema>,
): Promise<Page<LowStockItemDto>> {
  const where = and(
    eq(rawMaterials.companyId, ctx.companyId),
    eq(rawMaterials.active, true),
    statusCondition("below_minimum"),
    query.search
      ? or(
          ilike(rawMaterials.name, likePattern(query.search)),
          ilike(rawMaterials.internalCode, likePattern(query.search)),
        )
      : undefined,
  );
  const join = and(
    eq(rawMaterialInventoryCosts.companyId, rawMaterials.companyId),
    eq(rawMaterialInventoryCosts.rawMaterialId, rawMaterials.id),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: rawMaterials.id,
        code: rawMaterials.internalCode,
        name: rawMaterials.name,
        minimumStock: rawMaterials.minimumStock,
        quantity: companyQty,
        unit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
        supplier: { id: suppliers.id, legal: suppliers.legalName, trade: suppliers.tradeName },
      })
      .from(rawMaterials)
      .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, rawMaterials.baseUnitId))
      .leftJoin(rawMaterialInventoryCosts, join)
      .leftJoin(suppliers, eq(suppliers.id, rawMaterials.preferredSupplierId))
      .where(where)
      .orderBy(sql`${companyQty} / ${rawMaterials.minimumStock}`, asc(rawMaterials.name))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: count() })
      .from(rawMaterials)
      .leftJoin(rawMaterialInventoryCosts, join)
      .where(where),
  ]);
  return toPage(
    rows.map((r) => ({
      id: r.id,
      rawMaterial: { id: r.id, code: r.code, name: r.name },
      baseUnit: r.unit,
      quantity: fixedQty(r.quantity),
      minimumStock: r.minimumStock,
      shortage: shortage(r.quantity, r.minimumStock).toFixed(),
      status: stockStatus(r.quantity, r.minimumStock),
      preferredSupplier: r.supplier?.id
        ? { id: r.supplier.id, name: r.supplier.trade ?? r.supplier.legal }
        : null,
    })),
    total?.n ?? 0,
    query,
  );
}

/* ---------- Costo e historial ---------- */

export async function getInventoryCost(
  db: Database,
  ctx: OperationContext,
  rawMaterialId: string,
  query: z.infer<typeof costHistoryQuerySchema>,
): Promise<{ cost: InventoryCostDto; history: Page<CostHistoryEntryDto> }> {
  const { m, unit } = await findMaterial(db, ctx, rawMaterialId);
  const cost = await costRow(db, ctx, rawMaterialId);
  const effective = selectEffectiveCost({
    movingAverageCost: cost?.movingAverageCost ?? null,
    referenceCost: m.referenceCost,
    referenceCostSource: m.referenceCostSource,
  });
  const where = and(
    eq(inventoryCostHistory.companyId, ctx.companyId),
    eq(inventoryCostHistory.rawMaterialId, rawMaterialId),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        h: inventoryCostHistory,
        actor: { id: users.id, displayName: users.displayName },
        receiptNumber: purchaseReceipts.internalNumber,
        purchaseNumber: purchases.internalNumber,
        purchaseId: purchases.id,
      })
      .from(inventoryCostHistory)
      .leftJoin(users, eq(users.id, inventoryCostHistory.actorUserId))
      .leftJoin(
        purchaseReceipts,
        and(
          eq(inventoryCostHistory.referenceType, "PURCHASE_RECEIPT"),
          eq(purchaseReceipts.id, inventoryCostHistory.referenceId),
        ),
      )
      .leftJoin(purchases, eq(purchases.id, purchaseReceipts.purchaseId))
      .where(where)
      .orderBy(desc(inventoryCostHistory.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(inventoryCostHistory).where(where),
  ]);
  return {
    cost: {
      rawMaterial: { id: m.id, code: m.internalCode, name: m.name },
      baseUnit: unit,
      currency: await companyCurrency(db, ctx),
      quantity: fixedQty(cost?.quantity ?? "0"),
      inventoryValue: fixedMoney(cost?.inventoryValue ?? "0"),
      movingAverageCost: cost?.movingAverageCost ?? null,
      lastUpdatedAt: cost?.lastUpdatedAt?.toISOString() ?? null,
      referenceCost: m.referenceCost,
      effectiveCost: effective.cost === null ? null : fixedMoney(effective.cost),
      effectiveCostSource: effective.source,
    },
    history: toPage(
      rows.map(({ h, actor, receiptNumber, purchaseNumber, purchaseId }) => {
        const reference = referenceLabel(
          h.referenceType,
          h.referenceId,
          receiptNumber,
          purchaseNumber,
        );
        return {
          id: h.id,
          createdAt: h.createdAt.toISOString(),
          movementId: h.movementId,
          movementType: h.movementType,
          reference:
            reference && purchaseId
              ? { ...reference, id: purchaseId, type: "PURCHASE" }
              : reference,
          quantityBefore: h.quantityBefore,
          quantityAfter: h.quantityAfter,
          valueBefore: h.valueBefore,
          valueAfter: h.valueAfter,
          averageBefore: h.averageBefore,
          averageAfter: h.averageAfter,
          averageChanged: h.averageBefore !== h.averageAfter,
          actor: actor?.id ? { id: actor.id, displayName: actor.displayName } : null,
        };
      }),
      total?.n ?? 0,
      query,
    ),
  };
}

/* ---------- Operaciones manuales ---------- */

async function operationTargets(
  tx: Transaction,
  ctx: OperationContext,
  rawMaterialId: string,
  warehouseId: string,
) {
  const [material] = await tx
    .select({
      id: rawMaterials.id,
      code: rawMaterials.internalCode,
      name: rawMaterials.name,
      active: rawMaterials.active,
      baseUnitId: rawMaterials.baseUnitId,
      unitSymbol: unitsOfMeasure.symbol,
    })
    .from(rawMaterials)
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, rawMaterials.baseUnitId))
    .where(and(eq(rawMaterials.companyId, ctx.companyId), eq(rawMaterials.id, rawMaterialId)));
  if (!material) throw invalidReference("rawMaterialId", "Materia prima inexistente");
  const [warehouse] = await tx
    .select({ id: warehouses.id, name: warehouses.name, active: warehouses.active })
    .from(warehouses)
    .where(and(eq(warehouses.companyId, ctx.companyId), eq(warehouses.id, warehouseId)));
  if (!warehouse || !warehouse.active) {
    throw invalidReference("warehouseId", "Depósito inexistente o inactivo");
  }
  return { material, warehouse };
}

interface ManualOperation {
  type: Exclude<
    StockMovementType,
    | "PRODUCTION_CONSUMPTION"
    | "PRODUCTION_OUTPUT"
    | "LOT_TRANSFORMATION_OUT"
    | "LOT_TRANSFORMATION_IN"
  >;
  rawMaterialId: string;
  warehouseId: string;
  quantity: string;
  unitCost: string | null;
  occurredAt: string | null;
  reason: string | null;
  notes: string | null;
}

const AUDIT_ACTION = {
  INITIAL_STOCK: "INITIAL_STOCK_POSTED",
  ADJUSTMENT_POSITIVE: "INVENTORY_ADJUSTED",
  ADJUSTMENT_NEGATIVE: "INVENTORY_ADJUSTED",
  WASTE: "INVENTORY_WASTE_RECORDED",
} as const;

async function postManualOperation(
  db: Database,
  ctx: OperationContext,
  op: ManualOperation,
  canSeeCosts: boolean,
): Promise<StockOperationResultDto> {
  if (op.type === "PURCHASE_RECEIPT") throw new Error("Las recepciones se confirman desde compras");
  const auditAction = AUDIT_ACTION[op.type];
  return db.transaction(async (tx) => {
    const { material, warehouse } = await operationTargets(
      tx,
      ctx,
      op.rawMaterialId,
      op.warehouseId,
    );
    const inbound = op.type === "INITIAL_STOCK" || op.type === "ADJUSTMENT_POSITIVE";
    if (inbound && !material.active) {
      throw new AppError(409, "RAW_MATERIAL_INACTIVE", "La materia prima está desactivada.");
    }
    // Lock del costo de empresa ANTES de leer: decide el costo sobre el estado vigente.
    const costs = await lockMaterialCosts(tx, ctx, [material.id]);
    const cost = costs.get(material.id)!;
    if (op.type === "INITIAL_STOCK") {
      const [previous] = await tx
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.companyId, ctx.companyId),
            eq(stockMovements.rawMaterialId, material.id),
            eq(stockMovements.warehouseId, warehouse.id),
          ),
        )
        .limit(1);
      if (previous) {
        throw new AppError(
          409,
          "INITIAL_STOCK_ALREADY_LOADED",
          `${material.name} ya tiene movimientos en ${warehouse.name}: el stock inicial se carga una sola vez. Usá un ajuste.`,
        );
      }
    }
    let unitCost: string | undefined;
    if (inbound) {
      try {
        unitCost = positiveAdjustmentCost(
          op.type as "INITIAL_STOCK" | "ADJUSTMENT_POSITIVE",
          op.unitCost,
          cost.movingAverageCost,
        ).toFixed();
      } catch (err) {
        inventoryError(err);
      }
    }
    const currency = await companyCurrency(tx, ctx);
    const posted = await postStockMovement(tx, ctx, {
      rawMaterialId: material.id,
      rawMaterialCode: material.code,
      rawMaterialName: material.name,
      warehouseId: warehouse.id,
      baseUnitId: material.baseUnitId,
      baseUnitSymbol: material.unitSymbol,
      movementType: op.type,
      quantity: op.quantity,
      unitCost,
      occurredAt: op.occurredAt ? new Date(op.occurredAt) : new Date(),
      referenceType: null,
      referenceId: null,
      reason: op.reason,
      notes: op.notes,
      currency,
    });
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: auditAction,
      entityType: "raw_material",
      entityId: material.id,
      metadata: {
        code: material.code,
        name: material.name,
        movementId: posted.movement.id,
        movementType: op.type,
        warehouse: warehouse.name,
        quantity: posted.movement.quantity,
        unit: material.unitSymbol,
        before: posted.warehouseBefore,
        after: posted.warehouseAfter,
        reason: op.reason,
        currency,
        unitCost: posted.movement.unitCost,
        totalValue: posted.movement.totalValue,
      },
    });
    const [movement] = await selectMovements(
      tx,
      ctx,
      eq(stockMovements.id, posted.movement.id),
      canSeeCosts,
      { limit: 1, offset: 0 },
    );
    return {
      movement: movement!,
      warehouseQuantityBefore: posted.warehouseBefore,
      warehouseQuantityAfter: posted.warehouseAfter,
      companyQuantityAfter: fixedQty(posted.costed.after.quantity),
    };
  });
}

export const postInitialStock = (
  db: Database,
  ctx: OperationContext,
  input: InitialStockInput,
  canSeeCosts: boolean,
) =>
  postManualOperation(
    db,
    ctx,
    {
      type: "INITIAL_STOCK",
      rawMaterialId: input.rawMaterialId,
      warehouseId: input.warehouseId,
      quantity: input.quantity,
      unitCost: input.unitCost,
      occurredAt: input.occurredAt,
      reason: null,
      notes: input.notes,
    },
    canSeeCosts,
  );

export const postAdjustment = (
  db: Database,
  ctx: OperationContext,
  input: AdjustmentInput,
  canSeeCosts: boolean,
) =>
  postManualOperation(
    db,
    ctx,
    {
      type: input.direction === "POSITIVE" ? "ADJUSTMENT_POSITIVE" : "ADJUSTMENT_NEGATIVE",
      rawMaterialId: input.rawMaterialId,
      warehouseId: input.warehouseId,
      quantity: input.quantity,
      unitCost: input.unitCost,
      occurredAt: input.occurredAt,
      reason: input.reason,
      notes: input.notes,
    },
    canSeeCosts,
  );

export const postWaste = (
  db: Database,
  ctx: OperationContext,
  input: WasteInput,
  canSeeCosts: boolean,
) =>
  postManualOperation(
    db,
    ctx,
    {
      type: "WASTE",
      rawMaterialId: input.rawMaterialId,
      warehouseId: input.warehouseId,
      quantity: input.quantity,
      unitCost: null,
      occurredAt: input.occurredAt,
      reason: input.reason,
      notes: input.notes,
    },
    canSeeCosts,
  );
