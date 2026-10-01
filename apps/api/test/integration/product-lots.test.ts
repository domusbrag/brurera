import { randomUUID } from "node:crypto";
import { auditLogs, productLots, stockMovements } from "@bakery/database";
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
import {
  DAY,
  HOUR,
  MEDIALUNA,
  configureConservation,
  freeze,
  produce,
  reconciliationProblems,
  thaw,
  waste,
} from "./lot-fixtures.js";
import {
  buildProductionWorld,
  recordActuals,
  startedOrder,
  stock,
  type ProductionWorld,
} from "./production-fixtures.js";

/*
 * Lotes de producto terminado (Fase 4.5) contra la API real y PostgreSQL:
 * lote al completar producción, perfiles de conservación, congelar (§52),
 * descongelar (§53), disponibilidad a una fecha (§54), merma (§55), FEFO,
 * reconciliación, idempotencia, concurrencia, rollback, tenencia, permisos y
 * guardas de base. Costo de Pan francés: 900 × 0,75 + 400 × 0,008 = 678,20 $/kg.
 */

let ctx: TestContext;
let api: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
});
afterAll(() => ctx.close());

const db = () => ctx.database.db;

async function dbError(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e as { cause?: { message?: string }; message?: string },
  );
  return err?.cause?.message ?? err?.message ?? "sin error";
}

const lot = (id: string) => ok(api.get(`/api/product-lots/${id}`));
const productStock = (id: string) => ok(api.get(`/api/inventory/products/${id}`));
const availability = (productId: string, at: Date, warehouseId?: string) =>
  ok(
    api.get(
      `/api/inventory/products/${productId}/availability?at=${encodeURIComponent(at.toISOString())}${
        warehouseId ? `&warehouseId=${warehouseId}` : ""
      }`,
    ),
  );
const inDays = (days: number) => new Date(Date.now() + days * DAY * 60_000);

async function lotAudit(lotId: string) {
  const rows = await db()
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "product_lot"), eq(auditLogs.entityId, lotId)))
    .orderBy(auditLogs.id);
  return rows.map((r) => r.action);
}

async function expectReconciled() {
  expect(await reconciliationProblems(db())).toEqual([]);
}

async function errorCode(res: ReturnType<ApiClient["post"]>, status: number) {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return r.json().error?.code as string;
}

