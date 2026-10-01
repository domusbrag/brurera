import {
  CONSERVATION_LABELS,
  CONSERVATION_TRANSITIONS,
  D,
  LotError,
  calculateAvailabilityAt,
  calculateUsableUntil,
  childLotCode,
  lotEligibilityAt,
  lotOutflow,
  resolveInitialConservation,
  resolveTransformation,
  type ConservationState,
} from "@bakery/domain";
import {
  auditLogs,
  productLotBalances,
  productLots,
  products,
  stockMovements,
  unitsOfMeasure,
  users,
  warehouses,
  type Database,
  type Transaction,
} from "@bakery/database";
import {
  PRODUCT_WASTE_REASON_LABELS,
  type BlockLotInput,
  type ExpiringLotDto,
  type LotOperationResultDto,
  type LotWasteInput,
  type Page,
  type ProductAvailabilityDto,
  type ProductLotDetailDto,
  type ProductLotDto,
  type ProductLotSummaryDto,
  type TransformLotInput,
  type expiringQuerySchema,
  type productLotsQuerySchema,
} from "@bakery/shared";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { likePattern, pageWindow, toPage } from "../../lib/listing.js";
import { recordAudit } from "../audit/audit.service.js";
import { selectMovements } from "../inventory/inventory.service.js";
import { fixedMoney, fixedQty, lockLotBalance, postLotMovement } from "../inventory/ledger.js";
import {
  DEFAULT_NEAR_EXPIRY_MINUTES,
  findLotRow,
  forAvailability,
  loadProfile,
  loadProfiles,
  selectLots,
  toLotDto,
  toLotDtos,
  type Db,
  type LotRow,
} from "./lots.data.js";

/*
 * Lotes de producto terminado (Fase 4.5, ADR-043 a 046).
 *
 * - El lote raíz nace al completar una orden de producción (misma transacción).
 * - Congelar / descongelar = transformación explícita: crea un lote hijo, saca
 *   del padre (LOT_TRANSFORMATION_OUT) y entra al hijo (LOT_TRANSFORMATION_IN)
 *   con el mismo valor. Stock, valor y promedio del producto: sin cambio neto.
 * - Merma: sobre un lote, valorizada al costo del lote; no cambia el promedio.
 * - Orden de locks: lote (product_lots FOR UPDATE) → saldo del lote → costo del
 *   producto → saldo agregado del depósito → saldo del lote hijo.
 * - Idempotencia: `operationId` del cliente (lote hijo / línea de origen del
 *   movimiento); un reintento devuelve el resultado ya aplicado.
 */

/* ---------- Errores ---------- */

function lotError(err: unknown): never {
  if (err instanceof LotError) {
    const status =
      err.code === "QUANTITY_NOT_POSITIVE" || err.code === "INVALID_SHELF_LIFE" ? 422 : 409;
    throw new AppError(status, err.code, err.message);
  }
  throw err;
}

const operationReused = () =>
  new AppError(
    409,
    "OPERATION_ID_REUSED",
    "Ese identificador de operación ya se usó para otra operación.",
  );

const lotCodeTaken = () =>
  new AppError(409, "BATCH_CODE_TAKEN", "Ese código de lote ya está en uso.", [
    { path: "batchCode", message: "Código de lote en uso" },
  ]);

function assertOperable(row: LotRow, now: Date, action: "transform" | "waste") {
  const eligibility = lotEligibilityAt(forAvailability(row), now);
  if (eligibility.reason === "DEPLETED") {
    throw new AppError(409, "LOT_DEPLETED", `El lote ${row.lot.lotCode} está agotado.`);
  }
  if (action === "waste") return;
  if (eligibility.reason === "BLOCKED") {
    throw new AppError(
      409,
      "LOT_BLOCKED",
      `El lote ${row.lot.lotCode} está bloqueado por calidad: desbloquealo antes de transformarlo.`,
    );
  }
  if (eligibility.reason === "EXPIRED") {
    throw new AppError(
      409,
      "LOT_EXPIRED",
      `El lote ${row.lot.lotCode} ya no es utilizable: no se puede transformar. Registrá la merma si corresponde.`,
    );
  }
}

