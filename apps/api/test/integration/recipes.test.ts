import {
  auditLogs,
  permissions,
  recipeCostSnapshotLines,
  recipeCostSnapshots,
  recipeIngredients,
  recipeVersions,
  rolePermissions,
  roles,
} from "@bakery/database";
import { PERMISSIONS as P } from "@bakery/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  clientFor,
  createMember,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";
import { buildWorld, ingredient, type RecipeWorld } from "./recipe-fixtures.js";

/*
 * Recetas versionadas y costo teórico contra la API real y PostgreSQL:
 * publicación con snapshot, versionado, rollback, inmutabilidad (API y base),
 * unidades, costo incompleto y permisos de Producción.
 */

let ctx: TestContext;
let api: ApiClient;
let w: RecipeWorld;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
  w = await buildWorld(api);
});
afterAll(() => ctx.close());

async function recipeAudit(recipeId: string): Promise<string[]> {
  const rows = await ctx.database.db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "recipe"), eq(auditLogs.entityId, recipeId)))
    .orderBy(auditLogs.id);
  return rows.map((r) => r.action);
}

async function createRecipe(productId: string, version: Record<string, unknown>) {
  const res = await api.post("/api/recipes", { productId, version });
  if (res.statusCode !== 201) throw new Error(`receta: ${res.statusCode} ${res.body}`);
  return res.json() as { id: string; draftVersionId: string; versions: { id: string }[] };
}

const cost = async (versionId: string) =>
  (await api.get(`/api/recipe-versions/${versionId}/cost`)).json();

