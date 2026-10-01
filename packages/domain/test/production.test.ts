import { describe, expect, it } from "vitest";
import type { CostingUnit } from "../src/costing";
import type Decimal from "decimal.js";
import { toFixedString } from "../src/decimal";
import { applyInbound, applyOutbound } from "../src/inventory";
import {
  ProductionError,
  actualMaterialCost,
  actualUnitMaterialCost,
  aggregateRequirements,
  assertTransition,
  canTransition,
  consumptionVariance,
  findShortages,
  formatBatchCode,
  normalizeConsumption,
  normalizeOutput,
  outputPerformance,
  planProduction,
  scaleFactor,
  type PlanIngredientInput,
} from "../src/production";

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

const ing = (
  name: string,
  quantity: string,
  unitRef: CostingUnit,
  effectiveCost: string | null,
  baseUnit: CostingUnit = kg,
): PlanIngredientInput => ({
  recipeIngredientId: `ri-${name}`,
  rawMaterialId: `rm-${name}`,
  rawMaterialCode: name.toUpperCase(),
  rawMaterialName: name,
  quantity,
  unit: unitRef,
  baseUnit,
  effectiveCost,
  costSource: effectiveCost === null ? null : "PURCHASE_MOVING_AVERAGE",
});

const s = (v: Decimal) => v.toString();

describe("máquina de estados", () => {
  it("permite el camino feliz y cancelar antes de completar", () => {
    expect(canTransition("DRAFT", "PLANNED")).toBe(true);
    expect(canTransition("PLANNED", "IN_PROGRESS")).toBe(true);
    expect(canTransition("IN_PROGRESS", "COMPLETED")).toBe(true);
    for (const from of ["DRAFT", "PLANNED", "IN_PROGRESS"] as const) {
      expect(canTransition(from, "CANCELLED")).toBe(true);
    }
  });

  it("rechaza saltos y cualquier salida de COMPLETED o CANCELLED", () => {
    expect(canTransition("DRAFT", "IN_PROGRESS")).toBe(false);
    expect(canTransition("DRAFT", "COMPLETED")).toBe(false);
    expect(canTransition("PLANNED", "COMPLETED")).toBe(false);
    expect(canTransition("COMPLETED", "DRAFT")).toBe(false);
    expect(canTransition("COMPLETED", "CANCELLED")).toBe(false);
    expect(canTransition("CANCELLED", "DRAFT")).toBe(false);
    expect(() => assertTransition("COMPLETED", "CANCELLED")).toThrow(ProductionError);
  });
});

describe("escalado (§11, §65)", () => {
  it("receta 100 kg (75 kg harina, 0,8 kg sal) → orden 200 kg: 150 kg y 1,6 kg", () => {
    const plan = planProduction({
      plannedOutputQuantity: "200",
      plannedOutputUnit: kg,
      saleUnit: kg,
      recipeYieldQuantity: "100",
      recipeYieldUnit: kg,
      ingredients: [ing("harina", "75", kg, "1000"), ing("sal", "0.8", kg, "500")],
    });
    expect(s(plan.scaleFactor)).toBe("2");
    expect(plan.lines.map((l) => s(l.plannedNormalized))).toEqual(["150", "1.6"]);
    expect(plan.lines.map((l) => s(l.plannedQuantity))).toEqual(["150", "1.6"]);
  });

  it("normaliza unidades: orden en g, receta en kg, ingrediente en g con base kg", () => {
    const plan = planProduction({
      plannedOutputQuantity: "50000",
      plannedOutputUnit: g,
      saleUnit: kg,
      recipeYieldQuantity: "100",
      recipeYieldUnit: kg,
      ingredients: [ing("levadura", "2000", g, "4000")],
    });
    expect(s(plan.plannedOutputNormalized)).toBe("50");
    expect(s(plan.scaleFactor)).toBe("0.5");
    // 2.000 g × 0,5 = 1.000 g = 1 kg
    expect(s(plan.lines[0]!.plannedQuantity)).toBe("1000");
    expect(s(plan.lines[0]!.plannedNormalized)).toBe("1");
    expect(s(plan.lines[0]!.plannedCost!)).toBe("4000");
  });

  it("scaleFactor exige rendimiento positivo", () => {
    expect(s(scaleFactor("96", "100"))).toBe("0.96");
    expect(() => scaleFactor("1", "0")).toThrow(RangeError);
  });

  it("rechaza unidades incompatibles y versiones sin ingredientes", () => {
    const base = {
      plannedOutputQuantity: "1",
      plannedOutputUnit: kg,
      saleUnit: kg,
      recipeYieldQuantity: "1",
      recipeYieldUnit: kg,
      ingredients: [ing("harina", "1", kg, "1")],
    };
    expect(() => planProduction({ ...base, plannedOutputUnit: u })).toThrow(/se mide en kg/);
    expect(() => planProduction({ ...base, recipeYieldUnit: l })).toThrow(ProductionError);
    expect(() => planProduction({ ...base, ingredients: [ing("harina", "1", l, "1")] })).toThrow(
      ProductionError,
    );
    expect(() => planProduction({ ...base, ingredients: [] })).toThrow(/no tiene ingredientes/);
    expect(() => planProduction({ ...base, plannedOutputQuantity: "0" })).toThrow(ProductionError);
  });
});

