import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  ADMIN_B,
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
  adjust,
  advance,
  applyTo,
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
    await db().execute(
      sql.raw(`
      create or replace function test_fail_sale_debit() returns trigger language plpgsql as $$
      begin
        if new.movement_type = 'SALE_DEBIT' then raise exception 'falla inyectada'; end if;
        return new;
      end $$;
      create trigger test_fail_sale_debit before insert on customer_account_movements
        for each row execute function test_fail_sale_debit();
    `),
    );
    try {
      const res = await postSale(api, sale.id);
      expect(res.statusCode).toBe(500);
    } finally {
      await db().execute(
        sql.raw(`
        drop trigger test_fail_sale_debit on customer_account_movements;
        drop function test_fail_sale_debit();
      `),
      );
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

describe("rollback de un cobro: si falla la imputación no queda nada", () => {
  it("ni cobro, ni movimiento de cuenta, ni aplicación, ni auditoría", async () => {
    const w = await buildOrderWorld(api, " C6");
    await produce(api, w, "100");
    const sale = await postedSale(api, w, [{ productId: w.panFrances, quantity: "10" }], {
      customerId: w.customerId,
    });
    const tables = [
      "customer_payments",
      "customer_account_movements",
      "customer_payment_applications",
      "audit_logs",
    ];
    const snapshot = async () => ({
      counts: Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)]))),
      balance: (await accountOf(api, w.customerId)).balance,
      sale: (await ok(api.get(`/api/sales/${sale.id}`))).amounts,
    });
    const before = await snapshot();
    await db().execute(
      sql.raw(`
      create or replace function test_fail_application() returns trigger language plpgsql as $$
      begin raise exception 'falla inyectada'; end $$;
      create trigger test_fail_application before insert on customer_payment_applications
        for each row execute function test_fail_application();
    `),
    );
    const opId = randomUUID();
    try {
      const res = await pay(api, sale.id, "1000", opId);
      expect(res.statusCode).toBe(500);
    } finally {
      await db().execute(
        sql.raw(`
        drop trigger test_fail_application on customer_payment_applications;
        drop function test_fail_application();
      `),
      );
    }
    expect(await snapshot()).toEqual(before);
    // El reintento con el mismo operationId se registra normalmente (no quedó a medias).
    expect((await pay(api, sale.id, "1000", opId)).statusCode).toBe(201);
    await invariants();
  });
});

/*
 * Cierre de Fase 5B (ADR-063): imputación manual y ajuste de cuenta son
 * idempotentes por operationId, en la misma transacción que su consecuencia.
 */
