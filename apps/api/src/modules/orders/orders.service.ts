import {
  D,
  OrderError,
  assertOrderTransition,
  assertReadyAllowed,
  type OrderStatus,
} from "@bakery/domain";
import {
  allocateCode,
  customerOrderLines,
  customerOrderOperations,
  customerOrders,
  customers,
  orderMaterialRequirements,
  orderProductionRequirements,
  productLotReservations,
  productionOrders,
  products,
  type Database,
  type Transaction,
} from "@bakery/database";
import {
  ORDER_INFO_FIELDS,
  formatLocalDateTime,
  instantToZonedLocal,
  zonedLocalToInstant,
  type CancelOrderInput,
  type CoveragePreviewDto,
  type CoveragePreviewInput,
  type CreateOrderInput,
  type LineCoverageDto,
  type OrderDetailDto,
  type OrderLineInput,
  type QuoteOrderInput,
  type OrderListItemDto,
  type OrderOperationResultDto,
  type Page,
  type ReplanOrderInput,
  type ReplanPreviewDto,
  type ReplanPreviewInput,
  type UpdateOrderInput,
  type orderListQuerySchema,
} from "@bakery/shared";
import { and, asc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { likePattern, pageWindow, toPage } from "../../lib/listing.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";
import { loadUnits, unitOrThrow, type UnitRow } from "../recipes/recipes.data.js";
import {
  OPEN_REQUIREMENT,
  activeReservations,
  orderAdvances,
  effectiveCoverage,
  findOrder,
  getOrderDetail,
  isDemand,
  loadLines,
  materialProjection,
  openRequirements,
  orderEffectiveCoverage,
  qty,
  rawMaterialInfo,
  unitRef,
  type LineRow,
  type OrderRow,
  type OrderViewer,
} from "./orders.data.js";
import {
  buildPlan,
  planMaterialNeeds,
  resolveLines,
  type OrderPlan,
  type ResolvedLine,
} from "./orders.plan.js";
import {
  priceLine,
  priceListsFor,
  pricedTotals,
  resolvePrices,
  type PricedLine,
} from "../price-lists/pricing.js";
import { lockLots, reservationRemaining } from "./reservations.js";

/*
 * Pedidos de clientes (Fase 5A). Un pedido es un COMPROMISO FUTURO:
 *   DRAFT ──confirmar──▶ CONFIRMED ──▶ IN_PREPARATION ⇄ READY      (CANCELLED desde cualquiera)
 * Confirmar y replanificar son atómicos: reservan lotes FEFO (sin mover stock),
 * registran lo que falta producir con la versión de receta fijada y proyectan
 * las materias primas (sin reservarlas). Cada plan es una revisión numerada.
 *
 * Orden de locks (ADR-053): pedido → líneas → necesidades → lotes (por id) →
 * saldos → reservas. Las operaciones de lote (merma, bloqueo, transformación)
 * toman lote → saldo → reservas y nunca el pedido.
 */

type Dec = InstanceType<typeof D>;
type Db = Database | Transaction;

/* ---------- Errores ---------- */

function orderError(err: unknown): never {
  if (err instanceof OrderError) throw new AppError(409, err.code, err.message);
  throw err;
}

const cancelled = (order: OrderRow) =>
  new AppError(
    409,
    "ORDER_CANCELLED",
    `El pedido ${order.internalCode} está cancelado y no se modifica.`,
  );

const delivered = (order: OrderRow) =>
  new AppError(
    409,
    "ORDER_DELIVERED",
    `El pedido ${order.internalCode} ya se entregó y no se modifica.`,
  );

const partiallyDelivered = (order: OrderRow) =>
  new AppError(
    409,
    "ORDER_PARTIALLY_DELIVERED",
    `El pedido ${order.internalCode} ya tiene entregas: lo pendiente se entrega o se cancela, no se replanifica.`,
  );

const planLocked = (fields: string[]) =>
  new AppError(
    409,
    "ORDER_PLAN_LOCKED",
    "El pedido ya está confirmado: cliente, fecha y productos se cambian con «Modificar pedido» (recalcula reservas y producción).",
    fields.map((path) => ({ path, message: "Se cambia replanificando" })),
  );

const operationReused = () =>
  new AppError(
    409,
    "OPERATION_ID_REUSED",
    "Ese identificador de operación ya se usó para otra acción. Reintentá desde la pantalla.",
  );

/* ---------- Idempotencia ---------- */

/**
 * true si la operación ya se aplicó (reintento): se responde lo mismo sin volver
 * a ejecutar. Se consulta CON el pedido bloqueado, así un reintento concurrente
 * espera al primero y lo ve.
 */
async function alreadyApplied(
  tx: Transaction,
  ctx: OperationContext,
  operationId: string,
  orderId: string,
  action: string,
) {
  const [op] = await tx
    .select()
    .from(customerOrderOperations)
    .where(
      and(
        eq(customerOrderOperations.companyId, ctx.companyId),
        eq(customerOrderOperations.operationId, operationId),
      ),
    );
  if (!op) return false;
  if (op.customerOrderId !== orderId || op.action !== action) throw operationReused();
  return true;
}

async function recordOperation(
  tx: Transaction,
  ctx: OperationContext,
  operationId: string,
  orderId: string,
  action: string,
  planRevision: number,
) {
  // Un id usado en OTRO pedido no pasa por alreadyApplied (otro lock): la PK lo frena.
  const [existing] = await tx
    .select({ orderId: customerOrderOperations.customerOrderId })
    .from(customerOrderOperations)
    .where(
      and(
        eq(customerOrderOperations.companyId, ctx.companyId),
        eq(customerOrderOperations.operationId, operationId),
      ),
    );
  if (existing) throw operationReused();
  await tx.insert(customerOrderOperations).values({
    companyId: ctx.companyId,
    operationId,
    customerOrderId: orderId,
    action,
    planRevision,
    createdByUserId: ctx.userId,
  });
}

/* ---------- Referencias ---------- */

async function assertCustomer(db: Db, ctx: OperationContext, id: string) {
  const [row] = await db
    .select({ id: customers.id, active: customers.active })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, id)));
  if (!row || !row.active) throw invalidReference("customerId", "Cliente inexistente o inactivo");
}

function toInstant(local: string, ctx: OperationContext) {
  return zonedLocalToInstant(local, ctx.timezone);
}

/** Líneas guardadas como entrada; `manualPrices`: reenvía los precios cargados a mano. */
const lineInputsOf = (lines: readonly LineRow[], manualPrices = false): OrderLineInput[] =>
  lines.map((l) => ({
    id: l.id,
    productId: l.productId,
    quantity: l.requestedQuantity,
    unitId: l.unitId,
    requestedConservation: l.requestedConservation,
    notes: l.notes,
    priceOverrideReason: null,
    ...(manualPrices && l.priceSource === "MANUAL"
      ? {
          unitPrice: l.quotedUnitPrice ?? undefined,
          discountAmount: l.quotedDiscountAmount ?? undefined,
          priceOverrideReason: l.priceOverrideReason,
        }
      : {}),
  }));

