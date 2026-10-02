import { randomUUID } from "node:crypto";
import { companies, productLotReservations } from "@bakery/database";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  ADMIN_B,
  clientFor,
  createMember,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";
import { dec, ok } from "./inventory-fixtures.js";
import { produce, reconciliationProblems } from "./lot-fixtures.js";
import {
  buildOrderWorld,
  cancel,
  confirm,
  confirmedOrder,
  draft,
  localIn,
  orderOf,
  replan,
  reservedOf,
  type OrderWorld,
} from "./order-fixtures.js";

/*
 * Pedidos (Fase 5A): concurrencia real sobre el mismo lote (§69/§70),
 * idempotencia concurrente, rollback, aislamiento entre empresas, matriz de
 * permisos por rol y la hora del pedido en la zona de la empresa (Gate Q).
 */

let ctx: TestContext;
let api: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
});
afterAll(() => ctx.close());

const db = () => ctx.database.db;

async function activeOn(lotId: string) {
  const rows = await db()
    .select({ q: sql<string>`coalesce(sum(${productLotReservations.quantity}), 0)` })
    .from(productLotReservations)
    .where(
      and(
        eq(productLotReservations.productLotId, lotId),
        eq(productLotReservations.status, "ACTIVE"),
      ),
    );
  return dec(rows[0]!.q);
}

describe("concurrencia (§69, §70)", () => {
  let w: OrderWorld;
  let lotId: string;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " K");
    lotId = (await produce(api, w, "100")).lot.id;
  });

  it("dos confirmaciones simultáneas de 70 kg sobre 100 kg: nunca se reserva más que el lote", async () => {
    const a = await ok(draft(api, w, [{ productId: w.panFrances, quantity: "70" }]), 201);
    const b = await ok(draft(api, w, [{ productId: w.panFrances, quantity: "70" }]), 201);
    const [ra, rb] = await Promise.all([confirm(api, a.id), confirm(api, b.id)]);
    expect([ra.statusCode, rb.statusCode]).toEqual([200, 200]);
    const reserved = [reservedOf(ra.json().order), reservedOf(rb.json().order)].sort();
    expect(reserved).toEqual([30, 70]);
    expect(await activeOn(lotId)).toBe("100");
    const short = [ra.json().order, rb.json().order].find((o) => reservedOf(o) === 30);
    expect(dec(short.lines[0].toProduce)).toBe("40");
  });

  it("cancelar y replanificar a la vez no dejan reservas huérfanas ni sobre-reserva", async () => {
    const { items } = await ok(api.get("/api/orders?status=CONFIRMED"));
    const [x, y] = items;
    const results = await Promise.all([cancel(api, x.id), replan(api, y.id)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const after = await orderOf(api, y.id);
    expect(reservedOf(after)).toBe(70);
    expect(await activeOn(lotId)).toBe("70");
  });

  it("dos reintentos simultáneos con el mismo operationId confirman una sola vez", async () => {
    const order = await ok(draft(api, w, [{ productId: w.panFrances, quantity: "5" }]), 201);
    const op = randomUUID();
    const results = await Promise.all([confirm(api, order.id, op), confirm(api, order.id, op)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results.map((r) => r.json().replayed).sort()).toEqual([false, true]);
    const detail = await orderOf(api, order.id);
    expect(detail.reservations).toHaveLength(1);
  });

  it("merma y confirmación a la vez sobre el mismo lote: la base nunca queda inconsistente", async () => {
    const order = await ok(draft(api, w, [{ productId: w.panFrances, quantity: "25" }]), 201);
    const [wasted, confirmed] = await Promise.all([
      api.post(`/api/product-lots/${lotId}/waste`, {
        quantity: "20",
        reason: "DAMAGED",
        operationId: randomUUID(),
      }),
      confirm(api, order.id),
    ]);
    expect([wasted.statusCode, confirmed.statusCode]).toEqual([201, 200]);
    const balance = await ok(api.get(`/api/product-lots/${lotId}`));
    expect(Number(await activeOn(lotId))).toBeLessThanOrEqual(Number(balance.quantity));
    expect(await reconciliationProblems(db())).toEqual([]);
  });
});

describe("rollback", () => {
  it("una falla al auditar la confirmación no deja reservas, necesidades ni estado a medias", async () => {
    const w = await buildOrderWorld(api, " R");
    await produce(api, w, "10");
    const order = await ok(draft(api, w, [{ productId: w.panFrances, quantity: "30" }]), 201);
    await db().execute(sql`
      create function test_fail_order_audit() returns trigger language plpgsql as $$
      begin raise exception 'falla inyectada antes del commit'; end $$;
      create trigger test_fail_order_audit before insert on audit_logs
        for each row when (new.action = 'ORDER_CONFIRMED')
        execute function test_fail_order_audit();
    `);
    try {
      expect((await confirm(api, order.id)).statusCode).toBe(500);
    } finally {
      await db().execute(sql`
        drop trigger test_fail_order_audit on audit_logs;
        drop function test_fail_order_audit();
      `);
    }
    const after = await orderOf(api, order.id);
    expect(after).toMatchObject({ status: "DRAFT", planRevision: 0 });
    expect(after.reservations).toHaveLength(0);
    expect(after.productionRequirements).toHaveLength(0);
    const { order: confirmed } = await ok(confirm(api, order.id));
    expect(reservedOf(confirmed)).toBe(10);
  });
});

describe("tenencia", () => {
  let w: OrderWorld;
  let orderId: string;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " T");
    orderId = (await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "5" }])).id;
  });

  it("la empresa B no ve ni opera pedidos, necesidades ni productos de la A", async () => {
    const b = await clientFor(ctx.app, ADMIN_B);
    expect((await b.get(`/api/orders/${orderId}`)).statusCode).toBe(404);
    expect((await confirm(b, orderId)).statusCode).toBe(404);
    expect((await replan(b, orderId)).statusCode).toBe(404);
    expect((await cancel(b, orderId)).statusCode).toBe(404);
    expect((await b.post(`/api/orders/${orderId}/mark-ready`, {})).statusCode).toBe(404);
    expect((await ok(b.get("/api/orders?status=all"))).total).toBe(0);
    expect((await ok(b.get("/api/planning/production-needs"))).total).toBe(0);
    const [req] = (await orderOf(api, orderId)).productionRequirements;
    expect((await b.get(`/api/planning/requirements/${req.id}`)).statusCode).toBe(404);
    const foreign = await b.post("/api/orders/coverage-preview", {
      requestedAt: localIn(1),
      lines: [{ productId: w.panFrances, quantity: "1" }],
    });
    expect(foreign.statusCode).toBe(422);
    const customer = await b.post("/api/orders", {
      customerId: w.customerId,
      requestedAt: localIn(1),
      lines: [{ productId: w.panFrances, quantity: "1" }],
    });
    expect(customer.statusCode).toBe(422);
    expect(customer.json().error.details[0].path).toBe("customerId");
  });
});

