import { D } from "@bakery/domain";
import type { ApiClient } from "./helpers.js";
import { rawMaterial, unitIds } from "./recipe-fixtures.js";

/*
 * Datos de partida para compras e inventario, creados por la API: proveedor,
 * depósitos, materias primas y presentaciones de compra.
 */

/** Decimal normalizado ("1100.000000" → "1100") para comparar sin depender de la escala. */
export const dec = (v: string | null | undefined) =>
  v === null || v === undefined ? v : new D(v).toString();

type Res = Awaited<ReturnType<ApiClient["get"]>>;

/** Espera el status y devuelve el JSON (falla con el cuerpo si no coincide). */
export async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.statusCode !== status) throw new Error(`esperaba ${status}: ${r.statusCode} ${r.body}`);
  return r.json();
}

export interface PurchasingWorld {
  units: Record<string, string>;
  categoryId: string;
  supplierId: string;
  /** Depósito Principal (creado al dar de alta la empresa). */
  warehouseId: string;
  secondWarehouseId: string;
  harina: string;
  /** Bolsa 25 kg de harina. */
  bolsaHarina: string;
}

export async function buildPurchasingWorld(
  api: ApiClient,
  suffix = "",
  harinaReference: string | null = "900",
): Promise<PurchasingWorld> {
  for (const [code, name] of [
    ["paquete", "Paquete"],
    ["bidon", "Bidón"],
  ] as const) {
    const res = await api.post("/api/units", {
      code,
      name,
      symbol: code,
      dimension: "PACKAGING",
      decimals: 0,
    });
    if (res.statusCode !== 201 && res.statusCode !== 409) throw new Error(`unidad: ${res.body}`);
  }
  const units = await unitIds(api);
  const categoryId = (
    await ok(api.post("/api/categories", { type: "RAW_MATERIAL", name: `Secos${suffix}` }), 201)
  ).id;
  const supplierId = (
    await ok(api.post("/api/suppliers", { legalName: `Molino Sur${suffix} S.A.` }), 201)
  ).id;
  const warehouses = (await ok(api.get("/api/warehouses?pageSize=100"))).items as {
    id: string;
    name: string;
  }[];
  const warehouseId = warehouses.find((w) => w.name === "Depósito Principal")!.id;
  const secondWarehouseId = (
    await ok(api.post("/api/warehouses", { name: `Depósito Secundario${suffix}` }), 201)
  ).id;
  const harina = await rawMaterial(
    api,
    categoryId,
    `Harina 000${suffix}`,
    units.kg!,
    harinaReference,
  );
  const bolsaHarina = await presentation(api, harina, "Bolsa 25 kg", units.bolsa!, "25", units.kg!);
  return { units, categoryId, supplierId, warehouseId, secondWarehouseId, harina, bolsaHarina };
}

export async function presentation(
  api: ApiClient,
  rawMaterialId: string,
  name: string,
  purchaseUnitId: string,
  containedQuantity: string,
  containedUnitId: string,
): Promise<string> {
  return (
    await ok(
      api.post(`/api/raw-materials/${rawMaterialId}/presentations`, {
        name,
        purchaseUnitId,
        containedQuantity,
        containedUnitId,
      }),
      201,
    )
  ).id;
}

export interface LineSpec {
  rawMaterialId: string;
  presentationId?: string | null;
  purchaseUnitId?: string | null;
  quantity: string;
  unitPrice: string;
  discountAmount?: string | null;
}

/** Crea una compra en borrador. */
export async function draftPurchase(
  api: ApiClient,
  supplierId: string,
  lines: LineSpec[],
  extra: Record<string, unknown> = {},
) {
  return ok(
    api.post("/api/purchases", {
      supplierId,
      purchaseDate: "2026-09-30",
      lines,
      ...extra,
    }),
    201,
  );
}

/** Crea y confirma (ORDERED) una compra. */
export async function orderedPurchase(api: ApiClient, supplierId: string, lines: LineSpec[]) {
  const draft = await draftPurchase(api, supplierId, lines);
  return ok(api.post(`/api/purchases/${draft.id}/order`));
}

/** Crea una recepción en borrador; `quantities` en el orden de las líneas de la compra. */
export function createReceipt(
  api: ApiClient,
  purchase: { id: string; lines: { id: string }[] },
  warehouseId: string,
  quantities: string[],
) {
  return api.post(`/api/purchases/${purchase.id}/receipts`, {
    warehouseId,
    lines: purchase.lines.map((l, i) => ({ purchaseLineId: l.id, quantity: quantities[i] ?? "0" })),
  });
}

/** Crea y confirma una recepción. */
export async function receive(
  api: ApiClient,
  purchase: { id: string; lines: { id: string }[] },
  warehouseId: string,
  quantities: string[],
) {
  const receipt = await ok(createReceipt(api, purchase, warehouseId, quantities), 201);
  return ok(api.post(`/api/purchase-receipts/${receipt.id}/post`));
}

export async function initialStock(
  api: ApiClient,
  rawMaterialId: string,
  warehouseId: string,
  quantity: string,
  unitCost: string,
) {
  return ok(
    api.post("/api/inventory/initial-stock", { rawMaterialId, warehouseId, quantity, unitCost }),
    201,
  );
}

export const inventoryDetail = (api: ApiClient, rawMaterialId: string) =>
  ok(api.get(`/api/inventory/raw-materials/${rawMaterialId}`));
