import {
  inventoryCostHistory,
  purchaseLines,
  purchaseReceiptLines,
  purchaseReceipts,
  rawMaterialInventoryCosts,
  stockBalances,
  stockMovements,
} from "@bakery/database";
import { D } from "@bakery/domain";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  clientFor,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";
import {
  buildPurchasingWorld,
  createReceipt,
  dec,
  initialStock,
  inventoryDetail,
  ok,
  orderedPurchase,
  presentation,
  receive,
  type PurchasingWorld,
} from "./inventory-fixtures.js";
import { rawMaterial } from "./recipe-fixtures.js";

/*
 * Invariantes de inventario de Fase 3 (§59), en las dos capas: la API las
 * respeta y la base las sostiene aunque alguien escriba directo (triggers con
 * SQLSTATE 23001, CHECK 23514, UNIQUE 23505, FK 23503). Las invariantes 15–17
 * (recetas) y 20 (atomicidad) tienen además su escenario completo en
 * purchases-inventory.test.ts; la 18 en inventory-tenancy.test.ts; la 19 en
 * authorization.test.ts.
 */

let ctx: TestContext;
let api: ApiClient;
let w: PurchasingWorld;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
  w = await buildPurchasingWorld(api);
  await initialStock(api, w.harina, w.warehouseId, "100", "1000");
});
afterAll(() => ctx.close());

const db = () => ctx.database.db;

/** Drizzle envuelve el error de PostgreSQL en `cause`. */
async function pgError(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e as { cause?: { code?: string } },
  );
  return err?.cause?.code;
}

const newMaterial = (name: string, reference: string | null = null) =>
  rawMaterial(api, w.categoryId, name, w.units.kg!, reference);

/** Suma de movimientos por depósito == saldo; suma de valores == valor de empresa. */
async function assertLedgerConsistent() {
  const balances = await db().execute<{ ok: boolean }>(sql`
    select bool_and(b.quantity = coalesce(m.total, 0)) as ok
    from stock_balances b
    left join (
      select company_id, warehouse_id, raw_material_id, sum(quantity) as total
      from stock_movements group by 1, 2, 3
    ) m using (company_id, warehouse_id, raw_material_id)
  `);
  expect(balances.rows[0]!.ok).toBe(true);
  const costs = await db().execute<{ ok: boolean }>(sql`
    select bool_and(c.quantity = coalesce(m.qty, 0) and c.inventory_value = coalesce(m.value, 0)) as ok
    from raw_material_inventory_costs c
    left join (
      select company_id, raw_material_id, sum(quantity) as qty, sum(total_value) as value
      from stock_movements group by 1, 2
    ) m using (company_id, raw_material_id)
  `);
  expect(costs.rows[0]!.ok).toBe(true);
}

