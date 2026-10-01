import {
  auditLogs,
  purchaseReceipts,
  purchases,
  rawMaterialInventoryCosts,
  stockBalances,
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
import { ingredient, product, rawMaterial } from "./recipe-fixtures.js";

/*
 * Compras + inventario contra la API real y PostgreSQL: escenario principal
 * (§61), receta + inventario (§62), recepción parcial (§63), idempotencia (§64),
 * rollback (§65), salidas, ajustes, stock en cero y cancelación.
 */

let ctx: TestContext;
let api: ApiClient;
let w: PurchasingWorld;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
  w = await buildPurchasingWorld(api);
});
afterAll(() => ctx.close());

const db = () => ctx.database.db;

async function movementCount(rawMaterialId: string) {
  const [row] = await db()
    .select({ n: count() })
    .from(stockMovements)
    .where(eq(stockMovements.rawMaterialId, rawMaterialId));
  return row!.n;
}

async function auditCount(action: string, entityId?: string) {
  const [row] = await db()
    .select({ n: count() })
    .from(auditLogs)
    .where(
      and(eq(auditLogs.action, action), entityId ? eq(auditLogs.entityId, entityId) : undefined),
    );
  return row!.n;
}

async function newMaterial(name: string, reference: string | null = null, baseUnit = "kg") {
  return rawMaterial(api, w.categoryId, name, w.units[baseUnit]!, reference);
}

describe("escenario principal (§61)", () => {
  let purchase: { id: string; lines: { id: string }[] };

  it("stock inicial 100 kg @ $1.000: promedio $1.000, valor $100.000, referencia intacta", async () => {
    const result = await initialStock(api, w.harina, w.warehouseId, "100", "1000");
    expect(result.movement).toMatchObject({ movementType: "INITIAL_STOCK" });
    expect(dec(result.movement.quantity)).toBe("100");
    expect(dec(result.warehouseQuantityBefore)).toBe("0");
    expect(dec(result.warehouseQuantityAfter)).toBe("100");
    const detail = await inventoryDetail(api, w.harina);
    expect(dec(detail.quantity)).toBe("100");
    expect(dec(detail.movingAverageCost)).toBe("1000");
    expect(dec(detail.inventoryValue)).toBe("100000");
    expect(dec(detail.referenceCost)).toBe("900");
    expect(detail.effectiveCostSource).toBe("PURCHASE_MOVING_AVERAGE");
  });

  it("el stock inicial se carga una sola vez por materia prima y depósito", async () => {
    const res = await api.post("/api/inventory/initial-stock", {
      rawMaterialId: w.harina,
      warehouseId: w.warehouseId,
      quantity: "5",
      unitCost: "1000",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INITIAL_STOCK_ALREADY_LOADED");
  });

  it("compra 4 bolsas × 25 kg a $30.000: 100 kg a $1.200/kg", async () => {
    purchase = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: w.harina, presentationId: w.bolsaHarina, quantity: "4", unitPrice: "30000" },
    ]);
    const full = await ok(api.get(`/api/purchases/${purchase.id}`));
    expect(full.status).toBe("ORDERED");
    expect(full.number).toMatch(/^OC-/);
    expect(dec(full.total)).toBe("120000");
    expect(full.lines[0]).toMatchObject({
      presentation: { name: "Bolsa 25 kg" },
      purchaseUnit: { code: "bolsa" },
    });
    expect(dec(full.lines[0].baseQuantityPerUnit)).toBe("25");
    expect(dec(full.lines[0].orderedBaseQuantity)).toBe("100");
    expect(dec(full.lines[0].acquisitionUnitCost)).toBe("1200");
    // Pedir no mueve stock.
    expect(dec((await inventoryDetail(api, w.harina)).quantity)).toBe("100");
  });

  it("al confirmar la recepción: 200 kg, $220.000, promedio $1.100/kg", async () => {
    const receipt = await receive(api, purchase, w.warehouseId, ["4"]);
    expect(receipt.status).toBe("POSTED");
    expect(receipt.number).toMatch(/^REC-/);
    expect(dec(receipt.lines[0].normalizedBaseQuantity)).toBe("100");
    expect(dec(receipt.lines[0].acquisitionUnitCost)).toBe("1200");
    expect(dec(receipt.lines[0].lineInventoryValue)).toBe("120000");
    const detail = await inventoryDetail(api, w.harina);
    expect(dec(detail.quantity)).toBe("200");
    expect(dec(detail.inventoryValue)).toBe("220000");
    expect(dec(detail.movingAverageCost)).toBe("1100");
    expect(detail.lastPurchase).toMatchObject({
      receiptNumber: receipt.number,
      supplierName: "Molino Sur S.A.",
    });
    expect(dec(detail.lastPurchase.unitCost)).toBe("1200");
    expect((await ok(api.get(`/api/purchases/${purchase.id}`))).status).toBe("RECEIVED");
  });

  it("la referencia manual sigue en $900 y las recetas usan $1.100 (promedio de compras)", async () => {
    const material = await ok(api.get(`/api/raw-materials/${w.harina}`));
    expect(dec(material.referenceCost)).toBe("900");
    expect(material.referenceCostSource).toBe("MANUAL_REFERENCE");
    expect(dec(material.movingAverageCost)).toBe("1100");
    expect(dec(material.effectiveCost)).toBe("1100");
    expect(material.effectiveCostSource).toBe("PURCHASE_MOVING_AVERAGE");
  });

  it("historial de costo: dos cambios con el origen, antes y después", async () => {
    const { cost, history } = await ok(api.get(`/api/inventory/costs/${w.harina}`));
    expect(dec(cost.movingAverageCost)).toBe("1100");
    expect(dec(cost.referenceCost)).toBe("900");
    expect(history.items).toHaveLength(2);
    const [last, first] = history.items;
    expect(first).toMatchObject({ movementType: "INITIAL_STOCK", averageBefore: null });
    expect(dec(first.averageAfter)).toBe("1000");
    expect(last).toMatchObject({ movementType: "PURCHASE_RECEIPT", averageChanged: true });
    expect(dec(last.averageBefore)).toBe("1000");
    expect(dec(last.averageAfter)).toBe("1100");
    expect(last.reference).toMatchObject({ type: "PURCHASE", id: purchase.id });
    expect(await auditCount("MOVING_AVERAGE_COST_CHANGED", w.harina)).toBe(2);
  });

  it("movimientos: dos entradas con signo positivo y saldo posterior, más reciente primero", async () => {
    const page = await ok(api.get(`/api/inventory/movements?rawMaterialId=${w.harina}`));
    expect(page.total).toBe(2);
    expect(page.items.map((m: { movementType: string }) => m.movementType)).toEqual([
      "PURCHASE_RECEIPT",
      "INITIAL_STOCK",
    ]);
    expect(page.items.map((m: { balanceAfter: string }) => dec(m.balanceAfter))).toEqual([
      "200",
      "100",
    ]);
    expect(page.items[0].reference.label).toContain("OC-");
    expect(page.items[0].actor.displayName).toBe("Admin Test");
  });
});