/** Bloquea la fila del lote (serializa operaciones sobre el mismo lote). */
async function lockLot(tx: Transaction, ctx: OperationContext, lotId: string) {
  const [row] = await tx
    .select({ id: productLots.id })
    .from(productLots)
    .where(and(eq(productLots.companyId, ctx.companyId), eq(productLots.id, lotId)))
    .for("update");
  if (!row) throw notFound("Lote");
  return findLotRow(tx, ctx, lotId);
}

async function productUnit(db: Db, ctx: OperationContext, productId: string) {
  const [row] = await db
    .select({
      p: products,
      unit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
    })
    .from(products)
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.saleUnitId))
    .where(and(eq(products.companyId, ctx.companyId), eq(products.id, productId)));
  if (!row) throw notFound("Producto");
  return row;
}

/* ---------- Producción → lote ---------- */

/**
 * Crea el lote raíz de una orden que se está completando (dentro de su
 * transacción). Código = batch_code de la orden; estado inicial elegido o el
 * del perfil; vida útil según el perfil (null si no está configurada).
 */
export async function createProductionLot(
  tx: Transaction,
  ctx: OperationContext,
  args: {
    order: { id: string; internalCode: string };
    productId: string;
    warehouseId: string;
    saleUnitId: string;
    lotCode: string;
    quantity: string;
    unitCost: string;
    totalValue: string;
    requestedState?: ConservationState | null;
    producedAt: Date;
  },
) {
  const profile = await loadProfile(tx, ctx, args.productId);
  let initial: ReturnType<typeof resolveInitialConservation>;
  try {
    initial = resolveInitialConservation({
      profile: profile.entries,
      defaultInitialState: profile.configured ? profile.defaultInitialState : null,
      requested: args.requestedState ?? null,
    });
  } catch (err) {
    lotError(err);
  }
  const usableUntil =
    initial.shelfLifeMinutes === null
      ? null
      : calculateUsableUntil(args.producedAt, initial.shelfLifeMinutes);
  const [lot] = await mapUniqueViolations(
    tx
      .insert(productLots)
      .values({
        companyId: ctx.companyId,
        productId: args.productId,
        productionOrderId: args.order.id,
        lotCode: args.lotCode,
        warehouseId: args.warehouseId,
        conservationState: initial.state,
        producedAt: args.producedAt,
        stateChangedAt: args.producedAt,
        usableUntil,
        shelfLifeMinutes: usableUntil === null ? null : initial.shelfLifeMinutes,
        initialQuantity: fixedQty(args.quantity),
        unitId: args.saleUnitId,
        unitMaterialCost: args.unitCost,
        initialValue: args.totalValue,
        createdByUserId: ctx.userId,
      })
      .returning(),
    { product_lots_company_code_uq: lotCodeTaken },
  );
  if (!lot) throw new Error("Lote sin fila");
  await recordAudit(tx, {
    ...auditBase(ctx),
    action: "PRODUCT_LOT_CREATED",
    entityType: "product_lot",
    entityId: lot.id,
    metadata: {
      code: lot.lotCode,
      productId: args.productId,
      origin: "PRODUCTION",
      productionOrderId: args.order.id,
      productionOrder: args.order.internalCode,
      conservationState: lot.conservationState,
      quantity: lot.initialQuantity,
      usableUntil: lot.usableUntil?.toISOString() ?? null,
      shelfLifeConfigured: lot.usableUntil !== null,
    },
  });
  return lot;
}

/* ---------- Consultas ---------- */

export async function listProductLots(
  db: Database,
  ctx: OperationContext,
  productId: string,
  query: z.infer<typeof productLotsQuerySchema>,
  canSeeCosts: boolean,
): Promise<Page<ProductLotDto>> {
  await productUnit(db, ctx, productId);
  const where = and(
    eq(productLots.productId, productId),
    query.warehouseId ? eq(productLots.warehouseId, query.warehouseId) : undefined,
    query.scope === "active" ? gt(productLotBalances.quantity, "0") : undefined,
  );
  const { limit, offset } = pageWindow(query);
  const rows = await selectLots(db, ctx, where)
    // FEFO: primero lo que vence antes; sin vencimiento al final; agotados al final.
    .orderBy(
      sql`coalesce(${productLotBalances.quantity}, 0) = 0`,
      sql`${productLots.usableUntil} asc nulls last`,
      asc(productLots.producedAt),
      asc(productLots.lotCode),
    )
    .limit(limit)
    .offset(offset);
  const [total] = await db
    .select({ n: count() })
    .from(productLots)
    .leftJoin(productLotBalances, eq(productLotBalances.productLotId, productLots.id))
    .where(and(eq(productLots.companyId, ctx.companyId), where));
  return toPage(await toLotDtos(db, ctx, rows, canSeeCosts), total?.n ?? 0, query);
}