describe("costo esperado (§14)", () => {
  it("75 × 1.000 + 0,8 × 500 = 75.400 → 754/kg", () => {
    const plan = planProduction({
      plannedOutputQuantity: "100",
      plannedOutputUnit: kg,
      saleUnit: kg,
      recipeYieldQuantity: "100",
      recipeYieldUnit: kg,
      ingredients: [ing("harina", "75", kg, "1000"), ing("sal", "0.8", kg, "500")],
    });
    expect(plan.costStatus).toBe("COMPLETE");
    expect(s(plan.plannedMaterialCost!)).toBe("75400");
    expect(s(plan.plannedUnitMaterialCost!)).toBe("754");
    expect(plan.lines[0]!.costSource).toBe("PURCHASE_MOVING_AVERAGE");
  });

  it("sin costo de alguna materia prima el costo queda INCOMPLETO (sin total)", () => {
    const plan = planProduction({
      plannedOutputQuantity: "100",
      plannedOutputUnit: kg,
      saleUnit: kg,
      recipeYieldQuantity: "100",
      recipeYieldUnit: kg,
      ingredients: [ing("harina", "75", kg, "1000"), ing("mejorador", "1", kg, null)],
    });
    expect(plan.costStatus).toBe("INCOMPLETE");
    expect(plan.plannedMaterialCost).toBeNull();
    expect(plan.plannedUnitMaterialCost).toBeNull();
    expect(plan.missingCosts).toEqual([
      { rawMaterialId: "rm-mejorador", rawMaterialName: "mejorador" },
    ]);
    expect(plan.lines[1]!.plannedCost).toBeNull();
  });

  it("el total es la suma de las líneas ya redondeadas a 6 decimales", () => {
    const plan = planProduction({
      plannedOutputQuantity: "1",
      plannedOutputUnit: kg,
      saleUnit: kg,
      recipeYieldQuantity: "3",
      recipeYieldUnit: kg,
      ingredients: [ing("a", "1", kg, "1"), ing("b", "1", kg, "1")],
    });
    // 1/3 = 0,333333… → cada línea 0,333333 → total 0,666666
    expect(plan.lines.map((l) => s(l.plannedCost!))).toEqual(["0.333333", "0.333333"]);
    expect(s(plan.plannedMaterialCost!)).toBe("0.666666");
  });
});

describe("plan vs real (§19-23, §28)", () => {
  it("variación de consumo: plan 75, real 77,5 → +2,5 kg / +3,33 %", () => {
    const v = consumptionVariance("75", "77.5");
    expect(s(v.quantity)).toBe("2.5");
    expect(toFixedString(v.percentage!, 2)).toBe("3.33");
  });

  it("consumo extra: sin plan, variación = real y % indefinido", () => {
    const v = consumptionVariance(null, "1");
    expect(s(v.quantity)).toBe("1");
    expect(v.percentage).toBeNull();
  });

  it("consumo en unidad compatible: 1.950 g → 1,95 kg; 0 permitido; negativo y otra dimensión no", () => {
    expect(s(normalizeConsumption("1950", g, kg))).toBe("1.95");
    expect(s(normalizeConsumption("0", kg, kg))).toBe("0");
    expect(s(normalizeConsumption("1000", ml, l))).toBe("1");
    expect(() => normalizeConsumption("-1", kg, kg)).toThrow(/negativo/);
    expect(() => normalizeConsumption("1", l, kg, "Harina")).toThrow(/Harina se mide en kg/);
  });

  it("salida real: 96 kg contra 100 kg → −4 kg, −4 %, rendimiento 96 %", () => {
    const p = outputPerformance("100", "96");
    expect(s(p.variance)).toBe("-4");
    expect(s(p.variancePercentage)).toBe("-4");
    expect(s(p.yieldPerformance)).toBe("96");
    expect(s(normalizeOutput("96000", g, kg))).toBe("96");
    expect(() => normalizeOutput("0", kg, kg)).toThrow(ProductionError);
    expect(() => normalizeOutput("1", u, kg)).toThrow(ProductionError);
  });
});

