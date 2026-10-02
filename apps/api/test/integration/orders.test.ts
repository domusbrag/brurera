import { randomUUID } from "node:crypto";
import {
  auditLogs,
  customerOrders,
  orderMaterialRequirements,
  orderProductionRequirements,
  productLotReservations,
  stockMovements,
} from "@bakery/database";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  clientFor,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";
import { dec, ok } from "./inventory-fixtures.js";
import { DAY, freeze, produce, reconciliationProblems, waste } from "./lot-fixtures.js";
import {
  buildOrderWorld,
  cancel,
  confirm,
  confirmedOrder,
  draft,
  freshAndFrozen,
  localIn,
  orderOf,
  replan,
  reservedOf,
  type OrderWorld,
} from "./order-fixtures.js";
import { recordActuals, stock } from "./production-fixtures.js";

/*
 * Pedidos, demanda comprometida y necesidades (Fase 5A) contra la API real y
 * PostgreSQL: borrador sin reservas, confirmación atómica con reserva FEFO por
 * lote (sin mover stock), necesidades de producción y de materias primas,
 * demanda global con horizonte, REPLAN con historia, cancelación, LISTO,
 * calidad y merma sobre reservas, transformación de lo comprometido y orden de
 * producción desde un pedido.
 */

let ctx: TestContext;
let api: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
});
afterAll(() => ctx.close());

const db = () => ctx.database.db;

async function count(table: string) {
  const { rows } = await db().execute<{ n: number }>(
    sql.raw(`select count(*)::int as n from ${table}`),
  );
  return Number(rows[0]!.n);
}

async function snapshot() {
  const tables = [
    "customer_orders",
    "customer_order_lines",
    "product_lot_reservations",
    "order_production_requirements",
    "order_material_requirements",
    "customer_order_operations",
    "stock_movements",
    "audit_logs",
    "code_sequences",
  ];
  return Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)])));
}

async function orderAudit(orderId: string) {
  const rows = await db()
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "customer_order"), eq(auditLogs.entityId, orderId)))
    .orderBy(auditLogs.id);
  return rows.map((r) => r.action);
}