const lineValues = (
  ctx: OperationContext,
  orderId: string,
  line: ResolvedLine,
  priced?: PricedLine | null,
) => ({
  companyId: ctx.companyId,
  customerOrderId: orderId,
  productId: line.product.id,
  requestedQuantity: line.quantity,
  unitId: line.unit.id,
  normalizedQuantity: line.normalized.toFixed(10),
  saleUnitId: line.saleUnit.id,
  requestedConservation: line.requestedConservation,
  notes: line.notes,
  sortOrder: line.index,
  ...(priced === undefined ? {} : priceValues(priced)),
});

/** Columnas de cotización de una línea (null = sin precio). */
const priceValues = (priced: PricedLine | null) => ({
  quotedUnitPrice: priced?.unitPrice ?? null,
  quotedDiscountAmount: priced?.discountAmount ?? null,
  quotedNetAmount: priced?.netAmount ?? null,
  priceSource: priced?.priceSource ?? null,
  priceOverrideReason: priced?.priceOverrideReason ?? null,
});

/* ---------- Precios del pedido (Fase 5B, ADR-060) ---------- */

/**
 * Cotiza las líneas: precio vigente para el cliente salvo que `keep(prev)`
 * conserve el precio ya cotizado de la línea existente. Un precio cargado
 * distinto es un override (permiso + motivo).
 */
async function priceOrderLines(
  db: Db,
  ctx: OperationContext,
  customerId: string,
  lines: readonly ResolvedLine[],
  opts: {
    existing?: ReadonlyMap<string, LineRow>;
    keep?: (prev: LineRow) => boolean;
    permissions: Iterable<string>;
    pathOf?: (line: ResolvedLine) => string;
  },
): Promise<PricedLine[]> {
  const prices = await resolvePrices(
    db,
    ctx,
    customerId,
    lines.map((l) => l.product.id),
  );
  return lines.map((line) => {
    const prev = line.id ? opts.existing?.get(line.id) : undefined;
    const kept =
      prev && prev.quotedUnitPrice !== null && prev.priceSource !== null && opts.keep?.(prev);
    const current = prices.get(line.product.id)!;
    const base = kept
      ? {
          unitPrice: prev.quotedUnitPrice!,
          discountAmount: prev.quotedDiscountAmount,
          source: prev.priceSource!,
          reason: prev.priceOverrideReason,
        }
      : { unitPrice: current.unitPrice, discountAmount: "0", source: current.source };
    return priceLine({
      quantity: line.normalized,
      base,
      input: line.price,
      permissions: opts.permissions,
      path: opts.pathOf ? opts.pathOf(line) : `lines.${line.index}`,
    });
  });
}

/** Totales y lista vigente del pedido cotizado. */
async function quoteTotals(
  db: Db,
  ctx: OperationContext,
  customerId: string,
  priced: readonly PricedLine[],
) {
  const { customerList, companyDefault } = await priceListsFor(db, ctx, customerId);
  const totals = pricedTotals(priced);
  return {
    priceListId: (customerList ?? companyDefault)?.id ?? null,
    quotedSubtotal: totals.subtotal,
    quotedDiscountTotal: totals.discountTotal,
    quotedTotal: totals.total,
  };
}

/** Auditoría de cada precio cambiado a mano. */
async function auditOverrides(
  tx: Transaction,
  ctx: OperationContext,
  order: { id: string; internalCode: string },
  lines: readonly ResolvedLine[],
  priced: readonly PricedLine[],
) {
  for (const [i, p] of priced.entries()) {
    const line = lines[i]!;
    const explicit = line.price.unitPrice !== undefined || line.price.discountAmount !== undefined;
    if (!p.overridden || !explicit) continue;
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "SALE_PRICE_OVERRIDDEN",
      entityType: "customer_order",
      entityId: order.id,
      metadata: {
        code: order.internalCode,
        product: line.product.name,
        agreedUnitPrice: p.agreedUnitPrice,
        agreedDiscountAmount: p.agreedDiscountAmount,
        unitPrice: p.unitPrice,
        discountAmount: p.discountAmount,
        reason: p.priceOverrideReason,
      },
    });
  }
}

const summarize = (lines: readonly ResolvedLine[]) =>
  lines.map((l) => `${l.normalized.toString()} ${l.saleUnit.symbol} ${l.product.name}`).join(", ");

/* ---------- Listado y detalle ---------- */

type ListQuery = z.infer<typeof orderListQuerySchema>;

export async function listOrders(
  db: Database,
  ctx: OperationContext,
  query: ListQuery,
): Promise<Page<OrderListItemDto>> {
  const nextDay = (date: string) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  const shortage = sql`exists (
    select 1 from order_production_requirements r
    where r.company_id = "customer_orders"."company_id"
      and r.customer_order_id = "customer_orders"."id"
      and r.status in ('OPEN', 'PRODUCTION_CREATED')
  )`;
  const where = and(
    eq(customerOrders.companyId, ctx.companyId),
    query.status === "all"
      ? undefined
      : query.status === "active"
        ? sql`${customerOrders.status} <> 'CANCELLED'`
        : eq(customerOrders.status, query.status),
    query.coverage ? sql`(${effectiveCoverage}) = ${query.coverage}` : undefined,
    query.customerId ? eq(customerOrders.customerId, query.customerId) : undefined,
    query.priority ? eq(customerOrders.priority, query.priority) : undefined,
    query.from ? gte(customerOrders.requestedAt, toInstant(`${query.from}T00:00`, ctx)) : undefined,
    query.to
      ? lt(customerOrders.requestedAt, toInstant(`${nextDay(query.to)}T00:00`, ctx))
      : undefined,
    query.upcoming ? gte(customerOrders.requestedAt, new Date()) : undefined,
    query.withShortage ? shortage : undefined,
    query.search
      ? or(
          ilike(customerOrders.internalCode, likePattern(query.search)),
          ilike(customerOrders.eventName, likePattern(query.search)),
          ilike(customers.legalName, likePattern(query.search)),
          ilike(customers.tradeName, likePattern(query.search)),
        )
      : undefined,
  );
  const base = db
    .select({
      order: customerOrders,
      coverage: effectiveCoverage,
      customer: {
        id: customers.id,
        code: customers.internalCode,
        name: sql<string>`coalesce(${customers.tradeName}, ${customers.legalName})`,
      },
    })
    .from(customerOrders)
    .innerJoin(customers, eq(customers.id, customerOrders.customerId))
    .where(where);
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(customerOrders)
    .innerJoin(customers, eq(customers.id, customerOrders.customerId))
    .where(where);
  const rows = await base
    .orderBy(asc(customerOrders.requestedAt), asc(customerOrders.internalCode))
    .limit(pageWindow(query).limit)
    .offset(pageWindow(query).offset);
  const ids = rows.map((r) => r.order.id);
  const units = await loadUnits(db, ctx);
  const lines =
    ids.length === 0
      ? []
      : await db
          .select({
            orderId: customerOrderLines.customerOrderId,
            productId: customerOrderLines.productId,
            quantity: customerOrderLines.normalizedQuantity,
            unitId: customerOrderLines.saleUnitId,
            name: sql<string>`(select p.name from products p where p.id = ${customerOrderLines.productId})`,
          })
          .from(customerOrderLines)
          .where(
            and(
              eq(customerOrderLines.companyId, ctx.companyId),
              inArray(customerOrderLines.customerOrderId, ids),
              sql`${customerOrderLines.removedAt} is null`,
            ),
          )
          .orderBy(asc(customerOrderLines.sortOrder));
  const requirements =
    ids.length === 0
      ? []
      : await db
          .select({
            orderId: orderProductionRequirements.customerOrderId,
            productId: orderProductionRequirements.productId,
            quantity: orderProductionRequirements.requiredOutputQuantity,
            unitId: orderProductionRequirements.outputUnitId,
            name: sql<string>`(select p.name from products p where p.id = ${orderProductionRequirements.productId})`,
          })
          .from(orderProductionRequirements)
          .where(
            and(
              eq(orderProductionRequirements.companyId, ctx.companyId),
              inArray(orderProductionRequirements.customerOrderId, ids),
              inArray(orderProductionRequirements.status, [...OPEN_REQUIREMENT]),
            ),
          );
  const group = (
    items: { orderId: string; productId: string; quantity: string; unitId: string; name: string }[],
    orderId: string,
  ) => {
    const byProduct = new Map<string, { name: string; quantity: Dec; unit: string }>();
    for (const i of items.filter((x) => x.orderId === orderId)) {
      const prev = byProduct.get(i.productId);
      byProduct.set(i.productId, {
        name: i.name,
        quantity: (prev?.quantity ?? new D(0)).plus(i.quantity),
        unit: unitOrThrow(units, i.unitId).symbol,
      });
    }
    return [...byProduct.values()].map((v) => ({
      name: v.name,
      quantity: v.quantity.toDecimalPlaces(6).toString(),
      unit: v.unit,
    }));
  };
  return toPage(
    rows.map(({ order, coverage, customer }) => ({
      id: order.id,
      code: order.internalCode,
      customer,
      requestedAt: order.requestedAt.toISOString(),
      requestedAtLocal: instantToZonedLocal(order.requestedAt, ctx.timezone),
      fulfillmentType: order.fulfillmentType,
      priority: order.priority,
      status: order.status,
      coverageStatus: coverage,
      planRevision: order.planRevision,
      eventName: order.eventName,
      products: group(lines, order.id),
      shortages: group(requirements, order.id),
      pricingStatus: order.pricingStatus,
    })),
    total,
    query,
  );
}