describe("costo real (§24-27)", () => {
  it("costo material real = Σ |valor| de los consumos; por unidad = total / salida", () => {
    const total = actualMaterialCost(["-77000", "-400"]);
    expect(s(total)).toBe("77400");
    expect(s(actualUnitMaterialCost(total, "96"))).toBe("806.25");
  });

  it("la menor salida encarece la unidad: 100.000 / 90 = 1.111,11/kg", () => {
    expect(toFixedString(actualUnitMaterialCost("100000", "90"), 2)).toBe("1111.11");
    expect(() => actualUnitMaterialCost("1", "0")).toThrow(ProductionError);
  });

  it("los consumos salen al promedio vigente y no lo cambian", () => {
    const out = applyOutbound(
      { quantity: "200", inventoryValue: "200000", movingAverageCost: "1000" },
      "77",
    );
    expect(s(out.totalValue)).toBe("-77000");
    expect(s(out.after.movingAverageCost!)).toBe("1000");
    expect(out.averageChanged).toBe(false);
  });
});

describe("promedio del producto terminado (§34, §68)", () => {
  it("100 kg @ 1.000 + 100 kg @ 1.200 → 200 kg @ 1.100", () => {
    const first = applyInbound(
      { quantity: "0", inventoryValue: "0", movingAverageCost: null },
      "100",
      "1000",
      { totalValue: "100000" },
    );
    const second = applyInbound(
      {
        quantity: first.after.quantity,
        inventoryValue: first.after.inventoryValue,
        movingAverageCost: first.after.movingAverageCost,
      },
      "100",
      "1200",
      { totalValue: "120000" },
    );
    expect(s(second.after.quantity)).toBe("200");
    expect(s(second.after.movingAverageCost!)).toBe("1100");
    expect(s(second.after.inventoryValue)).toBe("220000");
  });

  it("con valor exacto del lote el inventario conserva lo consumido (sin redondeo del unitario)", () => {
    const r = applyInbound(
      { quantity: "0", inventoryValue: "0", movingAverageCost: null },
      "96",
      "806.25",
      { totalValue: "77400.000001" },
    );
    expect(s(r.totalValue)).toBe("77400.000001");
    expect(s(r.after.inventoryValue)).toBe("77400.000001");
    expect(s(r.after.movingAverageCost!)).toBe("806.25");
  });
});

describe("faltantes (§16, §21)", () => {
  it("agrega por materia prima y detalla requerido, disponible y faltante", () => {
    const reqs = [
      { rawMaterialId: "h", rawMaterialName: "Harina", required: "75" },
      { rawMaterialId: "h", rawMaterialName: "Harina", required: "2" },
      { rawMaterialId: "s", rawMaterialName: "Sal", required: "0.8" },
    ];
    const aggregated = aggregateRequirements(reqs);
    expect([...aggregated].map(([id, r]) => [id, s(r.required)])).toEqual([
      ["h", "77"],
      ["s", "0.8"],
    ]);
    const shortages = findShortages(
      reqs,
      new Map([
        ["h", "60"],
        ["s", "0.8"],
      ]),
    );
    expect(shortages).toHaveLength(1);
    expect(shortages[0]).toMatchObject({ rawMaterialId: "h", rawMaterialName: "Harina" });
    expect(s(shortages[0]!.missing)).toBe("17");
    expect(findShortages(reqs, new Map())).toHaveLength(2);
  });
});

describe("lote", () => {
  it("LOT-AAAAMMDD-NNN", () => {
    expect(formatBatchCode("2026-10-01", 1)).toBe("LOT-20261001-001");
    expect(formatBatchCode("2026-10-01", 12)).toBe("LOT-20261001-012");
    expect(() => formatBatchCode("01/10/2026", 1)).toThrow(RangeError);
    expect(() => formatBatchCode("2026-10-01", 0)).toThrow(RangeError);
  });
});