describe("salidas, ajustes y stock negativo (§19, §25, §26)", () => {
  let azucar: string;

  it("merma de 10 kg sobre 100 kg @ $1.000: 90 kg, promedio igual, valor $90.000", async () => {
    azucar = await newMaterial("Azúcar");
    await initialStock(api, azucar, w.warehouseId, "100", "1000");
    const result = await ok(
      api.post("/api/inventory/waste", {
        rawMaterialId: azucar,
        warehouseId: w.warehouseId,
        quantity: "10",
        reason: "DAMAGED",
      }),
      201,
    );
    expect(result.movement.movementType).toBe("WASTE");
    expect(dec(result.movement.quantity)).toBe("-10");
    expect(dec(result.movement.totalValue)).toBe("-10000");
    const detail = await inventoryDetail(api, azucar);
    expect(dec(detail.quantity)).toBe("90");
    expect(dec(detail.movingAverageCost)).toBe("1000");
    expect(dec(detail.inventoryValue)).toBe("90000");
  });

  it("una merma mayor al stock falla con INSUFFICIENT_STOCK y no deja rastro", async () => {
    const before = await movementCount(azucar);
    const res = await api.post("/api/inventory/waste", {
      rawMaterialId: azucar,
      warehouseId: w.warehouseId,
      quantity: "90.5",
      reason: "EXPIRED",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INSUFFICIENT_STOCK");
    expect(await movementCount(azucar)).toBe(before);
    expect(dec((await inventoryDetail(api, azucar)).quantity)).toBe("90");
  });

  it("el faltante se mide por depósito: el secundario está vacío aunque la empresa tenga stock", async () => {
    const res = await api.post("/api/inventory/adjustments", {
      rawMaterialId: azucar,
      warehouseId: w.secondWarehouseId,
      direction: "NEGATIVE",
      quantity: "1",
      reason: "PHYSICAL_COUNT",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INSUFFICIENT_STOCK");
  });

  it("ajuste negativo: sale al promedio vigente, sin cambiarlo", async () => {
    await ok(
      api.post("/api/inventory/adjustments", {
        rawMaterialId: azucar,
        warehouseId: w.warehouseId,
        direction: "NEGATIVE",
        quantity: "5",
        reason: "PHYSICAL_COUNT",
      }),
      201,
    );
    const detail = await inventoryDetail(api, azucar);
    expect(dec(detail.quantity)).toBe("85");
    expect(dec(detail.movingAverageCost)).toBe("1000");
    expect(dec(detail.inventoryValue)).toBe("85000");
  });

  it("un ajuste negativo no acepta costo (sale al promedio)", async () => {
    const res = await api.post("/api/inventory/adjustments", {
      rawMaterialId: azucar,
      warehouseId: w.warehouseId,
      direction: "NEGATIVE",
      quantity: "1",
      reason: "OTHER",
      unitCost: "5",
    });
    expect(res.statusCode).toBe(400);
  });

  it("ajuste positivo sin costo: entra al promedio vigente", async () => {
    const result = await ok(
      api.post("/api/inventory/adjustments", {
        rawMaterialId: azucar,
        warehouseId: w.secondWarehouseId,
        direction: "POSITIVE",
        quantity: "15",
        reason: "PHYSICAL_COUNT",
      }),
      201,
    );
    expect(dec(result.movement.unitCost)).toBe("1000");
    const detail = await inventoryDetail(api, azucar);
    expect(dec(detail.quantity)).toBe("100");
    expect(dec(detail.movingAverageCost)).toBe("1000");
    expect(
      detail.byWarehouse.map((b: { warehouse: { name: string }; quantity: string }) => [
        b.warehouse.name,
        dec(b.quantity),
      ]),
    ).toEqual([
      ["Depósito Principal", "85"],
      ["Depósito Secundario", "15"],
    ]);
  });

  it("ajuste positivo sin promedio vigente exige costo (VALUATION_COST_REQUIRED)", async () => {
    const sal = await newMaterial("Sal fina");
    const res = await api.post("/api/inventory/adjustments", {
      rawMaterialId: sal,
      warehouseId: w.warehouseId,
      direction: "POSITIVE",
      quantity: "3",
      reason: "DATA_CORRECTION",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALUATION_COST_REQUIRED");
    expect(await movementCount(sal)).toBe(0);
    await ok(
      api.post("/api/inventory/adjustments", {
        rawMaterialId: sal,
        warehouseId: w.warehouseId,
        direction: "POSITIVE",
        quantity: "3",
        reason: "DATA_CORRECTION",
        unitCost: "400",
      }),
      201,
    );
    expect(dec((await inventoryDetail(api, sal)).movingAverageCost)).toBe("400");
  });

  it("stock en cero: el siguiente ingreso fija el promedio en su propio costo (§24)", async () => {
    const manteca = await newMaterial("Manteca");
    await initialStock(api, manteca, w.warehouseId, "10", "5000");
    await ok(
      api.post("/api/inventory/waste", {
        rawMaterialId: manteca,
        warehouseId: w.warehouseId,
        quantity: "10",
        reason: "EXPIRED",
      }),
      201,
    );
    let detail = await inventoryDetail(api, manteca);
    expect(dec(detail.quantity)).toBe("0");
    expect(dec(detail.inventoryValue)).toBe("0");
    expect(detail.status).toBe("OUT_OF_STOCK");
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: manteca, purchaseUnitId: w.units.kg, quantity: "20", unitPrice: "7000" },
    ]);
    await receive(api, p, w.warehouseId, ["20"]);
    detail = await inventoryDetail(api, manteca);
    expect(dec(detail.quantity)).toBe("20");
    expect(dec(detail.movingAverageCost)).toBe("7000");
    expect(dec(detail.inventoryValue)).toBe("140000");
  });
});

describe("costo de adquisición: descuentos e impuestos (§27–29)", () => {
  it("4 bolsas × $20.000 − $8.000 de descuento, con IVA informativo: entra a $720/kg", async () => {
    const harinaIntegral = await newMaterial("Harina integral");
    const bolsa = await presentation(
      api,
      harinaIntegral,
      "Bolsa 25 kg",
      w.units.bolsa!,
      "25",
      w.units.kg!,
    );
    const draft = await ok(
      api.post("/api/purchases", {
        supplierId: w.supplierId,
        purchaseDate: "2026-09-30",
        taxTotal: "15120",
        lines: [
          {
            rawMaterialId: harinaIntegral,
            presentationId: bolsa,
            quantity: "4",
            unitPrice: "20000",
            discountAmount: "8000",
          },
        ],
      }),
      201,
    );
    expect(dec(draft.subtotal)).toBe("80000");
    expect(dec(draft.discountTotal)).toBe("8000");
    expect(dec(draft.taxTotal)).toBe("15120");
    expect(dec(draft.total)).toBe("87120");
    expect(dec(draft.lines[0].netAmount)).toBe("72000");
    expect(dec(draft.lines[0].acquisitionUnitCost)).toBe("720");
    const ordered = await ok(api.post(`/api/purchases/${draft.id}/order`));
    await receive(api, ordered, w.warehouseId, ["4"]);
    const detail = await inventoryDetail(api, harinaIntegral);
    expect(dec(detail.movingAverageCost)).toBe("720");
    expect(dec(detail.inventoryValue)).toBe("72000");
  });

  it("un descuento mayor que el bruto se rechaza", async () => {
    const res = await api.post("/api/purchases", {
      supplierId: w.supplierId,
      purchaseDate: "2026-09-30",
      lines: [
        {
          rawMaterialId: w.harina,
          presentationId: w.bolsaHarina,
          quantity: "1",
          unitPrice: "100",
          discountAmount: "150",
        },
      ],
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("receta + inventario (§62)", () => {
  it("snapshot anterior intacto, costo actual al promedio y nueva versión con PURCHASE_MOVING_AVERAGE", async () => {
    const harina = await newMaterial("Harina 0000", "800");
    const bolsa = await presentation(api, harina, "Bolsa 25 kg", w.units.bolsa!, "25", w.units.kg!);
    const productCategory = (
      await ok(api.post("/api/categories", { type: "PRODUCT", name: "Panes" }), 201)
    ).id;
    const pan = await product(api, productCategory, "Pan de molde", w.units.kg!, "1500");
    const recipe = await ok(
      api.post("/api/recipes", {
        productId: pan,
        version: {
          yieldQuantity: "100",
          yieldUnitId: w.units.kg,
          ingredients: [ingredient(harina, "75", w.units.kg!)],
        },
      }),
      201,
    );
    const v1 = recipe.draftVersionId as string;
    await ok(api.post(`/api/recipe-versions/${v1}/publish`, {}));
    let cost = await ok(api.get(`/api/recipe-versions/${v1}/cost`));
    expect(cost.snapshot.lines[0]).toMatchObject({
      referenceCost: "800.000000",
      costSource: "MANUAL_REFERENCE",
    });
    expect(dec(cost.snapshot.totalCost)).toBe("60000");

    // Primera recepción real: 4 bolsas × $21.250 = $85.000 / 100 kg = $850/kg.
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: harina, presentationId: bolsa, quantity: "4", unitPrice: "21250" },
    ]);
    await receive(api, p, w.warehouseId, ["4"]);

    cost = await ok(api.get(`/api/recipe-versions/${v1}/cost`));
    expect(cost.snapshot.lines[0]).toMatchObject({
      referenceCost: "800.000000",
      costSource: "MANUAL_REFERENCE",
    });
    expect(dec(cost.snapshot.totalCost)).toBe("60000");
    expect(cost.current.ingredients[0]).toMatchObject({ costSource: "PURCHASE_MOVING_AVERAGE" });
    expect(dec(cost.current.ingredients[0].referenceCost)).toBe("850");
    expect(dec(cost.current.totalCost)).toBe("63750");
    const current = await ok(api.get(`/api/recipes/${recipe.id}/current-cost`));
    expect(dec(current.current?.totalCost ?? current.totalCost)).toBe("63750");
    // La referencia manual se conserva.
    expect(dec((await ok(api.get(`/api/raw-materials/${harina}`))).referenceCost)).toBe("800");

    const v2 = (await ok(api.post(`/api/recipe-versions/${v1}/duplicate`), 201)).id as string;
    await ok(api.post(`/api/recipe-versions/${v2}/publish`, {}));
    const cost2 = await ok(api.get(`/api/recipe-versions/${v2}/cost`));
    expect(cost2.snapshot.lines[0]).toMatchObject({
      referenceCost: "850.000000",
      costSource: "PURCHASE_MOVING_AVERAGE",
    });
    expect(dec(cost2.snapshot.totalCost)).toBe("63750");
    // v1 sigue igual.
    const again = await ok(api.get(`/api/recipe-versions/${v1}/cost`));
    expect(again.snapshot).toEqual(cost.snapshot);
  });
});

describe("recepción parcial (§63)", () => {
  let levadura: string;
  let paquete: string;
  let purchase: { id: string; lines: { id: string }[] };

  beforeAll(async () => {
    levadura = await newMaterial("Levadura seca");
    paquete = await presentation(
      api,
      levadura,
      "Paquete 500 g",
      w.units.paquete!,
      "500",
      w.units.g!,
    );
    purchase = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: levadura, presentationId: paquete, quantity: "10", unitPrice: "3000" },
    ]);
  });

  it("recibe 6 de 10: PARTIALLY_RECEIVED con 4 pendientes (3 kg en stock)", async () => {
    await receive(api, purchase, w.warehouseId, ["6"]);
    const p = await ok(api.get(`/api/purchases/${purchase.id}`));
    expect(p.status).toBe("PARTIALLY_RECEIVED");
    expect(dec(p.lines[0].receivedQuantity)).toBe("6");
    expect(dec(p.lines[0].pendingQuantity)).toBe("4");
    expect(dec(p.receivedAmount)).toBe("18000");
    expect(dec(p.pendingAmount)).toBe("12000");
    expect(dec((await inventoryDetail(api, levadura)).quantity)).toBe("3");
  });

  it("no se puede recibir más de lo pendiente (5 > 4)", async () => {
    const res = await createReceipt(api, purchase, w.warehouseId, ["5"]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("RECEIPT_EXCEEDS_PENDING");
  });

  it("recibe los 4 restantes: RECEIVED", async () => {
    const receipt = await receive(api, purchase, w.warehouseId, ["4"]);
    expect(dec(receipt.lines[0].previouslyReceivedQuantity)).toBe("6");
    const p = await ok(api.get(`/api/purchases/${purchase.id}`));
    expect(p.status).toBe("RECEIVED");
    expect(dec(p.lines[0].pendingQuantity)).toBe("0");
    expect(p.receipts).toHaveLength(2);
    expect(dec((await inventoryDetail(api, levadura)).quantity)).toBe("5");
  });

  it("otra recepción sobre una compra recibida se rechaza", async () => {
    const res = await createReceipt(api, purchase, w.warehouseId, ["1"]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PURCHASE_NOT_RECEIVABLE");
  });

  it("un borrador que excede lo pendiente al confirmarse se rechaza (lo pendiente se revalida)", async () => {
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: levadura, presentationId: paquete, quantity: "2", unitPrice: "3000" },
    ]);
    const a = await ok(createReceipt(api, p, w.warehouseId, ["2"]), 201);
    const b = await ok(createReceipt(api, p, w.warehouseId, ["1"]), 201);
    await ok(api.post(`/api/purchase-receipts/${a.id}/post`));
    const res = await api.post(`/api/purchase-receipts/${b.id}/post`);
    expect(res.statusCode).toBe(409);
    expect(["RECEIPT_EXCEEDS_PENDING", "PURCHASE_NOT_RECEIVABLE"]).toContain(res.json().error.code);
    expect(dec((await inventoryDetail(api, levadura)).quantity)).toBe("6");
  });
});

describe("idempotencia (§64)", () => {
  it("confirmar dos veces: 409 ALREADY_POSTED, sin segundo movimiento ni auditoría", async () => {
    const aceite = await newMaterial("Aceite girasol", null, "l");
    const bidon = await presentation(api, aceite, "Bidón 5 l", w.units.bidon!, "5", w.units.l!);
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: aceite, presentationId: bidon, quantity: "3", unitPrice: "15000" },
    ]);
    const receipt = await ok(createReceipt(api, p, w.warehouseId, ["3"]), 201);
    await ok(api.post(`/api/purchase-receipts/${receipt.id}/post`));
    const before = await inventoryDetail(api, aceite);
    const movements = await movementCount(aceite);
    const audits = await auditCount("PURCHASE_RECEIPT_POSTED", p.id);
    expect(dec(before.quantity)).toBe("15");

    const res = await api.post(`/api/purchase-receipts/${receipt.id}/post`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ALREADY_POSTED");
    const after = await inventoryDetail(api, aceite);
    expect(after.quantity).toBe(before.quantity);
    expect(after.movingAverageCost).toBe(before.movingAverageCost);
    expect(await movementCount(aceite)).toBe(movements);
    expect(await auditCount("PURCHASE_RECEIPT_POSTED", p.id)).toBe(audits);
    // Una recepción confirmada tampoco se edita ni se descarta.
    expect(
      (await api.patch(`/api/purchase-receipts/${receipt.id}`, { notes: "x" })).statusCode,
    ).toBe(409);
    expect((await api.post(`/api/purchase-receipts/${receipt.id}/cancel`)).statusCode).toBe(409);
  });
});