describe("borrador, vista previa y confirmación (§72–§76)", () => {
  let w: OrderWorld;
  let lots: { fresh: string; frozen: string };
  beforeAll(async () => {
    w = await buildOrderWorld(api, " A");
    lots = await freshAndFrozen(api, w);
  });

  it("el borrador recibe PED-0001, guarda la hora de la empresa y no reserva nada", async () => {
    const before = await count("product_lot_reservations");
    const res = await draft(api, w, [{ productId: w.panFrances, quantity: "100" }], {
      requestedAt: "2030-10-10T10:00",
    });
    expect(res.statusCode).toBe(201);
    const order = res.json();
    expect(order.code).toBe("PED-0001");
    expect(order.status).toBe("DRAFT");
    expect(order.coverageStatus).toBeNull();
    expect(order.planRevision).toBe(0);
    // 10:00 en Buenos Aires = 13:00 UTC, y se muestra 10:00 (Gate Q, §84).
    expect(order.requestedAt).toBe("2030-10-10T13:00:00.000Z");
    expect(order.requestedAtLocal).toBe("2030-10-10T10:00");
    expect(order.timezone).toBe("America/Argentina/Buenos_Aires");
    expect(await count("product_lot_reservations")).toBe(before);
    expect(order.lines[0]).toMatchObject({ physical: null });
    expect(dec(order.lines[0].reserved)).toBe("0");
  });

  it("vista previa: 700 físicos, 300 vencen antes, 400 elegibles, explica y no escribe nada", async () => {
    const before = await snapshot();
    const preview = await ok(
      api.post("/api/orders/coverage-preview", {
        requestedAt: localIn(3, 10),
        lines: [{ productId: w.panFrances, quantity: "500" }],
      }),
    );
    expect(await snapshot()).toEqual(before);
    const line = preview.lines[0];
    expect(dec(line.physical)).toBe("700");
    expect(dec(line.eligible)).toBe("400");
    expect(dec(line.available)).toBe("400");
    expect(dec(line.reserve)).toBe("400");
    expect(dec(line.toProduce)).toBe("100");
    expect(line.ineligible).toEqual([
      expect.objectContaining({ reason: "EXPIRED", quantity: expect.stringMatching(/^300/) }),
    ]);
    expect(line.lots.find((l: { id: string }) => l.id === lots.frozen).reserve).toMatch(/^400/);
    expect(line.lots.find((l: { id: string }) => l.id === lots.fresh)).toMatchObject({
      eligible: false,
      reason: "EXPIRED",
    });
    expect(line.explanation.join(" ")).toContain("300 kg no sirven");
    expect(preview.coverageStatus).toBe("PARTIALLY_COVERED");
    // 100 kg a producir = 75 kg harina + 0,8 kg sal.
    expect(line.materials.map((m: { required: string }) => dec(m.required)).sort()).toEqual([
      "0.8",
      "75",
    ]);
  });

  it("confirmar reserva FEFO por lote, SIN mover stock, y registra la necesidad con la receta fijada", async () => {
    const movements = await count("stock_movements");
    const created = await ok(
      draft(api, w, [{ productId: w.panFrances, quantity: "100" }], {
        requestedAt: localIn(3, 10),
      }),
      201,
    );
    const { order, replayed } = await ok(confirm(api, created.id));
    expect(replayed).toBe(false);
    expect(order).toMatchObject({
      status: "CONFIRMED",
      coverageStatus: "FULLY_COVERED",
      planRevision: 1,
    });
    expect(order.reservations).toHaveLength(1);
    expect(order.reservations[0]).toMatchObject({ status: "ACTIVE", planRevision: 1 });
    expect(order.reservations[0].lot.id).toBe(lots.frozen);
    expect(dec(order.reservations[0].quantity)).toBe("100");
    expect(order.productionRequirements).toHaveLength(0);
    expect(await count("stock_movements")).toBe(movements);
    expect(await orderAudit(order.id)).toEqual([
      "ORDER_CREATED",
      "LOT_RESERVED",
      "ORDER_CONFIRMED",
    ]);
  });

  it("§73: comprometido 100 → otro pedido de 500 ve elegible 400, disponible 300, reserva 300 y produce 200", async () => {
    const order = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "500" }], {
      customerId: w.otherCustomerId,
      requestedAt: localIn(3, 10),
    });
    expect(order.coverageStatus).toBe("PARTIALLY_COVERED");
    expect(reservedOf(order)).toBe(300);
    const line = order.lines[0];
    expect(dec(line.eligible)).toBe("400");
    expect(dec(line.committedByOthers)).toBe("100");
    expect(dec(line.reserved)).toBe("300");
    expect(dec(line.toProduce)).toBe("200");
    const [req] = order.productionRequirements;
    expect(req).toMatchObject({ status: "OPEN", planRevision: 1, problem: null });
    expect(req.recipe).toMatchObject({ versionId: w.v1, versionNumber: 1 });
    expect(dec(req.quantity)).toBe("200");
    // 200 kg → 150 kg harina + 1,6 kg sal (mismo escalado que Producción).
    const mats = Object.fromEntries(
      req.materials.map((m: { rawMaterial: { id: string }; required: string }) => [
        m.rawMaterial.id,
        dec(m.required),
      ]),
    );
    expect(mats).toEqual({ [w.harina]: "150", [w.sal]: "1.6" });
    expect(order.issues.map((i: { code: string }) => i.code)).toContain("TO_PRODUCE");
  });

  it("la materia prima no se reserva: el stock sigue igual y sólo se proyecta la demanda", async () => {
    const [{ n }] = (
      await db().execute<{ n: number }>(
        sql`select count(*)::int as n from stock_movements where item_type = 'RAW_MATERIAL' and movement_type not in ('INITIAL_STOCK','ADJUSTMENT_POSITIVE','PRODUCTION_CONSUMPTION')`,
      )
    ).rows;
    expect(Number(n)).toBe(0);
    const demand = await ok(api.get("/api/planning/material-demand"));
    const harina = demand.items.find(
      (m: { rawMaterial: { id: string } }) => m.rawMaterial.id === w.harina,
    );
    expect(dec(harina.openOrderDemand)).toBe("150");
  });

  it("la disponibilidad del producto y el resumen de stock muestran comprometido y disponible", async () => {
    const at = new Date(Date.now() + 3 * DAY * 60_000).toISOString();
    const availability = await ok(
      api.get(`/api/inventory/products/${w.panFrances}/availability?at=${encodeURIComponent(at)}`),
    );
    expect(dec(availability.eligibleQuantity)).toBe("400");
    expect(dec(availability.committedQuantity)).toBe("400");
    expect(dec(availability.availableQuantity)).toBe("0");
    const lot = await ok(api.get(`/api/product-lots/${lots.frozen}`));
    expect(dec(lot.commitment.committedQuantity)).toBe("400");
    expect(dec(lot.commitment.freeQuantity)).toBe("0");
    expect(lot.commitment.reservations).toHaveLength(2);
    expect(lot.commitment.reservations[0].customer).toBeTruthy();
  });

  it("confirmar dos veces con el mismo operationId devuelve el mismo resultado (idempotente)", async () => {
    const created = await ok(draft(api, w, [{ productId: w.panFrances, quantity: "10" }]), 201);
    const op = randomUUID();
    const first = await ok(confirm(api, created.id, op));
    const before = await snapshot();
    const second = await ok(confirm(api, created.id, op));
    expect(second.replayed).toBe(true);
    expect(second.order.planRevision).toBe(first.order.planRevision);
    expect(await snapshot()).toEqual(before);
    // El mismo id para otra acción → 409.
    const reused = await cancel(api, created.id, {}, op);
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("OPERATION_ID_REUSED");
    // Confirmar un pedido ya confirmado (otro id) → transición inválida.
    const again = await confirm(api, created.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("INVALID_ORDER_TRANSITION");
    await ok(cancel(api, created.id));
  });

  it("GET de detalle, listado y planificación no escriben nada", async () => {
    const { items } = await ok(api.get("/api/orders?status=all"));
    const before = await snapshot();
    for (const o of items) await orderOf(api, o.id);
    await ok(api.get("/api/planning/production-needs"));
    await ok(api.get("/api/planning/material-demand"));
    await ok(api.get("/api/planning/orders-at-risk"));
    expect(await snapshot()).toEqual(before);
  });
});

