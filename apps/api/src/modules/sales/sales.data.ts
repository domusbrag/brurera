import { D, saleBalanceDue } from "@bakery/domain";
import {
  customerOrders,
  customerPaymentApplications,
  customerPayments,
  customers,
  productLots,
  products,
  saleLines,
  saleLotAllocations,
  sales,
  warehouses,
  type Database,
  type Transaction,
} from "@bakery/database";
import {
  PERMISSIONS,
  hasPermissions,
  instantToZonedLocal,
  zonedLocalToInstant,
  type Page,
  type SaleDetailDto,
  type SaleLineDto,
  type SaleListItemDto,
  type saleListQuerySchema,
} from "@bakery/shared";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { z } from "zod";
import type { OperationContext } from "../../lib/context.js";
import { notFound } from "../../lib/db-errors.js";
import { likePattern, pageWindow, toPage } from "../../lib/listing.js";
import { loadPeople, personOf } from "../../lib/people.js";
import { companyCurrency, loadUnits, unitOrThrow } from "../recipes/recipes.data.js";

/*
 * Lecturas de ventas (Fase 5B). Visibilidad:
 * - precios e importes: price_lists.read (Depósito ve la salida física sin precios);
 * - costo material y lotes valorizados: sales.cost.read;
 * - margen sobre materiales: sales.margin.read.
 * Sin el permiso, la API no envía el dato (null), no sólo la UI lo oculta.
 */

export type Db = Database | Transaction;
export type SaleRow = typeof sales.$inferSelect;
export type SaleLineRow = typeof saleLines.$inferSelect;

export interface SaleViewer {
  permissions: Iterable<string>;
}

export function visibility(viewer: SaleViewer) {
  const can = (code: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) =>
    hasPermissions(viewer.permissions, [code]);
  return {
    prices: can(PERMISSIONS.PRICE_LISTS_READ),
    costs: can(PERMISSIONS.SALES_COST_READ),
    margin: can(PERMISSIONS.SALES_MARGIN_READ),
    payments: can(PERMISSIONS.PAYMENTS_READ),
    can,
  };
}

export const customerName = (c: { legalName: string; tradeName: string | null }) =>
  c.tradeName ?? c.legalName;

const unitRef = (u: { id: string; code: string; symbol: string }) => ({
  id: u.id,
  code: u.code,
  symbol: u.symbol,
});

export async function findSale(db: Db, ctx: OperationContext, id: string, lock = false) {
  const query = db
    .select()
    .from(sales)
    .where(and(eq(sales.companyId, ctx.companyId), eq(sales.id, id)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Venta");
  return row;
}

export async function loadSaleLines(db: Db, ctx: OperationContext, saleId: string, lock = false) {
  const query = db
    .select()
    .from(saleLines)
    .where(and(eq(saleLines.companyId, ctx.companyId), eq(saleLines.saleId, saleId)))
    .orderBy(asc(saleLines.sortOrder), asc(saleLines.id));
  return lock ? query.for("update") : query;
}

/** Cliente "Consumidor Final" de la empresa (creado por la migración / alta de empresa). */
export async function walkInCustomer(db: Db, ctx: OperationContext) {
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.isWalkIn, true)));
  return row?.id ?? null;
}

const margin = (amount: string | null, percentage: string | null) =>
  amount === null
    ? null
    : { amount, percentage: percentage === null ? null : new D(percentage).toFixed(2) };

/* ---------- Listado ---------- */

