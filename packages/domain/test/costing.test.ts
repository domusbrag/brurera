import { describe, expect, it } from "vitest";
import {
  RecipeValidationError,
  calculateCostVariation,
  calculateGrossMargin,
  calculateIngredientCost,
  calculateRecipeCost,
  calculateUnitCost,
  diffRecipeVersions,
  findEffectiveVersion,
  normalizeRecipeYield,
  recipeCostToWire,
  validateRecipeVersion,
  type CostingUnit,
  type IngredientCostInput,
} from "../src/costing";
import { D, toFixedString } from "../src/decimal";
import { convertQuantity } from "../src/units";

const unit = (
  id: string,
  dimension: string,
  base: string | null = null,
  factor: string | null = null,
): CostingUnit => ({
  id,
  code: id,
  symbol: id,
  dimension,
  baseUnitId: base,
  conversionFactor: factor,
});
const kg = unit("kg", "MASS");
const g = unit("g", "MASS", "kg", "0.001");
const l = unit("l", "VOLUME");
const ml = unit("ml", "VOLUME", "l", "0.001");
const u = unit("unidad", "COUNT");
const doc = unit("docena", "COUNT", "unidad", "12");
const bolsa = unit("bolsa", "PACKAGING");

const ingredient = (
  name: string,
  quantity: string,
  qtyUnit: CostingUnit,
  baseUnit: CostingUnit,
  referenceCost: string | null,
): IngredientCostInput => ({
  rawMaterialId: name,
  rawMaterialCode: `MP-${name}`,
  rawMaterialName: name,
  quantity,
  unit: qtyUnit,
  baseUnit,
  referenceCost,
  costSource: referenceCost === null ? null : "MANUAL_REFERENCE",
});

describe("conversión de cantidades", () => {
  it("750 g → 0.750 kg", () => {
    expect(convertQuantity("750", g, kg).toFixed(3)).toBe("0.750");
  });
  it("0,5 l → 500 ml y 2 docenas → 24 unidades", () => {
    expect(convertQuantity("0.5", l, ml).toFixed()).toBe("500");
    expect(convertQuantity("2", doc, u).toFixed()).toBe("24");
  });
  it("PACKAGING nunca se convierte a masa", () => {
    expect(() => convertQuantity("1", bolsa, kg)).toThrow(/incompatibles/);
  });
});

describe("costo de un ingrediente", () => {
  it("0.750 kg × $1000/kg = $750", () => {
    const line = calculateIngredientCost(ingredient("Harina", "750", g, kg, "1000"));
    expect(line.normalizedQuantity.toFixed()).toBe("0.75");
    expect(line.cost?.toFixed(2)).toBe("750.00");
    expect(line.costSource).toBe("MANUAL_REFERENCE");
  });
  it("75 kg × $800/kg = $60.000 y 800 g × $500/kg = $400", () => {
    expect(calculateIngredientCost(ingredient("H", "75", kg, kg, "800")).cost?.toFixed()).toBe(
      "60000",
    );
    expect(calculateIngredientCost(ingredient("S", "800", g, kg, "500")).cost?.toFixed()).toBe(
      "400",
    );
  });
  it("sin costo de referencia: costo null, nunca 0", () => {
    const line = calculateIngredientCost(ingredient("Levadura", "2", kg, kg, null));
    expect(line.cost).toBeNull();
    expect(line.costSource).toBeNull();
  });
  it("rechaza unidad incompatible con la unidad base (litros para harina en kg)", () => {
    expect(() => calculateIngredientCost(ingredient("Harina", "1", l, kg, "800"))).toThrow(
      RecipeValidationError,
    );
  });
  it("rechaza cantidad cero o negativa", () => {
    expect(() => calculateIngredientCost(ingredient("Harina", "0", kg, kg, "800"))).toThrow(
      /mayor que cero/,
    );
    expect(() => calculateIngredientCost(ingredient("Harina", "-1", kg, kg, "800"))).toThrow(
      /mayor que cero/,
    );
  });
});

