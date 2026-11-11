import { randomUUID } from "node:crypto";
import {
  D,
  allocateAdvances,
  averageMaterialCost,
  creditLimitCheck,
  materialMargin,
  orderDeliveryStatus,
  saleBalanceDue,
} from "@bakery/domain";
import {
  allocateCode,
  customerOrders,
  customerPayments,
  customers,
  orderProductionRequirements,
  productLotReservations,
  products,
  saleLines,
  saleLotAllocations,
  sales,
  warehouses,
  type Database,
  type Transaction,
} from "@bakery/database";
import {
  NEGATIVE_MARGIN_WARNING,
  PERMISSIONS,
  hasPermissions,
  type CancelSaleInput,
  type CreateSaleInput,
  type OrderLineInput,
  type PostSaleInput,
  type SaleDetailDto,
  type SaleLineInput,
  type SaleOperationResultDto,
  type SalePreviewDto,
  type SalePreviewIssueDto,
  type UpdateSaleInput,
} from "@bakery/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { recordAudit } from "../audit/audit.service.js";
import {
  fixedMoney,
  fixedQty,
  lockProductBalance,
  lockProductCost,
  postLotMovement,
} from "../inventory/ledger.js";
import {
  OPEN_REQUIREMENT,
  deliveredByLine,
  findOrder,
  isDeliverable,
  loadLines,
  orderAdvances,
  type LineRow,
  type OrderRow,
} from "../orders/orders.data.js";
import { resolveLines, type ResolvedLine } from "../orders/orders.plan.js";
import {
  accountBalance,
  allocatePaymentCode,
  applyToSale,
  lockAccount,
  postAccountMovement,
} from "../payments/account.js";
import {
  priceLine,
  priceListsFor,
  pricedTotals,
  resolvePrices,
  type PricedLine,
} from "../price-lists/pricing.js";
import { companyCurrency, loadUnits } from "../recipes/recipes.data.js";
import {
  candidateLotIds,
  loadLotStates,
  lockSaleLots,
  orderReservations,
  planSaleLines,
  type PlannedLine,
} from "./sales.allocation.js";
import {
  findSale,
  getSaleDetail,
  loadSaleLines,
  visibility,
  walkInCustomer,
  type Db,
  type SaleRow,
  type SaleViewer,
} from "./sales.data.js";

/*
 * Ventas (Fase 5B, ADR-058). DRAFT → POSTED | CANCELLED.
 * POSTED = la entrega ocurrió: sale el producto (movimientos SALE por lote),
 * se congelan costo, precio y margen, se genera la deuda (SALE_DEBIT), se
 * aplican las señas del pedido y se actualiza la entrega del pedido. Todo en
 * UNA transacción: si algo falla, no queda nada a medias.
 *
 * Orden global de locks (ADR-062): pedido → líneas del pedido → venta → líneas
 * de venta → lotes (por id) → saldos de lote (por id) → reservas → costos de
 * producto (por id) → saldos de producto → saldo de cuenta del cliente → pagos
 * (por id).
 */

type Dec = InstanceType<typeof D>;

const money2 = (v: Dec | string | number) => new D(v).toFixed(2);

/* ---------- Errores ---------- */

const saleNotDraft = (sale: SaleRow) =>
  sale.status === "POSTED"
    ? new AppError(
        409,
        "SALE_ALREADY_POSTED",
        `La venta ${sale.internalCode} ya se confirmó: no se modifica (las devoluciones y notas de crédito llegan en una fase posterior).`,
      )
    : new AppError(409, "SALE_CANCELLED", `La venta ${sale.internalCode} está descartada.`);

const orderNotDeliverable = (order: OrderRow) =>
  new AppError(
    409,
    "ORDER_NOT_DELIVERABLE",
    order.status === "DELIVERED"
      ? `El pedido ${order.internalCode} ya se entregó por completo.`
      : `El pedido ${order.internalCode} no está listo para entregar: sólo se entrega un pedido listo o entregado parcialmente.`,
  );

const orderUnpriced = (order: OrderRow) =>
  new AppError(
    409,
    "ORDER_UNPRICED",
    `El pedido ${order.internalCode} no tiene precio acordado: usá «Acordar precio» antes de entregar.`,
  );

/* ---------- Borrador ---------- */

interface DraftContext {
  customerId: string;
  order: OrderRow | null;
  orderLines: LineRow[];
}

async function assertCustomer(db: Db, ctx: OperationContext, id: string, path = "customerId") {
  const [row] = await db
    .select({ id: customers.id, active: customers.active })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, id)));
  if (!row || !row.active) throw invalidReference(path, "Cliente inexistente o inactivo");
}

async function assertWarehouse(db: Db, ctx: OperationContext, id: string) {
  const [row] = await db
    .select({ id: warehouses.id, active: warehouses.active })
    .from(warehouses)
    .where(and(eq(warehouses.companyId, ctx.companyId), eq(warehouses.id, id)));
  if (!row || !row.active) throw invalidReference("warehouseId", "Depósito inexistente o inactivo");
}

