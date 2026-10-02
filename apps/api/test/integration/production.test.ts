import {
  auditLogs,
  productInventoryCostHistory,
  productInventoryCosts,
  productionMaterialLines,
  productionOrders,
  recipeIngredients,
  stockMovements,
} from "@bakery/database";
import { and, count, eq, sql } from "drizzle-orm";
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
  TODAY,
  buildProductionWorld,
  createOrder,
  publishNewVersion,
  recordActuals,
  startedOrder,
  stock,
  type ProductionWorld,
} from "./production-fixtures.js";
import { ingredient } from "./recipe-fixtures.js";

/*
 * Producción contra la API real y PostgreSQL: flujo principal (§66), receta
 * fijada (§67), promedio del producto (§68), consumo extra (§69), stock
 * insuficiente (§70), idempotencia secuencial, rollback (§73), máquina de
 * estados, inmutabilidad (API y base) y visibilidad de costos.
 */

let ctx: TestContext;
let api: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
});
afterAll(() => ctx.close());

const db = () => ctx.database.db;

/** Mensaje del error de PostgreSQL (drizzle lo envuelve en `cause`). */
async function dbError(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e as { cause?: { message?: string }; message?: string },
  );
  return err?.cause?.message ?? err?.message ?? "sin error";
}
const order = (id: string) => ok(api.get(`/api/production-orders/${id}`));

async function auditActions(orderId: string) {
  const rows = await db()
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "production_order"), eq(auditLogs.entityId, orderId)))
    .orderBy(auditLogs.id);
  return rows.map((r) => r.action);
}

async function movementsOf(orderId: string) {
  return db()
    .select()
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.referenceType, "PRODUCTION_ORDER"),
        eq(stockMovements.referenceId, orderId),
      ),
    );
}

async function productStock(productId: string) {
  return ok(api.get(`/api/inventory/products/${productId}`));
}