export function getOrder(db: Database, ctx: OperationContext, id: string, viewer: OrderViewer) {
  return getOrderDetail(db, ctx, id, viewer);
}

/* ---------- Alta y edición ---------- */

export async function createOrder(
  db: Database,
  ctx: OperationContext,
  input: CreateOrderInput,
  viewer: OrderViewer,
): Promise<OrderDetailDto> {
  const id = await db.transaction(async (tx) => {
    await assertCustomer(tx, ctx, input.customerId);
    const units = await loadUnits(tx, ctx);
    const lines = await resolveLines(tx, ctx, input.lines, units);
    const priced = await priceOrderLines(tx, ctx, input.customerId, lines, {
      permissions: viewer.permissions,
    });
    const quote = await quoteTotals(tx, ctx, input.customerId, priced);
    const requestedAt = toInstant(input.requestedAt, ctx);
    const code = await allocateCode(tx, ctx.companyId, "CUSTOMER_ORDER", async (c) => {
      const taken = await tx
        .select({ id: customerOrders.id })
        .from(customerOrders)
        .where(and(eq(customerOrders.companyId, ctx.companyId), eq(customerOrders.internalCode, c)))
        .limit(1);
      return taken.length > 0;
    });
    const [order] = await tx
      .insert(customerOrders)
      .values({
        companyId: ctx.companyId,
        internalCode: code,
        customerId: input.customerId,
        requestedAt,
        fulfillmentType: input.fulfillmentType,
        deliveryAddress: input.deliveryAddress,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        eventName: input.eventName,
        priority: input.priority,
        notes: input.notes,
        pricingStatus: "QUOTED",
        ...quote,
        createdByUserId: ctx.userId,
      })
      .returning();
    await tx
      .insert(customerOrderLines)
      .values(lines.map((l, i) => lineValues(ctx, order!.id, l, priced[i]!)));
    await auditOverrides(tx, ctx, order!, lines, priced);
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "ORDER_CREATED",
      entityType: "customer_order",
      entityId: order!.id,
      metadata: {
        code,
        requestedAt: requestedAt.toISOString(),
        requestedAtLocal: input.requestedAt,
        timezone: ctx.timezone,
        lines: summarize(lines),
        quotedTotal: quote.quotedTotal,
      },
    });
    return order!.id;
  });
  return getOrderDetail(db, ctx, id, viewer);
}

/**
 * En borrador se cambia todo (las líneas se reemplazan). Confirmado, sólo los
 * datos que no afectan la planificación (contacto, entrega, prioridad, notas):
 * fecha y productos se cambian replanificando.
 */
export async function updateOrder(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: UpdateOrderInput,
  viewer: OrderViewer,
): Promise<OrderDetailDto> {
  await db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    if (order.status === "CANCELLED") throw cancelled(order);
    if (order.status === "DELIVERED") throw delivered(order);
    const structural = (["customerId", "requestedAt", "lines"] as const).filter(
      (f) => input[f] !== undefined,
    );
    if (order.status !== "DRAFT" && structural.length > 0) throw planLocked([...structural]);
    const values: Partial<typeof customerOrders.$inferInsert> = {};
    for (const field of ORDER_INFO_FIELDS) {
      if (input[field] !== undefined) (values as Record<string, unknown>)[field] = input[field];
    }
    if (input.customerId !== undefined) {
      await assertCustomer(tx, ctx, input.customerId);
      values.customerId = input.customerId;
    }
    if (input.requestedAt !== undefined) values.requestedAt = toInstant(input.requestedAt, ctx);
    let linesSummary: string | undefined;
    if (order.status === "DRAFT" && (input.lines !== undefined || input.customerId !== undefined)) {
      // Borrador: se recotiza con los precios vigentes del cliente (los cargados a mano se envían).
      const units = await loadUnits(tx, ctx);
      const customerId = input.customerId ?? order.customerId;
      const lines = await resolveLines(
        tx,
        ctx,
        input.lines ?? lineInputsOf(await loadLines(tx, ctx, order.id), true),
        units,
      );
      const priced = await priceOrderLines(tx, ctx, customerId, lines, {
        permissions: viewer.permissions,
      });
      Object.assign(values, { pricingStatus: "QUOTED" }, await quoteTotals(tx, ctx, customerId, priced));
      await tx
        .delete(customerOrderLines)
        .where(
          and(
            eq(customerOrderLines.companyId, ctx.companyId),
            eq(customerOrderLines.customerOrderId, order.id),
          ),
        );
      await tx
        .insert(customerOrderLines)
        .values(lines.map((l, i) => lineValues(ctx, order.id, l, priced[i]!)));
      await auditOverrides(tx, ctx, order, lines, priced);
      linesSummary = summarize(lines);
    }
    const [after] = await tx
      .update(customerOrders)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(customerOrders.id, order.id))
      .returning();
    const changes = diffChanges(order, after!, [...ORDER_INFO_FIELDS, "customerId", "requestedAt"]);
    if (Object.keys(changes).length === 0 && linesSummary === undefined) return;
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "ORDER_UPDATED",
      entityType: "customer_order",
      entityId: order.id,
      metadata: {
        code: order.internalCode,
        changes,
        ...(linesSummary ? { lines: linesSummary } : {}),
      },
    });
  });
  return getOrderDetail(db, ctx, id, viewer);
}