describe("lote al completar producción (gate D)", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " D");
    await ok(configureConservation(api, w.panFrances, MEDIALUNA));
  });

  it("crea un lote raíz con el batch code, estado inicial y vencimiento del perfil", async () => {
    const before = Date.now();
    const { order, lot: l } = await produce(api, w, "100");
    expect(order.status).toBe("COMPLETED");
    expect(order.batchCode).toBeTruthy();
    expect(order.productLot).toMatchObject({
      id: l.id,
      code: order.batchCode,
      conservationState: "FRESH",
    });
    expect(l.code).toBe(order.batchCode);
    expect(l.parentLot).toBeNull();
    expect(l.productionOrder.id).toBe(order.id);
    expect(l.conservationState).toBe("FRESH");
    expect(l.qualityStatus).toBe("AVAILABLE");
    expect(l.status).toBe("AVAILABLE");
    expect(dec(l.initialQuantity)).toBe("100");
    expect(dec(l.quantity)).toBe("100");
    expect(dec(l.value)).toBe("67820");
    expect(dec(l.unitMaterialCost)).toBe("678.2");
    expect(l.shelfLifeMinutes).toBe(2 * DAY);
    const usable = new Date(l.usableUntil).getTime();
    const produced = new Date(l.producedAt).getTime();
    expect(usable - produced).toBe(2 * DAY * 60_000);
    expect(produced).toBeGreaterThanOrEqual(before - 1000);
    expect(l.transformTargets).toEqual(["FROZEN"]);

    // El movimiento de salida de producción lleva el lote.
    const movements = await db()
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.referenceId, order.id));
    const output = movements.find((m) => m.movementType === "PRODUCTION_OUTPUT")!;
    expect(output.productLotId).toBe(l.id);
    expect(await lotAudit(l.id)).toEqual(["PRODUCT_LOT_CREATED"]);
    await expectReconciled();
  });

  it("respeta el estado inicial pedido si el perfil lo permite y rechaza uno no permitido", async () => {
    await ok(
      configureConservation(api, w.panFrances, {
        ...MEDIALUNA,
        REFRIGERATED: [5 * DAY, true],
      }),
    );
    const { lot: refrigerated } = await produce(api, w, "20", {
      conservationState: "REFRIGERATED",
    });
    expect(refrigerated.conservationState).toBe("REFRIGERATED");
    expect(refrigerated.shelfLifeMinutes).toBe(5 * DAY);

    // FROZEN habilitado pero no permitido como inicial: la orden no se completa.
    await stock(api, w, w.harina, "15", "900");
    await stock(api, w, w.sal, "0.16", "400");
    const o = await startedOrder(api, w, { plannedOutputQuantity: "20" });
    await recordActuals(api, w, o, { [w.harina]: "15", [w.sal]: "0.16" }, "20");
    const code = await errorCode(
      api.post(`/api/production-orders/${o.id}/complete`, { conservationState: "FROZEN" }),
      409,
    );
    expect(code).toBe("INITIAL_STATE_NOT_ALLOWED");
    expect((await ok(api.get(`/api/production-orders/${o.id}`))).status).toBe("IN_PROGRESS");
    const done = await ok(api.post(`/api/production-orders/${o.id}/complete`, {}));
    expect(done.productLot.conservationState).toBe("FRESH");
    await ok(configureConservation(api, w.panFrances, MEDIALUNA));
  });

  it("producto sin conservación configurada: lote FRESH sin vencimiento, marcado como desconocido", async () => {
    const w2 = await buildProductionWorld(api, " D2");
    const { lot: l } = await produce(api, w2, "40");
    expect(l.conservationState).toBe("FRESH");
    expect(l.usableUntil).toBeNull();
    expect(l.shelfLifeMinutes).toBeNull();
    expect(l.status).toBe("AVAILABLE");
    expect(l.transformTargets).toEqual([]);
    const a = await availability(w2.panFrances, inDays(365));
    expect(dec(a.eligibleQuantity)).toBe("40");
    expect(dec(a.shelfLifeUnknownQuantity)).toBe("40");
    // No congelable: el estado no está habilitado.
    expect(await errorCode(freeze(api, l.id, "10"), 409)).toBe("CONSERVATION_STATE_DISABLED");
  });
});

