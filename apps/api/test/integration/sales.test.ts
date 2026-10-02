import { randomUUID } from "node:crypto";
import { auditLogs } from "@bakery/database";
import { NEGATIVE_MARGIN_WARNING } from "@bakery/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  ADMIN_B,
  SELLER,
  clientFor,
  createMember,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";
import { dec, ok } from "./inventory-fixtures.js";
import { reconciliationProblems } from "./lot-fixtures.js";
import {
  buildOrderWorld,
  cancel,
  confirmedOrder,
  orderOf,
  type OrderWorld,
} from "./order-fixtures.js";
import {
  accountOf,
  advance,
  draftSale,
  pay,
  postSale,
  postedSale,
  priceList,
  saleFromOrder,
  salesProblems,
  twoLotsWithDifferentCost,
} from "./sale-fixtures.js";

/*
 * Ventas, entregas, cobros y cuenta corriente (Fase 5B) contra la API real y
 * PostgreSQL: costo por lote específico (FEFO), entrega parcial y total de
 * pedidos consumiendo reservas, precios con prioridad y congelados al
 * confirmar, señas aplicadas solas, cobros idempotentes, imputación manual,
 * ajustes, límite de crédito (sólo aviso) y visibilidad de costos y márgenes.
 *
 * Costos de los lotes (receta 100 kg → 75 kg harina + 0,8 kg sal a 400):
 *   lote A, harina a   900 → 67.820 / 100 kg =   678,20/kg
 *   lote B, harina a 1.500 → 112.820 / 100 kg = 1.128,20/kg
 */

let ctx: TestContext;
let api: ApiClient;
let seller: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
  seller = await clientFor(ctx.app, SELLER);
});
afterAll(() => ctx.close());

const db = () => ctx.database.db;

async function invariants() {
  expect(await salesProblems(db())).toEqual([]);
  expect(await reconciliationProblems(db())).toEqual([]);
}

async function count(table: string) {
  const { rows } = await db().execute<{ n: number }>(
    sql.raw(`select count(*)::int as n from ${table}`),
  );
  return Number(rows[0]!.n);
}

async function snapshot() {
  const tables = [
    "sales",
    "sale_lines",
    "sale_lot_allocations",
    "stock_movements",
    "customer_payments",
    "customer_payment_applications",
    "customer_account_movements",
    "product_lot_reservations",
    "audit_logs",
  ];
  return Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)])));
}

async function auditOf(entityType: string, entityId: string) {
  const rows = await db()
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, entityId)))
    .orderBy(auditLogs.id);
  return rows.map((r) => r.action);
}

const productStock = (w: OrderWorld) => ok(api.get(`/api/inventory/products/${w.panFrances}`));

async function readyOrder(w: OrderWorld, quantity: string, extra: Record<string, unknown> = {}) {
  const order = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity }], extra);
  await ok(api.post(`/api/orders/${order.id}/start-preparation`, {}));
  await ok(api.post(`/api/orders/${order.id}/mark-ready`, {}));
  return orderOf(api, order.id);
}