/* ---------- Vista previa ---------- */

/** Plan → DTO de cobertura (vista previa y comparación del replan). */
async function previewDto(
  db: Db,
  ctx: OperationContext,
  plan: OrderPlan,
  excludeOrderId: string | null,
  units: Map<string, UnitRow>,
): Promise<CoveragePreviewDto> {
  const needs = planMaterialNeeds(plan);
  const projection = await materialProjection(db, ctx, needs, excludeOrderId, units);
  const info = await rawMaterialInfo(
    db,
    ctx,
    plan.lines.flatMap((l) => l.materials.map((m) => m.rawMaterialId)),
  );
  const lines: LineCoverageDto[] = plan.lines.map((p) => {
    const reserveByLot = new Map(p.allocations.map((a) => [a.lot.id, a.quantity]));
    return {
      product: { id: p.line.product.id, code: p.line.product.code, name: p.line.product.name },
      unit: unitRef(p.line.saleUnit),
      requestedConservation: p.line.requestedConservation,
      requested: qty(p.line.normalized),
      physical: qty(p.availability.physicalQuantity),
      eligible: qty(p.availability.eligibleQuantity),
      committed: qty(p.availability.committedQuantity),
      available: qty(p.availability.availableQuantity),
      reserve: qty(p.reserved),
      toProduce: qty(p.toProduce),
      uncovered: qty(p.uncovered),
      ineligible: Object.entries(p.availability.ineligibleByReason)
        .filter(([, q]) => q.gt(0))
        .map(([reason, q]) => ({
          reason: reason as LineCoverageDto["ineligible"][number]["reason"],
          quantity: qty(q),
          label:
            reason === "EXPIRED"
              ? "Vence antes de la fecha"
              : reason === "BLOCKED"
                ? "Bloqueado por calidad"
                : "Otra conservación",
        })),
      shelfLifeUnknown: qty(p.availability.shelfLifeUnknownAvailable),
      recipe: p.recipe
        ? {
            id: p.recipe.recipeId,
            versionId: p.recipe.versionId,
            versionNumber: p.recipe.versionNumber,
          }
        : null,
      problem: p.problem,
      explanation: p.explanation,
      materials: p.materials.map((m) => {
        const raw = info.get(m.rawMaterialId)!;
        return {
          rawMaterial: { id: raw.id, code: raw.code, name: raw.name },
          unit: unitRef(unitOrThrow(units, raw.baseUnitId)),
          required: qty(m.required),
        };
      }),
      lots: p.availability.lots.map((v) => ({
        id: v.lot.row.lot.id,
        code: v.lot.row.lot.lotCode,
        conservationState: v.lot.row.lot.conservationState,
        warehouse: v.lot.row.warehouse,
        usableUntil: v.lot.row.lot.usableUntil?.toISOString() ?? null,
        physical: qty(v.physical),
        committed: qty(v.committed),
        available: qty(v.available),
        eligible: v.eligible,
        reason: v.reason,
        reserve: qty(reserveByLot.get(v.lot.id) ?? 0),
      })),
    };
  });
  return {
    requestedAt: plan.requestedAt.toISOString(),
    requestedAtLocal: plan.requestedAtLocal,
    timezone: ctx.timezone,
    coverageStatus: plan.coverage,
    lines,
    materials: projection,
  };
}

/** Vista previa de cobertura de un pedido sin guardar. No escribe ni bloquea. */
export async function previewCoverage(
  db: Database,
  ctx: OperationContext,
  input: CoveragePreviewInput,
): Promise<CoveragePreviewDto> {
  const units = await loadUnits(db, ctx);
  const lines = await resolveLines(db, ctx, input.lines, units);
  const plan = await buildPlan(db, ctx, {
    requestedAt: toInstant(input.requestedAt, ctx),
    lines,
    units,
  });
  return previewDto(db, ctx, plan, null, units);
}

/** Vista previa de un borrador guardado: qué pasaría al confirmarlo ahora. */
export async function previewDraft(
  db: Database,
  ctx: OperationContext,
  id: string,
): Promise<CoveragePreviewDto> {
  const order = await findOrder(db, ctx, id);
  if (order.status !== "DRAFT") {
    throw new AppError(
      409,
      "ORDER_NOT_DRAFT",
      "Sólo un borrador tiene vista previa de confirmación.",
    );
  }
  const units = await loadUnits(db, ctx);
  const lines = await resolveLines(db, ctx, lineInputsOf(await loadLines(db, ctx, id)), units);
  const plan = await buildPlan(db, ctx, { requestedAt: order.requestedAt, lines, units });
  return previewDto(db, ctx, plan, null, units);
}

/* ---------- Aplicar un plan ---------- */

/**
 * Persiste un plan como revisión `revision`: reservas por lote, necesidades de
 * producción (con versión de receta fijada) y su snapshot de materias primas.
 * Los lotes ya están bloqueados (buildPlan con lock) y las reservas anteriores
 * liberadas: el trigger de capacidad es la última barrera.
 */
async function applyPlan(
  tx: Transaction,
  ctx: OperationContext,
  order: OrderRow,
  plan: OrderPlan,
  lineIds: readonly string[],
  revision: number,
) {
  const reservedLots: string[] = [];
  for (const [i, p] of plan.lines.entries()) {
    const lineId = lineIds[i]!;
    for (const a of p.allocations) {
      await tx.insert(productLotReservations).values({
        companyId: ctx.companyId,
        customerOrderId: order.id,
        orderLineId: lineId,
        productId: p.line.product.id,
        productLotId: a.lot.id,
        quantity: qty(a.quantity),
        unitId: p.line.saleUnit.id,
        planRevision: revision,
        status: "ACTIVE",
        createdByUserId: ctx.userId,
      });
      reservedLots.push(
        `${a.lot.row.lot.lotCode}: ${a.quantity.toString()} ${p.line.saleUnit.symbol}`,
      );
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "LOT_RESERVED",
        entityType: "customer_order",
        entityId: order.id,
        metadata: {
          code: order.internalCode,
          lot: a.lot.row.lot.lotCode,
          lotId: a.lot.id,
          product: p.line.product.name,
          quantity: qty(a.quantity),
          unit: p.line.saleUnit.symbol,
          planRevision: revision,
        },
      });
    }
    const need = p.toProduce.plus(p.uncovered);
    if (!need.gt(0)) continue;
    const [requirement] = await tx
      .insert(orderProductionRequirements)
      .values({
        companyId: ctx.companyId,
        customerOrderId: order.id,
        orderLineId: lineId,
        productId: p.line.product.id,
        requiredOutputQuantity: qty(need),
        outputUnitId: p.line.saleUnit.id,
        recipeId: p.recipe?.recipeId ?? p.recipeId,
        recipeVersionId: p.recipe?.versionId ?? null,
        problem: p.problem,
        planRevision: revision,
        status: "OPEN",
        createdByUserId: ctx.userId,
      })
      .returning();
    if (p.materials.length > 0) {
      const info = await rawMaterialInfo(
        tx,
        ctx,
        p.materials.map((m) => m.rawMaterialId),
      );
      await tx.insert(orderMaterialRequirements).values(
        p.materials.map((m) => ({
          companyId: ctx.companyId,
          orderProductionRequirementId: requirement!.id,
          customerOrderId: order.id,
          rawMaterialId: m.rawMaterialId,
          requiredQuantity: qty(m.required),
          baseUnitId: info.get(m.rawMaterialId)!.baseUnitId,
          recipeVersionId: p.recipe!.versionId,
          planRevision: revision,
        })),
      );
    }
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "ORDER_PRODUCTION_REQUIREMENT_CREATED",
      entityType: "customer_order",
      entityId: order.id,
      metadata: {
        code: order.internalCode,
        requirementId: requirement!.id,
        product: p.line.product.name,
        quantity: qty(need),
        unit: p.line.saleUnit.symbol,
        recipeVersion: p.recipe?.versionNumber ?? null,
        problem: p.problem,
        planRevision: revision,
      },
    });
  }
  return reservedLots;
}

