import { describe, expect, it } from "vitest";
import { D } from "../src/decimal";
import {
  InventoryError,
  acquisitionUnitCost,
  applyInbound,
  applyOutbound,
  baseQuantityPerPurchaseUnit,
  calculatePurchaseLineAmounts,
  calculatePurchaseTotals,
  movementSign,
  nextBalance,
  positiveAdjustmentCost,
  selectEffectiveCost,
  shortage,
  signedQuantity,
  stockStatus,
  toBaseQuantity,
} from "../src/inventory";
import type { UnitForConversion } from "../src/units";

const unit = (
  id: string,
  dimension: string,
  base: string | null = null,
  factor: string | null = null,
): UnitForConversion => ({ id, code: id, dimension, baseUnitId: base, conversionFactor: factor });
const kg = unit("kg", "MASS");
const g = unit("g", "MASS", "kg", "0.001");
const l = unit("l", "VOLUME");
const u = unit("unidad", "COUNT");
const bolsa = unit("bolsa", "PACKAGING");
const paquete = unit("paquete", "PACKAGING");

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof InventoryError ? err.code : String(err);
  }
  return "OK";
};

describe("presentaciones de compra", () => {
  it("4 bolsas × Bolsa 25 kg = 100 kg", () => {
    const per = baseQuantityPerPurchaseUnit({
      baseUnit: kg,
      purchaseUnit: bolsa,
      presentation: { containedQuantity: "25", containedUnit: kg },
    });
    expect(per.toFixed()).toBe("25");
    expect(toBaseQuantity("4", per).toFixed()).toBe("100");
  });

  it("la presentación convierte con su propia unidad (Paquete 500 g → 0,5 kg)", () => {
    const per = baseQuantityPerPurchaseUnit({
      baseUnit: kg,
      purchaseUnit: paquete,
      presentation: { containedQuantity: "500", containedUnit: g },
    });
    expect(per.toFixed()).toBe("0.5");
    expect(toBaseQuantity("3", per).toFixed()).toBe("1.5");
  });

  it("Maple 30 unidades y Bidón 5 l", () => {
    expect(
      baseQuantityPerPurchaseUnit({
        baseUnit: u,
        purchaseUnit: unit("maple", "PACKAGING"),
        presentation: { containedQuantity: "30", containedUnit: u },
      }).toFixed(),
    ).toBe("30");
    expect(
      baseQuantityPerPurchaseUnit({
        baseUnit: l,
        purchaseUnit: unit("bidon", "PACKAGING"),
        presentation: { containedQuantity: "5", containedUnit: l },
      }).toFixed(),
    ).toBe("5");
  });

  it("el packaging no tiene conversión universal: sin presentación, bolsa → kg falla", () => {
    expect(
      code(() =>
        baseQuantityPerPurchaseUnit({ baseUnit: kg, purchaseUnit: bolsa, presentation: null }),
      ),
    ).toBe("INCOMPATIBLE_PURCHASE_UNIT");
  });

  it("sin presentación se puede comprar en una unidad compatible (g → kg)", () => {
    expect(
      baseQuantityPerPurchaseUnit({ baseUnit: kg, purchaseUnit: g, presentation: null }).toFixed(),
    ).toBe("0.001");
  });

  it("rechaza una presentación cuyo contenido es incompatible con la unidad base", () => {
    expect(
      code(() =>
        baseQuantityPerPurchaseUnit({
          baseUnit: kg,
          purchaseUnit: bolsa,
          presentation: { containedQuantity: "5", containedUnit: l },
        }),
      ),
    ).toBe("INCOMPATIBLE_PRESENTATION_UNIT");
  });
});