describe("invariantes de inventario (§59)", () => {
  it("1. todo cambio de stock tiene su movimiento: saldos y costos = suma del ledger", async () => {
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: w.harina, presentationId: w.bolsaHarina, quantity: "2", unitPrice: "30000" },
    ]);
    await receive(api, p, w.warehouseId, ["2"]);
    await ok(
      api.post("/api/inventory/waste", {
        rawMaterialId: w.harina,
        warehouseId: w.warehouseId,
        quantity: "3",
        reason: "QUALITY",
      }),
      201,
    );
    await assertLedgerConsistent();
  });

  it("2. stock_movements es append-only (UPDATE y DELETE rechazados por la base)", async () => {
    const [m] = await db().select().from(stockMovements).limit(1);
    expect(
      await pgError(
        db().update(stockMovements).set({ quantity: "999" }).where(eq(stockMovements.id, m!.id)),
      ),
    ).toBe("23001");
    expect(await pgError(db().delete(stockMovements).where(eq(stockMovements.id, m!.id)))).toBe(
      "23001",
    );
    expect(await pgError(db().execute(sql`delete from inventory_cost_history`))).toBe("23001");
  });

  it("3. el saldo no cambia sin un movimiento nuevo que lo explique", async () => {
    expect(
      await pgError(
        db()
          .update(stockBalances)
          .set({ quantity: sql`${stockBalances.quantity} + 1` })
          .where(eq(stockBalances.rawMaterialId, w.harina)),
      ),
    ).toBe("23001");
    expect(
      await pgError(
        db()
          .update(rawMaterialInventoryCosts)
          .set({ movingAverageCost: "1" })
          .where(eq(rawMaterialInventoryCosts.rawMaterialId, w.harina)),
      ),
    ).toBe("23001");
    expect(
      await pgError(db().delete(stockBalances).where(eq(stockBalances.rawMaterialId, w.harina))),
    ).toBe("23001");
    // Un saldo nuevo sólo puede nacer en cero.
    const otra = await newMaterial("Semillas");
    expect(
      await pgError(
        db().insert(stockBalances).values({
          companyId: ctx.companyId,
          warehouseId: w.warehouseId,
          itemType: "RAW_MATERIAL",
          rawMaterialId: otra,
          baseUnitId: w.units.kg!,
          quantity: "50",
        }),
      ),
    ).toBe("23001");
  });

  it("4. una recepción no se aplica dos veces (API 409 y UNIQUE por línea de origen)", async () => {
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: w.harina, presentationId: w.bolsaHarina, quantity: "1", unitPrice: "30000" },
    ]);
    const receipt = await receive(api, p, w.warehouseId, ["1"]);
    const again = await api.post(`/api/purchase-receipts/${receipt.id}/post`);
    expect(again.json().error.code).toBe("ALREADY_POSTED");
    const [m] = await db()
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.referenceId, receipt.id));
    const { id: _id, sequence: _seq, createdAt: _c, ...copy } = m!;
    expect(await pgError(db().insert(stockMovements).values(copy))).toBe("23505");
  });

  it("5. una recepción confirmada es inmutable (cabecera y líneas)", async () => {
    const [r] = await db()
      .select()
      .from(purchaseReceipts)
      .where(eq(purchaseReceipts.status, "POSTED"))
      .limit(1);
    expect(
      await pgError(
        db()
          .update(purchaseReceipts)
          .set({ documentNumber: "X" })
          .where(eq(purchaseReceipts.id, r!.id)),
      ),
    ).toBe("23001");
    expect(
      await pgError(
        db()
          .update(purchaseReceiptLines)
          .set({ receivedQuantity: "99" })
          .where(eq(purchaseReceiptLines.receiptId, r!.id)),
      ),
    ).toBe("23001");
    expect(await pgError(db().delete(purchaseReceipts).where(eq(purchaseReceipts.id, r!.id)))).toBe(
      "23001",
    );
  });

  it("6. no se recibe más de lo pendiente (API 409 y CHECK recibido ≤ pedido)", async () => {
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: w.harina, presentationId: w.bolsaHarina, quantity: "2", unitPrice: "30000" },
    ]);
    const res = await createReceipt(api, p, w.warehouseId, ["3"]);
    expect(res.json().error.code).toBe("RECEIPT_EXCEEDS_PENDING");
    expect(
      await pgError(
        db()
          .update(purchaseLines)
          .set({ receivedQuantity: "3" })
          .where(eq(purchaseLines.id, p.lines[0].id)),
      ),
    ).toBe("23514");
  });

  it("7. el stock nunca queda negativo (API INSUFFICIENT_STOCK y CHECK ≥ 0)", async () => {
    const detail = await inventoryDetail(api, w.harina);
    const res = await api.post("/api/inventory/adjustments", {
      rawMaterialId: w.harina,
      warehouseId: w.warehouseId,
      direction: "NEGATIVE",
      quantity: new D(detail.quantity).plus("0.001").toString(),
      reason: "PHYSICAL_COUNT",
    });
    expect(res.json().error.code).toBe("INSUFFICIENT_STOCK");
    const check = await db().execute<{ c: string }>(sql`
      select pg_get_constraintdef(oid) as c from pg_constraint
      where conrelid = 'stock_balances'::regclass and contype = 'c'
    `);
    expect(check.rows.map((r) => r.c).join(" ")).toMatch(/quantity >= /);
  });

  it("8. una compra cancelada no puede recibir", async () => {
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: w.harina, presentationId: w.bolsaHarina, quantity: "1", unitPrice: "1" },
    ]);
    await ok(api.post(`/api/purchases/${p.id}/cancel`, {}));
    const res = await createReceipt(api, p, w.warehouseId, ["1"]);
    expect(res.json().error.code).toBe("PURCHASE_NOT_RECEIVABLE");
  });

  it("9. una compra con recepción confirmada no se cancela", async () => {
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: w.harina, presentationId: w.bolsaHarina, quantity: "2", unitPrice: "30000" },
    ]);
    await receive(api, p, w.warehouseId, ["1"]);
    const res = await api.post(`/api/purchases/${p.id}/cancel`, {});
    expect(res.json().error.code).toBe("PURCHASE_HAS_RECEIPTS");
  });

  it("10. una presentación es de UNA materia prima (API 422 y FK compuesta)", async () => {
    const azucar = await newMaterial("Azúcar");
    const res = await api.post("/api/purchases", {
      supplierId: w.supplierId,
      purchaseDate: "2026-09-30",
      lines: [
        { rawMaterialId: azucar, presentationId: w.bolsaHarina, quantity: "1", unitPrice: "1" },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].path).toBe("lines.0.presentationId");
    // Directo en la base: la línea de compra referencia (empresa, materia prima, presentación).
    const draft = await ok(
      api.post("/api/purchases", {
        supplierId: w.supplierId,
        purchaseDate: "2026-09-30",
        lines: [
          { rawMaterialId: w.harina, presentationId: w.bolsaHarina, quantity: "1", unitPrice: "1" },
        ],
      }),
      201,
    );
    expect(
      await pgError(
        db()
          .update(purchaseLines)
          .set({ rawMaterialId: azucar })
          .where(eq(purchaseLines.id, draft.lines[0].id)),
      ),
    ).toBe("23503");
  });

  it("11. el packaging no tiene conversión universal: bolsa sin presentación se rechaza", async () => {
    const res = await api.post("/api/purchases", {
      supplierId: w.supplierId,
      purchaseDate: "2026-09-30",
      lines: [
        { rawMaterialId: w.harina, purchaseUnitId: w.units.bolsa, quantity: "1", unitPrice: "1" },
      ],
    });
    expect(res.statusCode).toBe(422);
    // La misma unidad "bolsa" vale distinto según la materia prima.
    const azucar = await newMaterial("Azúcar impalpable");
    const bolsa10 = await presentation(
      api,
      azucar,
      "Bolsa 10 kg",
      w.units.bolsa!,
      "10",
      w.units.kg!,
    );
    const p = await ok(
      api.post("/api/purchases", {
        supplierId: w.supplierId,
        purchaseDate: "2026-09-30",
        lines: [
          { rawMaterialId: w.harina, presentationId: w.bolsaHarina, quantity: "1", unitPrice: "1" },
          { rawMaterialId: azucar, presentationId: bolsa10, quantity: "1", unitPrice: "1" },
        ],
      }),
      201,
    );
    expect(p.lines.map((l: { orderedBaseQuantity: string }) => dec(l.orderedBaseQuantity))).toEqual(
      ["25", "10"],
    );
  });

  it("12. la cantidad recibida se normaliza a la unidad base (4 bolsas = 100 kg; 500 g = 0,5 kg)", async () => {
    const pasas = await newMaterial("Pasas de uva");
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: w.harina, presentationId: w.bolsaHarina, quantity: "4", unitPrice: "30000" },
      { rawMaterialId: pasas, purchaseUnitId: w.units.g, quantity: "500", unitPrice: "8" },
    ]);
    const receipt = await receive(api, p, w.warehouseId, ["4", "500"]);
    expect(
      receipt.lines.map((l: { normalizedBaseQuantity: string }) => dec(l.normalizedBaseQuantity)),
    ).toEqual(["100", "0.5"]);
    // 500 g × $8/g = $4.000 → $8.000/kg.
    expect(dec((await inventoryDetail(api, pasas)).movingAverageCost)).toBe("8000");
    const [m] = await db()
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.rawMaterialId, pasas));
    expect(dec(m!.quantity)).toBe("0.5");
    expect(m!.baseUnitId).toBe(w.units.kg);
  });

  it("13. promedio ponderado: 100 @ $1.000 + 100 @ $1.200 = 200 @ $1.100", async () => {
    const m = await newMaterial("Harina leudante");
    await initialStock(api, m, w.warehouseId, "100", "1000");
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: m, purchaseUnitId: w.units.kg, quantity: "100", unitPrice: "1200" },
    ]);
    await receive(api, p, w.warehouseId, ["100"]);
    const d = await inventoryDetail(api, m);
    expect([dec(d.quantity), dec(d.inventoryValue), dec(d.movingAverageCost)]).toEqual([
      "200",
      "220000",
      "1100",
    ]);
  });

  it("14. una salida no cambia el promedio", async () => {
    const before = await inventoryDetail(api, w.harina);
    await ok(
      api.post("/api/inventory/waste", {
        rawMaterialId: w.harina,
        warehouseId: w.warehouseId,
        quantity: "1",
        reason: "OTHER",
      }),
      201,
    );
    const after = await inventoryDetail(api, w.harina);
    expect(after.movingAverageCost).toBe(before.movingAverageCost);
    expect(new D(before.quantity).minus(after.quantity).toString()).toBe("1");
  });

  it("15. los snapshots de recetas son inmutables en la base", async () => {
    const res = await db().execute(sql`
      select tgname from pg_trigger
      where tgrelid in ('recipe_cost_snapshots'::regclass, 'recipe_cost_snapshot_lines'::regclass)
        and not tgisinternal
    `);
    expect(res.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("16–17. el costo efectivo usa el promedio y conserva la referencia manual", async () => {
    const material = await ok(api.get(`/api/raw-materials/${w.harina}`));
    expect(material.effectiveCostSource).toBe("PURCHASE_MOVING_AVERAGE");
    expect(material.effectiveCost).toBe(material.movingAverageCost);
    expect(dec(material.referenceCost)).toBe("900");
    const sinStock = await newMaterial("Nueces", "5000");
    const m2 = await ok(api.get(`/api/raw-materials/${sinStock}`));
    expect(m2).toMatchObject({ movingAverageCost: null, effectiveCostSource: "MANUAL_REFERENCE" });
    expect(dec(m2.effectiveCost)).toBe("5000");
    const sinCosto = await ok(api.get(`/api/raw-materials/${await newMaterial("Anís")}`));
    expect(sinCosto).toMatchObject({ effectiveCost: null, effectiveCostSource: null });
  });
});

describe("21. concurrencia: costo y stock consistentes", () => {
  it("dos confirmaciones simultáneas de la MISMA recepción: una aplica, la otra 409", async () => {
    const m = await newMaterial("Chocolate");
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: m, purchaseUnitId: w.units.kg, quantity: "10", unitPrice: "9000" },
    ]);
    const receipt = await ok(createReceipt(api, p, w.warehouseId, ["10"]), 201);
    const results = await Promise.all([
      api.post(`/api/purchase-receipts/${receipt.id}/post`),
      api.post(`/api/purchase-receipts/${receipt.id}/post`),
      api.post(`/api/purchase-receipts/${receipt.id}/post`),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect(dec((await inventoryDetail(api, m)).quantity)).toBe("10");
  });

  it("recepciones y mermas simultáneas de una materia prima no calculan sobre un estado viejo", async () => {
    const m = await newMaterial("Dulce de leche");
    await initialStock(api, m, w.warehouseId, "100", "1000");
    const costs = ["1200", "1400", "1600", "1800"];
    const receipts = [];
    for (const cost of costs) {
      const p = await orderedPurchase(api, w.supplierId, [
        { rawMaterialId: m, purchaseUnitId: w.units.kg, quantity: "100", unitPrice: cost },
      ]);
      receipts.push(await ok(createReceipt(api, p, w.secondWarehouseId, ["100"]), 201));
    }
    const results = await Promise.all([
      ...receipts.map((r) => api.post(`/api/purchase-receipts/${r.id}/post`)),
      ...[1, 2, 3].map(() =>
        api.post("/api/inventory/waste", {
          rawMaterialId: m,
          warehouseId: w.warehouseId,
          quantity: "10",
          reason: "DAMAGED",
        }),
      ),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 201, 201, 201]);

    const d = await inventoryDetail(api, m);
    expect(dec(d.quantity)).toBe("470");
    // Cada movimiento partió del estado que dejó el anterior: la historia encadena.
    const history = await db()
      .select()
      .from(inventoryCostHistory)
      .where(eq(inventoryCostHistory.rawMaterialId, m))
      .orderBy(asc(inventoryCostHistory.id));
    expect(history).toHaveLength(8);
    for (let i = 1; i < history.length; i++) {
      expect(history[i]!.quantityBefore).toBe(history[i - 1]!.quantityAfter);
      expect(history[i]!.valueBefore).toBe(history[i - 1]!.valueAfter);
    }
    // Sin pérdidas de actualización: todas las entradas (100 + 4×100 kg) están en el valor.
    const [cost] = await db()
      .select()
      .from(rawMaterialInventoryCosts)
      .where(eq(rawMaterialInventoryCosts.rawMaterialId, m));
    expect(dec(cost!.quantity)).toBe("470");
    const average = new D(cost!.inventoryValue).div(cost!.quantity);
    expect(average.minus(cost!.movingAverageCost!).abs().lt("0.01")).toBe(true);
    await assertLedgerConsistent();
  });

  it("mermas simultáneas que juntas superan el stock: sólo pasan las que alcanzan", async () => {
    const m = await newMaterial("Crema");
    await initialStock(api, m, w.warehouseId, "25", "3000");
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        api.post("/api/inventory/waste", {
          rawMaterialId: m,
          warehouseId: w.warehouseId,
          quantity: "10",
          reason: "EXPIRED",
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 201, 409, 409]);
    expect(dec((await inventoryDetail(api, m)).quantity)).toBe("5");
    await assertLedgerConsistent();
  });
});
