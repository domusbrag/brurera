import {
  applyInbound,
  applyOutbound,
  COST_SCALE,
  InventoryError,
  NORMALIZED_QUANTITY_SCALE,
  nextBalance,
  toFixedString,
  type CostedMovement,
  type StockMovementType,
} from "@bakery/domain";
import {
  inventoryCostHistory,
  rawMaterialInventoryCosts,
  stockBalances,
  stockMovements,
  type Transaction,
} from "@bakery/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { AppError } from "../../lib/errors.js";
import { recordAudit } from "../audit/audit.service.js";

/*
 * Núcleo transaccional del inventario. ÚNICA puerta para cambiar existencias:
 * todo cambio de stock (stock inicial, recepción, ajuste, merma) pasa por
 * `postStockMovement`, que dentro de la transacción del llamador:
 *
 *   1. bloquea el costo de la materia prima a nivel empresa y el saldo del depósito;
 *   2. calcula con @bakery/domain (promedio ponderado, stock no negativo);
 *   3. inserta el movimiento (ledger append-only);
 *   4. actualiza el saldo del depósito y el costo de empresa (proyecciones);
 *   5. agrega la fila de historial de costo y, si cambió el promedio, la auditoría.
 *
 * Los triggers de la base rechazan cualquier cambio de saldo o costo que no
 * corresponda exactamente a un movimiento nuevo.
 */

type Num = Parameters<typeof toFixedString>[0];
export const fixedQty = (v: Num) => toFixedString(v, NORMALIZED_QUANTITY_SCALE);
export const fixedMoney = (v: Num) => toFixedString(v, COST_SCALE);

/** Traduce un error de regla de inventario a un error HTTP con código estable. */
export function inventoryError(err: unknown): never {
  if (err instanceof InventoryError) {
    const status = err.code === "INSUFFICIENT_STOCK" ? 409 : 422;
    throw new AppError(status, err.code, err.message);
  }
  throw err;
}

/**
 * Bloquea (creándolas vacías si hace falta) las filas de costo de empresa de
 * varias materias primas, SIEMPRE en orden de id: dos operaciones que tocan las
 * mismas materias primas toman los locks en el mismo orden y no se bloquean
 * mutuamente (sin deadlocks).
 */
export async function lockMaterialCosts(
  tx: Transaction,
  ctx: OperationContext,
  rawMaterialIds: readonly string[],
) {
  const ids = [...new Set(rawMaterialIds)].sort();
  if (ids.length === 0) return new Map<string, typeof rawMaterialInventoryCosts.$inferSelect>();
  await tx
    .insert(rawMaterialInventoryCosts)
    .values(ids.map((rawMaterialId) => ({ companyId: ctx.companyId, rawMaterialId })))
    .onConflictDoNothing();
  const rows = await tx
    .select()
    .from(rawMaterialInventoryCosts)
    .where(
      and(
        eq(rawMaterialInventoryCosts.companyId, ctx.companyId),
        inArray(rawMaterialInventoryCosts.rawMaterialId, ids),
      ),
    )
    .orderBy(rawMaterialInventoryCosts.rawMaterialId)
    .for("update");
  return new Map(rows.map((r) => [r.rawMaterialId, r]));
}

async function lockBalance(
  tx: Transaction,
  ctx: OperationContext,
  warehouseId: string,
  rawMaterialId: string,
  baseUnitId: string,
) {
  await tx
    .insert(stockBalances)
    .values({
      companyId: ctx.companyId,
      warehouseId,
      itemType: "RAW_MATERIAL",
      rawMaterialId,
      baseUnitId,
      quantity: "0",
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.companyId, ctx.companyId),
        eq(stockBalances.warehouseId, warehouseId),
        eq(stockBalances.rawMaterialId, rawMaterialId),
      ),
    )
    .for("update");
  if (!row) throw new Error("Saldo no encontrado tras crearlo");
  return row;
}

export interface StockMovementRequest {
  rawMaterialId: string;
  rawMaterialCode: string;
  rawMaterialName: string;
  warehouseId: string;
  baseUnitId: string;
  movementType: StockMovementType;
  /** Cantidad POSITIVA en unidad base; el signo lo pone el tipo. */
  quantity: string;
  /** Costo por unidad base para ingresos (obligatorio en ingresos, ignorado en salidas). */
  unitCost?: string;
  occurredAt: Date;
  referenceType?: string | null;
  referenceId?: string | null;
  sourceLineId?: string | null;
  reason?: string | null;
  notes?: string | null;
  currency: string;
  baseUnitSymbol: string;
}

export interface PostedMovement {
  movement: typeof stockMovements.$inferSelect;
  costed: CostedMovement;
  warehouseBefore: string;
  warehouseAfter: string;
}