/* ---------- Confirmar ---------- */

export async function confirmOrder(
  db: Database,
  ctx: OperationContext,
  id: string,
  operationId: string,
  viewer: OrderViewer,
): Promise<OrderOperationResultDto> {
  const replayed = await db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    if (await alreadyApplied(tx, ctx, operationId, order.id, "CONFIRM")) return true;
    if (order.status === "CANCELLED") throw cancelled(order);
    try {
      assertOrderTransition(order.status, "CONFIRMED");
    } catch (err) {
      orderError(err);
    }
    await assertCustomer(tx, ctx, order.customerId);
    const lineRows = await loadLines(tx, ctx, order.id, true);
    const units = await loadUnits(tx, ctx);
    const lines = await resolveLines(tx, ctx, lineInputsOf(lineRows), units);
    const plan = await buildPlan(tx, ctx, {
      requestedAt: order.requestedAt,
      lines,
      lock: true,
      units,
    });
    const revision = 1;
    const reserved = await applyPlan(
      tx,
      ctx,
      order,
      plan,
      lineRows.map((l) => l.id),
      revision,
    );
    // Precio: se congela al confirmar. Lo cargado a mano se conserva; el resto,
    // al precio vigente de hoy para el cliente (ADR-060).
    const priced = await priceOrderLines(tx, ctx, order.customerId, lines, {
      existing: new Map(lineRows.map((l) => [l.id, l])),
      keep: (prev) => prev.priceSource === "MANUAL",
      permissions: viewer.permissions,
    });
    for (const [i, row] of lineRows.entries()) {
      await tx
        .update(customerOrderLines)
        .set({ ...priceValues(priced[i]!), updatedAt: new Date() })
        .where(eq(customerOrderLines.id, row.id));
    }
    const quote = await quoteTotals(tx, ctx, order.customerId, priced);
    const now = new Date();
    await tx
      .update(customerOrders)
      .set({
        status: "CONFIRMED",
        pricingStatus: "AGREED",
        ...quote,
        coverageStatus: plan.coverage,
        planRevision: revision,
        confirmedAt: now,
        confirmedByUserId: ctx.userId,
        updatedAt: now,
      })
      .where(eq(customerOrders.id, order.id));
    await recordOperation(tx, ctx, operationId, order.id, "CONFIRM", revision);
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "ORDER_CONFIRMED",
      entityType: "customer_order",
      entityId: order.id,
      metadata: {
        code: order.internalCode,
        planRevision: revision,
        coverage: plan.coverage,
        requestedAtLocal: plan.requestedAtLocal,
        quotedTotal: quote.quotedTotal,
        reserved,
        toProduce: plan.lines
          .filter((p) => p.toProduce.plus(p.uncovered).gt(0))
          .map(
            (p) =>
              `${p.toProduce.plus(p.uncovered).toString()} ${p.line.saleUnit.symbol} ${p.line.product.name}`,
          ),
      },
    });
    return false;
  });
  return { order: await getOrderDetail(db, ctx, id, viewer), replayed };
}

/* ---------- Replanificar ---------- */

interface ReplanSetup {
  order: OrderRow;
  currentLines: LineRow[];
  lines: ResolvedLine[];
  requestedAt: Date;
  /** Necesidades abiertas actuales con su orden de producción. */
  requirements: {
    r: typeof orderProductionRequirements.$inferSelect;
    productionStatus: string | null;
  }[];
  inFlightByLine: Map<string, Dec>;
  units: Map<string, UnitRow>;
}

const IN_FLIGHT = ["DRAFT", "PLANNED", "IN_PROGRESS"];

/** Valida el cambio pedido y arma las líneas nuevas (sin escribir). */
async function prepareReplan(
  db: Db,
  ctx: OperationContext,
  order: OrderRow,
  input: ReplanPreviewInput,
  lock: boolean,
): Promise<ReplanSetup> {
  if (order.status === "CANCELLED") throw cancelled(order);
  if (order.status === "DELIVERED") throw delivered(order);
  if (order.status === "PARTIALLY_DELIVERED") throw partiallyDelivered(order);
  if (!isDemand(order.status)) {
    throw new AppError(
      409,
      "ORDER_NOT_CONFIRMED",
      "Sólo un pedido confirmado se replanifica; un borrador se edita directamente.",
    );
  }
  const currentLines = await loadLines(db, ctx, order.id, lock);
  const byId = new Map(currentLines.map((l) => [l.id, l]));
  const inputs = input.lines ?? lineInputsOf(currentLines);
  const seen = new Set<string>();
  inputs.forEach((l, i) => {
    if (!l.id) return;
    const current = byId.get(l.id);
    if (!current || seen.has(l.id)) {
      throw invalidReference(`lines.${i}.id`, "La línea no es de este pedido");
    }
    if (current.productId !== l.productId) {
      throw invalidReference(
        `lines.${i}.productId`,
        "Una línea existente no cambia de producto: quitala y agregá otra",
      );
    }
    seen.add(l.id);
  });
  const units = await loadUnits(db, ctx);
  const lines = await resolveLines(db, ctx, inputs, units);
  const reqQuery = db
    .select({ r: orderProductionRequirements, productionStatus: productionOrders.status })
    .from(orderProductionRequirements)
    .leftJoin(
      productionOrders,
      eq(productionOrders.id, orderProductionRequirements.linkedProductionOrderId),
    )
    .where(
      and(
        eq(orderProductionRequirements.companyId, ctx.companyId),
        eq(orderProductionRequirements.customerOrderId, order.id),
        inArray(orderProductionRequirements.status, [...OPEN_REQUIREMENT]),
      ),
    )
    .orderBy(asc(orderProductionRequirements.id));
  const requirements = lock
    ? await reqQuery.for("update", { of: orderProductionRequirements })
    : await reqQuery;
  const keptLineIds = new Set(lines.map((l) => l.id).filter(Boolean));
  const inFlightByLine = new Map<string, Dec>();
  for (const { r, productionStatus } of requirements) {
    if (
      r.status === "PRODUCTION_CREATED" &&
      productionStatus &&
      IN_FLIGHT.includes(productionStatus) &&
      keptLineIds.has(r.orderLineId)
    ) {
      inFlightByLine.set(
        r.orderLineId,
        (inFlightByLine.get(r.orderLineId) ?? new D(0)).plus(r.requiredOutputQuantity),
      );
    }
  }
  return {
    order,
    currentLines,
    lines,
    requestedAt: input.requestedAt ? toInstant(input.requestedAt, ctx) : order.requestedAt,
    requirements,
    inFlightByLine,
    units,
  };
}