async function draftContext(
  db: Db,
  ctx: OperationContext,
  args: { sourceOrderId: string | null; customerId: string | null },
): Promise<DraftContext> {
  if (args.sourceOrderId) {
    const order = await findOrder(db, ctx, args.sourceOrderId).catch(() => {
      throw invalidReference("sourceOrderId", "Pedido inexistente");
    });
    if (args.customerId && args.customerId !== order.customerId) {
      throw invalidReference("customerId", "La venta de un pedido es para el cliente del pedido");
    }
    if (!isDeliverable(order.status)) throw orderNotDeliverable(order);
    if (order.pricingStatus === "UNPRICED") throw orderUnpriced(order);
    return { customerId: order.customerId, order, orderLines: await loadLines(db, ctx, order.id) };
  }
  const customerId = args.customerId ?? (await walkInCustomer(db, ctx));
  if (!customerId) {
    throw invalidReference("customerId", "Elegí un cliente (no hay Consumidor Final configurado)");
  }
  await assertCustomer(db, ctx, customerId);
  return { customerId, order: null, orderLines: [] };
}

interface DraftLine {
  resolved: ResolvedLine;
  orderLine: LineRow | null;
  priced: PricedLine;
}

/** Valida, normaliza y cotiza las líneas de un borrador. */
async function buildDraftLines(
  db: Db,
  ctx: OperationContext,
  dc: DraftContext,
  inputs: readonly SaleLineInput[],
  viewer: SaleViewer,
): Promise<DraftLine[]> {
  const units = await loadUnits(db, ctx);
  const byOrderLine = new Map(dc.orderLines.map((l) => [l.id, l]));
  const orderLineOf = inputs.map((input, i) => {
    if (!dc.order) {
      if (input.orderLineId) {
        throw invalidReference(
          `lines.${i}.orderLineId`,
          "Una venta directa no tiene líneas de pedido",
        );
      }
      return null;
    }
    const ol = input.orderLineId ? byOrderLine.get(input.orderLineId) : undefined;
    if (!ol) throw invalidReference(`lines.${i}.orderLineId`, "Elegí una línea del pedido");
    if (ol.productId !== input.productId) {
      throw invalidReference(`lines.${i}.productId`, "El producto no es el de la línea del pedido");
    }
    return ol;
  });
  const asOrderInputs: OrderLineInput[] = inputs.map((input, i) => ({
    id: null,
    productId: input.productId,
    quantity: input.quantity,
    unitId: input.unitId,
    requestedConservation: orderLineOf[i]?.requestedConservation ?? input.requestedConservation,
    notes: input.notes,
    unitPrice: input.unitPrice,
    discountAmount: input.discountAmount,
    priceOverrideReason: input.priceOverrideReason,
  }));
  const resolved = await resolveLines(db, ctx, asOrderInputs, units);

  // No más que lo pendiente de cada línea del pedido (se vuelve a validar al confirmar).
  if (dc.order) {
    const delivered = await deliveredByLine(db, ctx, dc.order.id);
    const asked = new Map<string, Dec>();
    resolved.forEach((r, i) => {
      const ol = orderLineOf[i]!;
      asked.set(ol.id, (asked.get(ol.id) ?? new D(0)).plus(r.normalized));
    });
    resolved.forEach((r, i) => {
      const ol = orderLineOf[i]!;
      const pending = D.max(new D(ol.normalizedQuantity).minus(delivered.get(ol.id) ?? 0), 0);
      if (asked.get(ol.id)!.gt(pending)) {
        throw new AppError(
          409,
          "DELIVERY_EXCEEDS_PENDING",
          `Quedan ${pending.toString()} ${r.saleUnit.symbol} de ${r.product.name} por entregar.`,
          [
            {
              path: `lines.${i}.quantity`,
              message: `Pendiente: ${pending.toString()} ${r.saleUnit.symbol}`,
            },
          ],
        );
      }
    });
  }

  const current = dc.order
    ? new Map()
    : await resolvePrices(
        db,
        ctx,
        dc.customerId,
        resolved.map((r) => r.product.id),
      );
  return resolved.map((r, i) => {
    const ol = orderLineOf[i];
    let base;
    if (ol) {
      // Precio acordado del pedido; el descuento acordado se prorratea por lo entregado.
      const share = r.normalized.dividedBy(ol.normalizedQuantity);
      base = {
        unitPrice: ol.quotedUnitPrice!,
        discountAmount: money2(
          new D(ol.quotedDiscountAmount ?? 0).times(share).toDecimalPlaces(2, D.ROUND_HALF_UP),
        ),
        source: "ORDER_QUOTE" as const,
      };
    } else {
      const p = current.get(r.product.id)!;
      base = { unitPrice: p.unitPrice, discountAmount: "0", source: p.source };
    }
    return {
      resolved: r,
      orderLine: ol ?? null,
      priced: priceLine({
        quantity: r.normalized,
        base,
        input: r.price,
        permissions: viewer.permissions,
        path: `lines.${i}`,
      }),
    };
  });
}

const saleLineValues = (ctx: OperationContext, saleId: string, d: DraftLine) => ({
  companyId: ctx.companyId,
  saleId,
  sourceOrderLineId: d.orderLine?.id ?? null,
  productId: d.resolved.product.id,
  quantity: d.resolved.quantity,
  unitId: d.resolved.unit.id,
  normalizedQuantity: d.resolved.normalized.toFixed(10),
  saleUnitId: d.resolved.saleUnit.id,
  requestedConservation: d.resolved.requestedConservation,
  unitPrice: d.priced.unitPrice,
  discountAmount: d.priced.discountAmount,
  netAmount: d.priced.netAmount,
  priceSource: d.priced.priceSource,
  agreedUnitPrice: d.priced.agreedUnitPrice,
  agreedDiscountAmount: d.priced.agreedDiscountAmount,
  priceOverrideReason: d.priced.priceOverrideReason,
  notes: d.resolved.notes,
  sortOrder: d.resolved.index,
});