describe("rendimiento", () => {
  it("producto en kg, receta que rinde 100.000 g → 100 kg", () => {
    expect(normalizeRecipeYield("100000", g, kg).toFixed()).toBe("100");
  });
  it("20 docenas vendidas por unidad → 240 unidades", () => {
    expect(normalizeRecipeYield("20", doc, u).toFixed()).toBe("240");
  });
  it("producto por unidad y receta en kg: no hay conversión válida", () => {
    expect(() => normalizeRecipeYield("50", kg, u)).toThrow(/se vende en unidad/);
  });
  it("rendimiento cero se rechaza", () => {
    expect(() => normalizeRecipeYield("0", kg, kg)).toThrow(/mayor que cero/);
  });
});

describe("costo de una receta (ejemplo de la especificación)", () => {
  const recipe = () =>
    calculateRecipeCost({
      currency: "ARS",
      yieldQuantity: "10",
      yieldUnit: kg,
      saleUnit: kg,
      salePrice: "1200",
      ingredients: [
        ingredient("Harina", "10", kg, kg, "800"),
        ingredient("Sal", "500", g, kg, "400"),
      ],
    });

  it("harina $8.000 + sal $200 = $8.200; $820/kg", () => {
    const result = recipe();
    expect(result.status).toBe("COMPLETE");
    expect(result.ingredients.map((i) => i.cost?.toFixed())).toEqual(["8000", "200"]);
    expect(result.totalCost?.toFixed()).toBe("8200");
    expect(result.normalizedYield.toFixed()).toBe("10");
    expect(result.unitCost?.toFixed()).toBe("820");
  });

  it("margen bruto teórico: $1.200 − $820 = $380; 31,666…%", () => {
    const margin = recipe().grossMargin!;
    expect(margin.amount.toFixed()).toBe("380");
    expect(margin.percentage!.toFixed(10)).toBe("31.6666666667");
    // Display según la política: 2 decimales.
    expect(toFixedString(margin.percentage!, 2)).toBe("31.67");
  });

  it("$100.000 / 100 kg = $1.000/kg", () => {
    const result = calculateRecipeCost({
      currency: "ARS",
      yieldQuantity: "100",
      yieldUnit: kg,
      saleUnit: kg,
      ingredients: [ingredient("Harina", "125", kg, kg, "800")],
    });
    expect(result.unitCost?.toFixed()).toBe("1000");
    expect(result.grossMargin).toBeNull();
  });

  it("la merma no se aplica dos veces: $100.000 sobre 90 kg útiles", () => {
    const result = calculateRecipeCost({
      currency: "ARS",
      yieldQuantity: "90",
      yieldUnit: kg,
      saleUnit: kg,
      ingredients: [ingredient("Harina", "125", kg, kg, "800")],
    });
    expect(toFixedString(result.unitCost!, 6)).toBe("1111.111111");
  });

  it("costo incompleto: estado INCOMPLETE, sin total, sin unitario, sin margen", () => {
    const result = calculateRecipeCost({
      currency: "ARS",
      yieldQuantity: "10",
      yieldUnit: kg,
      saleUnit: kg,
      salePrice: "1200",
      ingredients: [
        ingredient("Harina", "10", kg, kg, "800"),
        ingredient("Levadura fresca", "200", g, kg, null),
        ingredient("Mejorador", "50", g, kg, null),
      ],
    });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.totalCost).toBeNull();
    expect(result.unitCost).toBeNull();
    expect(result.grossMargin).toBeNull();
    expect(result.missingCosts.map((m) => m.rawMaterialName)).toEqual([
      "Levadura fresca",
      "Mejorador",
    ]);
    // El ingrediente con costo sigue mostrando el suyo.
    expect(result.ingredients[0]?.cost?.toFixed()).toBe("8000");
  });

  it("una receta sin ingredientes no tiene un costo completo", () => {
    const result = calculateRecipeCost({
      currency: "ARS",
      yieldQuantity: "1",
      yieldUnit: kg,
      saleUnit: kg,
      ingredients: [],
    });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.totalCost).toBeNull();
  });

  it("no redondea por ingrediente: 3 × 1 g a $333,333333/kg suma exacto", () => {
    const result = calculateRecipeCost({
      currency: "ARS",
      yieldQuantity: "3",
      yieldUnit: u,
      saleUnit: u,
      ingredients: [
        ingredient("A", "1", g, kg, "0.333333"),
        ingredient("B", "1", g, kg, "0.333333"),
        ingredient("C", "1", g, kg, "0.333334"),
      ],
    });
    // Cada línea es 0,000333…; redondeadas a 2 decimales serían 0 y el total, $0.
    expect(result.totalCost?.toFixed()).toBe("0.001");
    expect(recipeCostToWire(result).totalCost).toBe("0.001000");
  });
});