describe("integración — publicación (§43)", () => {
  let recipeId: string;
  let v1: string;

  it("crea Pan francés v1 DRAFT: 100 kg con 75 kg de harina", async () => {
    const recipe = await createRecipe(w.panFrances, {
      yieldQuantity: "100",
      yieldUnitId: w.units.kg,
      wastePercentage: "10",
      instructions: "Amasar, fermentar y hornear.",
      ingredients: [ingredient(w.harina, "75", w.units.kg!)],
    });
    recipeId = recipe.id;
    v1 = recipe.draftVersionId;
    const version = (await api.get(`/api/recipe-versions/${v1}`)).json();
    expect(version).toMatchObject({ versionNumber: 1, status: "DRAFT", snapshot: null });
    expect(version.ingredients).toHaveLength(1);
    expect(version).not.toHaveProperty("companyId");
  });

  it("el borrador ya muestra costo teórico: $60.000 el lote, $600/kg", async () => {
    const { current, snapshot } = await cost(v1);
    expect(snapshot).toBeNull();
    expect(current).toMatchObject({
      status: "COMPLETE",
      currency: "ARS",
      totalCost: "60000.000000",
      unitCost: "600.000000",
      normalizedYield: "100.0000000000",
    });
    expect(current.grossMargin).toMatchObject({ amount: "600.000000", percentage: "50.0000" });
  });

  it("publica: v1 ACTIVE con snapshot de 60.000 y 600/kg", async () => {
    const res = await api.post(`/api/recipe-versions/${v1}/publish`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ACTIVE", versionNumber: 1 });
    expect(res.json().publishedBy.displayName).toBe("Admin Test");
    const { snapshot } = await cost(v1);
    expect(snapshot).toMatchObject({
      status: "COMPLETE",
      currency: "ARS",
      totalCost: "60000.000000",
      unitCost: "600.000000",
      salePrice: "1200.000000",
      saleUnit: { code: "kg" },
    });
    expect(snapshot.lines).toEqual([
      expect.objectContaining({
        rawMaterialName: "Harina 000",
        quantity: "75.000000",
        unit: { code: "kg", symbol: "kg" },
        normalizedQuantity: "75.0000000000",
        referenceCost: "800.000000",
        costSource: "MANUAL_REFERENCE",
        ingredientCost: "60000.000000",
      }),
    ]);
  });

  it("cambiar la harina a $1.000/kg no toca el snapshot; el costo actual pasa a $750/kg (+25%)", async () => {
    const res = await api.put(`/api/raw-materials/${w.harina}/reference-cost`, {
      referenceCost: "1000",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ referenceCost: "1000.000000" });
    const result = await cost(v1);
    expect(result.snapshot).toMatchObject({ unitCost: "600.000000", totalCost: "60000.000000" });
    expect(result.snapshot.lines[0].referenceCost).toBe("800.000000");
    expect(result.current).toMatchObject({ unitCost: "750.000000", totalCost: "75000.000000" });
    expect(result.unitCostVariation).toEqual({ amount: "150.000000", percentage: "25.0000" });
    const current = (await api.get(`/api/recipes/${recipeId}/current-cost`)).json();
    expect(current.current.unitCost).toBe("750.000000");
  });

  it("el cambio de costo queda auditado con valor anterior y nuevo", async () => {
    const [row] = await ctx.database.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, w.harina),
          eq(auditLogs.action, "RAW_MATERIAL_REFERENCE_COST_CHANGED"),
        ),
      );
    expect(row?.metadata).toMatchObject({
      perUnit: "kg",
      currency: "ARS",
      source: "MANUAL_REFERENCE",
      changes: { referenceCost: { from: "800.000000", to: "1000.000000" } },
    });
  });

  describe("versionado (§44)", () => {
    let v2: string;

    it("duplicar v1 crea v2 DRAFT con ids nuevos y sin snapshot", async () => {
      const res = await api.post(`/api/recipe-versions/${v1}/duplicate`, {});
      expect(res.statusCode).toBe(201);
      const copy = res.json();
      v2 = copy.id;
      expect(copy).toMatchObject({
        versionNumber: 2,
        status: "DRAFT",
        yieldQuantity: "100.000000",
        wastePercentage: "10.0000",
        instructions: "Amasar, fermentar y hornear.",
        snapshot: null,
      });
      const original = (await api.get(`/api/recipe-versions/${v1}`)).json();
      expect(copy.ingredients.map((i: { id: string }) => i.id)).not.toContain(
        original.ingredients[0].id,
      );
      expect(copy.ingredients[0]).toMatchObject({ quantity: "75.000000" });
    });

    it("sólo un borrador por receta", async () => {
      const res = await api.post(`/api/recipes/${recipeId}/versions`, {});
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("DRAFT_ALREADY_EXISTS");
    });

    it("se edita el borrador (80 kg de harina + 1,6 kg de sal en gramos)", async () => {
      const res = await api.patch(`/api/recipe-versions/${v2}`, {
        ingredients: [
          ingredient(w.harina, "80", w.units.kg!),
          ingredient(w.sal, "1600", w.units.g!),
        ],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("DRAFT");
      expect(res.json().ingredients).toHaveLength(2);
      const { current } = await cost(v2);
      // 80 × 1000 + 1,6 × 500 = 80.800 → 808/kg
      expect(current).toMatchObject({ totalCost: "80800.000000", unitCost: "808.000000" });
    });

    it("el diff de v2 contra v1 muestra la harina modificada y la sal agregada", async () => {
      const diff = (await api.get(`/api/recipe-versions/${v2}/diff`)).json();
      expect(diff.from.versionNumber).toBe(1);
      expect(diff.added.map((i: { rawMaterialName: string }) => i.rawMaterialName)).toEqual([
        "Sal",
      ]);
      expect(diff.changed).toEqual([
        expect.objectContaining({
          rawMaterialName: "Harina 000",
          from: expect.objectContaining({ quantity: "75" }),
          to: expect.objectContaining({ quantity: "80" }),
        }),
      ]);
      expect(diff.removed).toEqual([]);
      expect(diff.yield).toBeNull();
    });

    it("publicar v2 archiva v1; v1 queda intacta; una sola ACTIVE", async () => {
      const before = (await api.get(`/api/recipe-versions/${v1}`)).json();
      const res = await api.post(`/api/recipe-versions/${v2}/publish`, {});
      expect(res.statusCode).toBe(200);
      const after = (await api.get(`/api/recipe-versions/${v1}`)).json();
      expect(after.status).toBe("ARCHIVED");
      expect(after.archivedAt).not.toBeNull();
      expect(after.ingredients).toEqual(before.ingredients);
      expect(after.yieldQuantity).toBe(before.yieldQuantity);
      expect((await cost(v1)).snapshot.unitCost).toBe("600.000000");
      const active = await ctx.database.db
        .select({ id: recipeVersions.id })
        .from(recipeVersions)
        .where(and(eq(recipeVersions.recipeId, recipeId), eq(recipeVersions.status, "ACTIVE")));
      expect(active).toEqual([{ id: v2 }]);
      const recipe = (await api.get(`/api/recipes/${recipeId}`)).json();
      expect(recipe.activeVersionId).toBe(v2);
      expect(
        recipe.versions.map((v: { versionNumber: number; status: string }) => [
          v.versionNumber,
          v.status,
        ]),
      ).toEqual([
        [2, "ACTIVE"],
        [1, "ARCHIVED"],
      ]);
    });

    it("auditoría completa de la receta", async () => {
      expect(await recipeAudit(recipeId)).toEqual([
        "RECIPE_CREATED",
        "RECIPE_VERSION_CREATED",
        "RECIPE_VERSION_PUBLISHED",
        "RECIPE_VERSION_CREATED",
        "RECIPE_VERSION_UPDATED",
        "RECIPE_VERSION_ARCHIVED",
        "RECIPE_VERSION_PUBLISHED",
      ]);
    });

    it("versión vigente en un momento dado", async () => {
      const versions = (await api.get(`/api/recipes/${recipeId}/versions`)).json();
      const v1Row = versions.find((v: { versionNumber: number }) => v.versionNumber === 1);
      const between = new Date(new Date(v1Row.publishedAt).getTime() + 1).toISOString();
      const atV1 = await api.get(
        `/api/recipes/${recipeId}/effective-version?at=${encodeURIComponent(between)}`,
      );
      expect(atV1.json().versionNumber).toBe(1);
      const now = await api.get(
        `/api/recipes/${recipeId}/effective-version?at=${encodeURIComponent(new Date().toISOString())}`,
      );
      expect(now.json().versionNumber).toBe(2);
      const before = await api.get(
        `/api/recipes/${recipeId}/effective-version?at=2000-01-01T00:00:00Z`,
      );
      expect(before.statusCode).toBe(404);
    });

    describe("inmutabilidad por API (§23)", () => {
      it("ACTIVE no se edita, no se descarta", async () => {
        const res = await api.patch(`/api/recipe-versions/${v2}`, { yieldQuantity: "90" });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("RECIPE_VERSION_IMMUTABLE");
        expect((await api.post(`/api/recipe-versions/${v2}/discard`)).statusCode).toBe(409);
      });
      it("ARCHIVED no se edita, no se publica, no se descarta", async () => {
        for (const body of [
          { ingredients: [] },
          { wastePercentage: "1" },
          { instructions: "otra" },
          { yieldUnitId: w.units.g },
        ]) {
          const res = await api.patch(`/api/recipe-versions/${v1}`, body);
          expect(res.statusCode).toBe(409);
        }
        expect((await api.post(`/api/recipe-versions/${v1}/publish`)).statusCode).toBe(409);
        expect((await api.post(`/api/recipe-versions/${v1}/discard`)).statusCode).toBe(409);
      });
    });

    describe("rollback de la publicación (§45)", () => {
      it("una falla al auditar revierte snapshot, archivado y activación", async () => {
        const v3 = (await api.post(`/api/recipe-versions/${v2}/duplicate`)).json().id as string;
        await api.patch(`/api/recipe-versions/${v3}`, { yieldQuantity: "95" });
        const auditBefore = await recipeAudit(recipeId);
        // Falla forzada en el último paso (auditoría de la publicación), después de
        // haber insertado el snapshot, archivado v2 y activado v3.
        await ctx.database.db.execute(sql`
          create or replace function test_fail_publish() returns trigger language plpgsql as $$
          begin
            if new.action = 'RECIPE_VERSION_PUBLISHED' then raise exception 'falla forzada'; end if;
            return new;
          end $$;
          create trigger test_fail_publish before insert on audit_logs
            for each row execute function test_fail_publish();
        `);
        try {
          const res = await api.post(`/api/recipe-versions/${v3}/publish`, {});
          expect(res.statusCode).toBe(500);
        } finally {
          await ctx.database.db.execute(sql`
            drop trigger test_fail_publish on audit_logs;
            drop function test_fail_publish();
          `);
        }
        const statuses = await ctx.database.db
          .select({ id: recipeVersions.id, status: recipeVersions.status })
          .from(recipeVersions)
          .where(inArray(recipeVersions.id, [v2, v3]));
        expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual({
          [v2]: "ACTIVE",
          [v3]: "DRAFT",
        });
        const snapshots = await ctx.database.db
          .select()
          .from(recipeCostSnapshots)
          .where(eq(recipeCostSnapshots.recipeVersionId, v3));
        expect(snapshots).toEqual([]);
        expect(await recipeAudit(recipeId)).toEqual(auditBefore);
        // Sin la falla, la misma publicación funciona.
        expect((await api.post(`/api/recipe-versions/${v3}/publish`, {})).statusCode).toBe(200);
      });
    });

    describe("inmutabilidad en la base (triggers)", () => {
      const db = () => ctx.database.db;
      /** Drizzle envuelve el error de PostgreSQL en `cause`. */
      const rejects = async (promise: Promise<unknown>) => {
        const err = await promise.then(
          () => null,
          (e: unknown) => e as { cause?: { message?: string; code?: string } },
        );
        expect(err?.cause?.message).toMatch(
          /recipe_version_immutable|recipe_cost_snapshot_immutable/,
        );
        expect(err?.cause?.code).toBe("23001");
      };

      it("no se modifica rendimiento, merma ni instrucciones de una ACTIVE/ARCHIVED", async () => {
        const [active] = await db()
          .select()
          .from(recipeVersions)
          .where(and(eq(recipeVersions.recipeId, recipeId), eq(recipeVersions.status, "ACTIVE")));
        await rejects(
          db()
            .update(recipeVersions)
            .set({ yieldQuantity: "1" })
            .where(eq(recipeVersions.id, active!.id)),
        );
        await rejects(
          db()
            .update(recipeVersions)
            .set({ wastePercentage: "1" })
            .where(eq(recipeVersions.id, v1)),
        );
        await rejects(
          db().update(recipeVersions).set({ status: "ACTIVE" }).where(eq(recipeVersions.id, v1)),
        );
        await rejects(db().delete(recipeVersions).where(eq(recipeVersions.id, v1)));
      });

      it("no se agregan, cambian ni quitan ingredientes de versiones publicadas", async () => {
        await rejects(
          db().insert(recipeIngredients).values({
            companyId: ctx.companyId,
            recipeVersionId: v1,
            rawMaterialId: w.agua,
            quantity: "1",
            unitId: w.units.l!,
          }),
        );
        await rejects(
          db()
            .update(recipeIngredients)
            .set({ quantity: "1" })
            .where(eq(recipeIngredients.recipeVersionId, v1)),
        );
        await rejects(
          db().delete(recipeIngredients).where(eq(recipeIngredients.recipeVersionId, v1)),
        );
      });

      it("los snapshots son append-only", async () => {
        await rejects(
          db()
            .update(recipeCostSnapshots)
            .set({ unitCost: "1" })
            .where(eq(recipeCostSnapshots.recipeVersionId, v1)),
        );
        await rejects(
          db().update(recipeCostSnapshotLines).set({ referenceCost: "1", ingredientCost: "1" }),
        );
        await rejects(db().delete(recipeCostSnapshotLines));
      });

      it("la base impide dos versiones ACTIVE en la misma receta", async () => {
        const [draft] = await db()
          .insert(recipeVersions)
          .values({
            companyId: ctx.companyId,
            recipeId,
            versionNumber: 99,
            yieldQuantity: "1",
            yieldUnitId: w.units.kg!,
          })
          .returning();
        await expect(
          db()
            .update(recipeVersions)
            .set({ status: "ACTIVE", publishedAt: new Date(), effectiveFrom: new Date() })
            .where(eq(recipeVersions.id, draft!.id)),
        ).rejects.toThrow();
        await db().delete(recipeVersions).where(eq(recipeVersions.id, draft!.id));
      });
    });
  });
});

