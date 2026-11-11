import { categories, products, rawMaterials, recipes } from "@bakery/database";
import { PERMISSIONS as P, productSetupSchema } from "@bakery/shared";
import { and, count, eq, ilike } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  clientFor,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";
import { ok } from "./inventory-fixtures.js";
import { rawMaterial, unitIds } from "./recipe-fixtures.js";
import { priceList } from "./sale-fixtures.js";
import { requiredPermissions } from "../../src/modules/product-setup/product-setup.service.js";

/*
 * Alta de producto de corrido: categoría + insumos nuevos + producto + receta
 * publicada + precio en listas, en una sola operación atómica.
 */

let ctx: TestContext;
let api: ApiClient;
let units: Record<string, string>;
let mpCategory: string;
let harina: string;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
  units = await unitIds(api);
  mpCategory = (
    await ok(api.post("/api/categories", { type: "RAW_MATERIAL", name: "Harinas PS" }), 201)
  ).id;
  harina = await rawMaterial(api, mpCategory, "Harina 000 PS", units.kg!, "800");
});
afterAll(() => ctx.close());

const db = () => ctx.database.db;

async function countWhere(table: typeof products | typeof rawMaterials, name: string) {
  const [row] = await db().select({ n: count() }).from(table).where(ilike(table.name, name));
  return row!.n;
}

