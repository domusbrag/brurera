import { D, freeLotQuantity, reservationsToInvalidate, type OrderPriority } from "@bakery/domain";
import {
  customerOrders,
  customers,
  productLotReservations,
  productLots,
  type Database,
  type Transaction,
} from "@bakery/database";
import { PERMISSIONS, hasPermissions, type LotCommitmentDto } from "@bakery/shared";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { recordAudit } from "../audit/audit.service.js";
import { fixedQty } from "../inventory/ledger.js";

/*
 * Reservas de lotes de producto terminado (Fase 5A, ADR-051/052). Compartido
 * por pedidos (reservar, liberar) y lotes (merma, calidad, transformación).
 *
 * Orden de locks (ADR-053): pedido → líneas → lotes (product_lots FOR UPDATE, por
 * id) → saldos de lote → reservas → necesidades. Las operaciones de lote
 * (merma, bloqueo, transformación) toman lote → saldo → reservas y NUNCA el
 * pedido: por eso un pedido afectado no se actualiza, su NEEDS_REPLAN se deriva
 * de sus reservas invalidadas.
 */

type Db = Database | Transaction;

/** Σ reservas ACTIVAS por lote (opcionalmente sin las de un pedido). */
export async function committedByLot(
  db: Db,
  ctx: OperationContext,
  lotIds: readonly string[],
  excludeOrderId: string | null = null,
): Promise<Map<string, string>> {
  const ids = [...new Set(lotIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      lotId: productLotReservations.productLotId,
      quantity: sql<string>`sum(${productLotReservations.quantity})`,
    })
    .from(productLotReservations)
    .where(
      and(
        eq(productLotReservations.companyId, ctx.companyId),
        inArray(productLotReservations.productLotId, ids),
        eq(productLotReservations.status, "ACTIVE"),
        excludeOrderId ? ne(productLotReservations.customerOrderId, excludeOrderId) : undefined,
      ),
    )
    .groupBy(productLotReservations.productLotId);
  return new Map(rows.map((r) => [r.lotId, r.quantity]));
}

/** Bloquea lotes en orden de id (serializa reservas, merma, bloqueo y transformación). */
export async function lockLots(tx: Transaction, ctx: OperationContext, lotIds: readonly string[]) {
  const ids = [...new Set(lotIds)].sort();
  if (ids.length === 0) return;
  await tx
    .select({ id: productLots.id })
    .from(productLots)
    .where(and(eq(productLots.companyId, ctx.companyId), inArray(productLots.id, ids)))
    .orderBy(asc(productLots.id))
    .for("update");
}

/** Cantidad comprometida de un lote (dentro de la transacción que ya lo bloqueó). */
export async function lotCommitted(tx: Db, ctx: OperationContext, lotId: string) {
  return new D((await committedByLot(tx, ctx, [lotId])).get(lotId) ?? 0);
}

export interface InvalidatedReservation {
  reservationId: string;
  orderId: string;
  orderCode: string;
  quantity: string;
  kept: string;
}

/**
 * Calidad y merma tienen prioridad sobre la reserva (ADR-052): el lote ya está
 * bloqueado (FOR UPDATE) por el llamador. Invalida las reservas que dejan de
 * estar cubiertas y, si parte sigue cubierta (merma parcial), crea una reserva
 * nueva por lo que queda. Nunca deja una reserva activa sobre cantidad
 * inexistente o un lote bloqueado. Audita en cada pedido afectado.
 */