describe("venta directa: costo por lote, stock y deuda (§94)", () => {
  let w: OrderWorld;
  let saleId: string;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " D");
    await twoLotsWithDifferentCost(api, w);
  });

  it("el borrador va a Consumidor Final al precio del producto y no mueve stock", async () => {
    const before = await count("stock_movements");
    const sale = await ok(draftSale(api, w, [{ productId: w.panFrances, quantity: "120" }]), 201);
    saleId = sale.id;
    expect(sale.code).toMatch(/^VTA-\d{4}$/);
    expect(sale).toMatchObject({ status: "DRAFT", paymentStatus: "UNPAID", order: null });
    expect(sale.customer).toMatchObject({ name: "Consumidor Final", walkIn: true });
    expect(sale.lines[0].price).toMatchObject({ priceSource: "PRODUCT_PRICE" });
    expect(dec(sale.lines[0].price.unitPrice)).toBe("1500");
    expect(dec(sale.amounts.total)).toBe("180000");
    expect(sale.materialCost).toBeNull();
    expect(await count("stock_movements")).toBe(before);
  });

  it("vista previa: FEFO 100 del lote A + 20 del B = 90.384, margen 89.616; no escribe", async () => {
    const before = await snapshot();
    const preview = await ok(api.get(`/api/sales/${saleId}/preview`));
    expect(await snapshot()).toEqual(before);
    expect(preview.canPost).toBe(true);
    const lots = preview.lines[0].lots.map((l: { quantity: string; materialCost: string }) => [
      dec(l.quantity),
      dec(l.materialCost),
    ]);
    expect(lots).toEqual([
      ["100", "67820"],
      ["20", "22564"],
    ]);
    expect(dec(preview.materialCost)).toBe("90384");
    expect(dec(preview.margin.amount)).toBe("89616");
    expect(preview.margin.percentage).toBe("49.79");
    expect(preview.issues).toEqual([]);
  });

  it("confirmar: VTA entregada, movimientos SALE por lote, promedio derivado, deuda", async () => {
    const res = await ok(postSale(api, saleId));
    const sale = res.sale;
    expect(sale).toMatchObject({ status: "POSTED", paymentStatus: "UNPAID" });
    expect(dec(sale.materialCost)).toBe("90384");
    expect(dec(sale.amounts.pending)).toBe("180000");
    expect(sale.lines[0].lots).toHaveLength(2);
    expect(sale.lines[0].lots.every((l: { fromReservation: boolean }) => !l.fromReservation)).toBe(
      true,
    );
    const stock = await productStock(w);
    expect(dec(stock.quantity)).toBe("80");
    expect(dec(stock.inventoryValue)).toBe("90256");
    expect(stock.averageMaterialCost).toBe("1128.200000");
    const account = await accountOf(api, sale.customer.id);
    expect(dec(account.balance)).toBe("180000");
    expect(account.balanceKind).toBe("DEBT");
    expect(account.movements.items[0]).toMatchObject({ type: "SALE_DEBIT" });
    expect(await auditOf("sale", saleId)).toEqual(["SALE_CREATED", "SALE_POSTED"]);
    await invariants();
  });

  it("idempotencia: [200, 409, 409]; una venta entregada no se edita ni se descarta", async () => {
    const sale = await ok(draftSale(api, w, [{ productId: w.panFrances, quantity: "1" }]), 201);
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await postSale(api, sale.id)).statusCode);
    expect(codes).toEqual([200, 409, 409]);
    expect((await postSale(api, sale.id)).json().error.code).toBe("SALE_ALREADY_POSTED");
    const edit = await api.patch(`/api/sales/${sale.id}`, { notes: "otra" });
    expect(edit.statusCode).toBe(409);
    const discard = await api.post(`/api/sales/${sale.id}/cancel`, { reason: "error" });
    expect(discard.statusCode).toBe(409);
    await invariants();
  });

  it("sin stock libre suficiente: INSUFFICIENT_FREE_PRODUCT_STOCK y nada cambia", async () => {
    const sale = await ok(draftSale(api, w, [{ productId: w.panFrances, quantity: "500" }]), 201);
    const preview = await ok(api.get(`/api/sales/${sale.id}/preview`));
    expect(preview.canPost).toBe(false);
    expect(preview.issues).toEqual([
      expect.objectContaining({ code: "INSUFFICIENT_FREE_PRODUCT_STOCK", blocking: true }),
    ]);
    const before = await snapshot();
    const res = await postSale(api, sale.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INSUFFICIENT_FREE_PRODUCT_STOCK");
    expect(await snapshot()).toEqual(before);
  });

  it("un borrador se descarta y ya no se confirma", async () => {
    const sale = await ok(draftSale(api, w, [{ productId: w.panFrances, quantity: "1" }]), 201);
    const done = await ok(api.post(`/api/sales/${sale.id}/cancel`, { reason: "Cargado de más" }));
    expect(done.sale ?? done).toMatchObject({ status: "CANCELLED" });
    expect((await postSale(api, sale.id)).statusCode).toBe(409);
    expect(await auditOf("sale", sale.id)).toContain("SALE_DRAFT_CANCELLED");
  });

  it("cobros: parcial, repetición idempotente, id reusado, exceso y saldo final", async () => {
    const opId = randomUUID();
    const first = await pay(api, saleId, "100000", opId);
    expect(first.statusCode).toBe(201);
    expect(first.json().payment.code).toMatch(/^COB-\d{4}$/);
    const replay = await pay(api, saleId, "100000", opId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true });
    expect(replay.json().payment.id).toBe(first.json().payment.id);
    const reused = await pay(api, saleId, "5000", opId);
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("OPERATION_ID_REUSED");
    let sale = await ok(api.get(`/api/sales/${saleId}`));
    expect(sale.paymentStatus).toBe("PARTIALLY_PAID");
    expect(dec(sale.amounts.pending)).toBe("80000");
    const exceed = await pay(api, saleId, "80000.01");
    expect(exceed.statusCode).toBe(422);
    expect(exceed.json().error.code).toBe("PAYMENT_EXCEEDS_SALE_BALANCE");
    await ok(pay(api, saleId, "80000"), 201);
    sale = await ok(api.get(`/api/sales/${saleId}`));
    expect(sale.paymentStatus).toBe("PAID");
    expect(sale.payments).toHaveLength(2);
    expect(dec((await accountOf(api, sale.customer.id)).balance)).toBe("1500");
    await invariants();
  });
});