describe("alta de producto de corrido", () => {
  it("crea categoría, insumo nuevo, producto, receta vigente y precio en lista en un paso", async () => {
    const list = await priceList(api, "Mayoristas PS", {});
    const res = await ok(
      api.post("/api/product-setup", {
        product: {
          name: "Pan de campo PS",
          newCategoryName: "Panes PS",
          saleUnitId: units.unidad,
          salePrice: "1500",
        },
        newMaterials: [
          {
            ref: "m1",
            name: "Masa madre PS",
            baseUnitId: units.kg,
            newCategoryName: "Fermentos PS",
            referenceCost: "300",
          },
        ],
        recipe: {
          yieldQuantity: "10",
          yieldUnitId: units.unidad,
          ingredients: [
            { rawMaterialId: harina, quantity: "5", unitId: units.kg },
            { newMaterialRef: "m1", quantity: "1000", unitId: units.g },
          ],
        },
        prices: [{ priceListId: list.id, unitPrice: "1300" }],
      }),
      201,
    );
    expect(res.product.code).toMatch(/^PROD-\d{4}$/);
    expect(res.category).toMatchObject({ name: "Panes PS", created: true });
    expect(res.newMaterials).toHaveLength(1);
    expect(res.recipe).toMatchObject({ published: true, costStatus: "COMPLETE" });

    // Receta vigente con costo: (5 kg × 800 + 1 kg × 300) / 10 = 430 por unidad.
    const cost = await ok(api.get(`/api/recipes/${res.recipe.id}/current-cost`));
    expect(Number(cost.current.unitCost)).toBe(430);

    // El precio de la lista se aplica y el producto ya se puede vender.
    const detail = await ok(api.get(`/api/price-lists/${list.id}`));
    const item = detail.items.find(
      (i: { product: { id: string } }) => i.product.id === res.product.id,
    );
    expect(Number(item.unitPrice)).toBe(1300);

    // El insumo nuevo quedó con su costo y su categoría nueva.
    const mp = await ok(api.get(`/api/raw-materials/${res.newMaterials[0].id}`));
    expect(mp.category.name).toBe("Fermentos PS");
    expect(Number(mp.referenceCost)).toBe(300);
  });

  it("reutiliza una categoría existente escrita con otras mayúsculas", async () => {
    const res = await ok(
      api.post("/api/product-setup", {
        product: {
          name: "Pan integral PS",
          newCategoryName: "  panes   ps ",
          saleUnitId: units.unidad,
          salePrice: "1600",
        },
      }),
      201,
    );
    expect(res.category).toMatchObject({ name: "Panes PS", created: false });
    expect(res.recipe).toBeNull();
    const [row] = await db()
      .select({ n: count() })
      .from(categories)
      .where(and(eq(categories.companyId, ctx.companyId), ilike(categories.name, "panes ps")));
    expect(row!.n).toBe(1);
  });

  it("si algo falla no queda nada a medias (ni categoría, ni insumo, ni producto)", async () => {
    const res = await api.post("/api/product-setup", {
      product: {
        name: "Bizcochitos PS",
        newCategoryName: "Galletería PS",
        saleUnitId: units.kg,
        salePrice: "5000",
      },
      newMaterials: [{ ref: "g", name: "Grasa PS", baseUnitId: units.kg, categoryId: mpCategory }],
      recipe: {
        yieldQuantity: "10",
        yieldUnitId: units.kg,
        // Litros para un insumo en kg: unidad incompatible, lo rechaza la receta.
        ingredients: [{ newMaterialRef: "g", quantity: "1", unitId: units.l }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(Object.keys(res.json().error.details ?? {}).length).toBeGreaterThan(0);
    expect(await countWhere(products, "Bizcochitos PS")).toBe(0);
    expect(await countWhere(rawMaterials, "Grasa PS")).toBe(0);
    const [cat] = await db()
      .select({ n: count() })
      .from(categories)
      .where(ilike(categories.name, "Galletería PS"));
    expect(cat!.n).toBe(0);
  });

  it("con costo incompleto exige confirmar para publicar; sin publicar queda en borrador", async () => {
    const base = {
      product: {
        name: "Prepizza PS",
        newCategoryName: "Panes PS",
        saleUnitId: units.unidad,
        salePrice: "900",
      },
      newMaterials: [{ ref: "s", name: "Salsa PS", baseUnitId: units.kg, categoryId: mpCategory }],
      recipe: {
        yieldQuantity: "20",
        yieldUnitId: units.unidad,
        ingredients: [
          { rawMaterialId: harina, quantity: "4", unitId: units.kg },
          { newMaterialRef: "s", quantity: "2", unitId: units.kg },
        ],
      },
    };
    const refused = await api.post("/api/product-setup", base);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("COST_INCOMPLETE_CONFIRMATION_REQUIRED");
    expect(await countWhere(products, "Prepizza PS")).toBe(0);

    const draft = await ok(
      api.post("/api/product-setup", { ...base, recipe: { ...base.recipe, publish: false } }),
      201,
    );
    expect(draft.recipe).toMatchObject({ published: false, costStatus: null });
    const recipe = await ok(api.get(`/api/recipes/${draft.recipe.id}`));
    expect(recipe.activeVersionId).toBeNull();
    expect(recipe.draftVersionId).toBe(draft.recipe.versionId);
    const [r] = await db()
      .select({ n: count() })
      .from(recipes)
      .where(eq(recipes.productId, draft.product.id));
    expect(r!.n).toBe(1);
  });

  it("carga en el momento el costo de un insumo existente que no tenía", async () => {
    const levadura = await rawMaterial(api, mpCategory, "Levadura PS", units.kg!, null);
    const res = await ok(
      api.post("/api/product-setup", {
        product: {
          name: "Pan francés PS",
          newCategoryName: "Panes PS",
          saleUnitId: units.kg,
          salePrice: "2000",
        },
        materialCosts: [{ rawMaterialId: levadura, referenceCost: "4000" }],
        recipe: {
          yieldQuantity: "10",
          yieldUnitId: units.kg,
          ingredients: [
            { rawMaterialId: harina, quantity: "8", unitId: units.kg },
            { rawMaterialId: levadura, quantity: "100", unitId: units.g },
          ],
        },
      }),
      201,
    );
    expect(res.recipe).toMatchObject({ published: true, costStatus: "COMPLETE" });
    const mp = await ok(api.get(`/api/raw-materials/${levadura}`));
    expect(Number(mp.referenceCost)).toBe(4000);
    // (8 × 800 + 0,1 × 4000) / 10 = 680 por kg.
    const cost = await ok(api.get(`/api/recipes/${res.recipe.id}/current-cost`));
    expect(Number(cost.current.unitCost)).toBe(680);
  });

  it("valida que cada ingrediente apunte a un insumo", async () => {
    const res = await api.post("/api/product-setup", {
      product: {
        name: "Roñosas PS",
        categoryId: null,
        newCategoryName: "Panes PS",
        saleUnitId: units.unidad,
        salePrice: "100",
      },
      recipe: {
        yieldQuantity: "1",
        yieldUnitId: units.unidad,
        ingredients: [{ newMaterialRef: "no-existe", quantity: "1", unitId: units.kg }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(await countWhere(products, "Roñosas PS")).toBe(0);
  });
});

describe("permisos del alta de corrido", () => {
  const parse = (body: unknown) => productSetupSchema.parse(body);
  const minimal = {
    product: {
      name: "X",
      categoryId: "00000000-0000-4000-8000-000000000000",
      saleUnitId: "00000000-0000-4000-8000-000000000001",
      salePrice: "1",
    },
  };

  it("un alta simple no pide nada más que products.create", () => {
    expect(requiredPermissions(parse(minimal))).toEqual([]);
  });

  it("cada parte pide su permiso", () => {
    const needed = requiredPermissions(
      parse({
        product: { ...minimal.product, categoryId: null, newCategoryName: "Nueva" },
        newMaterials: [
          {
            ref: "a",
            name: "A",
            baseUnitId: minimal.product.saleUnitId,
            categoryId: minimal.product.categoryId,
            referenceCost: "1",
          },
        ],
        recipe: {
          yieldQuantity: "1",
          yieldUnitId: minimal.product.saleUnitId,
          ingredients: [{ newMaterialRef: "a", quantity: "1", unitId: minimal.product.saleUnitId }],
        },
        prices: [{ priceListId: minimal.product.categoryId, unitPrice: "1" }],
      }),
    );
    expect(new Set(needed)).toEqual(
      new Set([
        P.CATEGORIES_MANAGE,
        P.RAW_MATERIALS_CREATE,
        P.RAW_MATERIALS_UPDATE_COST,
        P.RECIPES_CREATE,
        P.RECIPES_PUBLISH,
        P.PRICE_LISTS_MANAGE,
      ]),
    );
  });
});