describe("conservación pedida y sin receta", () => {
  let w: OrderWorld;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " B");
    await freshAndFrozen(api, w);
  });

  it("pedido de congelado sólo toma lotes congelados; fresco para mañana sólo frescos", async () => {
    const frozen = await confirmedOrder(api, w, [
      { productId: w.panFrances, quantity: "50", requestedConservation: "FROZEN" },
    ]);
    expect(frozen.reservations[0].lot.conservationState).toBe("FROZEN");
    const fresh = await confirmedOrder(
      api,
      w,
      [{ productId: w.panFrances, quantity: "50", requestedConservation: "FRESH" }],
      { requestedAt: localIn(1) },
    );
    expect(fresh.reservations[0].lot.conservationState).toBe("FRESH");
  });

  it("un producto sin receta queda sin cubrir, con problema y sin materias primas inventadas", async () => {
    const product = await ok(
      api.post("/api/products", {
        name: "Torta sin receta B",
        categoryId: w.productCategoryId,
        saleUnitId: w.units.unidad,
        salePrice: "1000",
      }),
      201,
    );
    const order = await confirmedOrder(api, w, [{ productId: product.id, quantity: "3" }]);
    expect(order.coverageStatus).toBe("NOT_COVERED");
    const [req] = order.productionRequirements;
    expect(req).toMatchObject({ problem: "NO_RECIPE_FOR_PRODUCTION", recipe: null, materials: [] });
    expect(dec(order.lines[0].uncovered)).toBe("3");
    expect(dec(order.lines[0].toProduce)).toBe("0");
    expect(order.issues.map((i: { code: string }) => i.code)).toContain("NO_RECIPE");
  });
});

