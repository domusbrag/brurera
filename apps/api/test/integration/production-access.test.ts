import { productionOrders } from "@bakery/database";
import { withoutProductionCosts, type ProductionOrderDto } from "@bakery/shared";
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
import { ok } from "./inventory-fixtures.js";
import {
  TODAY,
  buildProductionWorld,
  createOrder,
  recordActuals,
  startedOrder,
  stock,
  type ProductionWorld,
} from "./production-fixtures.js";

/*
 * Aislamiento entre empresas (§74) y visibilidad de costos por permiso (§51):
 * Producción ve cantidades y diferencias pero ningún importe; Administración
 * ve importes; Depósito ve el stock de producto terminado.
 */

let ctx: TestContext;
let api: ApiClient;
let apiB: ApiClient;
let a: ProductionWorld;
let b: ProductionWorld;
let completedA: ProductionOrderDto;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
  apiB = await clientFor(ctx.app, ADMIN_B);
  a = await buildProductionWorld(api);
  b = await buildProductionWorld(apiB, " B");
  await stock(api, a, a.harina, "300", "1000");
  await stock(api, a, a.sal, "10", "500");
  await stock(apiB, b, b.harina, "300", "1000");
  await stock(apiB, b, b.sal, "10", "500");
  const o = await startedOrder(api, a, { responsibleEmployeeId: a.employeeId });
  await recordActuals(api, a, o, { [a.harina]: "77" }, "96");
  completedA = await ok(api.post(`/api/production-orders/${o.id}/complete`));
});
afterAll(() => ctx.close());

const MONEY_KEYS = [
  "plannedUnitCost",
  "plannedCostSource",
  "plannedCost",
  "actualUnitCost",
  "actualCost",
] as const;

describe("tenencia (§74)", () => {
  it("la empresa B no usa producto, depósito, versión ni responsable de A", async () => {
    const base = {
      productId: b.panFrances,
      scheduledFor: TODAY,
      plannedOutputQuantity: "100",
      sourceWarehouseId: b.warehouseId,
      outputWarehouseId: b.warehouseId,
    };
    for (const [field, value] of [
      ["productId", a.panFrances],
      ["sourceWarehouseId", a.warehouseId],
      ["outputWarehouseId", a.secondWarehouseId],
      ["recipeVersionId", a.v1],
      ["responsibleEmployeeId", a.employeeId],
      ["plannedOutputUnitId", "00000000-0000-4000-8000-000000000000"],
    ] as const) {
      const res = await apiB.post("/api/production-orders", { ...base, [field]: value });
      expect(res.statusCode, field).toBe(422);
      expect(res.json().error.details?.[0]?.path, field).toBe(field);
    }
  });

  it("la empresa B no ve ni opera órdenes de A (404) y su listado no las incluye", async () => {
    const id = completedA.id;
    for (const res of [
      await apiB.get(`/api/production-orders/${id}`),
      await apiB.patch(`/api/production-orders/${id}`, { notes: "x" }),
      await apiB.post(`/api/production-orders/${id}/plan`),
      await apiB.post(`/api/production-orders/${id}/start`),
      await apiB.post(`/api/production-orders/${id}/complete`),
      await apiB.post(`/api/production-orders/${id}/cancel`, {}),
      await apiB.get(`/api/production-orders/${id}/availability`),
      await apiB.get(`/api/production-orders/${id}/movements`),
      await apiB.get(`/api/inventory/products/${a.panFrances}`),
    ]) {
      expect(res.statusCode).toBe(404);
    }
    const list = await ok(apiB.get("/api/production-orders?pageSize=100"));
    expect(list.items.map((i: { id: string }) => i.id)).not.toContain(id);
    const stockB = await ok(apiB.get("/api/inventory/products"));
    expect(stockB.items.map((i: { id: string }) => i.id)).not.toContain(a.panFrances);
    const movementsB = await ok(apiB.get("/api/inventory/movements?itemType=PRODUCT"));
    expect(movementsB.total).toBe(0);
  });

  it("B no agrega materia prima de A como consumo extra", async () => {
    const o = await startedOrder(apiB, b);
    const res = await apiB.post(`/api/production-orders/${o.id}/extra-materials`, {
      rawMaterialId: a.aceite,
      quantity: "1",
      unitId: b.units.l,
      notes: "Prueba",
    });
    expect(res.statusCode).toBe(422);
    const line = await apiB.put(`/api/production-orders/${o.id}/actuals`, {
      lines: [{ lineId: completedA.materials[0]!.id, quantity: "1", unitId: b.units.kg }],
    });
    expect(line.statusCode).toBe(422);
  });

  it("la base rechaza referencias cruzadas (FKs compuestas)", async () => {
    const err = await ctx.database.db
      .insert(productionOrders)
      .values({
        companyId: ctx.companyBId,
        internalCode: "OP-9999",
        productId: a.panFrances,
        recipeId: a.recipeId,
        recipeVersionId: a.v1,
        sourceWarehouseId: b.warehouseId,
        outputWarehouseId: b.warehouseId,
        scheduledFor: TODAY,
        plannedOutputQuantity: "1",
        plannedOutputUnitId: b.units.kg!,
        saleUnitId: b.units.kg!,
        plannedOutputNormalized: "1",
      })
      .then(
        () => null,
        (e: { cause?: { code?: string } }) => e.cause?.code,
      );
    expect(err).toBe("23503");
  });
});