describe("unidades y rendimiento", () => {
  it("750 g de harina se normalizan a 0,75 kg", async () => {
    const recipe = await createRecipe(w.medialunas, {
      yieldQuantity: "20",
      yieldUnitId: w.units.docena,
      ingredients: [ingredient(w.harina, "750", w.units.g!)],
    });
    const { current } = await cost(recipe.draftVersionId);
    expect(current.ingredients[0]).toMatchObject({
      normalizedQuantity: "0.7500000000",
      baseUnit: { code: "kg" },
      cost: "750.000000",
    });
    // 20 docenas vendidas por unidad = 240 unidades → 750 / 240 = 3,125
    expect(current).toMatchObject({ normalizedYield: "240.0000000000", unitCost: "3.125000" });
  });

  it("harina (kg) en litros se rechaza", async () => {
    const res = await api.post("/api/recipes", {
      productId: w.prepizza,
      version: {
        yieldQuantity: "50",
        yieldUnitId: w.units.unidad,
        ingredients: [ingredient(w.harina, "1", w.units.l!)],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("RECIPE_INVALID");
    expect(res.json().error.details[0]).toMatchObject({
      path: "ingredients.0.unitId",
      code: "INCOMPATIBLE_INGREDIENT_UNIT",
    });
  });

  it("un envase genérico (bolsa) no se convierte a kg", async () => {
    const res = await api.post("/api/recipes", {
      productId: w.prepizza,
      version: {
        yieldQuantity: "50",
        yieldUnitId: w.units.unidad,
        ingredients: [ingredient(w.envase, "1", w.units.kg!)],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("producto por unidad con rendimiento en kg: rechazado", async () => {
    const res = await api.post("/api/recipes", {
      productId: w.prepizza,
      version: { yieldQuantity: "50", yieldUnitId: w.units.kg, ingredients: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0]).toMatchObject({
      path: "yieldUnitId",
      code: "INCOMPATIBLE_YIELD_UNIT",
    });
  });

  it.each([
    ["cantidad 0", { ingredients: [{ rawMaterialId: "", quantity: "0", unitId: "" }] }],
    ["rendimiento 0", { yieldQuantity: "0" }],
    ["merma 100", { wastePercentage: "100" }],
    ["merma negativa", { wastePercentage: "-1" }],
    ["cantidad float exponencial", { yieldQuantity: "1e3" }],
  ])("%s → 400", async (_label, patch) => {
    const res = await api.post("/api/recipes", {
      productId: w.prepizza,
      version: { yieldQuantity: "50", yieldUnitId: w.units.unidad, ...patch },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("costo incompleto (§14, §22)", () => {
  let recipeId: string;
  let draft: string;

  it("un ingrediente sin costo: INCOMPLETE, sin total ni unitario, lista lo que falta", async () => {
    const recipe = await createRecipe(w.prepizza, {
      yieldQuantity: "50",
      yieldUnitId: w.units.unidad,
      ingredients: [
        ingredient(w.harina, "10", w.units.kg!),
        ingredient(w.levadura, "200", w.units.g!),
      ],
    });
    recipeId = recipe.id;
    draft = recipe.draftVersionId;
    const { current } = await cost(draft);
    expect(current).toMatchObject({
      status: "INCOMPLETE",
      totalCost: null,
      unitCost: null,
      grossMargin: null,
    });
    expect(current.missingCosts.map((m: { rawMaterialName: string }) => m.rawMaterialName)).toEqual(
      ["Levadura fresca"],
    );
    expect(current.ingredients[1]).toMatchObject({ referenceCost: null, cost: null });
  });

  it("publicar exige confirmación explícita", async () => {
    const res = await api.post(`/api/recipe-versions/${draft}/publish`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("COST_INCOMPLETE_CONFIRMATION_REQUIRED");
    expect(res.json().error.message).toContain("Levadura fresca");
  });

  it("con confirmación se publica; el snapshot queda INCOMPLETE sin unitario ni cero implícito", async () => {
    const res = await api.post(`/api/recipe-versions/${draft}/publish`, {
      acknowledgeIncompleteCost: true,
    });
    expect(res.statusCode).toBe(200);
    const { snapshot } = await cost(draft);
    expect(snapshot).toMatchObject({
      status: "INCOMPLETE",
      totalCost: null,
      unitCost: null,
      grossMargin: null,
    });
    expect(snapshot.lines[1]).toMatchObject({
      rawMaterialName: "Levadura fresca",
      referenceCost: null,
      ingredientCost: null,
      costSource: null,
    });
    const list = (await api.get(`/api/recipes?search=Prepizza`)).json();
    expect(list.items[0].currentCost).toMatchObject({
      status: "INCOMPLETE",
      unitCost: null,
      missingCount: 1,
    });
  });

  it("cargar el costo faltante completa el costo actual (el snapshot sigue incompleto)", async () => {
    await api.put(`/api/raw-materials/${w.levadura}/reference-cost`, { referenceCost: "4000" });
    const result = await cost(draft);
    expect(result.current.status).toBe("COMPLETE");
    expect(result.snapshot.status).toBe("INCOMPLETE");
    expect(result.unitCostVariation).toBeNull();
    await api.put(`/api/raw-materials/${w.levadura}/reference-cost`, { referenceCost: null });
  });

  it("listado y detalle de la receta", async () => {
    const recipe = (await api.get(`/api/recipes/${recipeId}`)).json();
    expect(recipe.product).toMatchObject({ name: "Prepizza", saleUnit: { code: "unidad" } });
  });
});

describe("borradores, desactivación y referencias en uso", () => {
  let recipeId: string;

  it("descartar un borrador lo borra y lo audita", async () => {
    const recipe = await createRecipe(w.panFrances, {
      yieldQuantity: "1",
      yieldUnitId: w.units.kg,
      ingredients: [],
    }).catch(() => null);
    // Pan francés ya tiene receta activa: una segunda se rechaza.
    expect(recipe).toBeNull();
    const dup = await api.post("/api/recipes", {
      productId: w.panFrances,
      version: { yieldQuantity: "1", yieldUnitId: w.units.kg },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("RECIPE_ALREADY_EXISTS");

    const list = (await api.get(`/api/recipes?search=Medialunas`)).json();
    recipeId = list.items[0].id;
    const draftId = list.items[0].draftVersion.id;
    const res = await api.post(`/api/recipe-versions/${draftId}/discard`);
    expect(res.statusCode).toBe(200);
    expect(res.json().versions).toEqual([]);
    expect((await api.get(`/api/recipe-versions/${draftId}`)).statusCode).toBe(404);
    expect(await recipeAudit(recipeId)).toContain("RECIPE_VERSION_DISCARDED");
  });

  it("una receta sin versiones necesita los datos de la nueva versión", async () => {
    const empty = await api.post(`/api/recipes/${recipeId}/versions`, {});
    expect(empty.statusCode).toBe(422);
    const res = await api.post(`/api/recipes/${recipeId}/versions`, {
      version: {
        yieldQuantity: "10",
        yieldUnitId: w.units.docena,
        ingredients: [ingredient(w.harina, "2", w.units.kg!)],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().versionNumber).toBe(2);
  });

  it("una receta desactivada no se modifica; se puede reactivar", async () => {
    expect((await api.post(`/api/recipes/${recipeId}/deactivate`)).statusCode).toBe(200);
    const recipe = (await api.get(`/api/recipes/${recipeId}`)).json();
    expect(recipe.active).toBe(false);
    const res = await api.patch(`/api/recipe-versions/${recipe.draftVersionId}`, {
      instructions: "x",
    });
    expect(res.json().error.code).toBe("RECIPE_INACTIVE");
    expect((await api.post(`/api/recipes/${recipeId}/activate`)).statusCode).toBe(200);
    expect(await recipeAudit(recipeId)).toEqual(
      expect.arrayContaining(["RECIPE_DEACTIVATED", "RECIPE_REACTIVATED"]),
    );
  });

  it("no se cambia la unidad base de una materia prima usada en recetas", async () => {
    const res = await api.patch(`/api/raw-materials/${w.harina}`, { baseUnitId: w.units.l });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("RAW_MATERIAL_IN_USE");
  });

  it("no se cambia la unidad de venta a una incompatible con la receta", async () => {
    const res = await api.patch(`/api/products/${w.panFrances}`, { saleUnitId: w.units.unidad });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SALE_UNIT_INCOMPATIBLE_WITH_RECIPE");
  });

  it("archivar la versión vigente deja la receta sin vigente", async () => {
    const list = (await api.get(`/api/recipes?search=Prepizza`)).json();
    const active = list.items[0].activeVersion.id;
    expect((await api.post(`/api/recipe-versions/${active}/archive`)).statusCode).toBe(200);
    expect((await api.get(`/api/recipes/${list.items[0].id}/current-cost`)).statusCode).toBe(404);
  });
});

describe("permisos de recetas y costos", () => {
  it("Producción crea y edita borradores, pero no publica ni cambia costos", async () => {
    const who = { email: "produccion@test.local", password: "produccion-pass-123" };
    await createMember(ctx.database, ctx.companyId, {
      ...who,
      displayName: "Producción",
      roles: ["PRODUCTION"],
    });
    const prod = await clientFor(ctx.app, who);
    const list = (await prod.get("/api/recipes?search=Medialunas")).json();
    const draftId = list.items[0].draftVersion.id;
    const edit = await prod.patch(`/api/recipe-versions/${draftId}`, { instructions: "Laminar" });
    expect(edit.statusCode).toBe(200);
    expect((await prod.post(`/api/recipe-versions/${draftId}/publish`, {})).statusCode).toBe(403);
    expect(
      (await prod.put(`/api/raw-materials/${w.harina}/reference-cost`, { referenceCost: "1" }))
        .statusCode,
    ).toBe(403);
  });

  it("dar de alta una materia prima CON costo exige raw_materials.update_cost", async () => {
    // Rol de prueba con alta de materias primas pero sin permiso de costos.
    const [role] = await ctx.database.db
      .insert(roles)
      .values({ companyId: ctx.companyId, code: "TEST_ALTA_MP", name: "Alta MP" })
      .returning();
    const perms = await ctx.database.db
      .select({ id: permissions.id })
      .from(permissions)
      .where(inArray(permissions.code, [P.RAW_MATERIALS_CREATE, P.CATEGORIES_READ, P.UNITS_READ]));
    await ctx.database.db
      .insert(rolePermissions)
      .values(perms.map((p) => ({ roleId: role!.id, permissionId: p.id })));
    const who = { email: "alta-mp@test.local", password: "alta-mp-pass-123" };
    const { membershipId } = await createMember(ctx.database, ctx.companyId, {
      ...who,
      displayName: "Alta MP",
      roles: [],
    });
    await ctx.database.db.execute(
      sql`insert into membership_roles (membership_id, role_id, company_id) values (${membershipId}, ${role!.id}, ${ctx.companyId})`,
    );
    const client = await clientFor(ctx.app, who);
    const category = (await api.get("/api/categories?type=RAW_MATERIAL")).json().items[0].id;
    const base = { categoryId: category, baseUnitId: w.units.kg };
    expect(
      (await client.post("/api/raw-materials", { ...base, name: "Con costo", referenceCost: "5" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await client.post("/api/raw-materials", { ...base, name: "Sin costo" })).statusCode,
    ).toBe(201);
  });
});