describe("demanda global de materias primas con horizonte (§77)", () => {
  let w: OrderWorld;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " C");
    // 10 kg de sal en stock; nada de Pan francés: todo se produce.
    await stock(api, w, w.sal, "10", "400");
  });

  it("A necesita 7 kg y B 5 kg con 10 kg en stock: demanda 12, faltante 2, aunque cada uno 'alcanzaba'", async () => {
    // 875 kg de pan → 7 kg de sal; 625 kg → 5 kg.
    const a = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "875" }], {
      requestedAt: localIn(2),
    });
    const b = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "625" }], {
      requestedAt: localIn(6),
    });
    const demand = await ok(api.get("/api/planning/material-demand"));
    const sal = demand.items.find(
      (m: { rawMaterial: { id: string } }) => m.rawMaterial.id === w.sal,
    );
    expect(dec(sal.currentStock)).toBe("10");
    expect(dec(sal.openOrderDemand)).toBe("12");
    expect(dec(sal.shortage)).toBe("2");
    expect(sal.orders.map((o: { orderCode: string }) => o.orderCode)).toEqual([a.code, b.code]);
    // En el pedido B: su necesidad (5) + la de los demás (7) − stock (10) = 2 de faltante proyectado.
    const salB = b.materials.find(
      (m: { rawMaterial: { id: string } }) => m.rawMaterial.id === w.sal,
    );
    expect(dec(salB.otherOrdersDemand)).toBe("7");
    expect(dec(salB.projectedShortage)).toBe("2");

    // Horizonte: hasta dentro de 4 días sólo cuenta A → 7 kg, sin faltante.
    const until = encodeURIComponent(localIn(4));
    const near = await ok(api.get(`/api/planning/material-demand?until=${until}`));
    const salNear = near.items.find(
      (m: { rawMaterial: { id: string } }) => m.rawMaterial.id === w.sal,
    );
    expect(dec(salNear.openOrderDemand)).toBe("7");
    expect(dec(salNear.shortage)).toBe("0");

    const needs = await ok(api.get("/api/planning/production-needs"));
    const pan = needs.items.find((n: { product: { id: string } }) => n.product.id === w.panFrances);
    expect(dec(pan.quantity)).toBe("1500");
    const risk = await ok(api.get("/api/planning/orders-at-risk"));
    const codes = risk.items.map((r: { order: { code: string } }) => r.order.code);
    expect(codes).toEqual(expect.arrayContaining([a.code, b.code]));
  });
});

