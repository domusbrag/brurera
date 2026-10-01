import { purchaseLines, purchases, stockMovements } from "@bakery/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  ADMIN_B,
  clientFor,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";
import {
  buildPurchasingWorld,
  createReceipt,
  initialStock,
  ok,
  orderedPurchase,
  receive,
  type PurchasingWorld,
} from "./inventory-fixtures.js";

/*
 * Aislamiento de compras e inventario entre Empresa A y Empresa B (§66). La API
 * trata un id de la otra empresa como inexistente (404 al leer, 422 como
 * referencia) y la base rechaza la referencia cruzada con FKs compuestas
 * (company_id, id) aunque la aplicación fallara.
 */

let ctx: TestContext;
let a: ApiClient;
let b: ApiClient;
let wa: PurchasingWorld;
let wb: PurchasingWorld;
let purchaseB: { id: string; lines: { id: string }[] };

beforeAll(async () => {
  ctx = await createTestContext();
  a = await clientFor(ctx.app, ADMIN);
  b = await clientFor(ctx.app, ADMIN_B);
  wa = await buildPurchasingWorld(a);
  wb = await buildPurchasingWorld(b, " B");
  await initialStock(a, wa.harina, wa.warehouseId, "10", "1000");
  await initialStock(b, wb.harina, wb.warehouseId, "20", "2000");
  purchaseB = await orderedPurchase(b, wb.supplierId, [
    { rawMaterialId: wb.harina, presentationId: wb.bolsaHarina, quantity: "2", unitPrice: "1" },
  ]);
  await receive(b, purchaseB, wb.warehouseId, ["1"]);
});
afterAll(() => ctx.close());

const line = (rawMaterialId: string, presentationId: string) => ({
  rawMaterialId,
  presentationId,
  quantity: "1",
  unitPrice: "100",
});

describe("compras: aislamiento A/B", () => {
  it("un proveedor de B en una compra de A → 422", async () => {
    const res = await a.post("/api/purchases", {
      supplierId: wb.supplierId,
      purchaseDate: "2026-09-30",
      lines: [line(wa.harina, wa.bolsaHarina)],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].path).toBe("supplierId");
    expect(res.body).not.toContain("Molino Sur B");
  });

  it("una materia prima de B en una compra de A → 422", async () => {
    const res = await a.post("/api/purchases", {
      supplierId: wa.supplierId,
      purchaseDate: "2026-09-30",
      lines: [line(wb.harina, wb.bolsaHarina)],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].path).toBe("lines.0.rawMaterialId");
  });

  it("una presentación de B sobre una materia prima de A → 422", async () => {
    const res = await a.post("/api/purchases", {
      supplierId: wa.supplierId,
      purchaseDate: "2026-09-30",
      lines: [line(wa.harina, wb.bolsaHarina)],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].path).toBe("lines.0.presentationId");
  });

  it("un depósito de B en una recepción de A → 422", async () => {
    const p = await orderedPurchase(a, wa.supplierId, [line(wa.harina, wa.bolsaHarina)]);
    const res = await createReceipt(a, p, wb.warehouseId, ["1"]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].path).toBe("warehouseId");
  });

  it("una línea de compra de B en una recepción de A → 422", async () => {
    const p = await orderedPurchase(a, wa.supplierId, [line(wa.harina, wa.bolsaHarina)]);
    const res = await a.post(`/api/purchases/${p.id}/receipts`, {
      warehouseId: wa.warehouseId,
      lines: [{ purchaseLineId: purchaseB.lines[0]!.id, quantity: "1" }],
    });
    expect(res.statusCode).toBe(422);
  });

  it("la compra, la recepción y las presentaciones de B no existen para A (404)", async () => {
    expect((await a.get(`/api/purchases/${purchaseB.id}`)).statusCode).toBe(404);
    expect((await a.get(`/api/purchases/${purchaseB.id}/receipts`)).statusCode).toBe(404);
    expect((await a.post(`/api/purchases/${purchaseB.id}/cancel`, {})).statusCode).toBe(404);
    const receiptsB = await ok(b.get(`/api/purchases/${purchaseB.id}/receipts`));
    const receiptB = receiptsB[0].id as string;
    expect((await a.get(`/api/purchase-receipts/${receiptB}`)).statusCode).toBe(404);
    expect((await a.post(`/api/purchase-receipts/${receiptB}/post`)).statusCode).toBe(404);
    expect((await a.get(`/api/raw-materials/${wb.harina}/presentations`)).statusCode).toBe(404);
    expect(
      (await a.patch(`/api/raw-material-presentations/${wb.bolsaHarina}`, { name: "X" }))
        .statusCode,
    ).toBe(404);
    const list = await ok(a.get("/api/purchases?pageSize=100"));
    expect(list.items.map((p: { id: string }) => p.id)).not.toContain(purchaseB.id);
  });
});