async function auditOverrides(
  tx: Transaction,
  ctx: OperationContext,
  sale: { id: string; internalCode: string },
  lines: readonly DraftLine[],
) {
  for (const d of lines) {
    const explicit =
      d.resolved.price.unitPrice !== undefined || d.resolved.price.discountAmount !== undefined;
    if (!d.priced.overridden || !explicit) continue;
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "SALE_PRICE_OVERRIDDEN",
      entityType: "sale",
      entityId: sale.id,
      metadata: {
        code: sale.internalCode,
        product: d.resolved.product.name,
        agreedUnitPrice: d.priced.agreedUnitPrice,
        agreedDiscountAmount: d.priced.agreedDiscountAmount,
        unitPrice: d.priced.unitPrice,
        discountAmount: d.priced.discountAmount,
        difference: money2(
          new D(d.priced.netAmount).minus(
            new D(d.resolved.normalized)
              .times(d.priced.agreedUnitPrice)
              .toDecimalPlaces(2, D.ROUND_HALF_UP)
              .minus(d.priced.agreedDiscountAmount),
          ),
        ),
        reason: d.priced.priceOverrideReason,
      },
    });
  }
}

const summarize = (lines: readonly DraftLine[]) =>
  lines
    .map(
      (d) =>
        `${d.resolved.normalized.toString()} ${d.resolved.saleUnit.symbol} ${d.resolved.product.name}`,
    )
    .join(", ");

export async function createSale(
  db: Database,
  ctx: OperationContext,
  input: CreateSaleInput,
  viewer: SaleViewer,
): Promise<SaleDetailDto> {
  const id = await db.transaction(async (tx) => {
    const dc = await draftContext(tx, ctx, {
      sourceOrderId: input.sourceOrderId,
      customerId: input.customerId,
    });
    await assertWarehouse(tx, ctx, input.warehouseId);
    const lines = await buildDraftLines(tx, ctx, dc, input.lines, viewer);
    const totals = pricedTotals(lines.map((l) => l.priced));
    const priceListId =
      dc.order?.priceListId ??
      (await (async () => {
        const { customerList, companyDefault } = await priceListsFor(tx, ctx, dc.customerId);
        return (customerList ?? companyDefault)?.id ?? null;
      })());
    const code = await allocateCode(tx, ctx.companyId, "SALE", async (c) => {
      const taken = await tx
        .select({ id: sales.id })
        .from(sales)
        .where(and(eq(sales.companyId, ctx.companyId), eq(sales.internalCode, c)))
        .limit(1);
      return taken.length > 0;
    });
    const [sale] = await tx
      .insert(sales)
      .values({
        companyId: ctx.companyId,
        internalCode: code,
        customerId: dc.customerId,
        sourceOrderId: dc.order?.id ?? null,
        warehouseId: input.warehouseId,
        priceListId,
        ...totals,
        currency: await companyCurrency(tx, ctx),
        notes: input.notes,
        createdByUserId: ctx.userId,
      })
      .returning();
    await tx.insert(saleLines).values(lines.map((l) => saleLineValues(ctx, sale!.id, l)));
    await auditOverrides(tx, ctx, sale!, lines);
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "SALE_CREATED",
      entityType: "sale",
      entityId: sale!.id,
      metadata: {
        code,
        order: dc.order?.internalCode ?? null,
        lines: summarize(lines),
        total: totals.total,
      },
    });
    return sale!.id;
  });
  return getSaleDetail(db, ctx, id, viewer);
}

export async function updateSale(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: UpdateSaleInput,
  viewer: SaleViewer,
): Promise<SaleDetailDto> {
  await db.transaction(async (tx) => {
    const sale = await findSale(tx, ctx, id, true);
    if (sale.status !== "DRAFT") throw saleNotDraft(sale);
    if (sale.sourceOrderId && input.customerId && input.customerId !== sale.customerId) {
      throw invalidReference("customerId", "La venta de un pedido es para el cliente del pedido");
    }
    const values: Partial<typeof sales.$inferInsert> = {};
    if (input.warehouseId !== undefined) {
      await assertWarehouse(tx, ctx, input.warehouseId);
      values.warehouseId = input.warehouseId;
    }
    if (input.notes !== undefined) values.notes = input.notes;
    let summary: string | undefined;
    if (input.lines !== undefined || input.customerId !== undefined) {
      const dc = await draftContext(tx, ctx, {
        sourceOrderId: sale.sourceOrderId,
        customerId: input.customerId ?? sale.customerId,
      });
      const current = await loadSaleLines(tx, ctx, sale.id);
      const inputs: SaleLineInput[] =
        input.lines ??
        current.map((l) => ({
          orderLineId: l.sourceOrderLineId,
          productId: l.productId,
          quantity: l.quantity,
          unitId: l.unitId,
          requestedConservation: l.requestedConservation,
          notes: l.notes,
          priceOverrideReason: l.priceSource === "MANUAL" ? l.priceOverrideReason : null,
          ...(l.priceSource === "MANUAL"
            ? { unitPrice: l.unitPrice, discountAmount: l.discountAmount }
            : {}),
        }));
      const lines = await buildDraftLines(tx, ctx, dc, inputs, viewer);
      Object.assign(values, pricedTotals(lines.map((l) => l.priced)));
      values.customerId = dc.customerId;
      await tx
        .delete(saleLines)
        .where(and(eq(saleLines.companyId, ctx.companyId), eq(saleLines.saleId, sale.id)));
      await tx.insert(saleLines).values(lines.map((l) => saleLineValues(ctx, sale.id, l)));
      await auditOverrides(tx, ctx, sale, lines);
      summary = summarize(lines);
    }
    await tx
      .update(sales)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(sales.id, sale.id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "SALE_UPDATED",
      entityType: "sale",
      entityId: sale.id,
      metadata: {
        code: sale.internalCode,
        ...(summary ? { lines: summary } : {}),
        ...(values.total !== undefined ? { total: values.total } : {}),
        ...(values.warehouseId ? { warehouseId: values.warehouseId } : {}),
      },
    });
  });
  return getSaleDetail(db, ctx, id, viewer);
}