describe("precios: prioridad, override y margen negativo (§95)", () => {
  let w: OrderWorld;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " L");
    await twoLotsWithDifferentCost(api, w);
  });

  const resolve = async (customerId: string) =>
    (
      await ok(
        api.get(`/api/price-lists/resolve?customerId=${customerId}&productIds=${w.panFrances}`),
      )
    )[0];

  it("producto → lista general → lista del cliente", async () => {
    expect(await resolve(w.customerId)).toMatchObject({ source: "PRODUCT_PRICE", priceList: null });
    const general = await priceList(api, "General L", { [w.panFrances]: "1400" }, { isDefault: true });
    expect(general.code).toMatch(/^LP-\d{4}$/);
    expect(await resolve(w.customerId)).toMatchObject({ source: "DEFAULT_PRICE_LIST" });
    const wholesale = await priceList(api, "Mayorista L", { [w.panFrances]: "1200" });
    await ok(api.patch(`/api/customers/${w.customerId}`, { defaultPriceListId: wholesale.id }));
    const resolved = await resolve(w.customerId);
    expect(resolved).toMatchObject({ source: "CUSTOMER_PRICE_LIST" });
    expect(dec(resolved.unitPrice)).toBe("1200");
    expect(dec((await resolve(w.otherCustomerId)).unitPrice)).toBe("1400");
    const customer = await ok(api.get(`/api/customers/${w.customerId}`));
    expect(customer.defaultPriceList).toMatchObject({ id: wholesale.id });
    // La lista general sólo puede ser una.
    const second = await priceList(api, "Otra L", {}, { isDefault: true });
    const lists = await ok(api.get("/api/price-lists"));
    expect(lists.items.filter((l: { isDefault: boolean }) => l.isDefault)).toEqual([
      expect.objectContaining({ id: second.id }),
    ]);
    await ok(api.patch(`/api/price-lists/${general.id}`, { isDefault: true }));
  });

  it("cambiar un precio sin permiso: 403; sin motivo: 422; con motivo: MANUAL y auditado", async () => {
    const forbidden = await draftSale(
      seller,
      w,
      [{ productId: w.panFrances, quantity: "1", unitPrice: "1000", priceOverrideReason: "Amigo" }],
      { customerId: w.customerId },
    );
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("PRICE_OVERRIDE_FORBIDDEN");
    const noReason = await draftSale(api, w, [
      { productId: w.panFrances, quantity: "1", unitPrice: "1000" },
    ]);
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json().error.code).toBe("PRICE_OVERRIDE_REASON_REQUIRED");
    const sale = await ok(
      draftSale(
        api,
        w,
        [{ productId: w.panFrances, quantity: "1", unitPrice: "1000", priceOverrideReason: "Promo" }],
        { customerId: w.customerId },
      ),
      201,
    );
    expect(sale.lines[0].price).toMatchObject({ priceSource: "MANUAL", overrideReason: "Promo" });
    expect(dec(sale.lines[0].price.agreedUnitPrice)).toBe("1200");
    expect(dec(sale.lines[0].price.difference)).toBe("-200");
    expect(await auditOf("sale", sale.id)).toContain("SALE_PRICE_OVERRIDDEN");
    // El vendedor sí carga el precio vigente (sin override).
    const plain = await draftSale(seller, w, [{ productId: w.panFrances, quantity: "1" }], {
      customerId: w.customerId,
    });
    expect(plain.statusCode).toBe(201);
  });

  it("margen negativo: avisa sin bloquear", async () => {
    const sale = await ok(
      draftSale(api, w, [
        { productId: w.panFrances, quantity: "2", unitPrice: "100", priceOverrideReason: "Merma" },
      ]),
      201,
    );
    const preview = await ok(api.get(`/api/sales/${sale.id}/preview`));
    expect(preview.canPost).toBe(true);
    expect(preview.issues).toEqual([
      expect.objectContaining({
        code: "NEGATIVE_MARGIN",
        blocking: false,
        message: NEGATIVE_MARGIN_WARNING,
      }),
    ]);
    const posted = await ok(postSale(api, sale.id));
    expect(Number(posted.sale.margin.amount)).toBeLessThan(0);
    await invariants();
  });
});