describe("idempotencia de imputaciones manuales y ajustes de cuenta", () => {
  let w: OrderWorld;
  const price = { unitPrice: "1250", priceOverrideReason: "Precio de prueba" };

  async function auditCount(action: string) {
    const { rows } = await db().execute<{ n: number }>(
      sql`select count(*)::int as n from audit_logs where action = ${action}`,
    );
    return Number(rows[0]!.n);
  }

  /** Venta de $50.000 al cliente y un cobro a cuenta de $50.000 sin imputar. */
  async function saleAndPayment() {
    const sale = await postedSale(api, w, [{ productId: w.panFrances, quantity: "40", ...price }], {
      customerId: w.customerId,
    });
    expect(dec(sale.amounts.total)).toBe("50000");
    const res = await api.post(`/api/customers/${w.customerId}/payments`, {
      amount: "50000",
      paymentMethod: "CASH",
      operationId: randomUUID(),
    });
    expect(res.statusCode).toBe(201);
    return { sale, paymentId: res.json().payment.id as string };
  }

  beforeAll(async () => {
    w = await buildOrderWorld(api, " C7");
    for (let i = 0; i < 3; i++) await produce(api, w, "100");
  });

  it("C1/C5 imputación: reintento idéntico = replay; otro monto u otra venta = OPERATION_ID_REUSED", async () => {
    const { sale, paymentId } = await saleAndPayment();
    const other = await postedSale(api, w, [{ productId: w.panFrances, quantity: "1" }], {
      customerId: w.customerId,
    });
    const opId = randomUUID();
    const audits = await auditCount("PAYMENT_APPLIED");
    const first = await applyTo(api, paymentId, sale.id, "20000", opId);
    expect(first.statusCode).toBe(201);
    expect(first.json().replayed).toBe(false);
    const again = await applyTo(api, paymentId, sale.id, "20000", opId);
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
    const before = await count("customer_payment_applications");
    for (const reuse of [
      applyTo(api, paymentId, sale.id, "30000", opId),
      applyTo(api, paymentId, other.id, "20000", opId),
    ]) {
      const res = await reuse;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("OPERATION_ID_REUSED");
    }
    expect(await count("customer_payment_applications")).toBe(before);
    expect(await auditCount("PAYMENT_APPLIED")).toBe(audits + 1);
    expect(dec((await ok(api.get(`/api/sales/${sale.id}`))).amounts.paid)).toBe("20000");
    await invariants();
  });

  it("C2 imputación: 5 envíos simultáneos del mismo intento = una sola imputación de $20.000", async () => {
    const { sale, paymentId } = await saleAndPayment();
    const opId = randomUUID();
    const before = await count("customer_payment_applications");
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => applyTo(api, paymentId, sale.id, "20000", opId)),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(await count("customer_payment_applications")).toBe(before + 1);
    expect(dec((await ok(api.get(`/api/sales/${sale.id}`))).amounts.paid)).toBe("20000");
    expect(dec((await ok(api.get(`/api/payments/${paymentId}`))).unapplied)).toBe("30000");
    await invariants();
  });

  it("C3/C5 ajuste: reintento idéntico = replay; otro monto, tipo o motivo = OPERATION_ID_REUSED", async () => {
    const body = { direction: "CREDIT", amount: "20000", reason: "Bonificación" } as const;
    const opId = randomUUID();
    const audits = await auditCount("CUSTOMER_ACCOUNT_ADJUSTED");
    const start = dec((await accountOf(api, w.customerId)).balance)!;
    const first = await adjust(api, w.customerId, body, opId);
    expect(first.statusCode).toBe(201);
    expect(first.json().replayed).toBe(false);
    // Las notas no son parte de la huella: un reintento con otra nota sigue siendo replay.
    const again = await adjust(api, w.customerId, { ...body, notes: "reintento" }, opId);
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
    const before = await count("customer_account_movements");
    for (const changed of [
      { ...body, amount: "30000" },
      { ...body, direction: "DEBIT" as const },
      { ...body, reason: "Otro motivo" },
    ]) {
      const res = await adjust(api, w.customerId, changed, opId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("OPERATION_ID_REUSED");
    }
    const otherCustomer = await adjust(api, w.otherCustomerId, body, opId);
    expect(otherCustomer.statusCode).toBe(409);
    expect(await count("customer_account_movements")).toBe(before);
    expect(await auditCount("CUSTOMER_ACCOUNT_ADJUSTED")).toBe(audits + 1);
    expect(Number(dec((await accountOf(api, w.customerId)).balance)) - Number(start)).toBe(-20000);
    await invariants();
  });

  it("C4 ajuste: saldo $100.000 y 5 créditos simultáneos de $20.000 con el mismo id = saldo $80.000", async () => {
    const c = await ok(
      api.post("/api/customers", {
        type: "RETAILER",
        legalName: `Cliente ajuste C7 ${randomUUID()}`,
      }),
      201,
    );
    await postedSale(api, w, [{ productId: w.panFrances, quantity: "80", ...price }], {
      customerId: c.id,
    });
    expect(dec((await accountOf(api, c.id)).balance)).toBe("100000");
    const opId = randomUUID();
    const body = { direction: "CREDIT", amount: "20000", reason: "Bonificación" } as const;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => adjust(api, c.id, body, opId)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 201]);
    const account = await accountOf(api, c.id);
    expect(dec(account.balance)).toBe("80000");
    expect(
      account.movements.items.filter((m: { type: string }) => m.type === "ADJUSTMENT_CREDIT"),
    ).toHaveLength(1);
    await invariants();
  });

  it("C6 rollback: una falla después de la imputación o del movimiento no deja el id quemado", async () => {
    const { sale, paymentId } = await saleAndPayment();
    const tables = ["customer_payment_applications", "customer_account_movements", "audit_logs"];
    const counts = async () =>
      Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)])));
    const before = await counts();
    const balance = (await accountOf(api, w.customerId)).balance;
    await db().execute(
      sql.raw(`
      create or replace function test_fail_closure_audit() returns trigger language plpgsql as $$
      begin
        if new.action in ('PAYMENT_APPLIED', 'CUSTOMER_ACCOUNT_ADJUSTED') then
          raise exception 'falla inyectada';
        end if;
        return new;
      end $$;
      create trigger test_fail_closure_audit before insert on audit_logs
        for each row execute function test_fail_closure_audit();
    `),
    );
    const applyOp = randomUUID();
    const adjustOp = randomUUID();
    const body = { direction: "DEBIT", amount: "1000", reason: "Corrección" } as const;
    try {
      expect((await applyTo(api, paymentId, sale.id, "20000", applyOp)).statusCode).toBe(500);
      expect((await adjust(api, w.customerId, body, adjustOp)).statusCode).toBe(500);
    } finally {
      await db().execute(
        sql.raw(`
        drop trigger test_fail_closure_audit on audit_logs;
        drop function test_fail_closure_audit();
      `),
      );
    }
    expect(await counts()).toEqual(before);
    expect((await accountOf(api, w.customerId)).balance).toBe(balance);
    expect(dec((await ok(api.get(`/api/sales/${sale.id}`))).amounts.paid)).toBe("0");
    // El mismo id se usa normalmente después del rollback.
    expect((await applyTo(api, paymentId, sale.id, "20000", applyOp)).statusCode).toBe(201);
    expect((await adjust(api, w.customerId, body, adjustOp)).statusCode).toBe(201);
    await invariants();
  });

  it("C7 empresas: el mismo operationId en otra empresa no interfiere ni hace replay", async () => {
    const apiB = await clientFor(ctx.app, ADMIN_B);
    const wB = await buildOrderWorld(apiB, " C7B");
    const opId = randomUUID();
    const body = { direction: "CREDIT", amount: "700", reason: "Bonificación" } as const;
    expect((await adjust(api, w.customerId, body, opId)).statusCode).toBe(201);
    // Empresa B usa el mismo id para su propio ajuste: se registra (no es replay de A).
    const inB = await adjust(apiB, wB.customerId, body, opId);
    expect(inB.statusCode).toBe(201);
    expect(inB.json().replayed).toBe(false);
    expect(dec((await accountOf(apiB, wB.customerId)).balance)).toBe("-700");
    // B no puede imputar ni ajustar en A, ni siquiera reusando el id.
    const { sale, paymentId } = await saleAndPayment();
    // La venta de A no existe para B (referencia inválida) y nada cambia en A.
    const crossApply = await applyTo(apiB, paymentId, sale.id, "100", opId);
    expect(crossApply.statusCode).toBe(422);
    expect(crossApply.json().error.code).toBe("INVALID_REFERENCE");
    expect((await adjust(apiB, w.customerId, body, opId)).statusCode).toBe(404);
    expect(dec((await ok(api.get(`/api/sales/${sale.id}`))).amounts.paid)).toBe("0");
    await invariants();
  });
});