/** Sólo un borrador se descarta. Una venta confirmada no se cancela (devoluciones: deuda). */
export async function cancelSale(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: CancelSaleInput,
  viewer: SaleViewer,
): Promise<SaleDetailDto> {
  await db.transaction(async (tx) => {
    const sale = await findSale(tx, ctx, id, true);
    if (sale.status !== "DRAFT") throw saleNotDraft(sale);
    const now = new Date();
    await tx
      .update(sales)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancelledByUserId: ctx.userId,
        cancelReason: input.reason,
        updatedAt: now,
      })
      .where(eq(sales.id, sale.id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "SALE_DRAFT_CANCELLED",
      entityType: "sale",
      entityId: sale.id,
      metadata: { code: sale.internalCode, reason: input.reason },
    });
  });
  return getSaleDetail(db, ctx, id, viewer);
}

/* ---------- Vista previa ---------- */

const productNames = async (db: Db, ctx: OperationContext, ids: readonly string[]) =>
  new Map(
    (ids.length
      ? await db
          .select({
            id: products.id,
            code: products.internalCode,
            name: products.name,
            unit: products.saleUnitId,
          })
          .from(products)
          .where(
            and(eq(products.companyId, ctx.companyId), inArray(products.id, [...new Set(ids)])),
          )
      : []
    ).map((p) => [p.id, p]),
  );

function lineMargin(net: string, cost: Dec) {
  const m = materialMargin(net, cost);
  return {
    amount: fixedMoney(m.amount),
    percentage: m.percentage === null ? null : m.percentage.toFixed(4),
  };
}

const showQty = (v: Dec | string) => new D(v).toDecimalPlaces(6).toString();

/**
 * Qué pasaría al confirmar ahora: lotes (reservados primero, luego FEFO),
 * faltantes, costo material, margen, señas a aplicar y límite de crédito. No
 * escribe ni bloquea.
 */
