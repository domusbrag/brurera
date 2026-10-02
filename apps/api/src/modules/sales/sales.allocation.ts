import {
  D,
  allocateSaleLine,
  lotEligibilityAt,
  lotOutflow,
  type RequestedConservation,
} from "@bakery/domain";
import {
  productLotBalances,
  productLotReservations,
  productLots,
  type Transaction,
} from "@bakery/database";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { OperationContext } from "../../lib/context.js";
import { type forAvailability, selectLots } from "../lots/lots.data.js";
import { committedByLot, lockLots, reservationRemaining } from "../orders/reservations.js";
import type { Db, SaleLineRow } from "./sales.data.js";

/*
 * Qué lotes salen en una venta (Fase 5B, ADR-058/059). Lo usan la vista previa
 * (sin locks) y el posteo (con locks, leyendo el estado DESPUÉS de bloquear):
 * 1. Venta desde pedido: primero las reservas ACTIVAS de su línea (lo prometido);
 *    lo que falte, stock libre FEFO del depósito de la venta.
 * 2. Venta directa: stock libre FEFO = físico − reservas activas de TODOS los
 *    pedidos, lotes AVAILABLE, no vencidos y con la conservación pedida.
 * El costo de cada lote retirado es su valor real (identificación específica).
 */

type Dec = InstanceType<typeof D>;

export interface LotState {
  id: string;
  code: string;
  productId: string;
  warehouseId: string;
  conservationState: ReturnType<typeof forAvailability>["conservationState"];
  qualityStatus: ReturnType<typeof forAvailability>["qualityStatus"];
  producedAt: Date;
  usableUntil: Date | null;
  unitMaterialCost: string;
  unitId: string;
  /** Saldo físico y valor actuales del lote (se actualizan al planificar). */
  quantity: Dec;
  value: Dec;
  /** Σ pendiente de reservas activas (de cualquier pedido). */
  committed: Dec;
}

export interface ReservationState {
  id: string;
  orderLineId: string;
  lotId: string;
  quantity: string;
  fulfilledQuantity: string;
  remaining: Dec;
}

export interface PlannedAllocation {
  lot: LotState;
  quantity: Dec;
  reservationId: string | null;
  /** Valor retirado del lote (costo material real) y su costo unitario. */
  value: Dec;
  unitCost: Dec;
}

export interface PlannedLine {
  line: SaleLineRow;
  allocations: PlannedAllocation[];
  fromReservations: Dec;
  missing: Dec;
  /** Reservas de la línea que no se pudieron usar (lote vencido o bloqueado). */
  unusableReservations: number;
  materialCost: Dec;
  /** Libre vendible en el depósito para el producto (para explicar un faltante). */
  freeAvailable: Dec;
}

/** Reservas activas del pedido (opcionalmente bloqueadas, después de los lotes). */
export async function orderReservations(
  db: Db,
  ctx: OperationContext,
  orderId: string,
  lock: boolean,
): Promise<ReservationState[]> {
  const query = db
    .select()
    .from(productLotReservations)
    .where(
      and(
        eq(productLotReservations.companyId, ctx.companyId),
        eq(productLotReservations.customerOrderId, orderId),
        eq(productLotReservations.status, "ACTIVE"),
      ),
    )
    .orderBy(asc(productLotReservations.id));
  const rows = lock ? await query.for("update") : await query;
  return rows.map((r) => ({
    id: r.id,
    orderLineId: r.orderLineId,
    lotId: r.productLotId,
    quantity: r.quantity,
    fulfilledQuantity: r.fulfilledQuantity,
    remaining: reservationRemaining(r),
  }));
}

/** Lotes candidatos: los del producto en el depósito de la venta y los reservados por el pedido. */
export async function candidateLotIds(
  db: Db,
  ctx: OperationContext,
  productIds: readonly string[],
  warehouseId: string,
  reservedLotIds: readonly string[],
) {
  if (productIds.length === 0) return [];
  const rows = await selectLots(
    db,
    ctx,
    and(
      inArray(productLots.productId, [...new Set(productIds)]),
      or(
        eq(productLots.warehouseId, warehouseId),
        reservedLotIds.length ? inArray(productLots.id, [...reservedLotIds]) : undefined,
      ),
    ),
  );
  return rows.filter((r) => new D(r.quantity).gt(0)).map((r) => r.lot.id);
}

/**
 * Bloquea (posteo) lotes por id y luego sus saldos por id (ADR-062). Devuelve
 * los ids bloqueados.
 */