describe("importes y costo de adquisición", () => {
  it("4 bolsas × $20.000 = $80.000 / 100 kg = $800/kg", () => {
    const amounts = calculatePurchaseLineAmounts({ quantity: "4", unitPrice: "20000" });
    expect(amounts.net.toFixed()).toBe("80000");
    expect(acquisitionUnitCost(amounts.net, "100").toFixed()).toBe("800");
  });

  it("el descuento se descuenta antes de valorizar ($100.000 − $10.000 = $90.000)", () => {
    const amounts = calculatePurchaseLineAmounts({
      quantity: "5",
      unitPrice: "20000",
      discountAmount: "10000",
    });
    expect(amounts.gross.toFixed()).toBe("100000");
    expect(amounts.net.toFixed()).toBe("90000");
    expect(acquisitionUnitCost(amounts.net, "125").toFixed()).toBe("720");
  });

  it("el descuento no puede superar el bruto", () => {
    expect(
      code(() =>
        calculatePurchaseLineAmounts({ quantity: "1", unitPrice: "10", discountAmount: "11" }),
      ),
    ).toBe("DISCOUNT_EXCEEDS_GROSS");
  });

  it("los impuestos suman al total pero no al costo", () => {
    const a = calculatePurchaseLineAmounts({
      quantity: "4",
      unitPrice: "20000",
      discountAmount: "0",
    });
    const b = calculatePurchaseLineAmounts({
      quantity: "2",
      unitPrice: "1000",
      discountAmount: "200",
    });
    const totals = calculatePurchaseTotals([a, b], "17010");
    expect(totals.subtotal.toFixed()).toBe("82000");
    expect(totals.discountTotal.toFixed()).toBe("200");
    expect(totals.total.toFixed()).toBe("98810");
    expect(acquisitionUnitCost(a.net, "100").toFixed()).toBe("800");
  });

  it("usa decimal exacto (0,1 × 3 = 0,3)", () => {
    expect(calculatePurchaseLineAmounts({ quantity: "3", unitPrice: "0.1" }).net.toFixed()).toBe(
      "0.3",
    );
  });
});

describe("promedio ponderado móvil", () => {
  it("100 kg @ $1.000 + 100 kg @ $1.200 = 200 kg @ $1.100 ($220.000)", () => {
    const first = applyInbound(
      { quantity: "0", inventoryValue: "0", movingAverageCost: null },
      "100",
      "1000",
    );
    expect(first.after.quantity.toFixed()).toBe("100");
    expect(first.after.inventoryValue.toFixed()).toBe("100000");
    expect(first.after.movingAverageCost?.toFixed()).toBe("1000");
    const second = applyInbound(
      {
        quantity: first.after.quantity,
        inventoryValue: first.after.inventoryValue,
        movingAverageCost: first.after.movingAverageCost,
      },
      "100",
      "1200",
    );
    expect(second.after.quantity.toFixed()).toBe("200");
    expect(second.after.inventoryValue.toFixed()).toBe("220000");
    expect(second.after.movingAverageCost?.toFixed()).toBe("1100");
    expect(second.totalValue.toFixed()).toBe("120000");
    expect(second.averageChanged).toBe(true);
  });

  it("con stock en cero, el nuevo promedio es el costo del ingreso (no arrastra el histórico)", () => {
    const r = applyInbound(
      { quantity: "0", inventoryValue: "0", movingAverageCost: "5000" },
      "10",
      "800",
    );
    expect(r.after.movingAverageCost?.toFixed()).toBe("800");
    expect(r.after.inventoryValue.toFixed()).toBe("8000");
  });

  it("el promedio se redondea a 6 decimales y el valor queda exacto", () => {
    const r = applyInbound(
      { quantity: "3", inventoryValue: "3", movingAverageCost: "1" },
      "3",
      "2",
    );
    expect(r.after.inventoryValue.toFixed()).toBe("9");
    expect(r.after.movingAverageCost?.toFixed()).toBe("1.5");
    const odd = applyInbound(
      { quantity: "1", inventoryValue: "1", movingAverageCost: "1" },
      "2",
      "1.5",
    );
    expect(odd.after.movingAverageCost?.toFixed()).toBe("1.333333");
    expect(odd.after.inventoryValue.toFixed()).toBe("4");
  });

  it("salida: 100 kg @ $1.000 − 10 kg = 90 kg @ $1.000 ($90.000), el promedio no cambia", () => {
    const r = applyOutbound(
      { quantity: "100", inventoryValue: "100000", movingAverageCost: "1000" },
      "10",
    );
    expect(r.quantity.toFixed()).toBe("-10");
    expect(r.totalValue.toFixed()).toBe("-10000");
    expect(r.after.quantity.toFixed()).toBe("90");
    expect(r.after.inventoryValue.toFixed()).toBe("90000");
    expect(r.after.movingAverageCost?.toFixed()).toBe("1000");
    expect(r.averageChanged).toBe(false);
  });

  it("una salida que deja la existencia en 0 deja el valor en 0", () => {
    const r = applyOutbound(
      { quantity: "3", inventoryValue: "4", movingAverageCost: "1.333333" },
      "3",
    );
    expect(r.after.inventoryValue.toFixed()).toBe("0");
    expect(r.totalValue.toFixed()).toBe("-4");
  });

  it("no permite stock negativo (10 kg − merma 15 kg)", () => {
    expect(
      code(() =>
        applyOutbound({ quantity: "10", inventoryValue: "10000", movingAverageCost: "1000" }, "15"),
      ),
    ).toBe("INSUFFICIENT_STOCK");
    expect(code(() => nextBalance("10", "-15"))).toBe("INSUFFICIENT_STOCK");
    expect(nextBalance("10", "-10").toFixed()).toBe("0");
  });
});