describe("perfil de conservación (gate C)", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " C");
  });

  it("sin configurar devuelve los cuatro estados deshabilitados", async () => {
    const p = await ok(api.get(`/api/products/${w.panFrances}/conservation`));
    expect(p.configured).toBe(false);
    expect(p.defaultInitialState).toBe("FRESH");
    expect(p.states.map((s: { state: string }) => s.state)).toEqual([
      "FRESH",
      "REFRIGERATED",
      "FROZEN",
      "THAWED",
    ]);
    expect(p.states.every((s: { enabled: boolean }) => !s.enabled)).toBe(true);
  });

  it("crea, actualiza y audita; valida coherencia", async () => {
    const created = await ok(configureConservation(api, w.panFrances, MEDIALUNA));
    expect(created.configured).toBe(true);
    const frozen = created.states.find((s: { state: string }) => s.state === "FROZEN");
    expect(frozen).toMatchObject({
      enabled: true,
      shelfLifeMinutes: 30 * DAY,
      allowedAsInitial: false,
    });

    const updated = await ok(
      configureConservation(api, w.panFrances, { ...MEDIALUNA, FRESH: [3 * DAY, true] }),
    );
    expect(updated.states[0].shelfLifeMinutes).toBe(3 * DAY);
    // Sin cambios: no audita de nuevo.
    await ok(configureConservation(api, w.panFrances, { ...MEDIALUNA, FRESH: [3 * DAY, true] }));
    const actions = (
      await db()
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(and(eq(auditLogs.entityType, "product"), eq(auditLogs.entityId, w.panFrances)))
    )
      .map((r) => r.action)
      .filter((a) => a.startsWith("PRODUCT_CONSERVATION"));
    expect(actions).toEqual([
      "PRODUCT_CONSERVATION_PROFILE_CREATED",
      "PRODUCT_CONSERVATION_PROFILE_UPDATED",
    ]);

    // Estado inicial por defecto deshabilitado → 400.
    const bad = await api.put(`/api/products/${w.panFrances}/conservation`, {
      defaultInitialState: "REFRIGERATED",
      nearExpiryMinutes: DAY,
      states: [
        {
          state: "FRESH",
          enabled: true,
          shelfLifeMinutes: DAY,
          allowedAsInitial: true,
          notes: null,
        },
      ],
    });
    expect(bad.statusCode).toBe(400);
    // Habilitado sin vida útil → 400.
    const noLife = await api.put(`/api/products/${w.panFrances}/conservation`, {
      defaultInitialState: "FRESH",
      nearExpiryMinutes: DAY,
      states: [
        {
          state: "FRESH",
          enabled: true,
          shelfLifeMinutes: null,
          allowedAsInitial: true,
          notes: null,
        },
      ],
    });
    expect(noLife.statusCode).toBe(400);
  });

  it("cambiar el perfil no modifica lotes existentes", async () => {
    await ok(configureConservation(api, w.panFrances, MEDIALUNA));
    const { lot: l } = await produce(api, w, "10");
    await ok(configureConservation(api, w.panFrances, { ...MEDIALUNA, FRESH: [1 * DAY, true] }));
    const after = await lot(l.id);
    expect(after.usableUntil).toBe(l.usableUntil);
    expect(after.shelfLifeMinutes).toBe(2 * DAY);
  });
});