export async function lockSaleLots(
  tx: Transaction,
  ctx: OperationContext,
  productIds: readonly string[],
  warehouseId: string,
  reservedLotIds: readonly string[],
) {
  const ids = [
    ...new Set([
      ...(await candidateLotIds(tx, ctx, productIds, warehouseId, reservedLotIds)),
      ...reservedLotIds,
    ]),
  ].sort();
  await lockLots(tx, ctx, ids);
  if (ids.length > 0) {
    await tx
      .select({ id: productLotBalances.id })
      .from(productLotBalances)
      .where(
        and(
          eq(productLotBalances.companyId, ctx.companyId),
          inArray(productLotBalances.productLotId, ids),
        ),
      )
      .orderBy(asc(productLotBalances.id))
      .for("update");
  }
  return ids;
}

/** Estado actual de los lotes (saldo, valor y comprometido por todos los pedidos). */
export async function loadLotStates(
  db: Db,
  ctx: OperationContext,
  lotIds: readonly string[],
): Promise<Map<string, LotState>> {
  if (lotIds.length === 0) return new Map();
  const rows = await selectLots(db, ctx, inArray(productLots.id, [...lotIds]));
  const committed = await committedByLot(
    db,
    ctx,
    rows.map((r) => r.lot.id),
  );
  return new Map(
    rows.map((r) => [
      r.lot.id,
      {
        id: r.lot.id,
        code: r.lot.lotCode,
        productId: r.lot.productId,
        warehouseId: r.lot.warehouseId,
        conservationState: r.lot.conservationState,
        qualityStatus: r.lot.qualityStatus,
        producedAt: r.lot.producedAt,
        usableUntil: r.lot.usableUntil,
        unitMaterialCost: r.lot.unitMaterialCost,
        unitId: r.lot.unitId,
        quantity: new D(r.quantity),
        value: new D(r.value),
        committed: new D(committed.get(r.lot.id) ?? 0),
      },
    ]),
  );
}

/** Lotes que se usarán para cada línea, con su costo; muta los estados (varias líneas). */
export function planSaleLines(args: {
  lines: readonly SaleLineRow[];
  lots: Map<string, LotState>;
  reservations: readonly ReservationState[];
  warehouseId: string;
  at: Date;
}): PlannedLine[] {
  const lots = args.lots;
  const forDomain = (l: LotState) => ({
    ...l,
    id: l.id,
    code: l.code,
    quantity: l.quantity,
    committed: l.committed,
  });
  return args.lines.map((line) => {
    const mine = line.sourceOrderLineId
      ? args.reservations.filter(
          (r) => r.orderLineId === line.sourceOrderLineId && r.remaining.gt(0),
        )
      : [];
    const usable = mine.filter((r) => {
      const lot = lots.get(r.lotId);
      return lot && lotEligibilityAt(forDomain(lot), args.at).eligible;
    });
    const freeLots = [...lots.values()].filter(
      (l) => l.productId === line.productId && l.warehouseId === args.warehouseId,
    );
    const freeAvailable = freeLots.reduce((s, l) => {
      if (!lotEligibilityAt(forDomain(l), args.at).eligible) return s;
      const requested = line.requestedConservation as RequestedConservation;
      if (requested !== "ANY" && l.conservationState !== requested) return s;
      const free = l.quantity.minus(l.committed);
      return free.gt(0) ? s.plus(free) : s;
    }, new D(0));
    const result = allocateSaleLine({
      quantity: line.normalizedQuantity,
      reservations: usable.map((r) => ({
        id: r.id,
        lot: forDomain(lots.get(r.lotId)!),
        remaining: r.remaining,
      })),
      freeLots: freeLots.map(forDomain),
      at: args.at,
      requested: line.requestedConservation as RequestedConservation,
    });
    const allocations: PlannedAllocation[] = [];
    let materialCost = new D(0);
    if (result.missing.isZero()) {
      for (const a of result.allocations) {
        const lot = lots.get(a.lot.id)!;
        const out = lotOutflow({
          lotQuantity: lot.quantity,
          lotValue: lot.value,
          unitCost: lot.unitMaterialCost,
          quantity: a.quantity,
        });
        lot.quantity = out.remainingQuantity;
        lot.value = out.remainingValue;
        if (a.reservationId) {
          lot.committed = lot.committed.minus(a.quantity);
          const r = args.reservations.find((x) => x.id === a.reservationId)!;
          r.remaining = r.remaining.minus(a.quantity);
        }
        allocations.push({
          lot,
          quantity: out.quantity,
          reservationId: a.reservationId,
          value: out.value,
          unitCost: new D(lot.unitMaterialCost),
        });
        materialCost = materialCost.plus(out.value);
      }
    }
    return {
      line,
      allocations,
      fromReservations: result.fromReservations,
      missing: result.missing,
      unusableReservations: mine.length - usable.length,
      materialCost,
      freeAvailable,
    };
  });
}