describe("integración — flujo principal (§66)", () => {
  let w: ProductionWorld;
  let id: string;

  beforeAll(async () => {
    w = await buildProductionWorld(api);
    await stock(api, w, w.harina, "200", "1000");
    await stock(api, w, w.sal, "10", "500");
  });

  it("crea la orden OP-0001 en DRAFT con la versión vigente y el plan en vivo", async () => {
    const res = await createOrder(api, w, { responsibleEmployeeId: w.employeeId });
    expect(res.statusCode).toBe(201);
    const o = res.json();
    id = o.id;
    expect(o).toMatchObject({
      code: "OP-0001",
      status: "DRAFT",
      scheduledFor: TODAY,
      plannedOutputNormalized: "100.0000000000",
      recipeVersion: { id: w.v1, versionNumber: 1 },
      materialsArePreview: true,
      responsible: { id: w.employeeId },
    });
    expect(o.materials.map((m: { plannedNormalized: string }) => dec(m.plannedNormalized))).toEqual(
      ["75", "0.8"],
    );
    expect(o.materials.every((m: { id: string | null }) => m.id === null)).toBe(true);
    expect(o.availability.sufficient).toBe(true);
    // Nada persistido todavía.
    const [lines] = await db()
      .select({ n: count() })
      .from(productionMaterialLines)
      .where(eq(productionMaterialLines.productionOrderId, id));
    expect(lines!.n).toBe(0);
  });

  it("planifica: 75 kg de harina, 0,8 kg de sal y costo esperado 75.400 (754/kg)", async () => {
    const o = await ok(api.post(`/api/production-orders/${id}/plan`));
    expect(o.status).toBe("PLANNED");
    expect(o.materialsArePreview).toBe(false);
    expect(o.scaleFactor).toBe("1.0000000000");
    expect(o.theoreticalWastePercentage).toBe("5.0000");
    expect(o.batchCode).toBe(`LOT-${TODAY.replaceAll("-", "")}-001`);
    const [harina, sal] = o.materials;
    expect(harina).toMatchObject({
      lineType: "RECIPE",
      plannedUnitCost: "1000.000000",
      plannedCostSource: "PURCHASE_MOVING_AVERAGE",
      plannedCost: "75000.000000",
    });
    expect(dec(harina.plannedNormalized)).toBe("75");
    expect(sal).toMatchObject({ plannedCost: "400.000000" });
    expect(o.costs.planned).toMatchObject({
      status: "COMPLETE",
      total: "75400.000000",
      unit: "754.000000",
    });
    expect(await movementsOf(id)).toHaveLength(0);
  });

  it("la disponibilidad muestra necesario, disponible y diferencia", async () => {
    const av = await ok(api.get(`/api/production-orders/${id}/availability`));
    expect(av.basis).toBe("PLANNED");
    expect(av.lines).toEqual([
      expect.objectContaining({
        rawMaterial: expect.objectContaining({ id: w.harina }),
        status: "OK",
      }),
      expect.objectContaining({
        rawMaterial: expect.objectContaining({ id: w.sal }),
        status: "OK",
      }),
    ]);
    expect(dec(av.lines[0].required)).toBe("75");
    expect(dec(av.lines[0].available)).toBe("200");
    expect(dec(av.lines[0].difference)).toBe("125");
  });

  it("inicia: propone real = plan y no mueve stock", async () => {
    const o = await ok(api.post(`/api/production-orders/${id}/start`));
    expect(o.status).toBe("IN_PROGRESS");
    expect(o.startedBy.displayName).toBe("Admin Test");
    expect(o.materials.map((m: { actualNormalized: string }) => dec(m.actualNormalized))).toEqual([
      "75",
      "0.8",
    ]);
    expect(await movementsOf(id)).toHaveLength(0);
  });

  it("registra consumo real (77 kg harina, 800 g de sal) y salida real 96 kg", async () => {
    const current = await order(id);
    const o = await recordActuals(
      api,
      w,
      current,
      { [w.harina]: "77", [w.sal]: ["800", "g"] },
      "96",
    );
    const harina = o.materials[0];
    expect(dec(harina.actualNormalized)).toBe("77");
    expect(dec(harina.variance.quantity)).toBe("2");
    expect(harina.variance.percentage).toBe("2.6667");
    expect(dec(o.materials[1].actualNormalized)).toBe("0.8");
    expect(o.materials[1].actualUnit.code).toBe("g");
    expect(o.output).toMatchObject({ variancePercentage: "-4.0000", yieldPerformance: "96.0000" });
    // Antes de completar: costo estimado con el consumo cargado y el promedio vigente.
    expect(o.costs.estimated).toEqual({
      status: "COMPLETE",
      total: "77400.000000",
      unit: "806.250000",
    });
    expect(dec(o.output.variance)).toBe("-4");
  });

  it("completa: consumos, salida, costo real 77.400 y 806,25/kg", async () => {
    const res = await api.post(`/api/production-orders/${id}/complete`);
    expect(res.statusCode).toBe(200);
    const o = res.json();
    expect(o.status).toBe("COMPLETED");
    expect(o.costs.actual).toEqual({ total: "77400.000000", unit: "806.250000" });
    expect(o.costs.variance).toMatchObject({ total: "2000.000000", unit: "52.250000" });
    expect(o.materials[0]).toMatchObject({
      actualUnitCost: "1000.000000",
      actualCost: "77000.000000",
    });
    expect(o.materials[1]).toMatchObject({ actualCost: "400.000000" });

    const movements = await movementsOf(id);
    expect(movements.map((m) => [m.movementType, m.itemType, dec(m.quantity)]).sort()).toEqual(
      [
        ["PRODUCTION_CONSUMPTION", "RAW_MATERIAL", "-0.8"],
        ["PRODUCTION_CONSUMPTION", "RAW_MATERIAL", "-77"],
        ["PRODUCTION_OUTPUT", "PRODUCT", "96"],
      ].sort(),
    );
    const output = movements.find((m) => m.movementType === "PRODUCTION_OUTPUT")!;
    expect(output.totalValue).toBe("77400.000000");
    expect(output.unitCost).toBe("806.250000");
    expect(
      o.materials.every((m: { consumptionMovementId: string }) => m.consumptionMovementId),
    ).toBe(true);
  });

  it("descuenta materias primas (123 kg / 9,2 kg) conservando el promedio", async () => {
    const harina = await inventoryDetail(api, w.harina);
    expect(dec(harina.quantity)).toBe("123");
    expect(harina.movingAverageCost).toBe("1000.000000");
    const sal = await inventoryDetail(api, w.sal);
    expect(dec(sal.quantity)).toBe("9.2");
    expect(sal.movingAverageCost).toBe("500.000000");
  });

  it("ingresa 96 kg de Pan francés a 806,25/kg y deja historial de costo", async () => {
    const detail = await productStock(w.panFrances);
    expect(dec(detail.quantity)).toBe("96");
    expect(detail.averageMaterialCost).toBe("806.250000");
    expect(detail.inventoryValue).toBe("77400.000000");
    expect(detail.byWarehouse).toEqual([
      expect.objectContaining({ warehouse: expect.objectContaining({ id: w.warehouseId }) }),
    ]);
    expect(detail.recentProductions[0]).toMatchObject({ id, unitCost: "806.250000" });
    expect(detail.theoreticalMargin).toEqual({ amount: "693.750000", percentage: "46.25" });
    const { cost, history } = await ok(
      api.get(`/api/inventory/products/${w.panFrances}/cost-history`),
    );
    expect(cost.averageMaterialCost).toBe("806.250000");
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      productionOrder: { id, code: "OP-0001" },
      averageBefore: null,
      averageAfter: "806.250000",
      batchUnitCost: "806.250000",
      batchValue: "77400.000000",
    });
    const list = await ok(api.get("/api/inventory/products?stock=in_stock"));
    expect(list.items).toEqual([
      expect.objectContaining({
        id: w.panFrances,
        lastProduction: expect.objectContaining({ id, code: "OP-0001" }),
        averageMaterialCost: "806.250000",
      }),
    ]);
  });

  it("movimientos por tipo de ítem y por orden", async () => {
    const products = await ok(api.get("/api/inventory/movements?itemType=PRODUCT"));
    expect(products.items).toHaveLength(1);
    expect(products.items[0]).toMatchObject({
      itemType: "PRODUCT",
      movementType: "PRODUCTION_OUTPUT",
      item: { id: w.panFrances },
      rawMaterial: null,
      reference: { type: "PRODUCTION_ORDER", id, label: "OP-0001" },
    });
    const ofOrder = await ok(api.get(`/api/production-orders/${id}/movements`));
    expect(ofOrder).toHaveLength(3);
  });

  it("plan vs real y auditoría completa", async () => {
    const cmp = await ok(api.get(`/api/production-orders/${id}/cost-comparison`));
    expect(cmp.costs.planned.total).toBe("75400.000000");
    expect(cmp.costs.actual.total).toBe("77400.000000");
    expect(cmp.output.yieldPerformance).toBe("96.0000");
    expect(await auditActions(id)).toEqual([
      "PRODUCTION_ORDER_CREATED",
      "PRODUCTION_ORDER_PLANNED",
      "PRODUCTION_ORDER_STARTED",
      "PRODUCTION_ORDER_ACTUALS_UPDATED",
      "PRODUCTION_ORDER_COMPLETED",
    ]);
    const [avg] = await db()
      .select({ n: count() })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "PRODUCT_MOVING_AVERAGE_COST_CHANGED"),
          eq(auditLogs.entityId, w.panFrances),
        ),
      );
    expect(avg!.n).toBe(1);
  });

  it("idempotencia: completar otra vez → 409 PRODUCTION_ALREADY_COMPLETED sin duplicar", async () => {
    const res = await api.post(`/api/production-orders/${id}/complete`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PRODUCTION_ALREADY_COMPLETED");
    expect(await movementsOf(id)).toHaveLength(3);
  });

  it("COMPLETED es inmutable: PATCH, consumos, extras y cancelación → 409", async () => {
    const patch = await api.patch(`/api/production-orders/${id}`, { plannedOutputQuantity: "50" });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.code).toBe("PRODUCTION_IMMUTABLE");
    const notes = await api.patch(`/api/production-orders/${id}`, { notes: "otra" });
    expect(notes.json().error.code).toBe("PRODUCTION_IMMUTABLE");
    const actuals = await api.put(`/api/production-orders/${id}/actuals`, {
      actualOutputQuantity: "90",
      actualOutputUnitId: w.units.kg,
    });
    expect(actuals.json().error.code).toBe("PRODUCTION_IMMUTABLE");
    const cancel = await api.post(`/api/production-orders/${id}/cancel`, {});
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error.code).toBe("PRODUCTION_IMMUTABLE");
  });

  it("la base rechaza modificar o borrar una orden completada y sus líneas", async () => {
    expect(
      await dbError(
        db()
          .update(productionOrders)
          .set({ actualOutputNormalized: "1" })
          .where(eq(productionOrders.id, id)),
      ),
    ).toMatch(/production_immutable/);
    expect(
      await dbError(
        db().update(productionOrders).set({ notes: "x" }).where(eq(productionOrders.id, id)),
      ),
    ).toMatch(/production_immutable/);
    expect(await dbError(db().delete(productionOrders).where(eq(productionOrders.id, id)))).toMatch(
      /production_not_deletable/,
    );
    expect(
      await dbError(
        db()
          .update(productionMaterialLines)
          .set({ actualCost: "0" })
          .where(eq(productionMaterialLines.productionOrderId, id)),
      ),
    ).toMatch(/production_immutable/);
    expect(
      await dbError(
        db()
          .delete(productInventoryCostHistory)
          .where(eq(productInventoryCostHistory.productId, w.panFrances)),
      ),
    ).toMatch(/./);
    expect(
      await dbError(
        db()
          .update(productInventoryCosts)
          .set({ quantity: "1000" })
          .where(eq(productInventoryCosts.productId, w.panFrances)),
      ),
    ).toMatch(/inventory_cost_derived/);
  });
});