describe("rollback (§65)", () => {
  it("una falla al auditar la confirmación revierte movimientos, saldos, costo y estados", async () => {
    const cacao = await newMaterial("Cacao");
    await initialStock(api, cacao, w.warehouseId, "10", "4000");
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: cacao, purchaseUnitId: w.units.kg, quantity: "10", unitPrice: "6000" },
    ]);
    const receipt = await ok(createReceipt(api, p, w.warehouseId, ["10"]), 201);
    const movementsBefore = await movementCount(cacao);
    const avgAuditsBefore = await auditCount("MOVING_AVERAGE_COST_CHANGED", cacao);
    // Falla forzada en el ÚLTIMO paso (auditoría de la recepción), después de haber
    // creado el movimiento, actualizado saldo, costo, promedio y estado de la compra.
    await db().execute(sql`
      create or replace function test_fail_receipt() returns trigger language plpgsql as $$
      begin
        if new.action = 'PURCHASE_RECEIPT_POSTED' then raise exception 'falla forzada'; end if;
        return new;
      end $$;
      create trigger test_fail_receipt before insert on audit_logs
        for each row execute function test_fail_receipt();
    `);
    try {
      const res = await api.post(`/api/purchase-receipts/${receipt.id}/post`);
      expect(res.statusCode).toBe(500);
    } finally {
      await db().execute(sql`
        drop trigger test_fail_receipt on audit_logs;
        drop function test_fail_receipt();
      `);
    }
    expect(await movementCount(cacao)).toBe(movementsBefore);
    const [balance] = await db()
      .select()
      .from(stockBalances)
      .where(eq(stockBalances.rawMaterialId, cacao));
    expect(dec(balance!.quantity)).toBe("10");
    const [costRow] = await db()
      .select()
      .from(rawMaterialInventoryCosts)
      .where(eq(rawMaterialInventoryCosts.rawMaterialId, cacao));
    expect(dec(costRow!.movingAverageCost)).toBe("4000");
    expect(dec(costRow!.inventoryValue)).toBe("40000");
    const [purchaseRow] = await db().select().from(purchases).where(eq(purchases.id, p.id));
    expect(purchaseRow!.status).toBe("ORDERED");
    const [receiptRow] = await db()
      .select()
      .from(purchaseReceipts)
      .where(eq(purchaseReceipts.id, receipt.id));
    expect(receiptRow!.status).toBe("DRAFT");
    expect(await auditCount("MOVING_AVERAGE_COST_CHANGED", cacao)).toBe(avgAuditsBefore);
    expect(await auditCount("PURCHASE_RECEIPT_POSTED", p.id)).toBe(0);
    // Sin la falla, la misma recepción se confirma: 20 kg a $5.000.
    await ok(api.post(`/api/purchase-receipts/${receipt.id}/post`));
    expect(dec((await inventoryDetail(api, cacao)).movingAverageCost)).toBe("5000");
  });
});