describe("pedido: precio congelado, seña, entrega parcial y total (§96–§97)", () => {
  let w: OrderWorld;
  let order: Awaited<ReturnType<typeof orderOf>>;
  let wholesaleId: string;
  const sales: string[] = [];
  beforeAll(async () => {
    w = await buildOrderWorld(api, " P");
    await twoLotsWithDifferentCost(api, w);
    const wholesale = await priceList(api, "Mayorista P", { [w.panFrances]: "1200" });
    wholesaleId = wholesale.id;
    await ok(api.patch(`/api/customers/${w.customerId}`, { defaultPriceListId: wholesale.id }));
  });

  it("confirmar congela el precio de la lista del cliente (AGREED)", async () => {
    order = await readyOrder(w, "150");
    expect(order.commercial).toMatchObject({ pricingStatus: "AGREED" });
    expect(dec(order.commercial.quotedTotal)).toBe("180000");
    expect(order.lines[0].price).toMatchObject({ priceSource: "CUSTOMER_PRICE_LIST" });
    await ok(api.put(`/api/price-lists/${wholesaleId}/items/${w.panFrances}`, { unitPrice: "1300" }));
    const again = await orderOf(api, order.id);
    expect(dec(again.commercial.quotedTotal)).toBe("180000");
    expect(again.actions.canDeliver).toBe(true);
  });

  it("la seña queda como crédito del cliente y en el pedido", async () => {
    const res = await advance(api, order.id, "50000");
    expect(res.statusCode).toBe(201);
    expect(res.json().payment).toMatchObject({ kind: "ORDER_ADVANCE" });
    const detail = await orderOf(api, order.id);
    expect(dec(detail.commercial.advances.available)).toBe("50000");
    const account = await accountOf(api, w.customerId);
    expect(dec(account.balance)).toBe("-50000");
    expect(account.balanceKind).toBe("CREDIT");
    expect(await auditOf("customer_payment", res.json().payment.id)).toEqual([
      "CUSTOMER_PAYMENT_CREATED",
      "ORDER_ADVANCE_PAYMENT_POSTED",
    ]);
  });

  it("no se entrega más que lo pendiente", async () => {
    const res = await saleFromOrder(api, w, order, { [order.lines[0].id]: "151" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DELIVERY_EXCEEDS_PENDING");
  });

  it("entrega parcial de 100: consume la reserva, aplica la seña, ENTREGADO PARCIALMENTE", async () => {
    const draft = await ok(saleFromOrder(api, w, order, { [order.lines[0].id]: "100" }), 201);
    expect(dec(draft.lines[0].price.unitPrice)).toBe("1200");
    expect(draft.lines[0].price.priceSource).toBe("ORDER_QUOTE");
    const preview = await ok(api.get(`/api/sales/${draft.id}/preview`));
    expect(dec(preview.lines[0].fromReservations)).toBe("100");
    expect(preview.advances).toMatchObject({ toApply: expect.stringMatching(/^50000/) });
    const { sale } = await ok(postSale(api, draft.id));
    sales.push(sale.id);
    expect(dec(sale.amounts.total)).toBe("120000");
    expect(dec(sale.amounts.paid)).toBe("50000");
    expect(sale.paymentStatus).toBe("PARTIALLY_PAID");
    expect(dec(sale.materialCost)).toBe("67820");
    expect(sale.lines[0].lots.every((l: { fromReservation: boolean }) => l.fromReservation)).toBe(
      true,
    );
    expect(sale.payments).toEqual([expect.objectContaining({ origin: "ADVANCE_AUTO" })]);
    order = await orderOf(api, order.id);
    expect(order.status).toBe("PARTIALLY_DELIVERED");
    expect(dec(order.lines[0].delivered)).toBe("100");
    expect(dec(order.lines[0].pendingDelivery)).toBe("50");
    expect(dec(order.lines[0].reserved)).toBe("50");
    expect(dec(order.commercial.advances.available)).toBe("0");
    expect(dec((await accountOf(api, w.customerId)).balance)).toBe("70000");
    expect(await auditOf("customer_order", order.id)).toContain("ORDER_PARTIALLY_DELIVERED");
    // Entregado parcialmente: ya no se replanifica.
    expect(order.actions.canReplan).toBe(false);
    await invariants();
  });

  it("entrega del resto: ENTREGADO, reservas cumplidas, nada más que entregar", async () => {
    const { sale } = await ok(postSale(api, (await ok(saleFromOrder(api, w, order), 201)).id));
    sales.push(sale.id);
    expect(dec(sale.amounts.total)).toBe("60000");
    expect(dec(sale.materialCost)).toBe("56410");
    order = await orderOf(api, order.id);
    expect(order.status).toBe("DELIVERED");
    expect(order.reservations.every((r: { status: string }) => r.status === "FULFILLED")).toBe(
      true,
    );
    expect(order.actions.canDeliver).toBe(false);
    const more = await draftSale(
      api,
      w,
      [{ orderLineId: order.lines[0].id, productId: w.panFrances, quantity: "1" }],
      { sourceOrderId: order.id },
    );
    expect(more.statusCode).toBe(409);
    expect(more.json().error.code).toBe("ORDER_NOT_DELIVERABLE");
    const cancelled = await cancel(api, order.id);
    expect(cancelled.statusCode).toBe(409);
    expect(dec((await accountOf(api, w.customerId)).balance)).toBe("130000");
    await invariants();
  });

  it("cobro a cuenta + imputación manual; no se imputa de más", async () => {
    const res = await api.post(`/api/customers/${w.customerId}/payments`, {
      amount: "130000",
      paymentMethod: "TRANSFER",
      operationId: randomUUID(),
    });
    expect(res.statusCode).toBe(201);
    const paymentId = res.json().payment.id;
    expect(dec(res.json().payment.unapplied)).toBe("130000");
    expect(dec((await accountOf(api, w.customerId)).balance)).toBe("0");
    const tooMuch = await api.post(`/api/payments/${paymentId}/applications`, {
      saleId: sales[0],
      amount: "70000.01",
    });
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json().error.code).toBe("PAYMENT_EXCEEDS_SALE_BALANCE");
    await ok(api.post(`/api/payments/${paymentId}/applications`, { saleId: sales[0], amount: "70000" }));
    await ok(api.post(`/api/payments/${paymentId}/applications`, { saleId: sales[1], amount: "60000" }));
    for (const id of sales) {
      expect((await ok(api.get(`/api/sales/${id}`))).paymentStatus).toBe("PAID");
    }
    const payment = await ok(api.get(`/api/payments/${paymentId}`));
    expect(dec(payment.unapplied)).toBe("0");
    expect(payment.applications).toHaveLength(2);
    // El saldo no cambia al imputar: el cobro ya estaba en la cuenta.
    expect(dec((await accountOf(api, w.customerId)).balance)).toBe("0");
    await invariants();
  });

  it("ajuste de cuenta: sólo con permiso, con motivo, deja movimiento", async () => {
    const body = { direction: "CREDIT", amount: "500", reason: "Bonificación por demora" };
    const denied = await seller.post(`/api/customers/${w.customerId}/account/adjustments`, body);
    expect(denied.statusCode).toBe(403);
    await ok(api.post(`/api/customers/${w.customerId}/account/adjustments`, body), 201);
    const account = await accountOf(api, w.customerId);
    expect(dec(account.balance)).toBe("-500");
    expect(account.movements.items[0]).toMatchObject({
      type: "ADJUSTMENT_CREDIT",
      reason: "Bonificación por demora",
    });
    await invariants();
  });
});

describe("pedidos anteriores a 5B, cancelación con seña y límite de crédito (§98)", () => {
  let w: OrderWorld;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " U");
    await twoLotsWithDifferentCost(api, w);
  });

  it("un pedido SIN PRECIO no se entrega hasta cotizarlo explícitamente", async () => {
    let order = await readyOrder(w, "10");
    // Pedido migrado de 5A: sin precio (los triggers no permiten volver atrás).
    await db().transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`update customer_order_lines set quoted_unit_price = null,
        quoted_discount_amount = null, quoted_net_amount = null, price_source = null,
        price_override_reason = null where customer_order_id = ${order.id}`);
      await tx.execute(sql`update customer_orders set pricing_status = 'UNPRICED', price_list_id = null,
        quoted_subtotal = null, quoted_discount_total = null, quoted_total = null where id = ${order.id}`);
    });
    order = await orderOf(api, order.id);
    expect(order.commercial.pricingStatus).toBe("UNPRICED");
    expect(order.actions).toMatchObject({ canDeliver: false, canQuote: true });
    const blocked = await saleFromOrder(api, w, order);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("ORDER_UNPRICED");
    const quoted = await ok(
      api.post(`/api/orders/${order.id}/quote`, {
        lines: [{ lineId: order.lines[0].id, priceOverrideReason: null }],
      }),
    );
    expect((quoted.order ?? quoted).commercial.pricingStatus).toBe("AGREED");
    expect(await auditOf("customer_order", order.id)).toContain("ORDER_QUOTED");
    const again = await api.post(`/api/orders/${order.id}/quote`, {
      lines: [{ lineId: order.lines[0].id, priceOverrideReason: null }],
    });
    expect(again.statusCode).toBe(409);
    await ok(postSale(api, (await ok(saleFromOrder(api, w, await orderOf(api, order.id)), 201)).id));
    await invariants();
  });

  it("cancelar un pedido con seña avisa que queda crédito a favor", async () => {
    const order = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "5" }]);
    await ok(advance(api, order.id, "1000"), 201);
    const res = await ok(cancel(api, order.id));
    expect(res.warnings?.join(" ")).toMatch(/seña|crédito/i);
    const late = await advance(api, order.id, "1000");
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("ORDER_CLOSED");
  });

  it("superar el límite de crédito sólo avisa (y queda auditado)", async () => {
    await ok(api.patch(`/api/customers/${w.otherCustomerId}`, { creditLimit: "1000" }));
    const sale = await ok(
      draftSale(api, w, [{ productId: w.panFrances, quantity: "1" }], {
        customerId: w.otherCustomerId,
      }),
      201,
    );
    const preview = await ok(api.get(`/api/sales/${sale.id}/preview`));
    expect(preview.canPost).toBe(true);
    expect(preview.credit).toMatchObject({ exceeded: true });
    expect(preview.issues).toEqual([
      expect.objectContaining({ code: "CREDIT_LIMIT_EXCEEDED", blocking: false }),
    ]);
    const res = await ok(postSale(api, sale.id));
    expect(res.sale.creditLimitExceeded).toBe(true);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(await auditOf("sale", sale.id)).toContain("CUSTOMER_CREDIT_LIMIT_EXCEEDED");
  });

  it("cobrar en el momento de entregar", async () => {
    const sale = await ok(draftSale(api, w, [{ productId: w.panFrances, quantity: "2" }]), 201);
    const res = await ok(
      postSale(api, sale.id, {
        initialPayment: { amount: "3000", paymentMethod: "CASH", operationId: randomUUID() },
      }),
    );
    expect(res.sale.paymentStatus).toBe("PAID");
    expect(res.sale.payments).toEqual([expect.objectContaining({ origin: "SALE_PAYMENT" })]);
    const tooMuch = await ok(draftSale(api, w, [{ productId: w.panFrances, quantity: "1" }]), 201);
    const rejected = await postSale(api, tooMuch.id, {
      initialPayment: { amount: "1500.01", paymentMethod: "CASH", operationId: randomUUID() },
    });
    expect(rejected.statusCode).toBe(422);
    expect((await ok(api.get(`/api/sales/${tooMuch.id}`))).status).toBe("DRAFT");
    await invariants();
  });
});