describe("integración — receta fijada al planificar (§67)", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " R");
    await stock(api, w, w.harina, "500", "1000");
    await stock(api, w, w.sal, "20", "500");
  });

  it("publicar v2 no cambia la orden planificada con v1", async () => {
    const created = await ok(createOrder(api, w), 201);
    await ok(api.post(`/api/production-orders/${created.id}/plan`));
    const v2 = await publishNewVersion(api, w.recipeId, w.units, [
      ingredient(w.harina, "80", w.units.kg!),
      ingredient(w.sal, "1", w.units.kg!),
    ]);
    const planned = await order(created.id);
    expect(planned.recipeVersion.id).toBe(w.v1);
    expect(planned.suggestedVersion).toBeNull();
    expect(dec(planned.materials[0].plannedNormalized)).toBe("75");

    // Cambiar la versión de una orden planificada: bloqueado (API y base).
    const patch = await api.patch(`/api/production-orders/${created.id}`, { recipeVersionId: v2 });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.code).toBe("PRODUCTION_PLAN_LOCKED");
    expect(
      await dbError(
        db()
          .update(productionOrders)
          .set({ recipeVersionId: v2 })
          .where(eq(productionOrders.id, created.id)),
      ),
    ).toMatch(/production_plan_locked/);
    expect(
      await dbError(
        db()
          .update(productionMaterialLines)
          .set({ plannedNormalizedQuantity: "80" })
          .where(eq(productionMaterialLines.productionOrderId, created.id)),
      ),
    ).toMatch(/production_plan_locked/);

    const started = await ok(api.post(`/api/production-orders/${created.id}/start`));
    await recordActuals(api, w, started, {}, "100");
    const done = await ok(api.post(`/api/production-orders/${created.id}/complete`));
    expect(done.recipeVersion).toMatchObject({ id: w.v1, versionNumber: 1 });
    expect(done.costs.actual.total).toBe("75400.000000");
    const harina = (await movementsOf(created.id)).find((m) => m.rawMaterialId === w.harina)!;
    expect(dec(harina.quantity)).toBe("-75");

    // Una orden nueva toma v2; el borrador sugiere la vigente.
    const fresh = await ok(createOrder(api, w), 201);
    expect(fresh.recipeVersion).toMatchObject({ id: v2, versionNumber: 2 });
    expect(dec(fresh.materials[0].plannedNormalized)).toBe("80");
    // v1 sigue con sus ingredientes originales.
    const v1Ingredients = await db()
      .select({ q: recipeIngredients.quantity })
      .from(recipeIngredients)
      .where(eq(recipeIngredients.recipeVersionId, w.v1));
    expect(v1Ingredients.map((r) => dec(r.q)).sort()).toEqual(["0.8", "75"]);
  });

  it("un borrador puede elegir otra versión publicada y sugiere la vigente", async () => {
    const draft = await ok(createOrder(api, w, { recipeVersionId: w.v1 }), 201);
    expect(draft.recipeVersion.id).toBe(w.v1);
    expect(draft.suggestedVersion).toMatchObject({ versionNumber: 2 });
  });
});