/** Qué pasaría al replanificar: reservas que se liberan y toman, producción y materias primas. */
export async function previewReplan(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: ReplanPreviewInput,
): Promise<ReplanPreviewDto> {
  const order = await findOrder(db, ctx, id);
  const setup = await prepareReplan(db, ctx, order, input, false);
  const plan = await buildPlan(db, ctx, {
    requestedAt: setup.requestedAt,
    lines: setup.lines,
    excludeOrderId: order.id,
    inFlightByLine: setup.inFlightByLine,
    units: setup.units,
  });
  const units = setup.units;
  const proposed = await previewDto(db, ctx, plan, order.id, units);
  const active = await activeReservations(db, ctx, order.id);
  const lotCodes = new Map<string, string>();
  for (const v of plan.lines.flatMap((p) => p.availability.lots))
    lotCodes.set(v.lot.id, v.lot.code);
  const productIds = [
    ...new Set([
      ...setup.currentLines.map((l) => l.productId),
      ...setup.lines.map((l) => l.product.id),
    ]),
  ];
  const productNames = new Map(
    (
      await db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(and(eq(products.companyId, ctx.companyId), inArray(products.id, productIds)))
    ).map((p) => [p.id, p.name]),
  );
  const unitSymbol = (unitId: string) => unitOrThrow(units, unitId).symbol;

  // Producción: antes = necesidades abiertas; después = en curso conservadas + nuevas.
  const production = new Map<string, { product: string; unit: string; before: Dec; after: Dec }>();
  const bump = (pid: string, unit: string, key: "before" | "after", q: Dec | string) => {
    const cur = production.get(pid) ?? {
      product: productNames.get(pid) ?? "",
      unit,
      before: new D(0),
      after: new D(0),
    };
    cur[key] = cur[key].plus(q);
    production.set(pid, cur);
  };
  for (const { r } of setup.requirements)
    bump(r.productId, unitSymbol(r.outputUnitId), "before", r.requiredOutputQuantity);
  for (const p of plan.lines) {
    bump(
      p.line.product.id,
      p.line.saleUnit.symbol,
      "after",
      p.toProduce.plus(p.uncovered).plus(p.inFlight),
    );
  }

  // Materias primas: antes = snapshot abierto; después = conservadas + plan nuevo.
  const materialRows = setup.requirements.length
    ? await db
        .select()
        .from(orderMaterialRequirements)
        .where(
          and(
            eq(orderMaterialRequirements.companyId, ctx.companyId),
            inArray(
              orderMaterialRequirements.orderProductionRequirementId,
              setup.requirements.map((r) => r.r.id),
            ),
          ),
        )
    : [];
  const keptIds = new Set(
    setup.requirements
      .filter(
        ({ r, productionStatus }) =>
          r.status === "PRODUCTION_CREATED" &&
          productionStatus &&
          IN_FLIGHT.includes(productionStatus) &&
          setup.lines.some((l) => l.id === r.orderLineId),
      )
      .map(({ r }) => r.id),
  );
  const material = new Map<string, { before: Dec; after: Dec }>();
  const mBump = (rid: string, key: "before" | "after", q: Dec | string) => {
    const cur = material.get(rid) ?? { before: new D(0), after: new D(0) };
    cur[key] = cur[key].plus(q);
    material.set(rid, cur);
  };
  for (const m of materialRows) {
    mBump(m.rawMaterialId, "before", m.requiredQuantity);
    if (keptIds.has(m.orderProductionRequirementId))
      mBump(m.rawMaterialId, "after", m.requiredQuantity);
  }
  for (const [rid, q] of planMaterialNeeds(plan)) mBump(rid, "after", q);
  const info = await rawMaterialInfo(db, ctx, [...material.keys()]);

  const fmt = (v: Dec) => v.toDecimalPlaces(6).toString();
  return {
    revisionFrom: order.planRevision,
    revisionTo: order.planRevision + 1,
    currentCoverage: await orderEffectiveCoverage(db, ctx, order.id),
    proposed,
    releasedLots: active.map((r) => ({
      code: lotCodes.get(r.productLotId) ?? "",
      product: productNames.get(r.productId) ?? "",
      quantity: fmt(reservationRemaining(r)),
      unit: unitSymbol(r.unitId),
    })),
    newLots: plan.lines.flatMap((p) =>
      p.allocations.map((a) => ({
        code: a.lot.code,
        product: p.line.product.name,
        quantity: fmt(a.quantity),
        unit: p.line.saleUnit.symbol,
      })),
    ),
    productionChange: [...production.values()]
      .filter((p) => !p.before.eq(p.after))
      .map((p) => ({
        product: p.product,
        unit: p.unit,
        before: fmt(p.before),
        after: fmt(p.after),
      })),
    materialChange: [...material.entries()]
      .filter(([, v]) => !v.before.eq(v.after))
      .map(([rid, v]) => {
        const raw = info.get(rid)!;
        return {
          rawMaterial: raw.name,
          unit: unitSymbol(raw.baseUnitId),
          before: fmt(v.before),
          after: fmt(v.after),
        };
      }),
  };
}

/**
 * REPLAN explícito (también "actualizar cobertura" sin cambios): nueva revisión
 * del plan. Libera las reservas actuales, cancela las necesidades que ya no
 * corresponden (conserva las que tienen producción en curso y cierra las
 * cumplidas) y vuelve a reservar y calcular, todo en una transacción. La
 * historia de revisiones anteriores queda intacta.
 */