describe("congelar (§52) y descongelar (§53)", () => {
  let w: ProductionWorld;
  let root: { id: string; code: string; usableUntil: string };
  let frozen: { id: string; code: string };

  beforeAll(async () => {
    w = await buildProductionWorld(api, " F");
    await ok(configureConservation(api, w.panFrances, MEDIALUNA));
    ({ lot: root } = await produce(api, w, "500"));
  });

  it("congelar 300 de 500: lote hijo, saldo agregado, valor y promedio sin cambios", async () => {
    const before = await productStock(w.panFrances);
    const res = await ok(freeze(api, root.id, "300"), 201);
    expect(res.replayed).toBe(false);
    frozen = res.childLot;
    expect(dec(res.lot.quantity)).toBe("200");
    expect(res.lot.conservationState).toBe("FRESH");
    expect(res.lot.usableUntil).toBe(root.usableUntil);
    expect(res.childLot.code).toBe(`${root.code}.1`);
    expect(res.childLot.parentLot).toEqual({ id: root.id, code: root.code });
    expect(res.childLot.conservationState).toBe("FROZEN");
    expect(dec(res.childLot.quantity)).toBe("300");
    expect(dec(res.childLot.value)).toBe("203460");
    expect(res.childLot.productionOrder.id).toBe((await lot(root.id)).productionOrder.id);
    const usable = new Date(res.childLot.usableUntil).getTime();
    const changed = new Date(res.childLot.stateChangedAt).getTime();
    expect(usable - changed).toBe(30 * DAY * 60_000);
    expect(res.movements.map((m: { movementType: string }) => m.movementType).sort()).toEqual([
      "LOT_TRANSFORMATION_IN",
      "LOT_TRANSFORMATION_OUT",
    ]);

    const after = await productStock(w.panFrances);
    expect(after.quantity).toBe(before.quantity);
    expect(after.inventoryValue).toBe(before.inventoryValue);
    expect(after.movingAverageCost).toBe(before.movingAverageCost);
    expect(dec(after.lots.byState.FRESH)).toBe("200");
    expect(dec(after.lots.byState.FROZEN)).toBe("300");
    expect(await lotAudit(root.id)).toContain("PRODUCT_LOT_TRANSFORMED");
    await expectReconciled();
  });

  it("descongelar 100: hijo THAWED con 12 h; el descongelado no se puede volver a congelar", async () => {
    const res = await ok(thaw(api, frozen.id, "100"), 201);
    expect(dec(res.lot.quantity)).toBe("200");
    const thawed = res.childLot;
    expect(thawed.code).toBe(`${frozen.code}.1`);
    expect(thawed.conservationState).toBe("THAWED");
    expect(thawed.parentLot.id).toBe(frozen.id);
    expect(thawed.shelfLifeMinutes).toBe(12 * HOUR);
    expect(thawed.transformTargets).toEqual([]);
    expect(await errorCode(freeze(api, thawed.id, "10"), 409)).toBe("TRANSFORMATION_NOT_ALLOWED");
    // Fresco no se descongela; congelado no se vuelve a congelar.
    expect(await errorCode(thaw(api, root.id, "10"), 409)).toBe("TRANSFORMATION_NOT_ALLOWED");
    expect(await errorCode(freeze(api, frozen.id, "10"), 409)).toBe("TRANSFORMATION_NOT_ALLOWED");

    const detail = await lot(frozen.id);
    expect(detail.children.map((c: { id: string }) => c.id)).toEqual([thawed.id]);
    const refreeze = (await lot(thawed.id)).transformOptions.find(
      (o: { targetState: string }) => o.targetState === "FROZEN",
    );
    expect(refreeze).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("no puede volver"),
    });
    await expectReconciled();
  });

  it("valida cantidad: más que el saldo → 409, cero o negativa → 400", async () => {
    expect(await errorCode(freeze(api, root.id, "200.001"), 409)).toBe("INSUFFICIENT_LOT_QUANTITY");
    expect((await freeze(api, root.id, "0")).statusCode).toBe(400);
    expect((await freeze(api, root.id, "-5")).statusCode).toBe(400);
  });

  it("transformar el saldo completo agota el lote (DEPLETED, nunca se borra)", async () => {
    const res = await ok(freeze(api, root.id, "200"), 201);
    expect(dec(res.lot.quantity)).toBe("0");
    expect(res.lot.status).toBe("DEPLETED");
    expect(dec(res.lot.value)).toBe("0");
    expect(res.childLot.code).toBe(`${root.code}.2`);
    expect(await errorCode(freeze(api, root.id, "1"), 409)).toBe("LOT_DEPLETED");
    const active = await ok(api.get(`/api/inventory/products/${w.panFrances}/lots`));
    expect(active.items.some((l: { id: string }) => l.id === root.id)).toBe(false);
    const all = await ok(api.get(`/api/inventory/products/${w.panFrances}/lots?scope=all`));
    expect(all.items.at(-1).id).toBe(root.id);
    const stockNow = await productStock(w.panFrances);
    expect(dec(stockNow.quantity)).toBe("500");
    expect(dec(stockNow.inventoryValue)).toBe("339100");
    await expectReconciled();
  });
});