describe("cancelación (§45)", () => {
  it("una compra pedida sin recepciones se cancela; después no puede recibir", async () => {
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: w.harina, presentationId: w.bolsaHarina, quantity: "1", unitPrice: "30000" },
    ]);
    const draftReceipt = await ok(createReceipt(api, p, w.warehouseId, ["1"]), 201);
    const cancelled = await ok(
      api.post(`/api/purchases/${p.id}/cancel`, { reason: "Error de carga" }),
    );
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelReason).toBe("Error de carga");
    const res = await createReceipt(api, p, w.warehouseId, ["1"]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PURCHASE_NOT_RECEIVABLE");
    // El borrador de recepción quedó descartado y no puede confirmarse.
    const post = await api.post(`/api/purchase-receipts/${draftReceipt.id}/post`);
    expect(post.statusCode).toBe(409);
  });

  it("una compra con mercadería recibida no se cancela", async () => {
    const p = await orderedPurchase(api, w.supplierId, [
      { rawMaterialId: w.harina, presentationId: w.bolsaHarina, quantity: "2", unitPrice: "30000" },
    ]);
    await receive(api, p, w.warehouseId, ["1"]);
    const res = await api.post(`/api/purchases/${p.id}/cancel`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PURCHASE_HAS_RECEIPTS");
    expect((await ok(api.get(`/api/purchases/${p.id}`))).status).toBe("PARTIALLY_RECEIVED");
  });

  it("un borrador se edita completo; una compra pedida sólo notas, fecha esperada y documento", async () => {
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
    const edited = await ok(
      api.patch(`/api/purchases/${draft.id}`, {
        lines: [
          {
            rawMaterialId: w.harina,
            presentationId: w.bolsaHarina,
            quantity: "2",
            unitPrice: "30000",
          },
        ],
      }),
    );
    expect(dec(edited.total)).toBe("60000");
    await ok(api.post(`/api/purchases/${draft.id}/order`));
    const res = await api.patch(`/api/purchases/${draft.id}`, {
      lines: [
        {
          rawMaterialId: w.harina,
          presentationId: w.bolsaHarina,
          quantity: "3",
          unitPrice: "30000",
        },
      ],
    });
    expect(res.statusCode).toBe(409);
    const notes = await ok(
      api.patch(`/api/purchases/${draft.id}`, { notes: "Entregar por la mañana" }),
    );
    expect(notes.notes).toBe("Entregar por la mañana");
    expect((await api.post(`/api/purchases/${draft.id}/order`)).statusCode).toBe(409);
  });

  it("una compra sin líneas no se puede pedir", async () => {
    const draft = await ok(
      api.post("/api/purchases", { supplierId: w.supplierId, purchaseDate: "2026-09-30" }),
      201,
    );
    const res = await api.post(`/api/purchases/${draft.id}/order`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PURCHASE_WITHOUT_LINES");
  });
});