describe("integración — promedio del producto (§68) y escalado", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " M");
    await stock(api, w, w.sal, "50", "0");
  });

  async function produce(harinaCost: string) {
    await stock(api, w, w.harina, "75", harinaCost);
    const o = await startedOrder(api, w);
    // Sin sal: la línea queda en 0 (no se usó); costo = 75 kg × costo de la harina.
    await recordActuals(api, w, o, { [w.sal]: "0" }, "100");
    return ok(api.post(`/api/production-orders/${o.id}/complete`));
  }

  it("100 kg @ 1.000 + 100 kg @ 1.200 → 200 kg @ 1.100", async () => {
    // 75 kg × 1.333,333333 = 99.999,999975 → 1.000/kg (6 decimales)
    const first = await produce("1333.333333");
    expect(first.costs.actual).toEqual({ total: "99999.999975", unit: "1000.000000" });
    const detailA = await productStock(w.panFrances);
    expect(detailA.averageMaterialCost).toBe("1000.000000");
    const second = await produce("1600");
    expect(second.costs.actual).toEqual({ total: "120000.000000", unit: "1200.000000" });
    const detail = await productStock(w.panFrances);
    expect(dec(detail.quantity)).toBe("200");
    expect(detail.averageMaterialCost).toBe("1100.000000");
    // El valor conserva exactamente lo consumido (sin redondeo del unitario).
    expect(detail.inventoryValue).toBe("219999.999975");
    const { history } = await ok(api.get(`/api/inventory/products/${w.panFrances}/cost-history`));
    expect(history.items.map((h: { averageAfter: string }) => h.averageAfter)).toEqual([
      "1100.000000",
      "1000.000000",
    ]);
    // La sal no consumida no genera movimiento y su costo real es 0.
    const salLine = second.materials.find(
      (m: { rawMaterial: { id: string } }) => m.rawMaterial.id === w.sal,
    );
    expect(salLine).toMatchObject({ actualCost: "0.000000", consumptionMovementId: null });
  });

  it("escala la receta: 200 kg → 150 kg de harina y 1,6 kg de sal (planificado en g)", async () => {
    const o = await ok(
      createOrder(api, w, { plannedOutputQuantity: "200000", plannedOutputUnitId: w.units.g }),
      201,
    );
    expect(dec(o.plannedOutputNormalized)).toBe("200");
    expect(o.plannedOutputUnit.code).toBe("g");
    expect(o.materials.map((m: { plannedNormalized: string }) => dec(m.plannedNormalized))).toEqual(
      ["150", "1.6"],
    );
    expect(dec(o.scaleFactor)).toBe("2");
  });

  it("rechaza unidades incompatibles en la cantidad y en el consumo real", async () => {
    const bad = await createOrder(api, w, { plannedOutputUnitId: w.units.l });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("INCOMPATIBLE_OUTPUT_UNIT");
    await stock(api, w, w.harina, "75", "1000");
    const o = await startedOrder(api, w);
    const line = o.materials[0];
    const res = await api.put(`/api/production-orders/${o.id}/actuals`, {
      lines: [{ lineId: line.id, quantity: "1", unitId: w.units.l }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("INCOMPATIBLE_CONSUMPTION_UNIT");
    const zero = await api.put(`/api/production-orders/${o.id}/actuals`, {
      actualOutputQuantity: "0",
      actualOutputUnitId: w.units.kg,
    });
    expect(zero.statusCode).toBe(400);
    const missing = await api.post(`/api/production-orders/${o.id}/complete`);
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.code).toBe("ACTUAL_OUTPUT_REQUIRED");
    await ok(api.post(`/api/production-orders/${o.id}/cancel`, { reason: "Prueba" }));
  });
});