export async function previewSale(
  db: Database,
  ctx: OperationContext,
  id: string,
  viewer: SaleViewer,
): Promise<SalePreviewDto> {
  const see = visibility(viewer);
  const sale = await findSale(db, ctx, id);
  if (sale.status !== "DRAFT") throw saleNotDraft(sale);
  const lines = await loadSaleLines(db, ctx, sale.id);
  const issues: SalePreviewIssueDto[] = [];
  const order = sale.sourceOrderId ? await findOrder(db, ctx, sale.sourceOrderId) : null;
  if (order && !isDeliverable(order.status)) {
    issues.push({
      code: "ORDER_NOT_DELIVERABLE",
      message: orderNotDeliverable(order).message,
      blocking: true,
    });
  }
  if (order?.pricingStatus === "UNPRICED") {
    issues.push({ code: "ORDER_UNPRICED", message: orderUnpriced(order).message, blocking: true });
  }
  const reservations = order ? await orderReservations(db, ctx, order.id, false) : [];
  const ids = await candidateLotIds(
    db,
    ctx,
    lines.map((l) => l.productId),
    sale.warehouseId,
    reservations.map((r) => r.lotId),
  );
  const lots = await loadLotStates(db, ctx, [
    ...new Set([...ids, ...reservations.map((r) => r.lotId)]),
  ]);
  const now = new Date();
  const planned = planSaleLines({
    lines,
    lots,
    reservations,
    warehouseId: sale.warehouseId,
    at: now,
  });
  const names = await productNames(
    db,
    ctx,
    lines.map((l) => l.productId),
  );
  const units = await loadUnits(db, ctx);

  if (order) {
    const delivered = await deliveredByLine(db, ctx, order.id);
    const orderLines = await loadLines(db, ctx, order.id);
    const asked = new Map<string, Dec>();
    for (const l of lines) {
      if (!l.sourceOrderLineId) continue;
      asked.set(
        l.sourceOrderLineId,
        (asked.get(l.sourceOrderLineId) ?? new D(0)).plus(l.normalizedQuantity),
      );
    }
    for (const [lineId, q] of asked) {
      const ol = orderLines.find((x) => x.id === lineId);
      const pending = ol
        ? D.max(new D(ol.normalizedQuantity).minus(delivered.get(lineId) ?? 0), 0)
        : new D(0);
      if (q.gt(pending)) {
        issues.push({
          code: "DELIVERY_EXCEEDS_PENDING",
          message: `${names.get(ol?.productId ?? "")?.name ?? "Producto"}: quedan ${showQty(pending)} por entregar.`,
          blocking: true,
        });
      }
    }
  }
  for (const p of planned) {
    const name = names.get(p.line.productId)?.name ?? "";
    const unit = units.get(p.line.saleUnitId)?.symbol ?? "";
    if (p.missing.gt(0)) {
      issues.push({
        code: "INSUFFICIENT_FREE_PRODUCT_STOCK",
        message: `${name}: faltan ${showQty(p.missing)} ${unit}. Disponible sin reservar en el depósito: ${showQty(p.freeAvailable)} ${unit}${p.fromReservations.gt(0) ? ` (más ${showQty(p.fromReservations)} ${unit} reservados para este pedido)` : ""}.`,
        blocking: true,
      });
    }
    if (p.unusableReservations > 0) {
      issues.push({
        code: "RESERVATION_UNUSABLE",
        message: `${name}: hay lotes reservados que ya no se pueden entregar (vencidos o bloqueados); se completará con otros lotes si hay stock libre.`,
        blocking: false,
      });
    }
  }
  const total = new D(sale.total);
  const costReady = planned.every((p) => p.missing.isZero());
  const materialCost = planned.reduce((s, p) => s.plus(p.materialCost), new D(0));
  const marginTotal = costReady ? materialMargin(total, materialCost) : null;
  if (
    (see.costs || see.margin) &&
    costReady &&
    planned.some((p) => new D(p.line.netAmount).lt(p.materialCost))
  ) {
    issues.push({ code: "NEGATIVE_MARGIN", message: NEGATIVE_MARGIN_WARNING, blocking: false });
  }

  let advances: SalePreviewDto["advances"] = null;
  let toApply = new D(0);
  if (order) {
    const adv = await orderAdvances(db, ctx, order.id);
    toApply = D.min(adv.available, total);
    if (see.payments) {
      advances = {
        available: adv.available.toFixed(2),
        toApply: toApply.toFixed(2),
        remainingCredit: adv.available.minus(toApply).toFixed(2),
      };
    }
  }
  const [customer] = await db
    .select({ creditLimit: customers.creditLimit })
    .from(customers)
    .where(eq(customers.id, sale.customerId));
  const current = await accountBalance(db, ctx, sale.customerId);
  const check = creditLimitCheck({
    creditLimit: customer?.creditLimit ?? null,
    currentBalance: current,
    saleTotal: total,
  });
  if (check.exceeded) {
    issues.push({
      code: "CREDIT_LIMIT_EXCEEDED",
      message:
        "Con esta venta el cliente supera su límite de crédito (se registra igual, con aviso).",
      blocking: false,
    });
  }
  return {
    saleId: sale.id,
    canPost: !issues.some((i) => i.blocking) && see.can(PERMISSIONS.SALES_POST),
    lines: planned.map((p) => ({
      lineId: p.line.id,
      product: (() => {
        const n = names.get(p.line.productId)!;
        return { id: n.id, code: n.code, name: n.name };
      })(),
      saleUnit: (() => {
        const u = units.get(p.line.saleUnitId)!;
        return { id: u.id, code: u.code, symbol: u.symbol };
      })(),
      quantity: p.line.normalizedQuantity,
      fromReservations: fixedQty(p.fromReservations),
      missing: fixedQty(p.missing),
      lots: p.allocations.map((a) => ({
        lot: {
          id: a.lot.id,
          code: a.lot.code,
          conservationState: a.lot.conservationState,
          usableUntil: a.lot.usableUntil?.toISOString() ?? null,
        },
        quantity: fixedQty(a.quantity),
        fromReservation: a.reservationId !== null,
        unitCost: see.costs ? fixedMoney(a.unitCost) : null,
        materialCost: see.costs ? fixedMoney(a.value) : null,
      })),
      netAmount: see.prices ? p.line.netAmount : null,
      materialCost: see.costs && p.missing.isZero() ? fixedMoney(p.materialCost) : null,
      margin:
        see.margin && p.missing.isZero() ? lineMargin(p.line.netAmount, p.materialCost) : null,
    })),
    total: see.prices ? sale.total : null,
    materialCost: see.costs && costReady ? fixedMoney(materialCost) : null,
    margin:
      see.margin && marginTotal
        ? {
            amount: fixedMoney(marginTotal.amount),
            percentage: marginTotal.percentage?.toFixed(2) ?? null,
          }
        : null,
    advances,
    credit: hasPermissions(viewer.permissions, [PERMISSIONS.CUSTOMER_ACCOUNTS_READ])
      ? {
          limit: customer?.creditLimit ?? null,
          currentBalance: current.toFixed(2),
          projectedBalance: check.projectedBalance.toFixed(2),
          exceeded: check.exceeded,
        }
      : null,
    issues,
  };
}

/* ---------- Confirmar entrega y venta ---------- */

/**
 * Posteo atómico (ADR-058/062). Idempotencia por estado: el primer intento
 * confirma (200); un reintento encuentra la venta POSTED (409
 * SALE_ALREADY_POSTED) y no mueve nada.
 */