describe("ajustes positivos y stock inicial", () => {
  it("el stock inicial exige siempre costo", () => {
    expect(code(() => positiveAdjustmentCost("INITIAL_STOCK", null, "1000"))).toBe(
      "VALUATION_COST_REQUIRED",
    );
    expect(positiveAdjustmentCost("INITIAL_STOCK", "900", null).toFixed()).toBe("900");
  });

  it("un ajuste positivo usa el promedio vigente por defecto; sin promedio exige costo", () => {
    expect(positiveAdjustmentCost("ADJUSTMENT_POSITIVE", undefined, "1100").toFixed()).toBe("1100");
    expect(code(() => positiveAdjustmentCost("ADJUSTMENT_POSITIVE", null, null))).toBe(
      "VALUATION_COST_REQUIRED",
    );
    // Un ajuste al promedio vigente no cambia el promedio.
    const r = applyInbound(
      { quantity: "100", inventoryValue: "110000", movingAverageCost: "1100" },
      "5",
      "1100",
    );
    expect(r.after.movingAverageCost?.toFixed()).toBe("1100");
    expect(r.averageChanged).toBe(false);
  });
});

describe("convención de signo", () => {
  it("ingresos positivos, salidas negativas", () => {
    expect(movementSign("INITIAL_STOCK")).toBe(1);
    expect(movementSign("PURCHASE_RECEIPT")).toBe(1);
    expect(movementSign("ADJUSTMENT_POSITIVE")).toBe(1);
    expect(movementSign("ADJUSTMENT_NEGATIVE")).toBe(-1);
    expect(movementSign("WASTE")).toBe(-1);
    expect(signedQuantity("WASTE", "5").toFixed()).toBe("-5");
    expect(signedQuantity("PURCHASE_RECEIPT", "100").toFixed()).toBe("100");
    expect(code(() => signedQuantity("WASTE", "-5"))).toBe("QUANTITY_NOT_POSITIVE");
  });
});

describe("stock mínimo", () => {
  it("OK / LOW / OUT_OF_STOCK contra el mínimo", () => {
    expect(stockStatus("40", "50")).toBe("LOW");
    expect(stockStatus("80", "50")).toBe("OK");
    expect(stockStatus("50", "50")).toBe("OK");
    expect(stockStatus("0", "50")).toBe("OUT_OF_STOCK");
    expect(stockStatus("0", "0")).toBe("OUT_OF_STOCK");
    expect(stockStatus("1", "0")).toBe("OK");
    expect(shortage("40", "50").toFixed()).toBe("10");
    expect(shortage("80", "50").toFixed()).toBe("0");
  });
});

describe("costo efectivo para recetas", () => {
  it("prioridad: promedio ponderado > referencia manual > incompleto", () => {
    const avg = selectEffectiveCost({ movingAverageCost: "850", referenceCost: "800" });
    expect(avg.source).toBe("PURCHASE_MOVING_AVERAGE");
    expect(avg.cost?.toFixed()).toBe("850");
    const manual = selectEffectiveCost({ movingAverageCost: null, referenceCost: "800" });
    expect(manual.source).toBe("MANUAL_REFERENCE");
    expect(manual.cost?.toFixed()).toBe("800");
    const none = selectEffectiveCost({ movingAverageCost: null, referenceCost: null });
    expect(none).toEqual({ cost: null, source: null });
  });

  it("un promedio en 0 es un costo válido (no se confunde con 'sin costo')", () => {
    expect(
      selectEffectiveCost({ movingAverageCost: "0", referenceCost: "800" }).cost?.eq(new D(0)),
    ).toBe(true);
  });
});
