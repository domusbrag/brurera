import { productInventoryCostHistory, stockMovements } from "@bakery/database";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  clientFor,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";
import { dec, inventoryDetail, ok } from "./inventory-fixtures.js";
import {
  buildProductionWorld,
  recordActuals,
  startedOrder,
  stock,
  type ProductionWorld,
} from "./production-fixtures.js";

/*
 * Concurrencia real (varias conexiones del pool a la vez): dos órdenes que
 * compiten por la misma harina (§71), varios "Completar" sobre la misma orden
 * (§72) y dos órdenes con las mismas materias primas sin deadlocks (ADR-042).
 */

let ctx: TestContext;
let api: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
});
afterAll(() => ctx.close());

const db = () => ctx.database.db;

async function outputsOf(orderId: string) {
  return db()
    .select()
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.referenceId, orderId),
        eq(stockMovements.movementType, "PRODUCTION_OUTPUT"),
      ),
    );
}

describe("concurrencia — dos órdenes por 70 kg con 100 kg en stock (§71)", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " C");
    await stock(api, w, w.harina, "100", "1000");
    await stock(api, w, w.sal, "10", "500");
  });

  it("una completa, la otra 409 INSUFFICIENT_STOCK; quedan 30 kg, nunca negativo", async () => {
    const a = await startedOrder(api, w);
    const b = await startedOrder(api, w);
    for (const o of [a, b]) await recordActuals(api, w, o, { [w.harina]: "70" }, "93");
    const results = await Promise.all(
      [a, b].map((o) => api.post(`/api/production-orders/${o.id}/complete`)),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    const rejected = results.find((r) => r.statusCode === 409)!;
    expect(rejected.json().error.code).toBe("INSUFFICIENT_STOCK");
    expect(rejected.json().error.details[0]).toMatchObject({
      rawMaterialId: w.harina,
      required: "70.0000000000",
      available: "30.0000000000",
      missing: "40.0000000000",
    });
    const harina = await inventoryDetail(api, w.harina);
    expect(dec(harina.quantity)).toBe("30");
    const loser = [a, b][results.indexOf(rejected)]!;
    expect((await ok(api.get(`/api/production-orders/${loser.id}`))).status).toBe("IN_PROGRESS");
    const loserMovements = await db()
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.referenceId, loser.id));
    expect(loserMovements).toHaveLength(0);
  });
});

describe("concurrencia — completar varias veces la misma orden (§72)", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " I");
    await stock(api, w, w.harina, "500", "1000");
    await stock(api, w, w.sal, "10", "500");
  });

  it("[200, 409, 409]: un único output, un único juego de consumos y un único costo", async () => {
    const o = await startedOrder(api, w);
    await recordActuals(api, w, o, {}, "100");
    const results = await Promise.all(
      [1, 2, 3].map(() => api.post(`/api/production-orders/${o.id}/complete`)),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(r.json().error.code).toBe("PRODUCTION_ALREADY_COMPLETED");
    }
    expect(await outputsOf(o.id)).toHaveLength(1);
    const consumptions = await db()
      .select()
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.referenceId, o.id),
          eq(stockMovements.movementType, "PRODUCTION_CONSUMPTION"),
        ),
      );
    expect(consumptions).toHaveLength(2);
    const history = await db()
      .select()
      .from(productInventoryCostHistory)
      .where(eq(productInventoryCostHistory.productionOrderId, o.id));
    expect(history).toHaveLength(1);
    expect(dec((await inventoryDetail(api, w.harina)).quantity)).toBe("425");
  });
});

describe("concurrencia — mismas materias primas en paralelo, sin deadlocks (ADR-042)", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " D");
    await stock(api, w, w.harina, "1000", "1000");
    await stock(api, w, w.sal, "100", "500");
    await stock(api, w, w.aceite, "100", "2000");
  });

  it("cuatro órdenes con harina, sal y aceite extra completan todas", async () => {
    const orders = [];
    for (let i = 0; i < 4; i++) {
      const o = await startedOrder(api, w);
      // El aceite extra entra en orden distinto según la orden (ids distintos de línea).
      const withExtra = await ok(
        api.post(`/api/production-orders/${o.id}/extra-materials`, {
          rawMaterialId: w.aceite,
          quantity: "1",
          unitId: w.units.l,
          notes: "Engrase",
        }),
        201,
      );
      orders.push(await recordActuals(api, w, withExtra, {}, "100"));
    }
    const results = await Promise.all(
      orders.map((o) => api.post(`/api/production-orders/${o.id}/complete`)),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect(dec((await inventoryDetail(api, w.harina)).quantity)).toBe("700");
    expect(dec((await inventoryDetail(api, w.aceite)).quantity)).toBe("96");
    const product = await ok(api.get(`/api/inventory/products/${w.panFrances}`));
    expect(dec(product.quantity)).toBe("400");
    // 75.000 + 400 + 2.000 = 77.400 por lote → 774/kg
    expect(product.movingAverageCost).toBe("774.000000");
  });
});