describe("listados (§70)", () => {
  it("compras paginadas y filtradas por estado y materia prima", async () => {
    const open = await ok(api.get("/api/purchases?status=open&pageSize=100"));
    expect(
      open.items.every((p: { status: string }) =>
        ["ORDERED", "PARTIALLY_RECEIVED"].includes(p.status),
      ),
    ).toBe(true);
    const byMaterial = await ok(api.get(`/api/purchases?rawMaterialId=${w.harina}&pageSize=2`));
    expect(byMaterial.items).toHaveLength(2);
    expect(byMaterial.total).toBeGreaterThan(2);
  });

  it("stock por depósito y filtro sin stock", async () => {
    const all = await ok(api.get(`/api/inventory?pageSize=100`));
    const harina = all.items.find((i: { id: string }) => i.id === w.harina);
    expect(harina.warehouse).toBeNull();
    const second = await ok(
      api.get(`/api/inventory?warehouseId=${w.secondWarehouseId}&pageSize=100`),
    );
    expect(second.items.find((i: { id: string }) => i.id === w.harina).quantity).toMatch(/^0/);
    const out = await ok(api.get(`/api/inventory?stockStatus=OUT_OF_STOCK&pageSize=100`));
    expect(out.items.every((i: { status: string }) => i.status === "OUT_OF_STOCK")).toBe(true);
  });

  it("los movimientos no cargan todo el ledger: paginan", async () => {
    const page = await ok(api.get("/api/inventory/movements?pageSize=3"));
    expect(page.items).toHaveLength(3);
    expect(page.total).toBeGreaterThan(3);
    const [all] = await db().select({ n: count() }).from(stockMovements);
    expect(all!.n).toBe(page.total);
  });
});