describe("disponibilidad a una fecha (§54) y FEFO", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " A");
    await ok(configureConservation(api, w.panFrances, MEDIALUNA));
  });

  it("700 físicos: 300 frescos vencen antes del sábado, 400 congelados disponibles", async () => {
    const { lot: l } = await produce(api, w, "700");
    const child = (await ok(freeze(api, l.id, "400"), 201)).childLot;
    const saturday = inDays(3);
    const a = await availability(w.panFrances, saturday);
    expect(dec(a.physicalQuantity)).toBe("700");
    expect(dec(a.eligibleQuantity)).toBe("400");
    expect(dec(a.ineligibleQuantity)).toBe("300");
    expect(dec(a.ineligibleByReason.EXPIRED)).toBe("300");
    expect(dec(a.physicalByState.FRESH)).toBe("300");
    expect(dec(a.physicalByState.FROZEN)).toBe("400");
    expect(dec(a.eligibleByState.FROZEN)).toBe("400");
    expect(dec(a.eligibleByState.FRESH)).toBe("0");
    expect(a.reasons).toEqual([
      expect.objectContaining({ reason: "EXPIRED", label: expect.stringContaining("300") }),
    ]);
    const byId = new Map(a.lots.map((x: { id: string }) => [x.id, x]));
    expect(byId.get(l.id)).toMatchObject({ eligible: false, reason: "EXPIRED" });
    expect(byId.get(child.id)).toMatchObject({ eligible: true, reason: null });

    // Hoy: todo disponible, primero el fresco (vence antes).
    const now = await availability(w.panFrances, new Date());
    expect(dec(now.eligibleQuantity)).toBe("700");
    const ranked = [...now.lots].sort(
      (x: { fefoRank: number }, y: { fefoRank: number }) => x.fefoRank - y.fefoRank,
    );
    expect(ranked.map((x: { id: string }) => x.id)).toEqual([l.id, child.id]);

    // Depósito sin stock del producto.
    const other = await availability(w.panFrances, saturday, w.secondWarehouseId);
    expect(dec(other.physicalQuantity)).toBe("0");
    // Fecha inválida → 400.
    expect(
      (await api.get(`/api/inventory/products/${w.panFrances}/availability?at=sabado`)).statusCode,
    ).toBe(400);
  });

  it("listado de lotes en orden FEFO (vencimiento, luego producción)", async () => {
    const list = await ok(api.get(`/api/inventory/products/${w.panFrances}/lots`));
    const until = list.items.map((l: { usableUntil: string | null }) => l.usableUntil ?? "9999");
    expect([...until].sort()).toEqual(until);
  });

  it("próximos a vencer: lotes frescos dentro del umbral", async () => {
    const near = await ok(
      api.get(`/api/inventory/expiring?withinHours=72&productId=${w.panFrances}`),
    );
    expect(near.items.length).toBe(1);
    expect(near.items[0].conservationState).toBe("FRESH");
    const near1h = await ok(
      api.get(`/api/inventory/expiring?withinHours=1&productId=${w.panFrances}`),
    );
    expect(near1h.items).toHaveLength(0);
  });

  it("resumen de stock por estado en el listado de productos terminados", async () => {
    const list = await ok(api.get("/api/inventory/products"));
    const row = list.items.find((i: { id: string }) => i.id === w.panFrances);
    expect(dec(row.lots.physicalQuantity)).toBe("700");
    expect(dec(row.lots.byState.FRESH)).toBe("300");
    expect(dec(row.lots.byState.FROZEN)).toBe("400");
    expect(dec(row.lots.usableNow)).toBe("700");
  });
});