describe("permisos por rol", () => {
  let w: OrderWorld;
  let orderId: string;
  const roleClient = async (role: string) => {
    const who = { email: `${role.toLowerCase()}@pedidos.test`, password: "role-password-123" };
    await createMember(ctx.database, ctx.companyId, {
      ...who,
      displayName: `Rol ${role}`,
      roles: [role as "PRODUCTION"],
    });
    return clientFor(ctx.app, who);
  };
  let sales: ApiClient;
  let production: ApiClient;
  let warehouse: ApiClient;
  let administration: ApiClient;

  beforeAll(async () => {
    w = await buildOrderWorld(api, " P");
    await produce(api, w, "50");
    sales = await roleClient("SALES");
    production = await roleClient("PRODUCTION");
    warehouse = await roleClient("WAREHOUSE");
    administration = await roleClient("ADMINISTRATION");
    const created = await ok(
      draft(sales, w, [{ productId: w.panFrances, quantity: "80" }], {
        contactName: "Marta",
        contactPhone: "11-4444",
        deliveryAddress: "Calle 1",
        fulfillmentType: "DELIVERY",
      }),
      201,
    );
    orderId = created.id;
  });

  it("Ventas carga y confirma; Producción y Depósito no", async () => {
    expect((await confirm(production, orderId)).statusCode).toBe(403);
    expect((await confirm(warehouse, orderId)).statusCode).toBe(403);
    expect(
      (await draft(production, w, [{ productId: w.panFrances, quantity: "1" }])).statusCode,
    ).toBe(403);
    expect((await confirm(sales, orderId)).statusCode).toBe(200);
  });

  it("Producción ve el pedido sin datos de contacto y crea la orden desde la necesidad; Ventas no", async () => {
    const seen = await orderOf(production, orderId);
    expect(seen.canSeeCustomerDetails).toBe(false);
    expect(seen.customer.name).toBe("Hotel Central P");
    expect(seen).toMatchObject({
      contactName: null,
      contactPhone: null,
      deliveryAddress: null,
      customer: { phone: null, address: null },
    });
    expect(seen.actions).toMatchObject({ canConfirm: false, canReplan: false, canCancel: false });
    const full = await orderOf(sales, orderId);
    expect(full).toMatchObject({ contactName: "Marta", canSeeCustomerDetails: true });

    const [req] = seen.productionRequirements;
    const body = {
      productId: w.panFrances,
      scheduledFor: localIn(1).slice(0, 10),
      plannedOutputQuantity: "30",
      sourceWarehouseId: w.warehouseId,
      outputWarehouseId: w.warehouseId,
      sourceOrderRequirementId: req.id,
    };
    expect((await sales.post("/api/production-orders", body)).statusCode).toBe(403);
    expect((await sales.get("/api/planning/production-needs")).statusCode).toBe(403);
    expect(
      (await ok(production.post("/api/production-orders", body), 201)).sourceOrder.orderId,
    ).toBe(orderId);
  });

  it("Depósito marca listo sólo con cobertura completa; Administración recalcula", async () => {
    const blocked = await warehouse.post(`/api/orders/${orderId}/mark-ready`, {});
    expect(blocked.statusCode).toBe(409);
    expect((await replan(warehouse, orderId)).statusCode).toBe(403);
    expect((await replan(administration, orderId)).statusCode).toBe(200);
    expect((await cancel(administration, orderId)).statusCode).toBe(403);
    expect((await ok(administration.get("/api/planning/material-demand"))).items).toBeDefined();
    await ok(cancel(sales, orderId));
    const small = await confirmedOrder(sales, w, [{ productId: w.panFrances, quantity: "1" }]);
    expect((await warehouse.post(`/api/orders/${small.id}/mark-ready`, {})).statusCode).toBe(200);
  });

  it("el detalle de lote lista los pedidos que lo reservan; sin customers.read, sin el cliente", async () => {
    const [ready] = (await ok(api.get("/api/orders?status=READY"))).items;
    const lotId = (await orderOf(api, ready.id)).reservations[0].lot.id;
    const asWarehouse = await ok(warehouse.get(`/api/product-lots/${lotId}`));
    expect(asWarehouse.commitment.reservations.length).toBeGreaterThan(0);
    expect(asWarehouse.commitment.reservations[0].customer).toBeNull();
  });
});