export async function getLot(
  db: Database,
  ctx: OperationContext,
  lotId: string,
  canSeeCosts: boolean,
): Promise<ProductLotDetailDto> {
  const row = await findLotRow(db, ctx, lotId);
  const now = new Date();
  const profile = await loadProfile(db, ctx, row.lot.productId);
  const children = await selectLots(db, ctx, eq(productLots.parentLotId, lotId)).orderBy(
    asc(productLots.createdAt),
    asc(productLots.lotCode),
  );
  const movements = await selectMovements(
    db,
    ctx,
    eq(stockMovements.productLotId, lotId),
    canSeeCosts,
    { limit: 200, offset: 0 },
  );
  const audit = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      metadata: auditLogs.metadata,
      requestId: auditLogs.requestId,
      createdAt: auditLogs.createdAt,
      actor: { id: users.id, displayName: users.displayName },
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, "product_lot"),
        eq(auditLogs.entityId, lotId),
      ),
    )
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(100);
  const [creator] = row.lot.createdByUserId
    ? await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, row.lot.createdByUserId))
    : [];
  const base = toLotDto(row, { now, canSeeCosts, profile });
  const operable = lotEligibilityAt(forAvailability(row), now);
  return {
    ...base,
    initialValue: canSeeCosts ? row.lot.initialValue : null,
    notes: row.lot.notes,
    createdBy: creator ?? null,
    children: children.map((c) => ({
      id: c.lot.id,
      code: c.lot.lotCode,
      conservationState: c.lot.conservationState,
      initialQuantity: fixedQty(c.lot.initialQuantity),
      quantity: fixedQty(c.quantity),
      createdAt: c.lot.createdAt.toISOString(),
    })),
    transformOptions: (["FROZEN", "THAWED"] as const)
      .filter((to) => to !== row.lot.conservationState)
      .map((to) => {
        const entry = profile.entries.find((e) => e.state === to)!;
        const transitionOk = CONSERVATION_TRANSITIONS[row.lot.conservationState].includes(to);
        const reason = !transitionOk
          ? row.lot.conservationState === "THAWED" && to === "FROZEN"
            ? "Un lote descongelado no puede volver a congelarse."
            : `Un lote ${CONSERVATION_LABELS[row.lot.conservationState].toLowerCase()} no se puede ${to === "FROZEN" ? "congelar" : "descongelar"}.`
          : !entry.enabled
            ? `${row.product.name} no tiene habilitado el estado ${CONSERVATION_LABELS[to].toLowerCase()}.`
            : !operable.eligible
              ? `El lote está ${operable.reason === "DEPLETED" ? "agotado" : operable.reason === "BLOCKED" ? "bloqueado" : "vencido"}.`
              : null;
        return {
          targetState: to,
          allowed: reason === null,
          reason,
          shelfLifeMinutes: entry.enabled ? entry.shelfLifeMinutes : null,
        };
      }),
    movements,
    audit: audit.map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      actor: a.actor?.id ? { id: a.actor.id, displayName: a.actor.displayName } : null,
      metadata: a.metadata,
      requestId: a.requestId,
      createdAt: a.createdAt.toISOString(),
    })),
    canSeeCosts,
  };
}

/* ---------- Transformación (congelar / descongelar) ---------- */

async function operationResult(
  db: Db,
  ctx: OperationContext,
  lotId: string,
  childId: string | null,
  sourceLineIds: string[],
  canSeeCosts: boolean,
  replayed: boolean,
): Promise<LotOperationResultDto> {
  const rows = await selectLots(
    db,
    ctx,
    inArray(productLots.id, childId ? [lotId, childId] : [lotId]),
  );
  const dtos = await toLotDtos(db, ctx, rows, canSeeCosts);
  const movements = await selectMovements(
    db,
    ctx,
    inArray(stockMovements.sourceLineId, sourceLineIds),
    canSeeCosts,
    { limit: 10, offset: 0 },
  );
  return {
    lot: dtos.find((d) => d.id === lotId)!,
    childLot: childId ? dtos.find((d) => d.id === childId)! : null,
    movements: movements.sort((a, b) => a.sequence - b.sequence),
    replayed,
  };
}