describe("merma de producto terminado (§55) y calidad", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " M");
    await ok(configureConservation(api, w.panFrances, MEDIALUNA));
  });

  it("merma 20 kg de 100 (§55): sale al costo del lote, el promedio no cambia", async () => {
    const { lot: l } = await produce(api, w, "100");
    const before = await productStock(w.panFrances);
    const res = await ok(waste(api, l.id, "20", "DAMAGED"), 201);
    expect(dec(res.lot.quantity)).toBe("80");
    expect(dec(res.lot.value)).toBe("54256");
    const [mv] = res.movements;
    expect(mv.movementType).toBe("WASTE");
    expect(mv.reason).toBe("DAMAGED");
    expect(dec(mv.totalValue)).toBe("-13564");
    expect(mv.productLot).toEqual({ id: l.id, code: l.code });
    const after = await productStock(w.panFrances);
    expect(dec(after.quantity)).toBe("80");
    expect(after.movingAverageCost).toBe(before.movingAverageCost);
    expect(dec(after.inventoryValue)).toBe("54256");
    expect(await lotAudit(l.id)).toContain("PRODUCT_LOT_WASTE_RECORDED");
    // Motivo de materia prima no vale para producto.
    expect((await waste(api, l.id, "1", "SPOILED")).statusCode).toBe(400);
    expect(await errorCode(waste(api, l.id, "81"), 409)).toBe("INSUFFICIENT_LOT_QUANTITY");
    await expectReconciled();
  });

  it("bloquear: no disponible ni transformable, pero admite merma; desbloquear lo devuelve", async () => {
    const { lot: l } = await produce(api, w, "50");
    const blocked = await ok(
      api.post(`/api/product-lots/${l.id}/block`, { reason: "Control de calidad" }),
    );
    expect(blocked.qualityStatus).toBe("BLOCKED");
    expect(blocked.status).toBe("BLOCKED");
    expect(
      await errorCode(api.post(`/api/product-lots/${l.id}/block`, { reason: "otra vez" }), 409),
    ).toBe("LOT_ALREADY_BLOCKED");
    const a = await availability(w.panFrances, new Date());
    expect(dec(a.ineligibleByReason.BLOCKED)).toBe("50");
    expect(await errorCode(freeze(api, l.id, "10"), 409)).toBe("LOT_BLOCKED");
    await ok(waste(api, l.id, "5", "QUALITY"), 201);
    const unblocked = await ok(api.post(`/api/product-lots/${l.id}/unblock`, {}));
    expect(unblocked.qualityStatus).toBe("AVAILABLE");
    expect(unblocked.conservationState).toBe("FRESH");
    expect(await errorCode(api.post(`/api/product-lots/${l.id}/unblock`, {}), 409)).toBe(
      "LOT_NOT_BLOCKED",
    );
    expect(await lotAudit(l.id)).toEqual(
      expect.arrayContaining(["PRODUCT_LOT_BLOCKED", "PRODUCT_LOT_UNBLOCKED"]),
    );
    await expectReconciled();
  });
});

describe("idempotencia (operationId)", () => {
  let w: ProductionWorld;
  let l: { id: string };

  beforeAll(async () => {
    w = await buildProductionWorld(api, " I");
    await ok(configureConservation(api, w.panFrances, MEDIALUNA));
    ({ lot: l } = await produce(api, w, "100"));
  });

  it("repetir una transformación devuelve 200 con el mismo resultado y no duplica", async () => {
    const op = randomUUID();
    const first = await ok(freeze(api, l.id, "30", op), 201);
    const second = await ok(freeze(api, l.id, "30", op), 200);
    expect(second.replayed).toBe(true);
    expect(second.childLot.id).toBe(first.childLot.id);
    expect(dec((await lot(l.id)).quantity)).toBe("70");
    const children = await db().select().from(productLots).where(eq(productLots.parentLotId, l.id));
    expect(children).toHaveLength(1);
  });

  it("repetir una merma devuelve 200 y no duplica; reusar el id en otra operación → 409", async () => {
    const op = randomUUID();
    await ok(waste(api, l.id, "5", "OTHER", op), 201);
    const again = await ok(waste(api, l.id, "5", "OTHER", op), 200);
    expect(again.replayed).toBe(true);
    expect(dec((await lot(l.id)).quantity)).toBe("65");
    expect(await errorCode(freeze(api, l.id, "5", op), 409)).toBe("OPERATION_ID_REUSED");
    await expectReconciled();
  });
});