describe("REPLAN, cancelación, stock liberado y LISTO (§78–§80)", () => {
  let w: OrderWorld;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " D");
    await produce(api, w, "100");
  });

  it("replan cambia cantidad: libera la revisión 1, reserva en la 2 y conserva la historia", async () => {
    const order = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "60" }]);
    expect(dec(order.lines[0].reserved)).toBe("60");
    const preview = await ok(
      api.post(`/api/orders/${order.id}/replan-preview`, {
        lines: [{ id: order.lines[0].id, productId: w.panFrances, quantity: "80" }],
      }),
    );
    expect(preview).toMatchObject({ revisionFrom: 1, revisionTo: 2 });
    expect(preview.releasedLots).toHaveLength(1);
    expect(dec(preview.newLots[0].quantity)).toBe("80");
    const { order: after } = await ok(
      replan(api, order.id, {
        lines: [{ id: order.lines[0].id, productId: w.panFrances, quantity: "80" }],
      }),
    );
    expect(after.planRevision).toBe(2);
    expect(dec(after.lines[0].reserved)).toBe("80");
    const byRevision = after.reservations.map(
      (r: { planRevision: number; status: string; releaseReason: string | null }) => [
        r.planRevision,
        r.status,
        r.releaseReason,
      ],
    );
    expect(byRevision).toEqual([
      [2, "ACTIVE", null],
      [1, "RELEASED", "ORDER_REPLANNED"],
    ]);
    expect(await orderAudit(order.id)).toContain("ORDER_REPLANNED");
    await ok(cancel(api, order.id));
  });

  it("cancelar libera las reservas; el stock liberado NO se reasigna solo: el otro pedido avisa", async () => {
    const a = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "100" }]);
    const b = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "40" }], {
      customerId: w.otherCustomerId,
    });
    expect(reservedOf(b)).toBe(0);
    expect(b.coverageStatus).toBe("NOT_COVERED");
    const { order: cancelled } = await ok(cancel(api, a.id));
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.reservations[0]).toMatchObject({
      status: "RELEASED",
      releaseReason: "ORDER_CANCELLED",
    });
    expect(
      cancelled.productionRequirements.every((r: { status: string }) => r.status === "CANCELLED"),
    ).toBe(true);
    const bNow = await orderOf(api, b.id);
    expect(reservedOf(bNow)).toBe(0);
    expect(bNow.coverageStatus).toBe("NOT_COVERED");
    expect(bNow.planRevision).toBe(1);
    expect(dec(bNow.lines[0].newlyAvailable)).toBe("40");
    const notice = bNow.issues.find((i: { code: string }) => i.code === "NEW_STOCK_AVAILABLE");
    expect(notice.message).toContain("Hay nuevo stock disponible — recalcular cobertura");
    // "Actualizar cobertura" = replan explícito sin cambios.
    const { order: refreshed } = await ok(replan(api, b.id));
    expect(refreshed.coverageStatus).toBe("FULLY_COVERED");
    expect(refreshed.planRevision).toBe(2);
    expect(
      refreshed.productionRequirements.find((r: { planRevision: number }) => r.planRevision === 1)
        .status,
    ).toBe("CANCELLED");
  });

  it("LISTO exige cobertura completa; un LISTO se cancela sólo con advertencia", async () => {
    const { items } = await ok(api.get("/api/orders?coverage=FULLY_COVERED"));
    const covered = items.find(
      (o: { customer: { id: string } }) => o.customer.id === w.otherCustomerId,
    );
    const partial = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "500" }]);
    const blocked = await api.post(`/api/orders/${partial.id}/mark-ready`, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("ORDER_NOT_FULLY_COVERED");
    expect(partial.actions.canMarkReady).toBe(false);
    expect(partial.actions.readyBlockedReason).toBeTruthy();

    await ok(api.post(`/api/orders/${covered.id}/start-preparation`, {}));
    const ready = await ok(api.post(`/api/orders/${covered.id}/mark-ready`, {}));
    expect(ready.status).toBe("READY");
    const refused = await cancel(api, covered.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("ORDER_READY_CANCEL_CONFIRMATION");
    const { order } = await ok(cancel(api, covered.id, { confirmReady: true }));
    expect(order.status).toBe("CANCELLED");
    await ok(cancel(api, partial.id));
  });

  it("un pedido confirmado sólo edita datos informativos; fecha y productos se replanifican", async () => {
    const order = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "1" }]);
    const info = await ok(
      api.patch(`/api/orders/${order.id}`, { contactName: "Marta", priority: "URGENT" }),
    );
    expect(info).toMatchObject({ contactName: "Marta", priority: "URGENT", planRevision: 1 });
    const locked = await api.patch(`/api/orders/${order.id}`, { requestedAt: localIn(5) });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe("ORDER_PLAN_LOCKED");
    await ok(cancel(api, order.id));
  });
});