describe("integración — consumo extra (§69)", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " X");
    await stock(api, w, w.harina, "100", "1000");
    await stock(api, w, w.sal, "5", "500");
    await stock(api, w, w.aceite, "10", "3000");
  });

  it("1 l de aceite extra: consume inventario, sube el costo real y no toca la receta", async () => {
    const o = await startedOrder(api, w);
    const missingNote = await api.post(`/api/production-orders/${o.id}/extra-materials`, {
      rawMaterialId: w.aceite,
      quantity: "1",
      unitId: w.units.l,
    });
    expect(missingNote.statusCode).toBe(400);
    const res = await api.post(`/api/production-orders/${o.id}/extra-materials`, {
      rawMaterialId: w.aceite,
      quantity: "1000",
      unitId: w.units.ml,
      notes: "La masa salió seca",
    });
    expect(res.statusCode).toBe(201);
    const extra = res.json().materials.find((m: { lineType: string }) => m.lineType === "EXTRA");
    expect(extra).toMatchObject({
      lineNumber: 3,
      notes: "La masa salió seca",
      plannedQuantity: null,
    });
    expect(dec(extra.actualNormalized)).toBe("1");
    expect(extra.variance).toEqual({ quantity: "1.0000000000", percentage: null });

    // Otro extra que se quita.
    const another = await ok(
      api.post(`/api/production-orders/${o.id}/extra-materials`, {
        rawMaterialId: w.sal,
        quantity: "0.1",
        unitId: w.units.kg,
        notes: "Error de carga",
      }),
      201,
    );
    const toRemove = another.materials.find((m: { lineNumber: number }) => m.lineNumber === 4);
    const removed = await ok(
      api.delete(`/api/production-orders/${o.id}/extra-materials/${toRemove.id}`),
    );
    expect(removed.materials).toHaveLength(3);
    const recipeLine = await api.delete(
      `/api/production-orders/${o.id}/extra-materials/${o.materials[0].id}`,
    );
    expect(recipeLine.statusCode).toBe(409);

    await recordActuals(api, w, removed, {}, "100");
    const done = await ok(api.post(`/api/production-orders/${o.id}/complete`));
    // 75.000 + 400 + 3.000 de aceite
    expect(done.costs.actual.total).toBe("78400.000000");
    expect(dec((await inventoryDetail(api, w.aceite)).quantity)).toBe("9");
    const versionIngredients = await db()
      .select({ id: recipeIngredients.rawMaterialId })
      .from(recipeIngredients)
      .where(eq(recipeIngredients.recipeVersionId, w.v1));
    expect(versionIngredients.map((r) => r.id)).not.toContain(w.aceite);
    expect(await auditActions(o.id)).toEqual(
      expect.arrayContaining([
        "PRODUCTION_EXTRA_MATERIAL_ADDED",
        "PRODUCTION_EXTRA_MATERIAL_REMOVED",
      ]),
    );
    const [added] = await db()
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, "PRODUCTION_EXTRA_MATERIAL_ADDED"), eq(auditLogs.entityId, o.id)),
      )
      .limit(1);
    expect(added!.metadata).toMatchObject({
      notes: "La masa salió seca",
      quantity: "1.0000000000",
    });
  });
});

