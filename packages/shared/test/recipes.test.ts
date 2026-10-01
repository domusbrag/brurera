import { describe, expect, it } from "vitest";
import { referenceCostSchema } from "../src/masters";
import {
  createRecipeSchema,
  publishRecipeVersionSchema,
  recipeVersionInputSchema,
  updateRecipeVersionSchema,
} from "../src/recipes";

const UUID = "11111111-1111-4111-8111-111111111111";
const version = { yieldQuantity: "100", yieldUnitId: UUID };

describe("esquemas de recetas", () => {
  it("cantidades: > 0, hasta 6 decimales, coma decimal, nunca float ni exponente", () => {
    const ing = (quantity: unknown) =>
      recipeVersionInputSchema.safeParse({
        ...version,
        ingredients: [{ rawMaterialId: UUID, unitId: UUID, quantity }],
      });
    expect(ing("0,750").data?.ingredients[0]?.quantity).toBe("0.750");
    expect(ing("0.000001").success).toBe(true);
    expect(ing("0.0000001").success).toBe(false);
    expect(ing("0").success).toBe(false);
    expect(ing("-1").success).toBe(false);
    expect(ing("1e3").success).toBe(false);
  });

  it("rendimiento > 0", () => {
    expect(recipeVersionInputSchema.safeParse({ ...version, yieldQuantity: "0" }).success).toBe(
      false,
    );
  });

  it("merma: vacía, 0 ≤ x < 100", () => {
    const waste = (wastePercentage: unknown) =>
      recipeVersionInputSchema.safeParse({ ...version, wastePercentage });
    expect(waste("").data?.wastePercentage).toBeNull();
    expect(waste("0").success).toBe(true);
    expect(waste("99.9999").success).toBe(true);
    expect(waste("100").success).toBe(false);
    expect(waste("-1").success).toBe(false);
  });

  it("alta: el nombre es opcional y los ingredientes por defecto vacíos", () => {
    const parsed = createRecipeSchema.parse({ productId: UUID, version });
    expect(parsed.name).toBeNull();
    expect(parsed.version.ingredients).toEqual([]);
  });

  it("editar un borrador exige al menos un cambio", () => {
    expect(updateRecipeVersionSchema.safeParse({}).success).toBe(false);
    expect(updateRecipeVersionSchema.safeParse({ instructions: "Amasar" }).success).toBe(true);
  });

  it("publicar sin confirmar costo incompleto por defecto", () => {
    expect(publishRecipeVersionSchema.parse({}).acknowledgeIncompleteCost).toBe(false);
  });

  it("costo de referencia: la clave es obligatoria; null la borra", () => {
    expect(referenceCostSchema.safeParse({}).success).toBe(false);
    expect(referenceCostSchema.parse({ referenceCost: null }).referenceCost).toBeNull();
    expect(referenceCostSchema.parse({ referenceCost: "850,5" }).referenceCost).toBe("850.5");
    expect(referenceCostSchema.safeParse({ referenceCost: "-1" }).success).toBe(false);
  });
});
