import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  clientFor,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";
import { dec, ok } from "./inventory-fixtures.js";
import { produce, reconciliationProblems } from "./lot-fixtures.js";
import { buildOrderWorld, confirmedOrder, orderOf, type OrderWorld } from "./order-fixtures.js";
import {
  accountOf,
  advance,
  draftSale,
  pay,
  postSale,
  postedSale,
  saleFromOrder,
  salesProblems,
} from "./sale-fixtures.js";

/*
 * Concurrencia real de ventas y cobros (Fase 5B, ADR-062): varias conexiones
 * del pool a la vez compitiendo por el mismo stock libre, la misma reserva, el
 * mismo pendiente de una venta y la misma confirmación; y rollback completo si
 * algo falla a mitad de la transacción.
 */

let ctx: TestContext;
let api: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
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

const productQty = async (w: OrderWorld) =>
  dec((await ok(api.get(`/api/inventory/products/${w.panFrances}`))).quantity);

describe("dos ventas de 70 kg con 100 kg libres", () => {
  let w: OrderWorld;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " C1");
    await produce(api, w, "100");
  });

  it("una se confirma, la otra INSUFFICIENT_FREE_PRODUCT_STOCK; quedan 30 kg", async () => {
    const a = await ok(draftSale(api, w, [{ productId: w.panFrances, quantity: "70" }]), 201);
    const b = await ok(draftSale(api, w, [{ productId: w.panFrances, quantity: "70" }]), 201);
    const results = await Promise.all([a, b].map((s) => postSale(api, s.id)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.statusCode === 409)!;
    expect(loser.json().error.code).toBe("INSUFFICIENT_FREE_PRODUCT_STOCK");
    expect(await productQty(w)).toBe("30");
    const statuses = await Promise.all(
      [a, b].map(async (s) => (await ok(api.get(`/api/sales/${s.id}`))).status),
    );
    expect(statuses.sort()).toEqual(["DRAFT", "POSTED"]);
    await invariants();
  });
});

describe("venta directa contra la reserva de un pedido", () => {
  let w: OrderWorld;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " C2");
    await produce(api, w, "100");
  });

  it("lo reservado no se vende al mostrador; en paralelo nunca se vende de más", async () => {
    const order = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "80" }]);
    const tooMuch = await ok(draftSale(api, w, [{ productId: w.panFrances, quantity: "30" }]), 201);
    const res = await postSale(api, tooMuch.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INSUFFICIENT_FREE_PRODUCT_STOCK");

    // Entrega del pedido (80, de la reserva) y venta de mostrador (20, libre) a la vez.
    await ok(api.post(`/api/orders/${order.id}/start-preparation`, {}));
    await ok(api.post(`/api/orders/${order.id}/mark-ready`, {}));
    const fromOrder = await ok(saleFromOrder(api, w, await orderOf(api, order.id)), 201);
    const counter = await ok(draftSale(api, w, [{ productId: w.panFrances, quantity: "20" }]), 201);
    const results = await Promise.all([fromOrder, counter].map((s) => postSale(api, s.id)));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await productQty(w)).toBe("0");
    expect((await orderOf(api, order.id)).status).toBe("DELIVERED");
    await invariants();
  });

  it("confirmar un pedido mientras se vende el mismo stock: nada queda negativo", async () => {
    await produce(api, w, "100");
    const created = await ok(
      api.post("/api/orders", {
        customerId: w.customerId,
        requestedAt: new Date(Date.now() + 86_400_000).toISOString().slice(0, 13) + ":00",
        lines: [{ productId: w.panFrances, quantity: "80" }],
      }),
      201,
    );
    const counter = await ok(draftSale(api, w, [{ productId: w.panFrances, quantity: "50" }]), 201);
    const [confirm, sale] = await Promise.all([
      api.post(`/api/orders/${created.id}/confirm`, { operationId: randomUUID() }),
      postSale(api, counter.id),
    ]);
    expect(confirm.statusCode).toBe(200);
    const order = await orderOf(api, created.id);
    const reserved = order.reservations
      .filter((r: { status: string }) => r.status === "ACTIVE")
      .reduce((s: number, r: { quantity: string }) => s + Number(r.quantity), 0);
    const sold = sale.statusCode === 200 ? 50 : 0;
    // Lo reservado + lo vendido nunca supera los 100 kg físicos.
    expect(reserved + sold).toBeLessThanOrEqual(100);
    if (sale.statusCode !== 200) {
      expect(sale.json().error.code).toBe("INSUFFICIENT_FREE_PRODUCT_STOCK");
    }
    await invariants();
  });
});