export async function invalidateLotReservations(
  tx: Transaction,
  ctx: OperationContext,
  lot: { id: string; code: string; productName: string; unitSymbol: string },
  cause: { reason: "LOT_BLOCKED" } | { reason: "LOT_WASTE"; newBalance: string },
): Promise<InvalidatedReservation[]> {
  const active = await tx
    .select({
      r: productLotReservations,
      orderCode: customerOrders.internalCode,
      priority: customerOrders.priority,
      requestedAt: customerOrders.requestedAt,
    })
    .from(productLotReservations)
    .innerJoin(customerOrders, eq(customerOrders.id, productLotReservations.customerOrderId))
    .where(
      and(
        eq(productLotReservations.companyId, ctx.companyId),
        eq(productLotReservations.productLotId, lot.id),
        eq(productLotReservations.status, "ACTIVE"),
      ),
    )
    .orderBy(asc(productLotReservations.id))
    .for("update", { of: productLotReservations });
  if (active.length === 0) return [];
  const affected =
    cause.reason === "LOT_BLOCKED"
      ? active.map((a) => ({ reservation: a, keep: new D(0) }))
      : reservationsToInvalidate(
          active.map((a) => ({
            ...a,
            id: a.r.id,
            quantity: a.r.quantity,
            priority: a.priority as OrderPriority,
            reservedAt: a.r.reservedAt,
          })),
          cause.newBalance,
        );
  const now = new Date();
  const result: InvalidatedReservation[] = [];
  for (const { reservation, keep } of affected) {
    const r = reservation.r;
    await tx
      .update(productLotReservations)
      .set({
        status: "INVALIDATED",
        releasedAt: now,
        releaseReason: cause.reason,
        releasedByUserId: ctx.userId,
      })
      .where(eq(productLotReservations.id, r.id));
    if (keep.gt(0)) {
      await tx.insert(productLotReservations).values({
        companyId: ctx.companyId,
        customerOrderId: r.customerOrderId,
        orderLineId: r.orderLineId,
        productId: r.productId,
        productLotId: r.productLotId,
        quantity: fixedQty(keep),
        unitId: r.unitId,
        planRevision: r.planRevision,
        status: "ACTIVE",
        replacesReservationId: r.id,
        createdByUserId: ctx.userId,
      });
    }
    const verb = cause.reason === "LOT_BLOCKED" ? "se bloqueó por calidad" : "tuvo merma";
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "LOT_RESERVATION_INVALIDATED",
      entityType: "customer_order",
      entityId: r.customerOrderId,
      metadata: {
        code: reservation.orderCode,
        lot: lot.code,
        lotId: lot.id,
        product: lot.productName,
        reason: cause.reason,
        quantity: fixedQty(r.quantity),
        kept: fixedQty(keep),
        unit: lot.unitSymbol,
        planRevision: r.planRevision,
        summary: keep.gt(0)
          ? `El lote ${lot.code} ${verb}: la reserva baja de ${new D(r.quantity).toString()} a ${keep.toString()} ${lot.unitSymbol}. Recalcular cobertura.`
          : `El lote ${lot.code} ${verb}: se invalidó la reserva de ${new D(r.quantity).toString()} ${lot.unitSymbol}. Recalcular cobertura.`,
      },
    });
    result.push({
      reservationId: r.id,
      orderId: r.customerOrderId,
      orderCode: reservation.orderCode,
      quantity: fixedQty(r.quantity),
      kept: fixedQty(keep),
    });
  }
  return result;
}

/**
 * Compromiso de un lote para su detalle: comprometido, libre y los pedidos que
 * lo reservan (sin orders.read no se listan; sin customers.read, sin cliente).
 */
export async function lotCommitment(
  db: Db,
  ctx: OperationContext,
  lotId: string,
  balance: string,
  permissions: Iterable<string>,
): Promise<LotCommitmentDto> {
  const rows = await db
    .select({
      id: productLotReservations.id,
      quantity: productLotReservations.quantity,
      planRevision: productLotReservations.planRevision,
      reservedAt: productLotReservations.reservedAt,
      order: {
        id: customerOrders.id,
        code: customerOrders.internalCode,
        requestedAt: customerOrders.requestedAt,
        status: customerOrders.status,
      },
      customer: sql<string>`coalesce(${customers.tradeName}, ${customers.legalName})`,
    })
    .from(productLotReservations)
    .innerJoin(customerOrders, eq(customerOrders.id, productLotReservations.customerOrderId))
    .innerJoin(customers, eq(customers.id, customerOrders.customerId))
    .where(
      and(
        eq(productLotReservations.companyId, ctx.companyId),
        eq(productLotReservations.productLotId, lotId),
        eq(productLotReservations.status, "ACTIVE"),
      ),
    )
    .orderBy(asc(customerOrders.requestedAt), asc(productLotReservations.id));
  const committed = rows.reduce((s, r) => s.plus(r.quantity), new D(0));
  const seeOrders = hasPermissions(permissions, [PERMISSIONS.ORDERS_READ]);
  const seeCustomers = hasPermissions(permissions, [PERMISSIONS.CUSTOMERS_READ]);
  return {
    committedQuantity: fixedQty(committed),
    freeQuantity: fixedQty(freeLotQuantity(balance, committed)),
    reservations: seeOrders
      ? rows.map((r) => ({
          id: r.id,
          order: { ...r.order, requestedAt: r.order.requestedAt.toISOString() },
          customer: seeCustomers ? r.customer : null,
          quantity: fixedQty(r.quantity),
          planRevision: r.planRevision,
          reservedAt: r.reservedAt.toISOString(),
        }))
      : null,
  };
}