describe("wire / persistencia", () => {
  it("serializa con las escalas de la política y sin notación exponencial", () => {
    const wire = recipeCostToWire(
      calculateRecipeCost({
        currency: "ARS",
        yieldQuantity: "90",
        yieldUnit: kg,
        saleUnit: kg,
        salePrice: "1500",
        ingredients: [ingredient("Sal", "0.001", g, kg, "500")],
      }),
    );
    expect(wire.ingredients[0]?.normalizedQuantity).toBe("0.0000010000");
    expect(wire.ingredients[0]?.cost).toBe("0.000500");
    expect(wire.unitCost).toBe("0.000006");
    expect(wire.grossMargin?.percentage).toMatch(/^\d+\.\d{4}$/);
    expect(JSON.stringify(wire)).not.toMatch(/e-/);
  });
});

describe("margen, costo unitario y variación", () => {
  it("precio 0: margen negativo y porcentaje indefinido", () => {
    const m = calculateGrossMargin("0", "100");
    expect(m.amount.toFixed()).toBe("-100");
    expect(m.percentage).toBeNull();
  });
  it("calculateUnitCost exige rendimiento positivo", () => {
    expect(() => calculateUnitCost("10", "0")).toThrow(RangeError);
  });
  it("variación $600 → $750 = +25%", () => {
    const v = calculateCostVariation("600", "750");
    expect(v.amount.toFixed()).toBe("150");
    expect(v.percentage?.toFixed()).toBe("25");
  });
  it("variación desde 0 no tiene porcentaje", () => {
    expect(calculateCostVariation("0", "10").percentage).toBeNull();
  });
});

describe("validación estructural", () => {
  const base = {
    yieldQuantity: "10",
    yieldUnit: kg,
    saleUnit: kg,
    wastePercentage: null as string | null,
    ingredients: [
      { rawMaterialId: "h", rawMaterialName: "Harina", quantity: "1", unit: kg, baseUnit: kg },
    ],
  };
  it("una versión válida no tiene problemas", () => {
    expect(validateRecipeVersion(base, { forPublish: true })).toEqual([]);
  });
  it.each([
    ["-0.01", true],
    ["0", false],
    ["99.99", false],
    ["100", true],
  ])("merma %s → inválida: %s", (waste, invalid) => {
    const issues = validateRecipeVersion({ ...base, wastePercentage: waste });
    expect(issues.some((i) => i.code === "WASTE_OUT_OF_RANGE")).toBe(invalid);
  });
  it("detecta unidad de rendimiento incompatible, cantidad ≤ 0, unidad incompatible y repetidos", () => {
    const issues = validateRecipeVersion({
      ...base,
      yieldUnit: u,
      ingredients: [
        { rawMaterialId: "h", rawMaterialName: "Harina", quantity: "0", unit: l, baseUnit: kg },
        { rawMaterialId: "h", rawMaterialName: "Harina", quantity: "1", unit: kg, baseUnit: kg },
      ],
    });
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ["yieldUnitId", "INCOMPATIBLE_YIELD_UNIT"],
      ["ingredients.0.quantity", "QUANTITY_NOT_POSITIVE"],
      ["ingredients.0.unitId", "INCOMPATIBLE_INGREDIENT_UNIT"],
      ["ingredients.1.rawMaterialId", "DUPLICATE_INGREDIENT"],
    ]);
  });
  it("publicar exige al menos un ingrediente; un borrador puede estar vacío", () => {
    expect(validateRecipeVersion({ ...base, ingredients: [] })).toEqual([]);
    expect(validateRecipeVersion({ ...base, ingredients: [] }, { forPublish: true })).toEqual([
      expect.objectContaining({ code: "NO_INGREDIENTS" }),
    ]);
  });
});