describe("calidad, merma y transformación sobre lo comprometido (§81–§83)", () => {
  let w: OrderWorld;
  let lotId: string;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " E");
    lotId = (await produce(api, w, "100")).lot.id;
  });

  it("no se puede congelar lo comprometido: LOT_QUANTITY_COMMITTED, y la parte libre sí", async () => {
    const order = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "70" }]);
    const refused = await freeze(api, lotId, "40");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("LOT_QUANTITY_COMMITTED");
    expect(refused.json().error.message).toContain("hasta 30");
    await ok(freeze(api, lotId, "30"), 201);
    expect(reservedOf(await orderOf(api, order.id))).toBe(70);
  });

  it("merma parcial reduce la reserva (invalida y re-reserva lo que queda) y el pedido necesita recalcular", async () => {
    const [order] = (await ok(api.get("/api/orders?status=CONFIRMED"))).items.filter(
      (o: { products: { name: string }[] }) => o.products[0]?.name === "Pan francés E",
    );
    await ok(waste(api, lotId, "20"), 201);
    const after = await orderOf(api, order.id);
    expect(after.coverageStatus).toBe("NEEDS_REPLAN");
    expect(after.status).toBe("CONFIRMED");
    expect(reservedOf(after)).toBe(50);
    const statuses = after.reservations.map((r: { status: string; quantity: string }) => [
      r.status,
      dec(r.quantity),
    ]);
    expect(statuses).toEqual(
      expect.arrayContaining([
        ["ACTIVE", "50"],
        ["INVALIDATED", "70"],
      ]),
    );
    expect(after.issues.map((i: { code: string }) => i.code)).toEqual(
      expect.arrayContaining(["LOT_WASTE", "NEEDS_REPLAN"]),
    );
    expect(after.actions.canMarkReady).toBe(false);
    expect(await reconciliationProblems(db())).toEqual([]);
  });

  it("bloquear el lote invalida todas sus reservas; replan reserva otra cosa o pasa a producir", async () => {
    const [order] = (await ok(api.get("/api/orders?coverage=NEEDS_REPLAN"))).items;
    await ok(api.post(`/api/product-lots/${lotId}/block`, { reason: "Contaminación" }));
    const after = await orderOf(api, order.id);
    expect(reservedOf(after)).toBe(0);
    expect(after.issues.map((i: { code: string }) => i.code)).toContain("LOT_BLOCKED");
    const { order: replanned } = await ok(replan(api, order.id));
    expect(replanned.coverageStatus).not.toBe("NEEDS_REPLAN");
    // Toma los 30 kg congelados libres (lote hijo) y el resto pasa a producir.
    expect(dec(replanned.lines[0].reserved)).toBe("30");
    expect(replanned.reservations[0].lot.conservationState).toBe("FROZEN");
    expect(dec(replanned.lines[0].toProduce)).toBe("40");
    // La base impide reservar un lote bloqueado aunque la aplicación fallara.
    const [line] = replanned.lines;
    const err = await db()
      .insert(productLotReservations)
      .values({
        companyId: ctx.companyId,
        customerOrderId: replanned.id,
        orderLineId: line.id,
        productId: w.panFrances,
        productLotId: lotId,
        quantity: "1",
        unitId: w.units.kg!,
        planRevision: replanned.planRevision,
      })
      .then(
        () => "sin error",
        (e: { cause?: { message?: string } }) => e.cause?.message ?? "",
      );
    expect(err).toMatch(/lot_reservation/);
  });
});

describe("orden de producción desde un pedido (§80)", () => {
  let w: OrderWorld;
  beforeAll(async () => {
    w = await buildOrderWorld(api, " F");
  });

  it("prellena con la necesidad, la vincula, no permite duplicar; completar la cumple y avisa stock nuevo", async () => {
    const order = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "40" }]);
    const [req] = order.productionRequirements;
    const prefill = await ok(api.get(`/api/planning/requirements/${req.id}`));
    expect(prefill).toMatchObject({ blockedReason: null, status: "OPEN" });
    expect(dec(prefill.quantity)).toBe("40");
    const production = await ok(
      api.post("/api/production-orders", {
        productId: w.panFrances,
        scheduledFor: prefill.requiredBy,
        plannedOutputQuantity: prefill.quantity,
        recipeVersionId: prefill.recipe.versionId,
        sourceWarehouseId: w.warehouseId,
        outputWarehouseId: w.warehouseId,
        sourceOrderRequirementId: req.id,
      }),
      201,
    );
    expect(production.sourceOrder).toMatchObject({ orderCode: order.code, requirementId: req.id });
    const linked = await orderOf(api, order.id);
    expect(linked.productionRequirements[0]).toMatchObject({
      status: "PRODUCTION_CREATED",
      productionOrder: { id: production.id },
    });
    expect(await orderAudit(order.id)).toContain("PRODUCTION_ORDER_CREATED_FROM_ORDER");
    const dup = await api.post("/api/production-orders", {
      productId: w.panFrances,
      scheduledFor: prefill.requiredBy,
      plannedOutputQuantity: "40",
      sourceWarehouseId: w.warehouseId,
      outputWarehouseId: w.warehouseId,
      sourceOrderRequirementId: req.id,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("REQUIREMENT_NOT_OPEN");

    // Completar la producción cumple la necesidad; el lote nuevo NO se reserva solo.
    await stock(api, w, w.harina, "30", "900");
    await stock(api, w, w.sal, "0.32", "400");
    await ok(api.post(`/api/production-orders/${production.id}/plan`, {}));
    const started = await ok(api.post(`/api/production-orders/${production.id}/start`, {}));
    await recordActuals(api, w, started, { [w.harina]: "30", [w.sal]: "0.32" }, "40");
    await ok(api.post(`/api/production-orders/${production.id}/complete`, {}));
    const after = await orderOf(api, order.id);
    expect(after.productionRequirements[0].status).toBe("SATISFIED");
    expect(reservedOf(after)).toBe(0);
    expect(after.issues.map((i: { code: string }) => i.code)).toContain("NEW_STOCK_AVAILABLE");
    const { order: refreshed } = await ok(replan(api, order.id));
    expect(refreshed.coverageStatus).toBe("FULLY_COVERED");
  });

  it("cancelar la orden de producción deja la necesidad pendiente otra vez", async () => {
    const order = await confirmedOrder(api, w, [{ productId: w.panFrances, quantity: "300" }]);
    const req = order.productionRequirements.find((r: { status: string }) => r.status === "OPEN");
    const production = await ok(
      api.post("/api/production-orders", {
        productId: w.panFrances,
        scheduledFor: localIn(1).slice(0, 10),
        plannedOutputQuantity: "300",
        sourceWarehouseId: w.warehouseId,
        outputWarehouseId: w.warehouseId,
        sourceOrderRequirementId: req.id,
      }),
      201,
    );
    await ok(api.post(`/api/production-orders/${production.id}/cancel`, { reason: "Sin horno" }));
    const after = await orderOf(api, order.id);
    const reqAfter = after.productionRequirements.find((r: { id: string }) => r.id === req.id);
    expect(reqAfter).toMatchObject({ status: "OPEN", productionOrder: null });
    expect(after.issues.map((i: { code: string }) => i.code)).toContain("PRODUCTION_CANCELLED");
  });
});