export async function replanOrder(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: ReplanOrderInput,
  viewer: OrderViewer,
): Promise<OrderOperationResultDto> {
  const replayed = await db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    if (await alreadyApplied(tx, ctx, input.operationId, order.id, "REPLAN")) return true;
    const setup = await prepareReplan(tx, ctx, order, input, true);
    const active = await activeReservations(tx, ctx, order.id);
    const plan = await buildPlan(tx, ctx, {
      requestedAt: setup.requestedAt,
      lines: setup.lines,
      excludeOrderId: order.id,
      lock: true,
      extraLotIds: active.map((r) => r.productLotId),
      inFlightByLine: setup.inFlightByLine,
      units: setup.units,
    });
    const now = new Date();
    const revision = order.planRevision + 1;

    // 1. Reservas actuales: se liberan (bloqueadas después de los lotes).
    const toRelease = await activeReservations(tx, ctx, order.id, true);
    if (toRelease.length > 0) {
      await tx
        .update(productLotReservations)
        .set({
          status: "RELEASED",
          releasedAt: now,
          releaseReason: "ORDER_REPLANNED",
          releasedByUserId: ctx.userId,
        })
        .where(
          inArray(
            productLotReservations.id,
            toRelease.map((r) => r.id),
          ),
        );
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "LOT_RESERVATION_RELEASED",
        entityType: "customer_order",
        entityId: order.id,
        metadata: {
          code: order.internalCode,
          reason: "ORDER_REPLANNED",
          planRevision: order.planRevision,
          reservations: toRelease.length,
          quantity: toRelease.reduce((s, r) => s.plus(reservationRemaining(r)), new D(0)).toString(),
        },
      });
    }

    // 2. Necesidades actuales: cumplidas → SATISFIED; en curso → se conservan; resto → CANCELLED.
    const keptLineIds = new Set(setup.lines.map((l) => l.id).filter(Boolean));
    for (const { r, productionStatus } of setup.requirements) {
      if (productionStatus === "COMPLETED") {
        await tx
          .update(orderProductionRequirements)
          .set({ status: "SATISFIED", closedAt: now })
          .where(eq(orderProductionRequirements.id, r.id));
      } else if (
        r.status === "PRODUCTION_CREATED" &&
        productionStatus &&
        IN_FLIGHT.includes(productionStatus) &&
        keptLineIds.has(r.orderLineId)
      ) {
        continue;
      } else {
        await tx
          .update(orderProductionRequirements)
          .set({ status: "CANCELLED", closedAt: now })
          .where(eq(orderProductionRequirements.id, r.id));
      }
    }

    // 3. Líneas: quitadas, modificadas y nuevas. El precio acordado se conserva
    //    (salvo cambio explícito); las líneas nuevas toman el precio vigente.
    const priced =
      order.pricingStatus === "UNPRICED"
        ? null
        : await priceOrderLines(tx, ctx, order.customerId, setup.lines, {
            existing: new Map(setup.currentLines.map((l) => [l.id, l])),
            keep: () => true,
            permissions: viewer.permissions,
          });
    const lineIds: string[] = [];
    for (const current of setup.currentLines) {
      if (!keptLineIds.has(current.id)) {
        await tx
          .update(customerOrderLines)
          .set({ removedAt: now, updatedAt: now })
          .where(eq(customerOrderLines.id, current.id));
      }
    }
    for (const [i, line] of setup.lines.entries()) {
      const values = lineValues(ctx, order.id, line, priced ? priced[i]! : null);
      if (line.id) {
        await tx
          .update(customerOrderLines)
          .set({
            requestedQuantity: values.requestedQuantity,
            unitId: values.unitId,
            normalizedQuantity: values.normalizedQuantity,
            requestedConservation: values.requestedConservation,
            notes: values.notes,
            sortOrder: values.sortOrder,
            ...(priced ? priceValues(priced[i]!) : {}),
            updatedAt: now,
          })
          .where(eq(customerOrderLines.id, line.id));
        lineIds.push(line.id);
      } else {
        const [row] = await tx.insert(customerOrderLines).values(values).returning();
        lineIds.push(row!.id);
      }
    }

    // 4. Nuevo plan.
    const reserved = await applyPlan(tx, ctx, order, plan, lineIds, revision);
    const status: OrderStatus =
      order.status === "READY" && plan.coverage !== "FULLY_COVERED"
        ? "IN_PREPARATION"
        : order.status;
    const quote = priced ? await quoteTotals(tx, ctx, order.customerId, priced) : null;
    if (priced) await auditOverrides(tx, ctx, order, setup.lines, priced);
    await tx
      .update(customerOrders)
      .set({
        requestedAt: setup.requestedAt,
        coverageStatus: plan.coverage,
        planRevision: revision,
        status,
        ...(quote
          ? {
              quotedSubtotal: quote.quotedSubtotal,
              quotedDiscountTotal: quote.quotedDiscountTotal,
              quotedTotal: quote.quotedTotal,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(customerOrders.id, order.id));
    await recordOperation(tx, ctx, input.operationId, order.id, "REPLAN", revision);
    const before = instantToZonedLocal(order.requestedAt, ctx.timezone);
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "ORDER_REPLANNED",
      entityType: "customer_order",
      entityId: order.id,
      metadata: {
        code: order.internalCode,
        revisionFrom: order.planRevision,
        revisionTo: revision,
        coverageFrom: order.coverageStatus,
        coverageTo: plan.coverage,
        ...(status !== order.status ? { statusFrom: order.status, statusTo: status } : {}),
        ...(plan.requestedAtLocal !== before
          ? {
              requestedAtFrom: formatLocalDateTime(before),
              requestedAtTo: formatLocalDateTime(plan.requestedAtLocal),
            }
          : {}),
        lines: summarize(setup.lines),
        reserved,
      },
    });
    return false;
  });
  return { order: await getOrderDetail(db, ctx, id, viewer), replayed };
}

/* ---------- Cancelar ---------- */

export async function cancelOrder(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: CancelOrderInput,
  viewer: OrderViewer,
): Promise<OrderOperationResultDto> {
  const replayed = await db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    if (await alreadyApplied(tx, ctx, input.operationId, order.id, "CANCEL")) return true;
    if (order.status === "CANCELLED") throw cancelled(order);
    if (order.status === "DELIVERED") throw delivered(order);
    if (order.status === "READY" && !input.confirmReady) {
      throw new AppError(
        409,
        "ORDER_READY_CANCEL_CONFIRMATION",
        `El pedido ${order.internalCode} está listo para entregar: confirmá que querés cancelarlo (se liberan sus reservas).`,
      );
    }
    await loadLines(tx, ctx, order.id, true);
    const requirements = await openRequirements(tx, ctx, order.id, true);
    const current = await activeReservations(tx, ctx, order.id);
    await lockLots(
      tx,
      ctx,
      current.map((r) => r.productLotId),
    );
    const active = await activeReservations(tx, ctx, order.id, true);
    const advance = (await orderAdvances(tx, ctx, order.id)).available;
    const now = new Date();
    if (active.length > 0) {
      await tx
        .update(productLotReservations)
        .set({
          status: "RELEASED",
          releasedAt: now,
          releaseReason: "ORDER_CANCELLED",
          releasedByUserId: ctx.userId,
        })
        .where(
          inArray(
            productLotReservations.id,
            active.map((r) => r.id),
          ),
        );
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "LOT_RESERVATION_RELEASED",
        entityType: "customer_order",
        entityId: order.id,
        metadata: {
          code: order.internalCode,
          reason: "ORDER_CANCELLED",
          planRevision: order.planRevision,
          reservations: active.length,
          quantity: active.reduce((s, r) => s.plus(reservationRemaining(r)), new D(0)).toString(),
        },
      });
    }
    if (requirements.length > 0) {
      await tx
        .update(orderProductionRequirements)
        .set({ status: "CANCELLED", closedAt: now })
        .where(
          inArray(
            orderProductionRequirements.id,
            requirements.map((r) => r.id),
          ),
        );
    }
    await tx
      .update(customerOrders)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancelledByUserId: ctx.userId,
        cancelReason: input.reason,
        updatedAt: now,
      })
      .where(eq(customerOrders.id, order.id));
    await recordOperation(tx, ctx, input.operationId, order.id, "CANCEL", order.planRevision);
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "ORDER_CANCELLED",
      entityType: "customer_order",
      entityId: order.id,
      metadata: {
        code: order.internalCode,
        from: order.status,
        reason: input.reason,
        releasedReservations: active.length,
        cancelledRequirements: requirements.length,
        linkedProduction: requirements.filter((r) => r.linkedProductionOrderId).length,
        ...(advance.gt(0) ? { advanceToCredit: advance.toFixed(2) } : {}),
      },
    });
    return false;
  });
  const result = await getOrderDetail(db, ctx, id, viewer);
  // La seña ya acreditó la cuenta al cobrarse: lo no aplicado queda como crédito a favor.
  const available = (await orderAdvances(db, ctx, id)).available;
  return {
    order: result,
    replayed,
    warnings: available.gt(0)
      ? [
          `La seña sin aplicar ($ ${available.toFixed(2)}) queda como crédito a favor del cliente en su cuenta corriente.`,
        ]
      : [],
  };
}