describe("visibilidad de costos (§50-51)", () => {
  const as = async (role: string) => {
    const who = { email: `f4-${role.toLowerCase()}@test.local`, password: "rol-password-123" };
    await createMember(ctx.database, ctx.companyId, {
      ...who,
      displayName: `Rol ${role}`,
      roles: [role as "PRODUCTION"],
    });
    return clientFor(ctx.app, who);
  };

  it("Producción ve cantidades y diferencias, nunca importes", async () => {
    const prod = await as("PRODUCTION");
    const o = await ok(prod.get(`/api/production-orders/${completedA.id}`));
    expect(o.canSeeCosts).toBe(false);
    expect(o.costs).toBeNull();
    for (const line of o.materials) {
      for (const key of MONEY_KEYS) expect(line[key], key).toBeNull();
    }
    expect(o.materials[0].variance.quantity).toBe("2.0000000000");
    expect(o.actualOutputNormalized).toBe("96.0000000000");
    const list = await ok(prod.get("/api/production-orders"));
    expect(list.items[0].actualMaterialCost).toBeNull();
    const movements = await ok(prod.get(`/api/production-orders/${completedA.id}/movements`));
    expect(movements.every((m: { totalValue: unknown }) => m.totalValue === null)).toBe(true);
    expect(
      (await prod.get(`/api/production-orders/${completedA.id}/cost-comparison`)).statusCode,
    ).toBe(403);
    // Puede operar: crear, planificar e iniciar sin ver costos.
    const created = await ok(createOrder(prod, a), 201);
    const planned = await ok(prod.post(`/api/production-orders/${created.id}/plan`));
    expect(planned.costs).toBeNull();
    expect(planned.materials[0].plannedCost).toBeNull();
  });

  it("Administración ve costos; Depósito ve stock de producto sin valorizar; Compras no ve producción", async () => {
    const admin = await as("ADMINISTRATION");
    const o = await ok(admin.get(`/api/production-orders/${completedA.id}`));
    expect(o.costs.actual.total).toBe("77400.000000");
    expect((await admin.patch(`/api/production-orders/${completedA.id}`, {})).statusCode).toBe(403);

    const warehouse = await as("WAREHOUSE");
    expect((await warehouse.get("/api/production-orders")).statusCode).toBe(403);
    const stockList = await ok(warehouse.get("/api/inventory/products"));
    const row = stockList.items.find((i: { id: string }) => i.id === a.panFrances);
    expect(row.quantity).toBe("96.0000000000");
    expect(row.averageMaterialCost).toBeNull();

    const purchasing = await as("PURCHASING");
    expect((await purchasing.get("/api/production-orders")).statusCode).toBe(403);
  });

  it("withoutProductionCosts quita todos los importes y conserva cantidades", () => {
    const redacted = withoutProductionCosts(completedA);
    expect(redacted.costs).toBeNull();
    expect(redacted.materials[0]!.actualNormalized).toBe(completedA.materials[0]!.actualNormalized);
    expect(JSON.stringify(redacted)).not.toContain("77400");
  });
});