async function findTransformation(tx: Db, ctx: OperationContext, operationId: string) {
  const [child] = await tx
    .select({ id: productLots.id, parentLotId: productLots.parentLotId })
    .from(productLots)
    .where(and(eq(productLots.companyId, ctx.companyId), eq(productLots.operationId, operationId)));
  return child ?? null;
}

async function findOperationMovement(tx: Db, ctx: OperationContext, operationId: string) {
  const [mv] = await tx
    .select({
      id: stockMovements.id,
      productLotId: stockMovements.productLotId,
      movementType: stockMovements.movementType,
    })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.companyId, ctx.companyId),
        eq(stockMovements.sourceLineId, operationId),
      ),
    );
  return mv ?? null;
}

export async function transformLot(
  db: Database,
  ctx: OperationContext,
  lotId: string,
  input: TransformLotInput,
  canSeeCosts: boolean,
): Promise<LotOperationResultDto> {
  return db.transaction(async (tx) => {
    const replay = async () => {
      const child = await findTransformation(tx, ctx, input.operationId);
      if (child) {
        if (child.parentLotId !== lotId) throw operationReused();
        return operationResult(
          tx,
          ctx,
          lotId,
          child.id,
          [input.operationId, child.id],
          canSeeCosts,
          true,
        );
      }
      if (await findOperationMovement(tx, ctx, input.operationId)) throw operationReused();
      return null;
    };
    // Reintento: antes y después del lock (un doble click concurrente espera el lock).
    const early = await replay();
    if (early) return early;
    const row = await lockLot(tx, ctx, lotId);
    const late = await replay();
    if (late) return late;

    const now = new Date();
    assertOperable(row, now, "transform");
    const profile = await loadProfile(tx, ctx, row.lot.productId);
    let shelfLifeMinutes: number | null;
    try {
      ({ shelfLifeMinutes } = resolveTransformation({
        from: row.lot.conservationState,
        to: input.targetState,
        profile: profile.entries,
      }));
    } catch (err) {
      lotError(err);
    }
    const balance = await lockLotBalance(tx, ctx, {
      id: row.lot.id,
      productId: row.lot.productId,
      warehouseId: row.lot.warehouseId,
    });
    let out: ReturnType<typeof lotOutflow>;
    try {
      out = lotOutflow({
        lotQuantity: balance.quantity,
        lotValue: balance.inventoryValue,
        unitCost: row.lot.unitMaterialCost,
        quantity: input.quantity,
      });
    } catch (err) {
      lotError(err);
    }

    const [{ n: siblings } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(productLots)
      .where(and(eq(productLots.companyId, ctx.companyId), eq(productLots.parentLotId, lotId)));
    const usableUntil =
      shelfLifeMinutes === null ? null : calculateUsableUntil(now, shelfLifeMinutes);
    const [child] = await mapUniqueViolations(
      tx
        .insert(productLots)
        .values({
          companyId: ctx.companyId,
          productId: row.lot.productId,
          productionOrderId: row.lot.productionOrderId,
          parentLotId: row.lot.id,
          lotCode: childLotCode(row.lot.lotCode, siblings + 1),
          warehouseId: row.lot.warehouseId,
          conservationState: input.targetState,
          producedAt: row.lot.producedAt,
          stateChangedAt: now,
          usableUntil,
          shelfLifeMinutes: usableUntil === null ? null : shelfLifeMinutes,
          initialQuantity: fixedQty(out.quantity),
          unitId: row.lot.unitId,
          unitMaterialCost: row.lot.unitMaterialCost,
          initialValue: fixedMoney(out.value),
          notes: input.notes,
          operationId: input.operationId,
          createdByUserId: ctx.userId,
        })
        .returning(),
      { product_lots_company_code_uq: lotCodeTaken },
    );
    if (!child) throw new Error("Lote hijo sin fila");

    const common = {
      productId: row.lot.productId,
      productCode: row.product.code,
      productName: row.product.name,
      saleUnitId: row.lot.unitId,
      quantity: fixedQty(out.quantity),
      value: fixedMoney(out.value),
      occurredAt: now,
      referenceType: "PRODUCT_LOT_TRANSFORMATION" as const,
      referenceId: child.id,
      notes: input.notes,
      recordCostHistory: false,
    };
    const outMovement = await postLotMovement(tx, ctx, {
      ...common,
      lot: { id: row.lot.id, code: row.lot.lotCode, warehouseId: row.lot.warehouseId },
      movementType: "LOT_TRANSFORMATION_OUT",
      sourceLineId: input.operationId,
    });
    const inMovement = await postLotMovement(tx, ctx, {
      ...common,
      lot: { id: child.id, code: child.lotCode, warehouseId: child.warehouseId },
      movementType: "LOT_TRANSFORMATION_IN",
      sourceLineId: child.id,
    });

    const verb = input.targetState === "FROZEN" ? "Congelado" : "Descongelado";
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRODUCT_LOT_TRANSFORMED",
      entityType: "product_lot",
      entityId: row.lot.id,
      metadata: {
        code: row.lot.lotCode,
        product: row.product.name,
        summary: `${verb}: ${fixedQty(out.quantity)} ${row.unit.symbol} de ${row.lot.lotCode} pasan al lote ${child.lotCode}`,
        from: row.lot.conservationState,
        to: input.targetState,
        quantity: fixedQty(out.quantity),
        unit: row.unit.symbol,
        sourceQuantityBefore: outMovement.lotBefore,
        sourceQuantityAfter: outMovement.lotAfter,
        childLotId: child.id,
        childLot: child.lotCode,
        childUsableUntil: child.usableUntil?.toISOString() ?? null,
        operationId: input.operationId,
        movementIds: [outMovement.movement.id, inMovement.movement.id],
      },
    });
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRODUCT_LOT_CREATED",
      entityType: "product_lot",
      entityId: child.id,
      metadata: {
        code: child.lotCode,
        productId: row.lot.productId,
        origin: "TRANSFORMATION",
        parentLotId: row.lot.id,
        parentLot: row.lot.lotCode,
        conservationState: child.conservationState,
        quantity: child.initialQuantity,
        usableUntil: child.usableUntil?.toISOString() ?? null,
        shelfLifeConfigured: child.usableUntil !== null,
      },
    });
    return operationResult(
      tx,
      ctx,
      lotId,
      child.id,
      [input.operationId, child.id],
      canSeeCosts,
      false,
    );
  });
}