describe("visibilidad de precios, costos y márgenes por rol; empresas (§99)", () => {
  let w: OrderWorld;
  let saleId: string;
  const as = async (role: "ADMINISTRATION" | "WAREHOUSE" | "PRODUCTION") => {
    const who = { email: `vis-${role.toLowerCase()}@test.local`, password: "vis-password-123" };
    await createMember(ctx.database, ctx.companyId, { ...who, displayName: role, roles: [role] });
    return clientFor(ctx.app, who);
  };
  beforeAll(async () => {
    w = await buildOrderWorld(api, " V");
    await twoLotsWithDifferentCost(api, w);
    saleId = (await postedSale(api, w, [{ productId: w.panFrances, quantity: "10" }])).id;
  });

  it("Ventas ve precios pero no costos ni márgenes", async () => {
    const sale = await ok(seller.get(`/api/sales/${saleId}`));
    expect(sale.amounts).not.toBeNull();
    expect(sale).toMatchObject({ materialCost: null, margin: null, canSeeCosts: false });
    expect(sale.lines[0]).toMatchObject({ materialCost: null, margin: null });
    expect(sale.lines[0].lots[0]).toMatchObject({ unitCost: null, materialCost: null });
    const list = await ok(seller.get("/api/sales"));
    expect(list.items.every((s: { margin: unknown }) => s.margin === null)).toBe(true);
    const preview = await ok(
      seller.get(
        `/api/sales/${(await ok(draftSale(seller, w, [{ productId: w.panFrances, quantity: "1" }]), 201)).id}/preview`,
      ),
    );
    expect(preview).toMatchObject({ materialCost: null, margin: null });
  });

  it("Depósito ve la venta sin montos; Producción no ve ventas", async () => {
    const warehouse = await as("WAREHOUSE");
    const sale = await ok(warehouse.get(`/api/sales/${saleId}`));
    expect(sale).toMatchObject({ amounts: null, materialCost: null, payments: null });
    expect(sale.lines[0].price).toBeNull();
    expect((await warehouse.get(`/api/customers/${sale.customer.id}/account`)).statusCode).toBe(
      403,
    );
    const production = await as("PRODUCTION");
    expect((await production.get(`/api/sales/${saleId}`)).statusCode).toBe(403);
  });

  it("Administración ve costo y margen", async () => {
    const admin = await as("ADMINISTRATION");
    const sale = await ok(admin.get(`/api/sales/${saleId}`));
    expect(dec(sale.materialCost)).toBe("6782");
    expect(sale.margin).toMatchObject({ percentage: "54.79" });
  });

  it("otra empresa no ve la venta, los cobros ni la cuenta", async () => {
    const other = await clientFor(ctx.app, ADMIN_B);
    expect((await other.get(`/api/sales/${saleId}`)).statusCode).toBe(404);
    expect((await other.get(`/api/customers/${w.customerId}/account`)).statusCode).toBe(404);
    expect((await other.post(`/api/sales/${saleId}/post`, {})).statusCode).toBe(404);
    expect((await ok(other.get("/api/sales"))).total).toBe(0);
    expect((await ok(other.get("/api/payments"))).total).toBe(0);
  });

  it("Consumidor Final no se desactiva", async () => {
    const sale = await ok(api.get(`/api/sales/${saleId}`));
    const res = await api.post(`/api/customers/${sale.customer.id}/deactivate`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("WALK_IN_CUSTOMER");
  });
});