describe("hora del pedido en la zona de la empresa (Gate Q, §84)", () => {
  it("la misma hora de pared se guarda distinta según la zona de la empresa", async () => {
    await db()
      .update(companies)
      .set({ timezone: "Asia/Tokyo" })
      .where(eq(companies.id, ctx.companyBId));
    const b = await clientFor(ctx.app, ADMIN_B);
    const w = await buildOrderWorld(b, " Z");
    const order = await ok(
      draft(b, w, [{ productId: w.panFrances, quantity: "1" }], {
        requestedAt: "2030-10-10T10:00",
      }),
      201,
    );
    expect(order.requestedAt).toBe("2030-10-10T01:00:00.000Z");
    expect(order.requestedAtLocal).toBe("2030-10-10T10:00");
    expect(order.timezone).toBe("Asia/Tokyo");
    const bad = await b.post("/api/orders", {
      customerId: w.customerId,
      requestedAt: "2030-10-10T10:00:00Z",
      lines: [{ productId: w.panFrances, quantity: "1" }],
    });
    expect(bad.statusCode).toBe(400);
    // El filtro por fecha también es de calendario de la empresa.
    const listed = await ok(b.get("/api/orders?from=2030-10-10&to=2030-10-10&status=all"));
    expect(listed.items.map((o: { id: string }) => o.id)).toContain(order.id);
    const nextDay = await ok(b.get("/api/orders?from=2030-10-11&status=all"));
    expect(nextDay.items.map((o: { id: string }) => o.id)).not.toContain(order.id);
  });
});