describe("integración — stock insuficiente (§70)", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " S");
    await stock(api, w, w.harina, "50", "1000");
    await stock(api, w, w.sal, "5", "500");
  });

  it("planifica con faltante, no inicia, inicia tras cargar stock y revalida al completar", async () => {
    const created = await ok(createOrder(api, w), 201);
    const planned = await ok(api.post(`/api/production-orders/${created.id}/plan`));
    expect(planned.status).toBe("PLANNED");
    expect(planned.availability.sufficient).toBe(false);
    const short = planned.availability.lines.find((l: { status: string }) => l.status === "SHORT");
    expect(dec(short.missing)).toBe("25");

    const start = await api.post(`/api/production-orders/${created.id}/start`);
    expect(start.statusCode).toBe(409);
    expect(start.json().error).toMatchObject({
      code: "INSUFFICIENT_MATERIALS_FOR_PRODUCTION",
      details: [
        expect.objectContaining({
          rawMaterialId: w.harina,
          required: "75.0000000000",
          available: "50.0000000000",
          missing: "25.0000000000",
        }),
      ],
    });

    await stock(api, w, w.harina, "30", "1000");
    const started = await ok(api.post(`/api/production-orders/${created.id}/start`));
    expect(started.status).toBe("IN_PROGRESS");

    // Otro proceso consume harina antes de completar (sin reservas).
    await ok(
      api.post("/api/inventory/waste", {
        rawMaterialId: w.harina,
        warehouseId: w.warehouseId,
        quantity: "10",
        reason: "DAMAGED",
      }),
      201,
    );
    await recordActuals(api, w, started, {}, "100");
    const before = await inventoryDetail(api, w.harina);
    const res = await api.post(`/api/production-orders/${created.id}/complete`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INSUFFICIENT_STOCK");
    expect(res.json().error.details[0]).toMatchObject({
      rawMaterialId: w.harina,
      missing: "5.0000000000",
    });
    expect(await movementsOf(created.id)).toHaveLength(0);
    const after = await inventoryDetail(api, w.harina);
    expect(after.quantity).toBe(before.quantity);
    expect((await order(created.id)).status).toBe("IN_PROGRESS");
  });
});

describe("integración — rollback (§73)", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " RB");
    await stock(api, w, w.harina, "100", "1000");
    await stock(api, w, w.sal, "5", "500");
  });

  it("una falla al ingresar el producto revierte consumos, saldos, costos y auditoría", async () => {
    const o = await startedOrder(api, w);
    await recordActuals(api, w, o, {}, "100");
    const harinaBefore = await inventoryDetail(api, w.harina);
    // Falla inyectada DESPUÉS de los consumos: el historial de costo del producto rechaza el alta.
    await db().execute(sql`
      create function test_fail_product_history() returns trigger language plpgsql as $$
      begin raise exception 'falla inyectada antes del commit'; end $$;
      create trigger test_fail_product_history before insert on product_inventory_cost_history
        for each row execute function test_fail_product_history();
    `);
    try {
      const res = await api.post(`/api/production-orders/${o.id}/complete`);
      expect(res.statusCode).toBe(500);
    } finally {
      await db().execute(sql`
        drop trigger test_fail_product_history on product_inventory_cost_history;
        drop function test_fail_product_history();
      `);
    }
    expect((await order(o.id)).status).toBe("IN_PROGRESS");
    expect(await movementsOf(o.id)).toHaveLength(0);
    const harinaAfter = await inventoryDetail(api, w.harina);
    expect(harinaAfter.quantity).toBe(harinaBefore.quantity);
    expect(harinaAfter.inventoryValue).toBe(harinaBefore.inventoryValue);
    const detail = await productStock(w.panFrances);
    expect(dec(detail.quantity)).toBe("0");
    const [costRow] = await db()
      .select()
      .from(productInventoryCosts)
      .where(eq(productInventoryCosts.productId, w.panFrances));
    expect(costRow).toBeUndefined();
    expect(await auditActions(o.id)).not.toContain("PRODUCTION_ORDER_COMPLETED");

    // Sin la falla, la misma orden completa normalmente.
    const done = await ok(api.post(`/api/production-orders/${o.id}/complete`));
    expect(done.status).toBe("COMPLETED");
  });
});