describe("guardas de base", () => {
  it("las reservas no se borran y los pedidos cancelados no cambian", async () => {
    const [reservation] = await db().select().from(productLotReservations).limit(1);
    expect(
      await db()
        .delete(productLotReservations)
        .where(eq(productLotReservations.id, reservation!.id))
        .then(
          () => "sin error",
          (e: { cause?: { message?: string } }) => e.cause?.message ?? "",
        ),
    ).not.toBe("sin error");
    const [order] = await db()
      .select()
      .from(customerOrders)
      .where(eq(customerOrders.status, "CANCELLED"))
      .limit(1);
    expect(
      await db()
        .update(customerOrders)
        .set({ notes: "cambio" })
        .where(eq(customerOrders.id, order!.id))
        .then(
          () => "sin error",
          (e: { cause?: { message?: string } }) => e.cause?.message ?? "",
        ),
    ).not.toBe("sin error");
    const [material] = await db().select().from(orderMaterialRequirements).limit(1);
    expect(
      await db()
        .update(orderMaterialRequirements)
        .set({ requiredQuantity: "1" })
        .where(eq(orderMaterialRequirements.id, material!.id))
        .then(
          () => "sin error",
          (e: { cause?: { message?: string } }) => e.cause?.message ?? "",
        ),
    ).not.toBe("sin error");
    const [requirement] = await db().select().from(orderProductionRequirements).limit(1);
    expect(
      await db()
        .update(orderProductionRequirements)
        .set({ requiredOutputQuantity: "1" })
        .where(eq(orderProductionRequirements.id, requirement!.id))
        .then(
          () => "sin error",
          (e: { cause?: { message?: string } }) => e.cause?.message ?? "",
        ),
    ).not.toBe("sin error");
  });

  it("ningún pedido movió stock: todos los movimientos de producto vienen de producción y lotes", async () => {
    const rows = await db()
      .select({ type: stockMovements.movementType })
      .from(stockMovements)
      .where(eq(stockMovements.itemType, "PRODUCT"));
    expect(new Set(rows.map((r) => r.type))).toEqual(
      new Set(["PRODUCTION_OUTPUT", "LOT_TRANSFORMATION_OUT", "LOT_TRANSFORMATION_IN", "WASTE"]),
    );
    expect(await reconciliationProblems(db())).toEqual([]);
  });
});