/* ---------- Merma ---------- */

export async function wasteLot(
  db: Database,
  ctx: OperationContext,
  lotId: string,
  input: LotWasteInput,
  canSeeCosts: boolean,
): Promise<LotOperationResultDto> {
  return db.transaction(async (tx) => {
    const replay = async () => {
      const mv = await findOperationMovement(tx, ctx, input.operationId);
      if (mv) {
        if (mv.productLotId !== lotId || mv.movementType !== "WASTE") throw operationReused();
        return operationResult(tx, ctx, lotId, null, [input.operationId], canSeeCosts, true);
      }
      if (await findTransformation(tx, ctx, input.operationId)) throw operationReused();
      return null;
    };
    const early = await replay();
    if (early) return early;
    const row = await lockLot(tx, ctx, lotId);
    const late = await replay();
    if (late) return late;

    const now = new Date();
    assertOperable(row, now, "waste");
    const balance = await lockLotBalance(tx, ctx, {
      id: row.lot.id,
      productId: row.lot.productId,
      warehouseId: row.lot.warehouseId,
    });
    let out: ReturnType<typeof lotOutflow>;
    try {
      out = lotOutflow({
        lotQuantity: balance.quantity,
        lotValue: balance.inventoryValue,
        unitCost: row.lot.unitMaterialCost,
        quantity: input.quantity,
      });
    } catch (err) {
      lotError(err);
    }
    const posted = await postLotMovement(tx, ctx, {
      productId: row.lot.productId,
      productCode: row.product.code,
      productName: row.product.name,
      lot: { id: row.lot.id, code: row.lot.lotCode, warehouseId: row.lot.warehouseId },
      saleUnitId: row.lot.unitId,
      movementType: "WASTE",
      quantity: fixedQty(out.quantity),
      value: fixedMoney(out.value),
      occurredAt: now,
      referenceType: "PRODUCT_LOT",
      referenceId: row.lot.id,
      sourceLineId: input.operationId,
      reason: input.reason,
      notes: input.notes,
      recordCostHistory: true,
    });
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRODUCT_LOT_WASTE_RECORDED",
      entityType: "product_lot",
      entityId: row.lot.id,
      metadata: {
        code: row.lot.lotCode,
        product: row.product.name,
        summary: `Merma de ${fixedQty(out.quantity)} ${row.unit.symbol} del lote ${row.lot.lotCode} (${PRODUCT_WASTE_REASON_LABELS[input.reason].toLowerCase()})`,
        reason: input.reason,
        quantity: fixedQty(out.quantity),
        unit: row.unit.symbol,
        quantityBefore: posted.lotBefore,
        quantityAfter: posted.lotAfter,
        notes: input.notes,
        operationId: input.operationId,
        movementId: posted.movement.id,
      },
    });
    return operationResult(tx, ctx, lotId, null, [input.operationId], canSeeCosts, false);
  });
}