describe("integración — máquina de estados y reglas de alta", () => {
  let w: ProductionWorld;

  beforeAll(async () => {
    w = await buildProductionWorld(api, " E");
    await stock(api, w, w.harina, "1000", "1000");
    await stock(api, w, w.sal, "100", "500");
  });

  it("la vista previa calcula receta, plan y disponibilidad sin guardar nada", async () => {
    const [before] = await db().select({ n: count() }).from(productionOrders);
    const res = await api.post("/api/production-orders/preview", {
      productId: w.panFrances,
      scheduledFor: TODAY,
      plannedOutputQuantity: "200",
      sourceWarehouseId: w.warehouseId,
      outputWarehouseId: w.warehouseId,
    });
    expect(res.statusCode).toBe(200);
    const preview = res.json();
    expect(preview.recipeVersion).toMatchObject({ id: w.v1, versionNumber: 1 });
    expect(
      preview.materials.map((m: { plannedNormalized: string }) => dec(m.plannedNormalized)),
    ).toEqual(["150", "1.6"]);
    expect(preview.availability.sufficient).toBe(true);
    expect(preview.costs.planned.total).toBe("150800.000000");
    const [after] = await db().select({ n: count() }).from(productionOrders);
    expect(after!.n).toBe(before!.n);
    const bad = await api.post("/api/production-orders/preview", {
      productId: w.panFrances,
      scheduledFor: TODAY,
      plannedOutputQuantity: "1",
      plannedOutputUnitId: w.units.l,
      sourceWarehouseId: w.warehouseId,
      outputWarehouseId: w.warehouseId,
    });
    expect(bad.json().error.code).toBe("INCOMPATIBLE_OUTPUT_UNIT");
  });

  it("transiciones inválidas → 409 INVALID_PRODUCTION_TRANSITION", async () => {
    const o = await ok(createOrder(api, w), 201);
    const start = await api.post(`/api/production-orders/${o.id}/start`);
    expect(start.statusCode).toBe(409);
    expect(start.json().error.code).toBe("INVALID_PRODUCTION_TRANSITION");
    const complete = await api.post(`/api/production-orders/${o.id}/complete`);
    expect(complete.json().error.code).toBe("INVALID_PRODUCTION_TRANSITION");
    await ok(api.post(`/api/production-orders/${o.id}/plan`));
    const again = await api.post(`/api/production-orders/${o.id}/plan`);
    expect(again.json().error.code).toBe("INVALID_PRODUCTION_TRANSITION");
    const completePlanned = await api.post(`/api/production-orders/${o.id}/complete`);
    expect(completePlanned.json().error.code).toBe("INVALID_PRODUCTION_TRANSITION");
    const actuals = await api.put(`/api/production-orders/${o.id}/actuals`, { notes: "x" });
    expect(actuals.json().error.code).toBe("PRODUCTION_NOT_IN_PROGRESS");
  });

  it("cancela desde DRAFT, PLANNED e IN_PROGRESS (auditado, sin inventario); CANCELLED es final", async () => {
    for (const steps of [[], ["plan"], ["plan", "start"]]) {
      const o = await ok(createOrder(api, w), 201);
      for (const step of steps) await ok(api.post(`/api/production-orders/${o.id}/${step}`));
      const cancelled = await ok(
        api.post(`/api/production-orders/${o.id}/cancel`, { reason: "Sin horno" }),
      );
      expect(cancelled).toMatchObject({ status: "CANCELLED", cancelReason: "Sin horno" });
      expect(await movementsOf(o.id)).toHaveLength(0);
      expect(await auditActions(o.id)).toContain("PRODUCTION_ORDER_CANCELLED");
      const res = await api.post(`/api/production-orders/${o.id}/plan`);
      expect(res.json().error.code).toBe("PRODUCTION_IMMUTABLE");
      expect(
        await dbError(
          db()
            .update(productionOrders)
            .set({ status: "DRAFT" })
            .where(eq(productionOrders.id, o.id)),
        ),
      ).toMatch(/production_immutable/);
    }
  });

  it("DRAFT edita todo; PLANNED sólo responsable, lote y notas", async () => {
    const o = await ok(createOrder(api, w), 201);
    const edited = await ok(
      api.patch(`/api/production-orders/${o.id}`, {
        plannedOutputQuantity: "50",
        sourceWarehouseId: w.secondWarehouseId,
        notes: "Para el sábado",
      }),
    );
    expect(dec(edited.plannedOutputNormalized)).toBe("50");
    expect(edited.sourceWarehouse.id).toBe(w.secondWarehouseId);
    expect(dec(edited.materials[0].plannedNormalized)).toBe("37.5");
    await ok(api.post(`/api/production-orders/${o.id}/plan`));
    const locked = await api.patch(`/api/production-orders/${o.id}`, {
      plannedOutputQuantity: "60",
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toMatchObject({
      code: "PRODUCTION_PLAN_LOCKED",
      details: [expect.objectContaining({ path: "plannedOutputQuantity" })],
    });
    // Reenviar el mismo valor no es un cambio.
    await ok(api.patch(`/api/production-orders/${o.id}`, { plannedOutputQuantity: "50.000" }));
    const ops = await ok(
      api.patch(`/api/production-orders/${o.id}`, {
        responsibleEmployeeId: w.employeeId,
        batchCode: "LOTE-ESPECIAL",
        notes: "Cambió el turno",
      }),
    );
    expect(ops).toMatchObject({ batchCode: "LOTE-ESPECIAL", notes: "Cambió el turno" });
    const other = await ok(createOrder(api, w), 201);
    const dup = await api.patch(`/api/production-orders/${other.id}`, {
      batchCode: "LOTE-ESPECIAL",
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("BATCH_CODE_TAKEN");
    expect(await auditActions(o.id)).toEqual(expect.arrayContaining(["PRODUCTION_ORDER_UPDATED"]));
  });

  it("producto sin control de stock, inactivo o sin receta: no se crean órdenes", async () => {
    const noStock = await ok(
      api.post("/api/products", {
        name: "Torta por encargo E",
        categoryId: w.productCategoryId,
        saleUnitId: w.units.unidad,
        salePrice: "5000",
        controlsStock: false,
      }),
      201,
    );
    const res = await createOrder(api, w, { productId: noStock.id });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PRODUCT_NOT_STOCK_CONTROLLED");

    const noRecipe = await ok(
      api.post("/api/products", {
        name: "Grisines E",
        categoryId: w.productCategoryId,
        saleUnitId: w.units.kg,
        salePrice: "3000",
      }),
      201,
    );
    expect((await createOrder(api, w, { productId: noRecipe.id })).json().error.code).toBe(
      "PRODUCT_WITHOUT_RECIPE",
    );

    // Una orden en curso se completa aunque el producto se desactive después (§46).
    const inProgress = await startedOrder(api, w);
    const planned = await ok(createOrder(api, w), 201);
    await ok(api.post(`/api/production-orders/${planned.id}/plan`));
    await ok(api.post(`/api/products/${w.panFrances}/deactivate`));
    expect((await createOrder(api, w)).json().error.code).toBe("PRODUCT_INACTIVE");
    expect((await api.post(`/api/production-orders/${planned.id}/start`)).json().error.code).toBe(
      "PRODUCT_INACTIVE",
    );
    await recordActuals(api, w, inProgress, {}, "100");
    expect((await ok(api.post(`/api/production-orders/${inProgress.id}/complete`))).status).toBe(
      "COMPLETED",
    );
    await ok(api.post(`/api/products/${w.panFrances}/activate`));
  });

  it("materia prima dada de baja bloquea planificar e iniciar (§47)", async () => {
    const planned = await ok(createOrder(api, w), 201);
    await ok(api.post(`/api/production-orders/${planned.id}/plan`));
    const draft = await ok(createOrder(api, w), 201);
    await ok(api.post(`/api/raw-materials/${w.sal}/deactivate`));
    const plan = await api.post(`/api/production-orders/${draft.id}/plan`);
    expect(plan.statusCode).toBe(409);
    expect(plan.json().error.code).toBe("RAW_MATERIAL_INACTIVE");
    const detail = await order(draft.id);
    expect(detail.issues.map((i: { code: string }) => i.code)).toContain("RAW_MATERIAL_INACTIVE");
    const start = await api.post(`/api/production-orders/${planned.id}/start`);
    expect(start.json().error.code).toBe("RAW_MATERIAL_INACTIVE");
    await ok(api.post(`/api/raw-materials/${w.sal}/activate`));
    expect((await ok(api.post(`/api/production-orders/${planned.id}/start`))).status).toBe(
      "IN_PROGRESS",
    );
  });

  it("listado con filtros por estado, producto, fecha y búsqueda", async () => {
    const all = await ok(api.get(`/api/production-orders?productId=${w.panFrances}&pageSize=100`));
    expect(all.total).toBeGreaterThan(5);
    const completed = await ok(
      api.get(`/api/production-orders?productId=${w.panFrances}&status=COMPLETED`),
    );
    expect(completed.items.every((i: { status: string }) => i.status === "COMPLETED")).toBe(true);
    expect(completed.items[0].actualMaterialCost).not.toBeNull();
    const open = await ok(api.get(`/api/production-orders?status=open&productId=${w.panFrances}`));
    expect(
      open.items.every((i: { status: string }) =>
        ["DRAFT", "PLANNED", "IN_PROGRESS"].includes(i.status),
      ),
    ).toBe(true);
    const future = await ok(api.get("/api/production-orders?from=2999-01-01"));
    expect(future.total).toBe(0);
    const byBatch = await ok(api.get("/api/production-orders?search=LOTE-ESPECIAL"));
    expect(byBatch.items).toHaveLength(1);
    const responsibles = await ok(api.get("/api/production/responsibles"));
    expect(responsibles).toEqual(
      expect.arrayContaining([{ id: w.employeeId, name: "Juana Panadera E" }]),
    );
  });
});

describe("integración — saldos = Σ movimientos con productos", () => {
  it("cada saldo (materia prima y producto) coincide con la suma de sus movimientos", async () => {
    const rows = await db().execute<{ mismatches: number }>(sql`
      select count(*)::int as mismatches from stock_balances b
      where b.quantity <> coalesce((
        select sum(m.quantity) from stock_movements m
        where m.company_id = b.company_id and m.warehouse_id = b.warehouse_id
          and m.item_type = b.item_type
          and m.raw_material_id is not distinct from b.raw_material_id
          and m.product_id is not distinct from b.product_id), 0)
    `);
    expect(rows.rows[0]!.mismatches).toBe(0);
    const products = await db().execute<{ mismatches: number }>(sql`
      select count(*)::int as mismatches from product_inventory_costs c
      where c.quantity <> coalesce((select sum(m.quantity) from stock_movements m
        where m.company_id = c.company_id and m.product_id = c.product_id), 0)
        or c.inventory_value <> coalesce((select sum(m.total_value) from stock_movements m
        where m.company_id = c.company_id and m.product_id = c.product_id), 0)
    `);
    expect(products.rows[0]!.mismatches).toBe(0);
  });
});
