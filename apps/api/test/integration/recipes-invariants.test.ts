import { recipeIngredients, recipeVersions, recipes } from "@bakery/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  clientFor,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";
import { buildWorld, ingredient, type RecipeWorld } from "./recipe-fixtures.js";

/*
 * Invariantes 9–11 de Fase 2 (cantidad > 0, rendimiento > 0, merma 0 ≤ x < 100),
 * verificadas en las dos capas: la API las rechaza con 400 y la base, si alguien
 * escribiera directo, con CHECK (SQLSTATE 23514). El resto de las invariantes
 * se cubre en recipes.test.ts, recipes-tenancy.test.ts y los unit tests (ver
 * docs/TESTING.md).
 */

let ctx: TestContext;
let api: ApiClient;
let w: RecipeWorld;
let recipeId: string;
let draftId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
  w = await buildWorld(api);
  const res = await api.post("/api/recipes", {
    productId: w.panFrances,
    version: {
      yieldQuantity: "100",
      yieldUnitId: w.units.kg,
      ingredients: [ingredient(w.harina, "75", w.units.kg!)],
    },
  });
  expect(res.statusCode).toBe(201);
  recipeId = res.json().id;
  draftId = res.json().draftVersionId;
});
afterAll(() => ctx.close());

const version = (overrides: Record<string, unknown>) => ({
  yieldQuantity: "100",
  yieldUnitId: w.units.kg,
  ingredients: [ingredient(w.harina, "75", w.units.kg!)],
  ...overrides,
});

/** Drizzle envuelve el error de PostgreSQL en `cause`. */
async function checkViolation(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e as { cause?: { code?: string } },
  );
  expect(err?.cause?.code).toBe("23514");
}

describe("invariantes de cantidades (API)", () => {
  it.each([
    ["cantidad 0", { ingredients: [ingredient("", "0", "")] }],
    ["cantidad negativa", { ingredients: [ingredient("", "-1", "")] }],
    ["rendimiento 0", { yieldQuantity: "0" }],
    ["rendimiento negativo", { yieldQuantity: "-5" }],
    ["merma 100 %", { wastePercentage: "100" }],
    ["merma negativa", { wastePercentage: "-1" }],
  ])("%s → 400 VALIDATION_ERROR", async (_, overrides) => {
    const patch =
      "ingredients" in overrides
        ? {
            ingredients: overrides.ingredients.map((i) => ({
              ...i,
              rawMaterialId: w.harina,
              unitId: w.units.kg,
            })),
          }
        : overrides;
    const res = await api.patch(`/api/recipe-versions/${draftId}`, version(patch));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("merma 0 y 99,99 % son válidas", async () => {
    for (const wastePercentage of ["0", "99.99"]) {
      const res = await api.patch(`/api/recipe-versions/${draftId}`, version({ wastePercentage }));
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("invariantes de cantidades (base)", () => {
  const db = () => ctx.database.db;

  it("la base rechaza rendimiento ≤ 0 y merma fuera de rango", async () => {
    await checkViolation(
      db().update(recipeVersions).set({ yieldQuantity: "0" }).where(eq(recipeVersions.id, draftId)),
    );
    await checkViolation(
      db()
        .update(recipeVersions)
        .set({ wastePercentage: "100" })
        .where(eq(recipeVersions.id, draftId)),
    );
    await checkViolation(
      db()
        .update(recipeVersions)
        .set({ wastePercentage: "-0.01" })
        .where(eq(recipeVersions.id, draftId)),
    );
  });

  it("la base rechaza cantidades de ingrediente ≤ 0", async () => {
    await checkViolation(
      db()
        .update(recipeIngredients)
        .set({ quantity: "0" })
        .where(eq(recipeIngredients.recipeVersionId, draftId)),
    );
    await checkViolation(
      db().insert(recipeIngredients).values({
        companyId: ctx.companyId,
        recipeVersionId: draftId,
        rawMaterialId: w.sal,
        quantity: "-1",
        unitId: w.units.kg!,
      }),
    );
  });

  it("los datos válidos siguen intactos tras los rechazos", async () => {
    const [recipe] = await db().select().from(recipes).where(eq(recipes.id, recipeId));
    expect(recipe?.active).toBe(true);
    const lines = await db()
      .select()
      .from(recipeIngredients)
      .where(eq(recipeIngredients.recipeVersionId, draftId));
    expect(lines.map((l) => l.quantity)).toEqual(["75.000000"]);
  });
});