/* ---------- Calidad ---------- */

export async function setLotQuality(
  db: Database,
  ctx: OperationContext,
  lotId: string,
  blocked: boolean,
  input: BlockLotInput | null,
  canSeeCosts: boolean,
): Promise<ProductLotDto> {
  return db.transaction(async (tx) => {
    const row = await lockLot(tx, ctx, lotId);
    if (blocked && row.lot.qualityStatus === "BLOCKED") {
      throw new AppError(
        409,
        "LOT_ALREADY_BLOCKED",
        `El lote ${row.lot.lotCode} ya está bloqueado.`,
      );
    }
    if (!blocked && row.lot.qualityStatus === "AVAILABLE") {
      throw new AppError(409, "LOT_NOT_BLOCKED", `El lote ${row.lot.lotCode} no está bloqueado.`);
    }
    await tx
      .update(productLots)
      .set(
        blocked
          ? { qualityStatus: "BLOCKED", qualityReason: input!.reason }
          : { qualityStatus: "AVAILABLE", qualityReason: null },
      )
      .where(eq(productLots.id, lotId));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: blocked ? "PRODUCT_LOT_BLOCKED" : "PRODUCT_LOT_UNBLOCKED",
      entityType: "product_lot",
      entityId: lotId,
      metadata: {
        code: row.lot.lotCode,
        product: row.product.name,
        reason: blocked ? input!.reason : row.lot.qualityReason,
        quantity: fixedQty(row.quantity),
      },
    });
    const [dto] = await toLotDtos(tx, ctx, [await findLotRow(tx, ctx, lotId)], canSeeCosts);
    return dto!;
  });
}

/* ---------- Disponibilidad a una fecha ---------- */

/**
 * calculateProductAvailabilityAt(productId, warehouse?, requestedAt): qué
 * cantidad existe y qué cantidad es utilizable en ese momento (FEFO). Base de
 * Pedidos (Fase 5A). No descuenta reservas: no existen todavía.
 */