describe("concurrencia: congelar 300 + 300 sobre 500", () => {
  it("una congela, la otra 409 INSUFFICIENT_LOT_QUANTITY; nunca negativo", async () => {
    const w = await buildProductionWorld(api, " K");
    await ok(configureConservation(api, w.panFrances, MEDIALUNA));
    const { lot: l } = await produce(api, w, "500");
    const results = await Promise.all([freeze(api, l.id, "300"), freeze(api, l.id, "300")]);
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, 409]);
    const failed = results.find((r) => r.statusCode === 409)!;
    expect(failed.json().error.code).toBe("INSUFFICIENT_LOT_QUANTITY");
    expect(dec((await lot(l.id)).quantity)).toBe("200");
    // Mismo operationId en paralelo: un solo hijo.
    const op = randomUUID();
    const twin = await Promise.all([freeze(api, l.id, "50", op), freeze(api, l.id, "50", op)]);
    expect(twin.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(dec((await lot(l.id)).quantity)).toBe("150");
    await expectReconciled();
  });
});

describe("rollback", () => {
  it("una falla al auditar la transformación revierte lote hijo, movimientos y saldos", async () => {
    const w = await buildProductionWorld(api, " R");
    await ok(configureConservation(api, w.panFrances, MEDIALUNA));
    const { lot: l } = await produce(api, w, "100");
    const before = await productStock(w.panFrances);
    await db().execute(sql`
      create function test_fail_lot_audit() returns trigger language plpgsql as $$
      begin raise exception 'falla inyectada antes del commit'; end $$;
      create trigger test_fail_lot_audit before insert on audit_logs
        for each row when (new.action = 'PRODUCT_LOT_TRANSFORMED')
        execute function test_fail_lot_audit();
    `);
    try {
      expect((await freeze(api, l.id, "40")).statusCode).toBe(500);
    } finally {
      await db().execute(sql`
        drop trigger test_fail_lot_audit on audit_logs;
        drop function test_fail_lot_audit();
      `);
    }
    expect(dec((await lot(l.id)).quantity)).toBe("100");
    const children = await db().select().from(productLots).where(eq(productLots.parentLotId, l.id));
    expect(children).toHaveLength(0);
    const after = await productStock(w.panFrances);
    expect(after.quantity).toBe(before.quantity);
    expect(after.inventoryValue).toBe(before.inventoryValue);
    await expectReconciled();
    await ok(freeze(api, l.id, "40"), 201);
  });
});

