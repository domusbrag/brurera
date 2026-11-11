import { purchaseReceipts } from "@bakery/database";
import { count, eq } from "drizzle-orm";
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
  dec,
  initialStock,
  inventoryDetail,
  ok,
  orderedPurchase,
  receive,
  type PurchasingWorld,
} from "./inventory-fixtures.js";
import { buildOrderWorld, confirmedOrder, draft, type OrderWorld } from "./order-fixtures.js";
import { rawMaterial } from "./recipe-fixtures.js";
import { produce } from "./lot-fixtures.js";
import { accountOf, advance, postedSale } from "./sale-fixtures.js";
import { randomUUID } from "node:crypto";

/*
 * Revisión integral (mejoras de control sobre lo ya construido):
 * - "En camino": lo pedido a proveedores y no recibido se descuenta de lo que falta pedir.
 * - Recepción en un paso: crear + confirmar atómico, sin borradores huérfanos si falla.
 * - Seña sólo sobre un pedido confirmado.
 */

let ctx: TestContext;
let api: ApiClient;
let pw: PurchasingWorld;
let ow: OrderWorld;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
  pw = await buildPurchasingWorld(api, " CI");
  ow = await buildOrderWorld(api, " CI");
});
afterAll(() => ctx.close());

const db = () => ctx.database.db;

async function receiptCount(purchaseId: string) {
  const [row] = await db()
    .select({ n: count() })
    .from(purchaseReceipts)
    .where(eq(purchaseReceipts.purchaseId, purchaseId));
  return row!.n;
}

describe("stock bajo mínimo: en camino y falta pedir", () => {
  let malta: string;
  let purchase: { id: string; lines: { id: string }[] };

  const lowStockRow = async () => {
    const page = await ok(api.get("/api/inventory/low-stock?pageSize=100"));
    return page.items.find((i: { id: string }) => i.id === malta);
  };

  beforeAll(async () => {
    malta = await rawMaterial(api, pw.categoryId, "Malta", pw.units.kg!, null);
    await ok(api.patch(`/api/raw-materials/${malta}`, { minimumStock: "100" }));
    await initialStock(api, malta, pw.warehouseId, "30", "500");
  });

  it("sin compras pedidas: falta pedir = faltante (70 kg)", async () => {
    const row = await lowStockRow();
    expect(dec(row.shortage)).toBe("70");
    expect(dec(row.onOrder)).toBe("0");
    expect(dec(row.toOrder)).toBe("70");
  });

  it("un borrador no cuenta como en camino; una compra pedida de 50 kg sí", async () => {
    await ok(
      api.post("/api/purchases", {
        supplierId: pw.supplierId,
        purchaseDate: "2026-09-30",
        lines: [
          { rawMaterialId: malta, purchaseUnitId: pw.units.kg, quantity: "40", unitPrice: "500" },
        ],
      }),
      201,
    );
    expect(dec((await lowStockRow()).onOrder)).toBe("0");
    purchase = await orderedPurchase(api, pw.supplierId, [
      { rawMaterialId: malta, purchaseUnitId: pw.units.kg, quantity: "50", unitPrice: "500" },
    ]);
    const row = await lowStockRow();
    expect(dec(row.onOrder)).toBe("50");
    expect(dec(row.toOrder)).toBe("20");
  });

  it("al recibir una parte, lo recibido sale de en camino y entra al stock", async () => {
    await receive(api, purchase, pw.warehouseId, ["20"]);
    const row = await lowStockRow();
    expect(dec(row.quantity)).toBe("50");
    expect(dec(row.shortage)).toBe("50");
    expect(dec(row.onOrder)).toBe("30");
    expect(dec(row.toOrder)).toBe("20");
  });

  it("nunca es negativo: con más en camino que faltante, falta pedir = 0", async () => {
    await orderedPurchase(api, pw.supplierId, [
      { rawMaterialId: malta, purchaseUnitId: pw.units.kg, quantity: "100", unitPrice: "500" },
    ]);
    const row = await lowStockRow();
    expect(dec(row.onOrder)).toBe("130");
    expect(dec(row.toOrder)).toBe("0");
  });
});