export async function calculateProductAvailabilityAt(
  db: Db,
  ctx: OperationContext,
  productId: string,
  warehouseId: string | null,
  requestedAt: Date,
): Promise<ProductAvailabilityDto> {
  const { p, unit } = await productUnit(db, ctx, productId);
  let warehouse: ProductAvailabilityDto["warehouse"] = null;
  if (warehouseId) {
    const [w] = await db
      .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
      .from(warehouses)
      .where(and(eq(warehouses.companyId, ctx.companyId), eq(warehouses.id, warehouseId)));
    if (!w) throw invalidReference("warehouseId", "Depósito inexistente");
    warehouse = w;
  }
  const rows = await selectLots(
    db,
    ctx,
    and(
      eq(productLots.productId, productId),
      gt(productLotBalances.quantity, "0"),
      warehouseId ? eq(productLots.warehouseId, warehouseId) : undefined,
    ),
  );
  const byId = new Map(rows.map((r) => [r.lot.id, r]));
  const result = calculateAvailabilityAt(rows.map(forAvailability), requestedAt);
  const breakdown = (b: typeof result.physicalByState) => ({
    FRESH: fixedQty(b.FRESH),
    REFRIGERATED: fixedQty(b.REFRIGERATED),
    FROZEN: fixedQty(b.FROZEN),
    THAWED: fixedQty(b.THAWED),
  });
  const reasons: ProductAvailabilityDto["reasons"] = [];
  const describe = (q: InstanceType<typeof D>, text: string) =>
    `${q.toDecimalPlaces(4).toString()} ${unit.symbol} ${text}`;
  if (result.ineligibleByReason.EXPIRED.gt(0)) {
    reasons.push({
      reason: "EXPIRED",
      quantity: fixedQty(result.ineligibleByReason.EXPIRED),
      label: describe(result.ineligibleByReason.EXPIRED, "vencen antes de la fecha"),
    });
  }
  if (result.ineligibleByReason.BLOCKED.gt(0)) {
    reasons.push({
      reason: "BLOCKED",
      quantity: fixedQty(result.ineligibleByReason.BLOCKED),
      label: describe(result.ineligibleByReason.BLOCKED, "están bloqueados por calidad"),
    });
  }
  return {
    product: { id: p.id, code: p.internalCode, name: p.name },
    unit,
    warehouse,
    requestedAt: requestedAt.toISOString(),
    physicalQuantity: fixedQty(result.physicalQuantity),
    eligibleQuantity: fixedQty(result.eligibleQuantity),
    ineligibleQuantity: fixedQty(result.ineligibleQuantity),
    ineligibleByReason: {
      EXPIRED: fixedQty(result.ineligibleByReason.EXPIRED),
      BLOCKED: fixedQty(result.ineligibleByReason.BLOCKED),
    },
    physicalByState: breakdown(result.physicalByState),
    eligibleByState: breakdown(result.eligibleByState),
    shelfLifeUnknownQuantity: fixedQty(result.shelfLifeUnknownQuantity),
    reasons,
    lots: result.lots.map((l, i) => ({
      id: l.id,
      code: l.code,
      conservationState: l.conservationState,
      qualityStatus: l.qualityStatus,
      warehouse: byId.get(l.id)!.warehouse,
      quantity: fixedQty(l.quantity),
      producedAt: l.producedAt.toISOString(),
      usableUntil: l.usableUntil?.toISOString() ?? null,
      eligible: l.eligible,
      reason: l.reason,
      fefoRank: i + 1,
    })),
  };
}

/* ---------- Próximos a vencer ---------- */

export async function listExpiring(
  db: Database,
  ctx: OperationContext,
  query: z.infer<typeof expiringQuerySchema>,
  canSeeCosts: boolean,
): Promise<Page<ExpiringLotDto>> {
  const now = new Date();
  // Umbral: el pedido (horas) o el configurado en cada producto (24 h por defecto).
  const threshold = query.withinHours
    ? sql`${query.withinHours * 60}`
    : sql`coalesce((select s.near_expiry_minutes from product_conservation_settings s
        where s.company_id = ${productLots.companyId} and s.product_id = ${productLots.productId}), ${DEFAULT_NEAR_EXPIRY_MINUTES})`;
  const nowSql = sql`${now.toISOString()}::timestamptz`;
  const where = and(
    gt(productLotBalances.quantity, "0"),
    isNotNull(productLots.usableUntil),
    query.warehouseId ? eq(productLots.warehouseId, query.warehouseId) : undefined,
    query.productId ? eq(productLots.productId, query.productId) : undefined,
    query.search
      ? sql`(${productLots.lotCode} ilike ${likePattern(query.search)} or exists (
          select 1 from products p where p.id = ${productLots.productId}
            and (p.name ilike ${likePattern(query.search)} or p.internal_code ilike ${likePattern(query.search)})))`
      : undefined,
    query.status === "expired"
      ? sql`${productLots.usableUntil} < ${nowSql}`
      : query.status === "near_expiry"
        ? sql`${productLots.usableUntil} >= ${nowSql} and ${productLots.usableUntil} <= ${nowSql} + make_interval(mins => (${threshold})::int)`
        : sql`${productLots.usableUntil} <= ${nowSql} + make_interval(mins => (${threshold})::int)`,
  );
  const { limit, offset } = pageWindow(query);
  const rows = await selectLots(db, ctx, where)
    .orderBy(asc(productLots.usableUntil), asc(productLots.producedAt), asc(productLots.lotCode))
    .limit(limit)
    .offset(offset);
  const [total] = await db
    .select({ n: count() })
    .from(productLots)
    .innerJoin(
      productLotBalances,
      and(
        eq(productLotBalances.productLotId, productLots.id),
        eq(productLotBalances.warehouseId, productLots.warehouseId),
      ),
    )
    .where(and(eq(productLots.companyId, ctx.companyId), where));
  const profiles = await loadProfiles(
    db,
    ctx,
    rows.map((r) => r.lot.productId),
  );
  const items = rows.map((row): ExpiringLotDto => {
    const profile = profiles.get(row.lot.productId);
    return {
      ...toLotDto(row, { now, canSeeCosts, profile }),
      nearExpiryMinutes: query.withinHours
        ? query.withinHours * 60
        : (profile?.nearExpiryMinutes ?? DEFAULT_NEAR_EXPIRY_MINUTES),
    };
  });
  return toPage(items, total?.n ?? 0, query);
}