export async function postStockMovement(
  tx: Transaction,
  ctx: OperationContext,
  req: StockMovementRequest,
): Promise<PostedMovement> {
  const costs = await lockMaterialCosts(tx, ctx, [req.rawMaterialId]);
  const cost = costs.get(req.rawMaterialId);
  if (!cost) throw new Error("Costo de inventario no encontrado tras crearlo");
  const balance = await lockBalance(tx, ctx, req.warehouseId, req.rawMaterialId, req.baseUnitId);

  let costed: CostedMovement;
  let warehouseAfter: string;
  try {
    const state = {
      quantity: cost.quantity,
      inventoryValue: cost.inventoryValue,
      movingAverageCost: cost.movingAverageCost,
    };
    const inbound = ["INITIAL_STOCK", "PURCHASE_RECEIPT", "ADJUSTMENT_POSITIVE"].includes(
      req.movementType,
    );
    if (inbound) {
      if (req.unitCost === undefined) throw new Error("Ingreso sin costo de valorización");
      costed = applyInbound(state, req.quantity, req.unitCost);
    } else {
      // Primero el depósito (más restrictivo que el total de la empresa).
      nextBalance(balance.quantity, `-${req.quantity}`);
      costed = applyOutbound(state, req.quantity);
    }
    warehouseAfter = fixedQty(nextBalance(balance.quantity, costed.quantity));
  } catch (err) {
    inventoryError(err);
  }

  const [movement] = await tx
    .insert(stockMovements)
    .values({
      companyId: ctx.companyId,
      warehouseId: req.warehouseId,
      itemType: "RAW_MATERIAL",
      rawMaterialId: req.rawMaterialId,
      movementType: req.movementType,
      quantity: fixedQty(costed.quantity),
      baseUnitId: req.baseUnitId,
      unitCost: fixedMoney(costed.unitCost),
      totalValue: fixedMoney(costed.totalValue),
      balanceAfter: warehouseAfter,
      occurredAt: req.occurredAt,
      referenceType: req.referenceType ?? null,
      referenceId: req.referenceId ?? null,
      sourceLineId: req.sourceLineId ?? null,
      reason: req.reason ?? null,
      actorUserId: ctx.userId,
      notes: req.notes ?? null,
    })
    .returning();
  if (!movement) throw new Error("Movimiento sin fila");

  await tx
    .update(stockBalances)
    .set({ quantity: warehouseAfter, lastMovementId: movement.id })
    .where(eq(stockBalances.id, balance.id));

  const after = costed.after;
  await tx
    .update(rawMaterialInventoryCosts)
    .set({
      quantity: fixedQty(after.quantity),
      inventoryValue: fixedMoney(after.inventoryValue),
      movingAverageCost:
        after.movingAverageCost === null ? null : fixedMoney(after.movingAverageCost),
      lastMovementId: movement.id,
      lastUpdatedAt: sql`now()`,
    })
    .where(
      and(
        eq(rawMaterialInventoryCosts.companyId, ctx.companyId),
        eq(rawMaterialInventoryCosts.rawMaterialId, req.rawMaterialId),
      ),
    );

  const before = costed.before;
  await tx.insert(inventoryCostHistory).values({
    companyId: ctx.companyId,
    rawMaterialId: req.rawMaterialId,
    movementId: movement.id,
    movementSequence: movement.sequence,
    movementType: req.movementType,
    referenceType: req.referenceType ?? null,
    referenceId: req.referenceId ?? null,
    quantityBefore: fixedQty(before.quantity),
    quantityAfter: fixedQty(after.quantity),
    valueBefore: fixedMoney(before.inventoryValue),
    valueAfter: fixedMoney(after.inventoryValue),
    averageBefore: before.movingAverageCost === null ? null : fixedMoney(before.movingAverageCost),
    averageAfter: after.movingAverageCost === null ? null : fixedMoney(after.movingAverageCost),
    actorUserId: ctx.userId,
  });

  if (costed.averageChanged) {
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "MOVING_AVERAGE_COST_CHANGED",
      entityType: "raw_material",
      entityId: req.rawMaterialId,
      metadata: {
        code: req.rawMaterialCode,
        name: req.rawMaterialName,
        currency: req.currency,
        perUnit: req.baseUnitSymbol,
        movementId: movement.id,
        movementType: req.movementType,
        referenceType: req.referenceType ?? null,
        referenceId: req.referenceId ?? null,
        changes: {
          movingAverageCost: {
            from: before.movingAverageCost === null ? null : fixedMoney(before.movingAverageCost),
            to: after.movingAverageCost === null ? null : fixedMoney(after.movingAverageCost),
          },
        },
      },
    });
  }

  return { movement, costed, warehouseBefore: fixedQty(balance.quantity), warehouseAfter };
}
