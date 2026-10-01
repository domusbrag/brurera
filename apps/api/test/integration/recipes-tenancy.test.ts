import { recipeIngredients, recipeVersions, recipes } from "@bakery/database";
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
import { buildWorld, ingredient, type RecipeWorld } from "./recipe-fixtures.js";

/*
 * Aislamiento de recetas entre Empresa A y Empresa B (§46). La API trata un id
 * de la otra empresa como inexistente (404 al leer o modificar, 422
 * INVALID_REFERENCE como referencia) y la base rechaza la referencia cruzada
 * con sus FKs compuestas (company_id, id) aunque la aplicación fallara.
 */

let ctx: TestContext;
let a: ApiClient;
let b: ApiClient;
let wa: RecipeWorld;
let wb: RecipeWorld;
let recipeA: string;
let versionA: string;

beforeAll(async () => {
  ctx = await createTestContext();
  a = await clientFor(ctx.app, ADMIN);
  b = await clientFor(ctx.app, ADMIN_B);
  wa = await buildWorld(a);
  wb = await buildWorld(b, " B");
  const res = await a.post("/api/recipes", {
    productId: wa.panFrances,
    version: {
      yieldQuantity: "100",
      yieldUnitId: wa.units.kg,
      ingredients: [ingredient(wa.harina, "75", wa.units.kg!)],
    },
  });
  recipeA = res.json().id;
  versionA = res.json().draftVersionId;
});
afterAll(() => ctx.close());

describe("recetas: aislamiento A/B", () => {
  it("una materia prima de B en una receta de A → 422 INVALID_REFERENCE", async () => {
    const res = await a.patch(`/api/recipe-versions/${versionA}`, {
      ingredients: [ingredient(wb.harina, "1", wa.units.kg!)],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: "INVALID_REFERENCE",
      details: [{ path: "ingredients.0.rawMaterialId" }],
    });
    expect(res.body).not.toContain("Harina 000 B");
  });

  it("una unidad de B en un ingrediente o en el rendimiento → 422", async () => {
    const ing = await a.patch(`/api/recipe-versions/${versionA}`, {
      ingredients: [ingredient(wa.harina, "1", wb.units.kg!)],
    });
    expect(ing.statusCode).toBe(422);
    expect(ing.json().error.details[0].path).toBe("ingredients.0.unitId");
    const yieldRes = await a.patch(`/api/recipe-versions/${versionA}`, {
      yieldUnitId: wb.units.kg,
    });
    expect(yieldRes.statusCode).toBe(422);
  });

  it("una receta para un producto de B → 422", async () => {
    const res = await a.post("/api/recipes", {
      productId: wb.prepizza,
      version: { yieldQuantity: "1", yieldUnitId: wa.units.unidad },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("INVALID_REFERENCE");
  });

  it("B no ve ni modifica recetas ni versiones de A (404)", async () => {
    expect((await b.get(`/api/recipes/${recipeA}`)).statusCode).toBe(404);
    expect((await b.get(`/api/recipes/${recipeA}/versions`)).statusCode).toBe(404);
    expect((await b.get(`/api/recipes/${recipeA}/current-cost`)).statusCode).toBe(404);
    expect((await b.get(`/api/recipe-versions/${versionA}`)).statusCode).toBe(404);
    expect((await b.get(`/api/recipe-versions/${versionA}/cost`)).statusCode).toBe(404);
    expect((await b.get(`/api/recipe-versions/${versionA}/diff`)).statusCode).toBe(404);
    expect(
      (await b.patch(`/api/recipe-versions/${versionA}`, { instructions: "x" })).statusCode,
    ).toBe(404);
    expect((await b.post(`/api/recipe-versions/${versionA}/publish`, {})).statusCode).toBe(404);
    expect((await b.post(`/api/recipe-versions/${versionA}/duplicate`)).statusCode).toBe(404);
    expect((await b.post(`/api/recipe-versions/${versionA}/discard`)).statusCode).toBe(404);
    expect((await b.post(`/api/recipes/${recipeA}/deactivate`)).statusCode).toBe(404);
    expect((await b.post(`/api/recipes/${recipeA}/versions`, {})).statusCode).toBe(404);
    expect((await b.get("/api/recipes?status=all")).json().items).toEqual([]);
  });

  it("A no puede copiar una versión de B en su receta", async () => {
    const draftB = (
      await b.post("/api/recipes", {
        productId: wb.panFrances,
        version: { yieldQuantity: "1", yieldUnitId: wb.units.kg },
      })
    ).json().draftVersionId;
    await a.post(`/api/recipe-versions/${versionA}/publish`, {});
    const res = await a.post(`/api/recipes/${recipeA}/versions`, { copyFromVersionId: draftB });
    expect(res.statusCode).toBe(404);
  });

  it("la base rechaza un ingrediente de A que apunte a una materia prima de B", async () => {
    const draft = (await a.post(`/api/recipe-versions/${versionA}/duplicate`)).json().id;
    await expect(
      ctx.database.db.insert(recipeIngredients).values({
        companyId: ctx.companyId,
        recipeVersionId: draft,
        rawMaterialId: wb.sal,
        quantity: "1",
        unitId: wa.units.kg!,
      }),
    ).rejects.toThrow();
  });

  it("la base rechaza una receta de A para un producto de B y una versión con unidad de B", async () => {
    await expect(
      ctx.database.db
        .insert(recipes)
        .values({ companyId: ctx.companyId, productId: wb.medialunas, name: "Cruzada" }),
    ).rejects.toThrow();
    await expect(
      ctx.database.db.insert(recipeVersions).values({
        companyId: ctx.companyId,
        recipeId: recipeA,
        versionNumber: 50,
        yieldQuantity: "1",
        yieldUnitId: wb.units.kg!,
      }),
    ).rejects.toThrow();
    const versions = await ctx.database.db
      .select({ n: recipeVersions.versionNumber })
      .from(recipeVersions)
      .where(eq(recipeVersions.recipeId, recipeA));
    expect(versions.map((v) => v.n)).not.toContain(50);
  });
});