describe("recepción en un paso", () => {
  let cebada: string;

  beforeAll(async () => {
    cebada = await rawMaterial(api, pw.categoryId, "Cebada", pw.units.kg!, null);
  });

  it("crea y confirma la recepción en una sola llamada", async () => {
    const p = await orderedPurchase(api, pw.supplierId, [
      { rawMaterialId: cebada, purchaseUnitId: pw.units.kg, quantity: "10", unitPrice: "800" },
    ]);
    const receipt = await ok(
      api.post(`/api/purchases/${p.id}/receipts/posted`, {
        warehouseId: pw.warehouseId,
        lines: [{ purchaseLineId: p.lines[0].id, quantity: "10" }],
      }),
      201,
    );
    expect(receipt.status).toBe("POSTED");
    expect((await ok(api.get(`/api/purchases/${p.id}`))).status).toBe("RECEIVED");
    expect(dec((await inventoryDetail(api, cebada)).quantity)).toBe("10");
  });

  it("si falla no deja ningún borrador (ni cancelado) ni stock", async () => {
    const p = await orderedPurchase(api, pw.supplierId, [
      { rawMaterialId: cebada, purchaseUnitId: pw.units.kg, quantity: "5", unitPrice: "800" },
    ]);
    const res = await api.post(`/api/purchases/${p.id}/receipts/posted`, {
      warehouseId: pw.warehouseId,
      lines: [{ purchaseLineId: p.lines[0].id, quantity: "6" }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("RECEIPT_EXCEEDS_PENDING");
    expect(await receiptCount(p.id)).toBe(0);
    expect(dec((await inventoryDetail(api, cebada)).quantity)).toBe("10");
  });
});

describe("necesidades de materia prima: en camino", () => {
  it("lo pedido al proveedor se descuenta de lo que falta pedir para los pedidos", async () => {
    // 100 kg de pan francés sin stock → 75 kg de harina, sin harina en stock.
    await confirmedOrder(api, ow, [{ productId: ow.panFrances, quantity: "100" }]);
    const before = await ok(api.get("/api/planning/material-demand"));
    const harina = before.items.find(
      (m: { rawMaterial: { id: string } }) => m.rawMaterial.id === ow.harina,
    );
    const shortage = dec(harina.shortage)!;
    expect(dec(harina.toOrder)).toBe(shortage);

    await orderedPurchase(api, pw.supplierId, [
      { rawMaterialId: ow.harina, purchaseUnitId: ow.units.kg, quantity: "30", unitPrice: "900" },
    ]);
    const after = await ok(api.get("/api/planning/material-demand"));
    const row = after.items.find(
      (m: { rawMaterial: { id: string } }) => m.rawMaterial.id === ow.harina,
    );
    expect(dec(row.shortage)).toBe(shortage);
    expect(dec(row.onOrder)).toBe("30");
    expect(dec(row.toOrder)).toBe(String(Math.max(Number(shortage) - 30, 0)));
  });
});

describe("seña", () => {
  it("un pedido en borrador no admite seña ni la ofrece", async () => {
    const order = await ok(draft(api, ow, [{ productId: ow.panFrances, quantity: "5" }]), 201);
    expect(order.actions.canRegisterAdvance).toBe(false);
    const res = await advance(api, order.id, "1000");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ORDER_NOT_CONFIRMED");
  });

  it("confirmado sí admite seña", async () => {
    const order = await confirmedOrder(api, ow, [{ productId: ow.panFrances, quantity: "5" }]);
    expect(order.actions.canRegisterAdvance).toBe(true);
    expect((await advance(api, order.id, "1000")).statusCode).toBe(201);
  });
});

describe("imputar el crédito a las ventas más viejas", () => {
  let customerId: string;
  let older: { id: string; amounts: { total: string } };
  let newer: { id: string; amounts: { total: string } };

  beforeAll(async () => {
    customerId = (
      await ok(api.post("/api/customers", { type: "RETAILER", legalName: "Bar FIFO" }), 201)
    ).id;
    await produce(api, ow, "50");
    older = await postedSale(api, ow, [{ productId: ow.panFrances, quantity: "2" }], {
      customerId,
    });
    newer = await postedSale(api, ow, [{ productId: ow.panFrances, quantity: "3" }], {
      customerId,
    });
  });

  it("aplica el cobro a cuenta a la venta más vieja primero, sin cambiar el saldo", async () => {
    const t1 = Number(older.amounts.total);
    const t2 = Number(newer.amounts.total);
    const paid = (t1 + t2 / 2).toFixed(2);
    await ok(
      api.post(`/api/customers/${customerId}/payments`, {
        amount: paid,
        paymentMethod: "CASH",
        operationId: randomUUID(),
      }),
      201,
    );
    const before = await accountOf(api, customerId);
    const operationId = randomUUID();
    const res = await ok(
      api.post(`/api/customers/${customerId}/account/apply-oldest`, { operationId }),
      201,
    );
    expect(res.replayed).toBe(false);
    expect(res.applications).toHaveLength(2);
    const a = await ok(api.get(`/api/sales/${older.id}`));
    const b = await ok(api.get(`/api/sales/${newer.id}`));
    expect(a.paymentStatus).toBe("PAID");
    expect(b.paymentStatus).toBe("PARTIALLY_PAID");
    expect(Number(b.amounts.paid)).toBeCloseTo(t2 / 2, 2);
    const after = await accountOf(api, customerId);
    expect(dec(after.balance)).toBe(dec(before.balance));
    expect(after.unappliedPayments).toHaveLength(0);

    const replay = await ok(
      api.post(`/api/customers/${customerId}/account/apply-oldest`, { operationId }),
    );
    expect(replay).toMatchObject({ replayed: true, applications: [] });
  });

  it("resumen de cuentas a cobrar: total adeudado y deudores", async () => {
    const summary = await ok(api.get("/api/customer-accounts/summary"));
    const list = await ok(api.get("/api/customer-accounts?balance=debt&pageSize=100"));
    const sum = list.items.reduce(
      (s: number, r: { balanceAmount: string }) => s + Number(r.balanceAmount),
      0,
    );
    expect(summary.debtors).toBe(list.total);
    expect(Number(summary.totalDebt)).toBeCloseTo(sum, 2);
    expect(summary.oldestPendingSaleDate).not.toBeNull();
  });

  it("sin crédito sin imputar no hace nada", async () => {
    const res = await ok(
      api.post(`/api/customers/${customerId}/account/apply-oldest`, { operationId: randomUUID() }),
      201,
    );
    expect(res.applications).toHaveLength(0);
  });
});