export async function listSales(
  db: Database,
  ctx: OperationContext,
  query: z.infer<typeof saleListQuerySchema>,
  viewer: SaleViewer,
): Promise<Page<SaleListItemDto>> {
  const see = visibility(viewer);
  const nextDay = (date: string) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  const when = sql<Date>`coalesce(${sales.saleDate}, ${sales.createdAt})`;
  const where = and(
    eq(sales.companyId, ctx.companyId),
    query.status === "all" ? undefined : eq(sales.status, query.status),
    query.paymentStatus
      ? and(eq(sales.status, "POSTED"), eq(sales.paymentStatus, query.paymentStatus))
      : undefined,
    query.customerId ? eq(sales.customerId, query.customerId) : undefined,
    query.orderId ? eq(sales.sourceOrderId, query.orderId) : undefined,
    query.origin === "order" ? isNotNull(sales.sourceOrderId) : undefined,
    query.origin === "direct" ? isNull(sales.sourceOrderId) : undefined,
    query.pendingOnly
      ? and(eq(sales.status, "POSTED"), sql`${sales.paidAmount} < ${sales.total}`)
      : undefined,
    query.from ? gte(when, zonedLocalToInstant(`${query.from}T00:00`, ctx.timezone)) : undefined,
    query.to
      ? lt(when, zonedLocalToInstant(`${nextDay(query.to)}T00:00`, ctx.timezone))
      : undefined,
    query.search
      ? or(
          ilike(sales.internalCode, likePattern(query.search)),
          ilike(customers.legalName, likePattern(query.search)),
          ilike(customers.tradeName, likePattern(query.search)),
          ilike(customerOrders.internalCode, likePattern(query.search)),
        )
      : undefined,
  );
  const { limit, offset } = pageWindow(query);
  const base = db
    .select({
      sale: sales,
      when,
      customer: {
        id: customers.id,
        code: customers.internalCode,
        name: sql<string>`coalesce(${customers.tradeName}, ${customers.legalName})`,
      },
      order: { id: customerOrders.id, code: customerOrders.internalCode },
    })
    .from(sales)
    .innerJoin(customers, eq(customers.id, sales.customerId))
    .leftJoin(customerOrders, eq(customerOrders.id, sales.sourceOrderId))
    .where(where);
  const [rows, [total]] = await Promise.all([
    base.orderBy(desc(when), desc(sales.internalCode)).limit(limit).offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(sales)
      .innerJoin(customers, eq(customers.id, sales.customerId))
      .leftJoin(customerOrders, eq(customerOrders.id, sales.sourceOrderId))
      .where(where),
  ]);
  const currency = await companyCurrency(db, ctx);
  return toPage(
    rows.map(({ sale, when: date, customer, order }) => ({
      id: sale.id,
      code: sale.internalCode,
      status: sale.status,
      paymentStatus: sale.paymentStatus,
      date: new Date(date).toISOString(),
      dateLocal: instantToZonedLocal(new Date(date), ctx.timezone),
      customer,
      order: order?.id ? { id: order.id, code: order.code } : null,
      total: see.prices ? sale.total : null,
      pending:
        see.prices && sale.status === "POSTED"
          ? saleBalanceDue(sale.total, sale.paidAmount).toFixed(2)
          : null,
      margin:
        see.margin && sale.status === "POSTED"
          ? margin(sale.grossMarginAmount, sale.grossMarginPercentage)
          : null,
      currency,
    })),
    total?.n ?? 0,
    query,
  );
}

/* ---------- Detalle ---------- */