export async function postSale(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: PostSaleInput,
  viewer: SaleViewer,
): Promise<SaleOperationResultDto> {
  const warnings: string[] = [];
  await db.transaction(async (tx) => {
    // 1-3. Pedido → líneas del pedido → venta → líneas de venta.
    const peek = await findSale(tx, ctx, id);
    const order = peek.sourceOrderId ? await findOrder(tx, ctx, peek.sourceOrderId, true) : null;
    const orderLines = order ? await loadLines(tx, ctx, order.id, true) : [];
    const sale = await findSale(tx, ctx, id, true);
    if (sale.status !== "DRAFT") throw saleNotDraft(sale);
    const lines = await loadSaleLines(tx, ctx, sale.id, true);
    if (lines.length === 0) {
      throw new AppError(422, "SALE_WITHOUT_LINES", "La venta no tiene productos.");
    }
    const now = new Date();

    // 4-5. Pedido entregable, con precio y sin superar lo pendiente.
    let delivered = new Map<string, Dec>();
    if (order) {
      if (!isDeliverable(order.status)) throw orderNotDeliverable(order);
      if (order.pricingStatus === "UNPRICED") throw orderUnpriced(order);
      delivered = await deliveredByLine(tx, ctx, order.id);
      const asked = new Map<string, Dec>();
      for (const l of lines) {
        const key = l.sourceOrderLineId!;
        asked.set(key, (asked.get(key) ?? new D(0)).plus(l.normalizedQuantity));
      }
      for (const [lineId, q] of asked) {
        const ol = orderLines.find((x) => x.id === lineId);
        const pending = ol
          ? D.max(new D(ol.normalizedQuantity).minus(delivered.get(lineId) ?? 0), 0)
          : new D(0);
        if (q.gt(pending)) {
          throw new AppError(
            409,
            "DELIVERY_EXCEEDS_PENDING",
            `Una línea supera lo pendiente de entregar del pedido (quedan ${showQty(pending)}).`,
          );
        }
      }
    }

    // 6-8. Lotes (por id) → saldos de lote (por id) → reservas del pedido.
    const reservedLots = order
      ? (await orderReservations(tx, ctx, order.id, false)).map((r) => r.lotId)
      : [];
    const lotIds = await lockSaleLots(
      tx,
      ctx,
      lines.map((l) => l.productId),
      sale.warehouseId,
      reservedLots,
    );
    const reservations = order ? await orderReservations(tx, ctx, order.id, true) : [];

    // 9-10. Estado DESPUÉS de bloquear y asignación (reservas primero, luego FEFO libre).
    const lots = await loadLotStates(tx, ctx, lotIds);
    const planned = planSaleLines({
      lines,
      lots,
      reservations,
      warehouseId: sale.warehouseId,
      at: now,
    });
    const names = await productNames(
      tx,
      ctx,
      lines.map((l) => l.productId),
    );
    const short = planned.filter((p) => p.missing.gt(0));
    if (short.length > 0) {
      throw new AppError(
        409,
        "INSUFFICIENT_FREE_PRODUCT_STOCK",
        `No hay stock disponible suficiente: ${short
          .map(
            (p) =>
              `${names.get(p.line.productId)?.name ?? ""} (faltan ${showQty(p.missing)}; libres ${showQty(p.freeAvailable)})`,
          )
          .join(", ")}. Lo reservado para otros pedidos no se usa.`,
        short.map((p) => ({
          path: `lines.${p.line.sortOrder}.quantity`,
          message: `Faltan ${showQty(p.missing)}`,
        })),
      );
    }

    // 11. Costos de producto (por id) → saldos de producto (por producto y depósito).
    const allocations = planned.flatMap((p) => p.allocations.map((a) => ({ p, a })));
    for (const productId of [...new Set(allocations.map((x) => x.p.line.productId))].sort()) {
      await lockProductCost(tx, ctx, productId);
    }
    const balanceKeys = [
      ...new Map(
        allocations.map((x) => [
          `${x.p.line.productId}:${x.a.lot.warehouseId}`,
          {
            productId: x.p.line.productId,
            warehouseId: x.a.lot.warehouseId,
            unitId: x.a.lot.unitId,
          },
        ]),
      ).entries(),
    ]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, v]) => v);
    for (const k of balanceKeys) {
      await lockProductBalance(tx, ctx, k.warehouseId, k.productId, k.unitId);
    }

    // 12. Reservas cumplidas (antes de bajar los saldos: el trigger exige saldo ≥ reservado).
    const fulfilled = new Map<string, Dec>();
    for (const { a } of allocations) {
      if (!a.reservationId) continue;
      fulfilled.set(a.reservationId, (fulfilled.get(a.reservationId) ?? new D(0)).plus(a.quantity));
    }
    for (const [reservationId, q] of fulfilled) {
      const r = reservations.find((x) => x.id === reservationId)!;
      const total = new D(r.fulfilledQuantity).plus(q);
      const complete = !total.lt(r.quantity);
      await tx
        .update(productLotReservations)
        .set({
          fulfilledQuantity: fixedQty(complete ? r.quantity : total),
          ...(complete
            ? { status: "FULFILLED" as const, releasedAt: now, releasedByUserId: ctx.userId }
            : {}),
        })
        .where(eq(productLotReservations.id, reservationId));
    }

    // 13-15. Movimientos SALE por lote + asignación con costo congelado (venta aún DRAFT).
    for (const { p, a } of allocations) {
      const allocationId = randomUUID();
      const name = names.get(p.line.productId)!;
      const posted = await postLotMovement(tx, ctx, {
        productId: p.line.productId,
        productCode: name.code,
        productName: name.name,
        lot: { id: a.lot.id, code: a.lot.code, warehouseId: a.lot.warehouseId },
        saleUnitId: a.lot.unitId,
        movementType: "SALE",
        quantity: fixedQty(a.quantity),
        value: fixedMoney(a.value),
        occurredAt: now,
        referenceType: "SALE",
        referenceId: sale.id,
        sourceLineId: allocationId,
        notes: null,
        recordCostHistory: true,
      });
      await tx.insert(saleLotAllocations).values({
        id: allocationId,
        companyId: ctx.companyId,
        saleId: sale.id,
        saleLineId: p.line.id,
        productId: p.line.productId,
        productLotId: a.lot.id,
        reservationId: a.reservationId,
        warehouseId: a.lot.warehouseId,
        quantity: fixedQty(a.quantity),
        unitId: a.lot.unitId,
        unitMaterialCost: fixedMoney(a.unitCost),
        materialCost: fixedMoney(a.value),
        stockMovementId: posted.movement.id,
      });
    }

    // 16. Costo y margen por línea (congelados).
    let materialCost = new D(0);
    for (const p of planned) {
      const m = materialMargin(p.line.netAmount, p.materialCost);
      materialCost = materialCost.plus(p.materialCost);
      await tx
        .update(saleLines)
        .set({
          materialCost: fixedMoney(p.materialCost),
          averageLotUnitCost: fixedMoney(
            averageMaterialCost(p.line.normalizedQuantity, p.materialCost) ?? 0,
          ),
          grossMarginAmount: fixedMoney(m.amount),
          grossMarginPercentage: m.percentage?.toFixed(4) ?? null,
          updatedAt: now,
        })
        .where(eq(saleLines.id, p.line.id));
    }
    const total = new D(sale.total);
    const saleMargin = materialMargin(total, materialCost);
    if (planned.some((p) => new D(p.line.netAmount).lt(p.materialCost))) {
      if (visibility(viewer).costs || visibility(viewer).margin)
        warnings.push(NEGATIVE_MARGIN_WARNING);
    }

    // 17-18. Cuenta corriente: deuda de la venta y límite de crédito (sólo aviso).
    const account = await lockAccount(tx, ctx, sale.customerId);
    const [customer] = await tx
      .select({ creditLimit: customers.creditLimit, name: customers.legalName })
      .from(customers)
      .where(eq(customers.id, sale.customerId));
    const initial = input.initialPayment ? new D(input.initialPayment.amount) : new D(0);
    const advance = order ? await orderAdvances(tx, ctx, order.id) : null;
    const credit = creditLimitCheck({
      creditLimit: customer?.creditLimit ?? null,
      currentBalance: account.balance,
      saleTotal: total,
      initialPayment: initial,
    });
    if (total.gt(0)) {
      await postAccountMovement(tx, ctx, {
        customerId: sale.customerId,
        movementType: "SALE_DEBIT",
        amount: total.toFixed(2),
        occurredAt: now,
        saleId: sale.id,
      });
    }

    // 19. La venta queda registrada (inmutable salvo su cobro).
    await tx
      .update(sales)
      .set({
        status: "POSTED",
        paymentStatus: total.isZero() ? "PAID" : "UNPAID",
        saleDate: now,
        postedAt: now,
        postedByUserId: ctx.userId,
        materialCostTotal: fixedMoney(materialCost),
        grossMarginAmount: fixedMoney(saleMargin.amount),
        grossMarginPercentage: saleMargin.percentage?.toFixed(4) ?? null,
        creditLimitExceeded: credit.exceeded,
        updatedAt: now,
      })
      .where(eq(sales.id, sale.id));
    const saleState = {
      id: sale.id,
      customerId: sale.customerId,
      total: sale.total,
      paidAmount: "0.00",
    };
    if (credit.exceeded) {
      warnings.push(
        `El cliente supera su límite de crédito: saldo proyectado $ ${credit.projectedBalance.toFixed(2)} (límite $ ${new D(customer!.creditLimit!).toFixed(2)}).`,
      );
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "CUSTOMER_CREDIT_LIMIT_EXCEEDED",
        entityType: "sale",
        entityId: sale.id,
        metadata: {
          code: sale.internalCode,
          customer: customer?.name ?? null,
          creditLimit: customer?.creditLimit ?? null,
          projectedBalance: credit.projectedBalance.toFixed(2),
          excess: credit.excess.toFixed(2),
        },
      });
    }

    // 20-21. Señas del pedido: se aplican solas (más viejas primero); el excedente queda a favor.
    if (advance && advance.available.gt(0) && total.gt(0)) {
      const ids = advance.rows.map((r) => r.id).sort();
      await tx
        .select({ id: customerPayments.id })
        .from(customerPayments)
        .where(inArray(customerPayments.id, ids))
        .orderBy(asc(customerPayments.id))
        .for("update");
      const fresh = await orderAdvances(tx, ctx, order!.id);
      const plan = allocateAdvances(
        fresh.rows.map((r) => ({
          id: r.id,
          code: r.code,
          available: new D(r.amount).minus(r.applied),
        })),
        total,
      );
      for (const { advance: a, amount } of plan) {
        await applyToSale(tx, ctx, {
          sale: saleState,
          paymentId: a.id,
          amount,
          origin: "ADVANCE_AUTO",
        });
        await recordAudit(tx, {
          ...auditBase(ctx),
          action: "PAYMENT_APPLIED",
          entityType: "sale",
          entityId: sale.id,
          metadata: {
            code: sale.internalCode,
            payment: a.code,
            amount: amount.toFixed(2),
            origin: "ADVANCE_AUTO",
          },
        });
      }
      const left = fresh.available.minus(plan.reduce((s, x) => s.plus(x.amount), new D(0)));
      if (left.gt(0)) {
        warnings.push(`Quedan $ ${left.toFixed(2)} de seña como crédito a favor del cliente.`);
      }
    }

    // 22-24. Cobro en el momento (opcional): pago + crédito en cuenta + aplicación.
    if (input.initialPayment) {
      const due = saleBalanceDue(saleState.total, saleState.paidAmount);
      if (initial.gt(due)) {
        throw new AppError(
          422,
          "PAYMENT_EXCEEDS_SALE_BALANCE",
          `El pendiente de la venta es $ ${due.toFixed(2)}: no se puede cobrar $ ${initial.toFixed(2)} en ella. El resto se registra como cobro a cuenta.`,
          [{ path: "initialPayment.amount", message: `Pendiente: $ ${due.toFixed(2)}` }],
        );
      }
      const [reused] = await tx
        .select({ id: customerPayments.id })
        .from(customerPayments)
        .where(
          and(
            eq(customerPayments.companyId, ctx.companyId),
            eq(customerPayments.operationId, input.initialPayment.operationId),
          ),
        );
      if (reused) {
        throw new AppError(
          409,
          "OPERATION_ID_REUSED",
          "Ese identificador de operación ya se usó para otro cobro. Reintentá desde la pantalla.",
        );
      }
      const code = await allocatePaymentCode(tx, ctx);
      const [payment] = await tx
        .insert(customerPayments)
        .values({
          companyId: ctx.companyId,
          internalCode: code,
          customerId: sale.customerId,
          kind: "SALE_PAYMENT",
          sourceSaleId: sale.id,
          paymentDate: now,
          amount: initial.toFixed(2),
          paymentMethod: input.initialPayment.paymentMethod,
          reference: input.initialPayment.reference,
          operationId: input.initialPayment.operationId,
          createdByUserId: ctx.userId,
          postedByUserId: ctx.userId,
          postedAt: now,
        })
        .returning();
      await postAccountMovement(tx, ctx, {
        customerId: sale.customerId,
        movementType: "PAYMENT_CREDIT",
        amount: initial.toFixed(2),
        occurredAt: now,
        paymentId: payment!.id,
      });
      await applyToSale(tx, ctx, {
        sale: saleState,
        paymentId: payment!.id,
        amount: initial,
        origin: "SALE_PAYMENT",
      });
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "CUSTOMER_PAYMENT_POSTED",
        entityType: "customer_payment",
        entityId: payment!.id,
        metadata: {
          code,
          sale: sale.internalCode,
          amount: initial.toFixed(2),
          method: input.initialPayment.paymentMethod,
        },
      });
    }

    // 25-27. Entrega del pedido: parcial o completa; lo completo libera reservas y cierra necesidades.
    let orderStatus: string | null = null;
    if (order) {
      const after = new Map(delivered);
      for (const l of lines) {
        const key = l.sourceOrderLineId!;
        after.set(key, (after.get(key) ?? new D(0)).plus(l.normalizedQuantity));
      }
      const status = orderDeliveryStatus(
        orderLines.map((ol) => ({
          ordered: ol.normalizedQuantity,
          delivered: after.get(ol.id) ?? 0,
        })),
      );
      orderStatus = status;
      if (status === "DELIVERED") {
        const leftover = (await orderReservations(tx, ctx, order.id, false)).map((r) => r.id);
        if (leftover.length > 0) {
          await tx
            .update(productLotReservations)
            .set({
              status: "RELEASED",
              releasedAt: now,
              releaseReason: "ORDER_DELIVERED",
              releasedByUserId: ctx.userId,
            })
            .where(inArray(productLotReservations.id, leftover));
        }
        await tx
          .update(orderProductionRequirements)
          .set({ status: "SATISFIED", closedAt: now })
          .where(
            and(
              eq(orderProductionRequirements.companyId, ctx.companyId),
              eq(orderProductionRequirements.customerOrderId, order.id),
              inArray(orderProductionRequirements.status, [...OPEN_REQUIREMENT]),
            ),
          );
      }
      await tx
        .update(customerOrders)
        .set({
          status,
          firstDeliveredAt: order.firstDeliveredAt ?? now,
          ...(status === "DELIVERED" ? { deliveredAt: now, deliveredByUserId: ctx.userId } : {}),
          updatedAt: now,
        })
        .where(eq(customerOrders.id, order.id));
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: status === "DELIVERED" ? "ORDER_DELIVERED" : "ORDER_PARTIALLY_DELIVERED",
        entityType: "customer_order",
        entityId: order.id,
        metadata: {
          code: order.internalCode,
          from: order.status,
          sale: sale.internalCode,
          delivered: lines
            .map((l) => `${showQty(l.normalizedQuantity)} ${names.get(l.productId)?.name ?? ""}`)
            .join(", "),
        },
      });
    }

    // 28. Auditoría de la venta.
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "SALE_POSTED",
      entityType: "sale",
      entityId: sale.id,
      metadata: {
        code: sale.internalCode,
        order: order?.internalCode ?? null,
        orderStatus,
        total: sale.total,
        materialCost: fixedMoney(materialCost),
        lots: allocations.map(({ a }) => `${a.lot.code}: ${showQty(a.quantity)}`).join(", "),
        paid: saleState.paidAmount,
        creditLimitExceeded: credit.exceeded,
      },
    });
  });
  return { sale: await getSaleDetail(db, ctx, id, viewer), warnings };
}

export type { PlannedLine };
