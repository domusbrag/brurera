import type { ApiClient } from "./helpers.js";
import { ok } from "./inventory-fixtures.js";
import { ingredient, product, rawMaterial, unitIds } from "./recipe-fixtures.js";

/*
 * Datos de partida para producción, creados por la API: materias primas con
 * stock valorizado, Pan francés con receta publicada (100 kg → 75 kg de harina
 * + 0,8 kg de sal) y depósitos.
 */

/** Hoy en la zona horaria por defecto de las empresas de test. */
export const TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
}).format(new Date());

export interface ProductionWorld {
  units: Record<string, string>;
  rawCategoryId: string;
  productCategoryId: string;
  /** Depósito Principal (materias primas y producto terminado). */
  warehouseId: string;
  secondWarehouseId: string;
  harina: string;
  sal: string;
  aceite: string;
  panFrances: string;
  recipeId: string;
  v1: string;
  employeeId: string;
}

export async function buildProductionWorld(api: ApiClient, suffix = ""): Promise<ProductionWorld> {
  const units = await unitIds(api);
  const rawCategoryId = (
    await ok(api.post("/api/categories", { type: "RAW_MATERIAL", name: `Insumos${suffix}` }), 201)
  ).id;
  const productCategoryId = (
    await ok(api.post("/api/categories", { type: "PRODUCT", name: `Panes${suffix}` }), 201)
  ).id;
  const warehouses = (await ok(api.get("/api/warehouses?pageSize=100"))).items as {
    id: string;
    name: string;
  }[];
  const warehouseId = warehouses.find((w) => w.name === "Depósito Principal")!.id;
  const secondWarehouseId = (
    await ok(api.post("/api/warehouses", { name: `Cámara${suffix}` }), 201)
  ).id;
  const harina = await rawMaterial(api, rawCategoryId, `Harina 000${suffix}`, units.kg!, "900");
  const sal = await rawMaterial(api, rawCategoryId, `Sal fina${suffix}`, units.kg!, "400");
  const aceite = await rawMaterial(api, rawCategoryId, `Aceite${suffix}`, units.l!, "2000");
  const panFrances = await product(
    api,
    productCategoryId,
    `Pan francés${suffix}`,
    units.kg!,
    "1500",
  );
  const { recipeId, versionId: v1 } = await publishedRecipe(api, panFrances, units, [
    ingredient(harina, "75", units.kg!),
    ingredient(sal, "0.8", units.kg!),
  ]);
  const employeeId = (
    await ok(api.post("/api/employees", { firstName: "Juana", lastName: `Panadera${suffix}` }), 201)
  ).id;
  return {
    units,
    rawCategoryId,
    productCategoryId,
    warehouseId,
    secondWarehouseId,
    harina,
    sal,
    aceite,
    panFrances,
    recipeId,
    v1,
    employeeId,
  };
}

/** Crea y publica una receta (v1) para el producto: 100 kg de rendimiento. */
export async function publishedRecipe(
  api: ApiClient,
  productId: string,
  units: Record<string, string>,
  ingredients: ReturnType<typeof ingredient>[],
) {
  const recipe = await ok(
    api.post("/api/recipes", {
      productId,
      version: {
        yieldQuantity: "100",
        yieldUnitId: units.kg,
        wastePercentage: "5",
        ingredients,
      },
    }),
    201,
  );
  await ok(api.post(`/api/recipe-versions/${recipe.draftVersionId}/publish`, {}));
  return { recipeId: recipe.id as string, versionId: recipe.draftVersionId as string };
}

/** Publica una versión nueva de la receta con otros ingredientes. */
export async function publishNewVersion(
  api: ApiClient,
  recipeId: string,
  units: Record<string, string>,
  ingredients: ReturnType<typeof ingredient>[],
) {
  const draft = await ok(api.post(`/api/recipes/${recipeId}/versions`, {}), 201);
  const versionId = (draft.id ?? draft.draftVersionId) as string;
  await ok(
    api.patch(`/api/recipe-versions/${versionId}`, {
      yieldQuantity: "100",
      yieldUnitId: units.kg,
      ingredients,
    }),
  );
  await ok(api.post(`/api/recipe-versions/${versionId}/publish`, {}));
  return versionId;
}

export async function stock(
  api: ApiClient,
  w: ProductionWorld,
  rawMaterialId: string,
  quantity: string,
  unitCost: string,
  warehouseId = w.warehouseId,
) {
  // El stock inicial se carga una sola vez por depósito; después, ajuste positivo con costo.
  const res = await api.post("/api/inventory/initial-stock", {
    rawMaterialId,
    warehouseId,
    quantity,
    unitCost,
  });
  if (res.statusCode === 201) return res.json();
  if (res.json().error?.code !== "INITIAL_STOCK_ALREADY_LOADED") {
    throw new Error(`stock: ${res.statusCode} ${res.body}`);
  }
  return ok(
    api.post("/api/inventory/adjustments", {
      rawMaterialId,
      warehouseId,
      quantity,
      unitCost,
      direction: "POSITIVE",
      reason: "DATA_CORRECTION",
    }),
    201,
  );
}

export function createOrder(
  api: ApiClient,
  w: ProductionWorld,
  extra: Record<string, unknown> = {},
) {
  return api.post("/api/production-orders", {
    productId: w.panFrances,
    scheduledFor: TODAY,
    plannedOutputQuantity: "100",
    sourceWarehouseId: w.warehouseId,
    outputWarehouseId: w.warehouseId,
    ...extra,
  });
}

/** Orden creada, planificada e iniciada (IN_PROGRESS). */
export async function startedOrder(
  api: ApiClient,
  w: ProductionWorld,
  extra: Record<string, unknown> = {},
) {
  const order = await ok(createOrder(api, w, extra), 201);
  await ok(api.post(`/api/production-orders/${order.id}/plan`));
  return ok(api.post(`/api/production-orders/${order.id}/start`));
}

type Line = { id: string; rawMaterial: { id: string } };

/** Registra consumos reales (por materia prima, en kg salvo unidad) y la salida real. */
export async function recordActuals(
  api: ApiClient,
  w: ProductionWorld,
  order: { id: string; materials: Line[] },
  consumption: Record<string, string | [string, string]>,
  output: string | [string, string] | null,
) {
  const lines = Object.entries(consumption).map(([rawMaterialId, value]) => {
    const line = order.materials.find((m) => m.rawMaterial.id === rawMaterialId);
    if (!line) throw new Error(`sin línea para ${rawMaterialId}`);
    const [quantity, unit] = Array.isArray(value) ? value : [value, "kg"];
    return { lineId: line.id, quantity, unitId: w.units[unit] };
  });
  const body: Record<string, unknown> = { lines };
  if (output !== null) {
    const [quantity, unit] = Array.isArray(output) ? output : [output, "kg"];
    body.actualOutputQuantity = quantity;
    body.actualOutputUnitId = w.units[unit];
  }
  return ok(api.put(`/api/production-orders/${order.id}/actuals`, body));
}