describe("inventario: aislamiento A/B", () => {
  it("los movimientos, el stock y los costos de B no se ven desde A", async () => {
    const movements = await ok(a.get("/api/inventory/movements?pageSize=100"));
    expect(
      movements.items.every((m: { rawMaterial: { id: string } }) => m.rawMaterial.id === wa.harina),
    ).toBe(true);
    const filtered = await ok(a.get(`/api/inventory/movements?rawMaterialId=${wb.harina}`));
    expect(filtered.total).toBe(0);
    const stock = await ok(a.get("/api/inventory?pageSize=100"));
    expect(stock.items.map((i: { id: string }) => i.id)).not.toContain(wb.harina);
    expect((await a.get(`/api/inventory/raw-materials/${wb.harina}`)).statusCode).toBe(404);
    expect((await a.get(`/api/inventory/costs/${wb.harina}`)).statusCode).toBe(404);
    const low = await ok(a.get("/api/inventory/low-stock?pageSize=100"));
    expect(low.items.map((i: { id: string }) => i.id)).not.toContain(wb.harina);
  });

  it("stock inicial, ajustes y mermas con materia prima o depósito de B → 422", async () => {
    const cases = [
      [
        "/api/inventory/initial-stock",
        { rawMaterialId: wb.harina, warehouseId: wa.warehouseId, quantity: "1", unitCost: "1" },
      ],
      [
        "/api/inventory/initial-stock",
        { rawMaterialId: wa.harina, warehouseId: wb.warehouseId, quantity: "1", unitCost: "1" },
      ],
      [
        "/api/inventory/adjustments",
        {
          rawMaterialId: wb.harina,
          warehouseId: wa.warehouseId,
          quantity: "1",
          direction: "NEGATIVE",
          reason: "OTHER",
        },
      ],
      [
        "/api/inventory/waste",
        { rawMaterialId: wa.harina, warehouseId: wb.warehouseId, quantity: "1", reason: "OTHER" },
      ],
    ] as const;
    for (const [url, body] of cases) {
      const res = await a.post(url, body);
      expect(res.statusCode, `${url} ${JSON.stringify(body)}`).toBe(422);
    }
    // El stock de B no cambió.
    const detailB = await ok(b.get(`/api/inventory/raw-materials/${wb.harina}`));
    expect(Number(detailB.quantity)).toBe(45);
  });

  it("la base rechaza referencias cruzadas aunque la aplicación fallara (FKs compuestas)", async () => {
    const db = ctx.database.db;
    const code = async (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (e: { cause?: { code?: string } }) => e.cause?.code,
      );
    // Compra de A con proveedor de B.
    expect(
      await code(
        db.insert(purchases).values({
          companyId: ctx.companyId,
          internalNumber: "OC-X",
          supplierId: wb.supplierId,
          purchaseDate: "2026-09-30",
          currencyCode: "ARS",
        }),
      ),
    ).toBe("23503");
    // Línea de compra de B apuntando a una materia prima de A.
    expect(
      await code(
        db
          .update(purchaseLines)
          .set({ rawMaterialId: wa.harina })
          .where(eq(purchaseLines.id, purchaseB.lines[0]!.id)),
      ),
    ).toMatch(/^23(503|001)$/);
    // Movimiento de A en un depósito de B.
    const [m] = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.rawMaterialId, wa.harina))
      .limit(1);
    const { id: _id, sequence: _s, createdAt: _c, sourceLineId: _l, ...copy } = m!;
    expect(
      await code(db.insert(stockMovements).values({ ...copy, warehouseId: wb.warehouseId })),
    ).toBe("23503");
  });
});