export async function getSaleDetail(
  db: Db,
  ctx: OperationContext,
  id: string,
  viewer: SaleViewer,
): Promise<SaleDetailDto> {
  const see = visibility(viewer);
  const P = PERMISSIONS;
  const sale = await findSale(db, ctx, id);
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, sale.customerId)));
  const [warehouse] = await db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
    .from(warehouses)
    .where(eq(warehouses.id, sale.warehouseId));
  const [order] = sale.sourceOrderId
    ? await db
        .select({
          id: customerOrders.id,
          code: customerOrders.internalCode,
          status: customerOrders.status,
        })
        .from(customerOrders)
        .where(eq(customerOrders.id, sale.sourceOrderId))
    : [];
  const lines = await loadSaleLines(db, ctx, sale.id);
  const units = await loadUnits(db, ctx);
  const productRows = lines.length
    ? await db
        .select({ id: products.id, code: products.internalCode, name: products.name })
        .from(products)
        .where(
          and(
            eq(products.companyId, ctx.companyId),
            inArray(
              products.id,
              lines.map((l) => l.productId),
            ),
          ),
        )
    : [];
  const productById = new Map(productRows.map((p) => [p.id, p]));
  const allocations = await db
    .select({
      a: saleLotAllocations,
      lot: {
        id: productLots.id,
        code: productLots.lotCode,
        conservationState: productLots.conservationState,
        usableUntil: productLots.usableUntil,
      },
    })
    .from(saleLotAllocations)
    .innerJoin(productLots, eq(productLots.id, saleLotAllocations.productLotId))
    .where(
      and(eq(saleLotAllocations.companyId, ctx.companyId), eq(saleLotAllocations.saleId, sale.id)),
    )
    .orderBy(asc(productLots.usableUntil), asc(productLots.lotCode));
  const applications = see.payments
    ? await db
        .select({
          app: customerPaymentApplications,
          payment: {
            id: customerPayments.id,
            code: customerPayments.internalCode,
            kind: customerPayments.kind,
            method: customerPayments.paymentMethod,
            paymentDate: customerPayments.paymentDate,
          },
        })
        .from(customerPaymentApplications)
        .innerJoin(customerPayments, eq(customerPayments.id, customerPaymentApplications.paymentId))
        .where(
          and(
            eq(customerPaymentApplications.companyId, ctx.companyId),
            eq(customerPaymentApplications.saleId, sale.id),
          ),
        )
        .orderBy(asc(customerPaymentApplications.createdAt))
    : null;
  const people = await loadPeople(db, [
    sale.createdByUserId,
    sale.postedByUserId,
    sale.cancelledByUserId,
  ]);
  const posted = sale.status === "POSTED";
  const lineDtos: SaleLineDto[] = lines.map((l) => {
    const p = productById.get(l.productId)!;
    const mine = allocations.filter((a) => a.a.saleLineId === l.id);
    const agreedNet =
      l.agreedUnitPrice === null
        ? null
        : new D(l.normalizedQuantity)
            .times(l.agreedUnitPrice)
            .toDecimalPlaces(2, D.ROUND_HALF_UP)
            .minus(l.agreedDiscountAmount ?? 0);
    return {
      id: l.id,
      sortOrder: l.sortOrder,
      product: { id: p.id, code: p.code, name: p.name },
      orderLineId: l.sourceOrderLineId,
      quantity: l.quantity,
      unit: unitRef(unitOrThrow(units, l.unitId)),
      normalizedQuantity: l.normalizedQuantity,
      saleUnit: unitRef(unitOrThrow(units, l.saleUnitId)),
      requestedConservation: l.requestedConservation,
      notes: l.notes,
      price: see.prices
        ? {
            unitPrice: l.unitPrice,
            discountAmount: l.discountAmount,
            netAmount: l.netAmount,
            priceSource: l.priceSource,
            agreedUnitPrice: l.agreedUnitPrice,
            agreedDiscountAmount: l.agreedDiscountAmount,
            difference: agreedNet === null ? null : new D(l.netAmount).minus(agreedNet).toFixed(2),
            overrideReason: l.priceOverrideReason,
          }
        : null,
      materialCost: see.costs && posted ? l.materialCost : null,
      averageLotUnitCost: see.costs && posted ? l.averageLotUnitCost : null,
      margin: see.margin && posted ? margin(l.grossMarginAmount, l.grossMarginPercentage) : null,
      lots: mine.map(({ a, lot }) => ({
        lot: {
          id: lot.id,
          code: lot.code,
          conservationState: lot.conservationState,
          usableUntil: lot.usableUntil?.toISOString() ?? null,
        },
        quantity: a.quantity,
        fromReservation: a.reservationId !== null,
        unitCost: see.costs ? a.unitMaterialCost : null,
        materialCost: see.costs ? a.materialCost : null,
      })),
    };
  });
  const due = saleBalanceDue(sale.total, sale.paidAmount);
  const editable = sale.status === "DRAFT";
  return {
    id: sale.id,
    code: sale.internalCode,
    status: sale.status,
    paymentStatus: sale.paymentStatus,
    customer: {
      id: customer!.id,
      code: customer!.internalCode,
      name: customerName(customer!),
      walkIn: customer!.isWalkIn,
    },
    order: order ? { id: order.id, code: order.code, status: order.status } : null,
    warehouse: warehouse!,
    saleDate: sale.saleDate?.toISOString() ?? null,
    saleDateLocal: sale.saleDate ? instantToZonedLocal(sale.saleDate, ctx.timezone) : null,
    timezone: ctx.timezone,
    currency: sale.currency,
    notes: sale.notes,
    amounts: see.prices
      ? {
          subtotal: sale.subtotal,
          discountTotal: sale.discountTotal,
          total: sale.total,
          paid: sale.paidAmount,
          pending: posted ? due.toFixed(2) : sale.total,
        }
      : null,
    materialCost: see.costs && posted ? sale.materialCostTotal : null,
    margin:
      see.margin && posted ? margin(sale.grossMarginAmount, sale.grossMarginPercentage) : null,
    creditLimitExceeded: sale.creditLimitExceeded,
    lines: lineDtos,
    payments: applications
      ? applications.map(({ app, payment }) => ({
          paymentId: payment.id,
          code: payment.code,
          kind: payment.kind,
          method: payment.method,
          paymentDate: payment.paymentDate.toISOString(),
          amount: app.amount,
          origin: app.origin,
          appliedAt: app.createdAt.toISOString(),
        }))
      : null,
    createdAt: sale.createdAt.toISOString(),
    createdBy: personOf(people, sale.createdByUserId),
    postedAt: sale.postedAt?.toISOString() ?? null,
    postedBy: personOf(people, sale.postedByUserId),
    cancelledAt: sale.cancelledAt?.toISOString() ?? null,
    cancelledBy: personOf(people, sale.cancelledByUserId),
    cancelReason: sale.cancelReason,
    canSeePrices: see.prices,
    canSeeCosts: see.costs,
    canSeeMargin: see.margin,
    actions: {
      canEdit: editable && see.can(P.SALES_UPDATE),
      canPost: editable && see.can(P.SALES_POST),
      canCancel: editable && see.can(P.SALES_UPDATE),
      canRegisterPayment:
        posted && due.gt(0) && see.can(P.PAYMENTS_CREATE) && see.can(P.PAYMENTS_POST),
    },
  };
}