describe("diferencias entre versiones", () => {
  const v1 = {
    yieldQuantity: "100",
    yieldUnit: kg,
    wastePercentage: "5",
    instructions: "Amasar",
    ingredients: [
      { rawMaterialId: "h", rawMaterialName: "Harina", quantity: "75", unit: kg, baseUnit: kg },
      { rawMaterialId: "s", rawMaterialName: "Sal", quantity: "800", unit: g, baseUnit: kg },
      { rawMaterialId: "m", rawMaterialName: "Mejorador", quantity: "1", unit: kg, baseUnit: kg },
    ],
  };
  it("detecta agregados, quitados, cantidades y rendimiento; 0,8 kg == 800 g no es cambio", () => {
    const v2 = {
      ...v1,
      yieldQuantity: "110",
      ingredients: [
        { rawMaterialId: "h", rawMaterialName: "Harina", quantity: "80", unit: kg, baseUnit: kg },
        { rawMaterialId: "s", rawMaterialName: "Sal", quantity: "0.8", unit: kg, baseUnit: kg },
        { rawMaterialId: "a", rawMaterialName: "Agua", quantity: "40", unit: l, baseUnit: l },
      ],
    };
    const diff = diffRecipeVersions(v1, v2);
    expect(diff.added.map((i) => i.rawMaterialName)).toEqual(["Agua"]);
    expect(diff.removed.map((i) => i.rawMaterialName)).toEqual(["Mejorador"]);
    expect(diff.changed).toEqual([
      expect.objectContaining({
        rawMaterialName: "Harina",
        from: expect.objectContaining({ quantity: "75" }),
        to: expect.objectContaining({ quantity: "80" }),
      }),
    ]);
    expect(diff.yield?.to.quantity).toBe("110");
    expect(diff.waste).toBeNull();
    expect(diff.instructionsChanged).toBe(false);
    expect(diff.hasChanges).toBe(true);
  });
  it("una copia exacta no tiene cambios", () => {
    expect(diffRecipeVersions(v1, structuredClone(v1)).hasChanges).toBe(false);
  });
});

describe("vigencia", () => {
  const t = (iso: string) => new Date(iso);
  const versions = [
    { id: "v1", effectiveFrom: t("2026-01-01T00:00:00Z"), archivedAt: t("2026-02-01T00:00:00Z") },
    { id: "v2", effectiveFrom: t("2026-02-01T00:00:00Z"), archivedAt: null },
    { id: "v3", effectiveFrom: null, archivedAt: null },
  ];
  it("devuelve la versión vigente en cada momento", () => {
    expect(findEffectiveVersion(versions, t("2025-12-31T00:00:00Z"))).toBeNull();
    expect(findEffectiveVersion(versions, t("2026-01-15T00:00:00Z"))?.id).toBe("v1");
    expect(findEffectiveVersion(versions, t("2026-02-01T00:00:00Z"))?.id).toBe("v2");
    expect(findEffectiveVersion(versions, t("2030-01-01T00:00:00Z"))?.id).toBe("v2");
  });
});

describe("política decimal", () => {
  it("0,1 + 0,2 es exactamente 0,3 (no float)", () => {
    expect(new D("0.1").plus("0.2").toFixed()).toBe("0.3");
  });
  it("redondeo HALF_UP sólo al final", () => {
    expect(toFixedString("2.345", 2)).toBe("2.35");
    expect(toFixedString("-2.345", 2)).toBe("-2.35");
  });
});