/* ---------- Resumen por producto (Stock → Productos terminados) ---------- */

const emptySummary = (): ProductLotSummaryDto => ({
  physicalQuantity: fixedQty(0),
  byState: {
    FRESH: fixedQty(0),
    REFRIGERATED: fixedQty(0),
    FROZEN: fixedQty(0),
    THAWED: fixedQty(0),
  },
  usableNow: fixedQty(0),
  nearExpiry: fixedQty(0),
  expired: fixedQty(0),
  blocked: fixedQty(0),
  shelfLifeUnknown: fixedQty(0),
});

/**
 * Stock por lote de varios productos: físico, por conservación, utilizable
 * ahora, próximo a vencer (umbral del producto), vencido, bloqueado.
 */
export async function lotSummaries(
  db: Db,
  ctx: OperationContext,
  productIds: readonly string[],
  warehouseId: string | null,
  now = new Date(),
): Promise<Map<string, ProductLotSummaryDto>> {
  const result = new Map<string, ProductLotSummaryDto>();
  const ids = [...new Set(productIds)];
  for (const id of ids) result.set(id, emptySummary());
  if (ids.length === 0) return result;
  const rows = await selectLots(
    db,
    ctx,
    and(
      inArray(productLots.productId, ids),
      gt(productLotBalances.quantity, "0"),
      warehouseId ? eq(productLots.warehouseId, warehouseId) : undefined,
    ),
  );
  const profiles = await loadProfiles(db, ctx, ids);
  const acc = new Map<
    string,
    Record<
      "physical" | "usable" | "near" | "expired" | "blocked" | "unknown" | ConservationState,
      InstanceType<typeof D>
    >
  >();
  for (const row of rows) {
    const key = row.lot.productId;
    const a =
      acc.get(key) ??
      ({
        physical: new D(0),
        usable: new D(0),
        near: new D(0),
        expired: new D(0),
        blocked: new D(0),
        unknown: new D(0),
        FRESH: new D(0),
        REFRIGERATED: new D(0),
        FROZEN: new D(0),
        THAWED: new D(0),
      } as const satisfies Record<string, InstanceType<typeof D>>);
    const q = new D(row.quantity);
    const status = toLotDto(row, {
      now,
      canSeeCosts: false,
      profile: profiles.get(key),
    }).status;
    const next = { ...a };
    next.physical = a.physical.plus(q);
    next[row.lot.conservationState] = a[row.lot.conservationState].plus(q);
    if (status === "AVAILABLE" || status === "NEAR_EXPIRY") {
      next.usable = a.usable.plus(q);
      if (status === "NEAR_EXPIRY") next.near = a.near.plus(q);
      if (row.lot.usableUntil === null) next.unknown = a.unknown.plus(q);
    } else if (status === "BLOCKED") {
      next.blocked = a.blocked.plus(q);
    } else if (status === "EXPIRED") {
      next.expired = a.expired.plus(q);
    }
    acc.set(key, next);
  }
  for (const [productId, a] of acc) {
    result.set(productId, {
      physicalQuantity: fixedQty(a.physical),
      byState: {
        FRESH: fixedQty(a.FRESH),
        REFRIGERATED: fixedQty(a.REFRIGERATED),
        FROZEN: fixedQty(a.FROZEN),
        THAWED: fixedQty(a.THAWED),
      },
      usableNow: fixedQty(a.usable),
      nearExpiry: fixedQty(a.near),
      expired: fixedQty(a.expired),
      blocked: fixedQty(a.blocked),
      shelfLifeUnknown: fixedQty(a.unknown),
    });
  }
  return result;
}