describe("cobros en paralelo sobre la misma venta", () => {
  let w: OrderWorld;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " C3");
    await produce(api, w, "100");
  });

  it("dos cobros de 60% cada uno: uno entra, el otro PAYMENT_EXCEEDS_SALE_BALANCE", async () => {
    const sale = await postedSale(api, w, [{ productId: w.panFrances, quantity: "10" }]);
    const results = await Promise.all([pay(api, sale.id, "9000"), pay(api, sale.id, "9000")]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422]);
    expect(results.find((r) => r.statusCode === 422)!.json().error.code).toBe(
      "PAYMENT_EXCEEDS_SALE_BALANCE",
    );
    const after = await ok(api.get(`/api/sales/${sale.id}`));
    expect(dec(after.amounts.paid)).toBe("9000");
    await invariants();
  });

  it("el mismo cobro reintentado en paralelo se registra una sola vez", async () => {
    const sale = await postedSale(api, w, [{ productId: w.panFrances, quantity: "10" }]);
    const opId = randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => pay(api, sale.id, "5000", opId)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
    expect(new Set(results.map((r) => r.json().payment.id)).size).toBe(1);
    const after = await ok(api.get(`/api/sales/${sale.id}`));
    expect(dec(after.amounts.paid)).toBe("5000");
    await invariants();
  });

  it("cobros, señas y ventas del mismo cliente en paralelo: saldo = Σ movimientos", async () => {
    const order = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "5" }]);
    const sale = await postedSale(api, w, [{ productId: w.panFrances, quantity: "4" }], {
      customerId: w.customerId,
    });
    const other = await ok(
      draftSale(api, w, [{ productId: w.panFrances, quantity: "3" }], { customerId: w.customerId }),
      201,
    );
    const results = await Promise.all([
      pay(api, sale.id, "1000"),
      advance(api, order.id, "700"),
      postSale(api, other.id),
      api.post(`/api/customers/${w.customerId}/payments`, {
        amount: "300",
        paymentMethod: "CASH",
        operationId: randomUUID(),
      }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 200, 201]);
    // 6.000 + 4.500 − 1.000 − 700 − 300
    expect(dec((await accountOf(api, w.customerId)).balance)).toBe("8500");
    await invariants();
  });
});

describe("la misma venta confirmada cinco veces a la vez", () => {
  it("una sola entrega: [200, 409×4], un solo juego de movimientos", async () => {
    const w = await buildOrderWorld(api, " C4");
    await produce(api, w, "100");
    const sale = await ok(draftSale(api, w, [{ productId: w.panFrances, quantity: "10" }]), 201);
    const before = await count("stock_movements");
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => postSale(api, sale.id)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409, 409]);
    expect(await count("stock_movements")).toBe(before + 1);
    expect(await productQty(w)).toBe("90");
    await invariants();
  });
});

describe("rollback: si algo falla a mitad de la confirmación no queda nada", () => {
  it("una falla al registrar la deuda revierte stock, lotes, reservas y estado", async () => {
    const w = await buildOrderWorld(api, " C5");
    await produce(api, w, "100");
    const order = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "10" }]);
    await ok(api.post(`/api/orders/${order.id}/start-preparation`, {}));
    await ok(api.post(`/api/orders/${order.id}/mark-ready`, {}));
    await ok(advance(api, order.id, "5000"), 201);
    const sale = await ok(saleFromOrder(api, w, await orderOf(api, order.id)), 201);
    const tables = [
      "stock_movements",
      "sale_lot_allocations",
      "customer_account_movements",
      "customer_payment_applications",
      "product_inventory_cost_history",
      "audit_logs",
    ];
    const snapshot = async () => ({
      counts: Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)]))),
      lots: (
        await db().execute(
          sql`select product_lot_id, quantity, inventory_value from product_lot_balances order by product_lot_id`,
        )
      ).rows,
      reservations: (
        await db().execute(
          sql`select id, status, fulfilled_quantity from product_lot_reservations order by id`,
        )
      ).rows,
      costs: (
        await db().execute(
          sql`select product_id, quantity, inventory_value from product_inventory_costs order by product_id`,
        )
      ).rows,
    });
    const before = await snapshot();
    await db().execute(sql.raw(`
      create or replace function test_fail_sale_debit() returns trigger language plpgsql as $$
      begin
        if new.movement_type = 'SALE_DEBIT' then raise exception 'falla inyectada'; end if;
        return new;
      end $$;
      create trigger test_fail_sale_debit before insert on customer_account_movements
        for each row execute function test_fail_sale_debit();
    `));
    try {
      const res = await postSale(api, sale.id);
      expect(res.statusCode).toBe(500);
    } finally {
      await db().execute(sql.raw(`
        drop trigger test_fail_sale_debit on customer_account_movements;
        drop function test_fail_sale_debit();
      `));
    }
    expect(await snapshot()).toEqual(before);
    expect((await ok(api.get(`/api/sales/${sale.id}`))).status).toBe("DRAFT");
    const detail = await orderOf(api, order.id);
    expect(detail.status).toBe("READY");
    expect(dec(detail.commercial.advances.available)).toBe("5000");
    // Sin la falla, la misma venta se confirma normalmente.
    await ok(postSale(api, sale.id));
    await invariants();
  });
});
