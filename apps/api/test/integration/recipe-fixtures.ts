import type { ApiClient } from "./helpers.js";

/*
 * Datos de partida para los tests de recetas, creados por la API (como lo haría
 * un usuario): categorías, materias primas con y sin costo, y productos.
 */

export interface RecipeWorld {
  units: Record<string, string>;
  harina: string;
  sal: string;
  levadura: string;
  agua: string;
  envase: string;
  panFrances: string;
  prepizza: string;
  medialunas: string;
}

export async function unitIds(api: ApiClient): Promise<Record<string, string>> {
  const items: { id: string; code: string }[] = (await api.get("/api/units?pageSize=100")).json()
    .items;
  return Object.fromEntries(items.map((u) => [u.code, u.id]));
}

async function created(
  res: Promise<{ statusCode: number; body: string; json: () => { id: string } }>,
) {
  const r = await res;
  if (r.statusCode !== 201) throw new Error(`fixture: ${r.statusCode} ${r.body}`);
  return r.json().id;
}

export async function rawMaterial(
  api: ApiClient,
  categoryId: string,
  name: string,
  baseUnitId: string,
  referenceCost: string | null,
): Promise<string> {
  return created(api.post("/api/raw-materials", { name, categoryId, baseUnitId, referenceCost }));
}

export async function product(
  api: ApiClient,
  categoryId: string,
  name: string,
  saleUnitId: string,
  salePrice: string,
): Promise<string> {
  return created(api.post("/api/products", { name, categoryId, saleUnitId, salePrice }));
}

export async function buildWorld(api: ApiClient, suffix = ""): Promise<RecipeWorld> {
  const units = await unitIds(api);
  const mp = await created(
    api.post("/api/categories", { type: "RAW_MATERIAL", name: `Insumos${suffix}` }),
  );
  const pr = await created(
    api.post("/api/categories", { type: "PRODUCT", name: `Panes${suffix}` }),
  );
  return {
    units,
    harina: await rawMaterial(api, mp, `Harina 000${suffix}`, units.kg!, "800"),
    sal: await rawMaterial(api, mp, `Sal${suffix}`, units.kg!, "500"),
    levadura: await rawMaterial(api, mp, `Levadura fresca${suffix}`, units.kg!, null),
    agua: await rawMaterial(api, mp, `Agua${suffix}`, units.l!, "2"),
    envase: await rawMaterial(api, mp, `Bolsa papel${suffix}`, units.bolsa!, "30"),
    panFrances: await product(api, pr, `Pan francés${suffix}`, units.kg!, "1200"),
    prepizza: await product(api, pr, `Prepizza${suffix}`, units.unidad!, "900"),
    medialunas: await product(api, pr, `Medialunas${suffix}`, units.unidad!, "350"),
  };
}

export const ingredient = (rawMaterialId: string, quantity: string, unitId: string) => ({
  rawMaterialId,
  quantity,
  unitId,
});