/* ---------- Preparación y listo ---------- */

export async function startPreparation(
  db: Database,
  ctx: OperationContext,
  id: string,
  viewer: OrderViewer,
): Promise<OrderDetailDto> {
  await db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    if (order.status === "CANCELLED") throw cancelled(order);
    try {
      assertOrderTransition(order.status, "IN_PREPARATION");
    } catch (err) {
      orderError(err);
    }
    const now = new Date();
    await tx
      .update(customerOrders)
      .set({
        status: "IN_PREPARATION",
        preparationStartedAt: order.preparationStartedAt ?? now,
        preparationStartedByUserId: order.preparationStartedByUserId ?? ctx.userId,
        updatedAt: now,
      })
      .where(eq(customerOrders.id, order.id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "ORDER_PREPARATION_STARTED",
      entityType: "customer_order",
      entityId: order.id,
      metadata: { code: order.internalCode, from: order.status },
    });
  });
  return getOrderDetail(db, ctx, id, viewer);
}

/** READY exige todo el producto reservado y ninguna reserva invalidada en el plan vigente. */
export async function markReady(
  db: Database,
  ctx: OperationContext,
  id: string,
  viewer: OrderViewer,
): Promise<OrderDetailDto> {
  await db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    if (order.status === "CANCELLED") throw cancelled(order);
    try {
      assertOrderTransition(order.status, "READY");
    } catch (err) {
      orderError(err);
    }
    const lines = await loadLines(tx, ctx, order.id);
    // FOR SHARE: una merma o bloqueo concurrente espera a que esto termine.
    const active = await tx
      .select()
      .from(productLotReservations)
      .where(
        and(
          eq(productLotReservations.companyId, ctx.companyId),
          eq(productLotReservations.customerOrderId, order.id),
          eq(productLotReservations.status, "ACTIVE"),
        ),
      )
      .for("share");
    const coverage = (await orderEffectiveCoverage(tx, ctx, order.id)) ?? "NOT_COVERED";
    try {
      assertReadyAllowed(
        coverage,
        lines.map((l) => ({
          requested: l.normalizedQuantity,
          reserved: active
            .filter((r) => r.orderLineId === l.id)
            .reduce((s, r) => s.plus(reservationRemaining(r)), new D(0)),
        })),
      );
    } catch (err) {
      orderError(err);
    }
    const now = new Date();
    await tx
      .update(customerOrders)
      .set({ status: "READY", readyAt: now, readyByUserId: ctx.userId, updatedAt: now })
      .where(eq(customerOrders.id, order.id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "ORDER_MARKED_READY",
      entityType: "customer_order",
      entityId: order.id,
      metadata: { code: order.internalCode, from: order.status, planRevision: order.planRevision },
    });
  });
  return getOrderDetail(db, ctx, id, viewer);
}

/* ---------- Cotizar (pedidos sin precio, Fase 5B) ---------- */

/**
 * Fija el precio acordado de un pedido confirmado que no lo tiene (pedidos
 * creados antes de 5B): precio vigente del cliente salvo override explícito.
 * Nunca se inventa: sin esto, el pedido no se entrega (ORDER_UNPRICED).
 */
export async function quoteOrder(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: QuoteOrderInput,
  viewer: OrderViewer,
): Promise<OrderDetailDto> {
  await db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    if (order.status === "CANCELLED") throw cancelled(order);
    if (order.pricingStatus !== "UNPRICED") {
      throw new AppError(
        409,
        "ORDER_ALREADY_PRICED",
        `El pedido ${order.internalCode} ya tiene precio acordado.`,
      );
    }
    if (!isDemand(order.status)) {
      throw new AppError(
        409,
        "ORDER_NOT_CONFIRMED",
        "Sólo se cotiza un pedido confirmado; un borrador toma precio al guardarlo.",
      );
    }
    const lineRows = await loadLines(tx, ctx, order.id, true);
    const byLine = new Map(input.lines.map((l, i) => [l.lineId, { ...l, index: i }]));
    for (const [lineId, l] of byLine) {
      if (!lineRows.some((r) => r.id === lineId)) {
        throw invalidReference(`lines.${l.index}.lineId`, "La línea no es de este pedido");
      }
    }
    const units = await loadUnits(tx, ctx);
    const inputs = lineInputsOf(lineRows).map((l) => {
      const price = byLine.get(l.id!);
      return price
        ? {
            ...l,
            unitPrice: price.unitPrice,
            discountAmount: price.discountAmount,
            priceOverrideReason: price.priceOverrideReason ?? null,
          }
        : l;
    });
    const lines = await resolveLines(tx, ctx, inputs, units);
    const priced = await priceOrderLines(tx, ctx, order.customerId, lines, {
      permissions: viewer.permissions,
      pathOf: (line) => {
        const i = byLine.get(line.id!)?.index;
        return i === undefined ? `lines.${line.index}` : `lines.${i}`;
      },
    });
    const now = new Date();
    for (const [i, row] of lineRows.entries()) {
      await tx
        .update(customerOrderLines)
        .set({ ...priceValues(priced[i]!), updatedAt: now })
        .where(eq(customerOrderLines.id, row.id));
    }
    const quote = await quoteTotals(tx, ctx, order.customerId, priced);
    await tx
      .update(customerOrders)
      .set({ pricingStatus: "AGREED", ...quote, updatedAt: now })
      .where(eq(customerOrders.id, order.id));
    await auditOverrides(tx, ctx, order, lines, priced);
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "ORDER_QUOTED",
      entityType: "customer_order",
      entityId: order.id,
      metadata: {
        code: order.internalCode,
        quotedTotal: quote.quotedTotal,
        lines: lines
          .map((l, i) => `${l.normalized.toString()} ${l.saleUnit.symbol} ${l.product.name} a $ ${priced[i]!.unitPrice}`)
          .join(", "),
      },
    });
  });
  return getOrderDetail(db, ctx, id, viewer);
}