describe("tenencia y permisos", () => {
  let w: ProductionWorld;
  let l: { id: string };

  beforeAll(async () => {
    w = await buildProductionWorld(api, " T");
    await ok(configureConservation(api, w.panFrances, MEDIALUNA));
    ({ lot: l } = await produce(api, w, "100"));
  });

  it("la empresa B no ve ni opera lotes ni perfiles de la empresa A", async () => {
    const b = await clientFor(ctx.app, ADMIN_B);
    expect((await b.get(`/api/product-lots/${l.id}`)).statusCode).toBe(404);
    expect((await freeze(b, l.id, "10")).statusCode).toBe(404);
    expect((await waste(b, l.id, "10")).statusCode).toBe(404);
    expect((await b.post(`/api/product-lots/${l.id}/block`, { reason: "x" })).statusCode).toBe(404);
    expect((await b.get(`/api/products/${w.panFrances}/conservation`)).statusCode).toBe(404);
    expect((await configureConservation(b, w.panFrances, MEDIALUNA)).statusCode).toBe(404);
    expect(
      (
        await b.get(
          `/api/inventory/products/${w.panFrances}/availability?at=${encodeURIComponent(new Date().toISOString())}`,
        )
      ).statusCode,
    ).toBe(404);
    const expiring = await ok(b.get("/api/inventory/expiring?withinHours=8784"));
    expect(expiring.items).toHaveLength(0);
    expect(dec((await lot(l.id)).quantity)).toBe("100");
  });

  it("Depósito ve lotes sin importes y opera; Ventas no ve lotes; Producción no registra merma", async () => {
    const as = async (role: "WAREHOUSE" | "PRODUCTION") => {
      const who = { email: `f45-${role.toLowerCase()}@test.local`, password: "rol-password-123" };
      await createMember(ctx.database, ctx.companyId, { ...who, displayName: role, roles: [role] });
      return clientFor(ctx.app, who);
    };
    const warehouse = await as("WAREHOUSE");
    const seen = await ok(warehouse.get(`/api/product-lots/${l.id}`));
    expect(seen.value).toBeNull();
    expect(seen.unitMaterialCost).toBeNull();
    expect(seen.initialValue).toBeNull();
    expect(seen.canSeeCosts).toBe(false);
    const frozen = await ok(freeze(warehouse, l.id, "10"), 201);
    expect(frozen.childLot.value).toBeNull();
    expect(frozen.movements.every((m: { totalValue: unknown }) => m.totalValue === null)).toBe(
      true,
    );
    await ok(waste(warehouse, l.id, "1"), 201);
    expect((await configureConservation(warehouse, w.panFrances, MEDIALUNA)).statusCode).toBe(403);

    const production = await as("PRODUCTION");
    await ok(production.get(`/api/product-lots/${l.id}`));
    expect((await waste(production, l.id, "1")).statusCode).toBe(403);
    expect(
      (await production.post(`/api/product-lots/${l.id}/block`, { reason: "x" })).statusCode,
    ).toBe(403);

    const seller = await clientFor(ctx.app, {
      email: "ventas@test.local",
      password: "ventas-password-123",
    });
    expect((await seller.get(`/api/product-lots/${l.id}`)).statusCode).toBe(403);
  });
});

describe("guardas de base", () => {
  let lotId: string;

  beforeAll(async () => {
    const w = await buildProductionWorld(api, " G");
    ({
      lot: { id: lotId },
    } = await produce(api, w, "10"));
  });

  it("no se borra un lote ni se cambian su cantidad, costo o vencimiento", async () => {
    expect(await dbError(db().execute(sql`delete from product_lots where id = ${lotId}`))).toMatch(
      /lote/i,
    );
    expect(
      await dbError(
        db().execute(sql`update product_lots set initial_quantity = 1 where id = ${lotId}`),
      ),
    ).toMatch(/lote/i);
    expect(
      await dbError(
        db().execute(sql`update product_lots set usable_until = now() where id = ${lotId}`),
      ),
    ).toMatch(/lote/i);
    expect(
      await dbError(
        db().execute(
          sql`update product_lots set conservation_state = 'FROZEN' where id = ${lotId}`,
        ),
      ),
    ).toMatch(/lote/i);
  });

  it("el saldo del lote solo cambia con un movimiento del lote", async () => {
    expect(
      await dbError(
        db().execute(
          sql`update product_lot_balances set quantity = quantity + 1 where product_lot_id = ${lotId}`,
        ),
      ),
    ).not.toBe("sin error");
    expect(
      await dbError(
        db().execute(sql`delete from product_lot_balances where product_lot_id = ${lotId}`),
      ),
    ).not.toBe("sin error");
  });

  it("un movimiento de producto sin lote es rechazado", async () => {
    const [mv] = await db()
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.productLotId, lotId));
    expect(
      await dbError(
        db().execute(sql`
          insert into stock_movements (company_id, warehouse_id, item_type, product_id, movement_type,
            quantity, base_unit_id, unit_cost, total_value, balance_after, occurred_at,
            reference_type, reference_id, actor_user_id)
          select company_id, warehouse_id, item_type, product_id, movement_type, quantity,
            base_unit_id, unit_cost, total_value, balance_after, now(), reference_type,
            reference_id, actor_user_id
          from stock_movements where id = ${mv!.id}`),
      ),
    ).toMatch(/stock_movements_product_lot/);
  });
});
