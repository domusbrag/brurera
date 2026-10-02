import { describe, expect, it } from "vitest";
import {
  formatMoney,
  formatPercent,
  formatQuantity,
  formatReferenceCost,
  formatUnitCost,
} from "@/lib/format";

describe("formato de costos (política de display)", () => {
  it("dinero: redondeo HALF_UP a 2 decimales, separadores es-AR", () => {
    expect(formatMoney("60000")).toBe("$60.000,00");
    expect(formatMoney("1111.111111")).toBe("$1.111,11");
    expect(formatMoney("2.345")).toBe("$2,35");
    expect(formatMoney(null)).toBe("—");
  });
  it("dinero negativo: el signo va antes de la moneda (margen negativo, saldo a favor)", () => {
    expect(formatMoney("-7500")).toBe("-$7.500,00");
    expect(formatMoney("-0.001")).toBe("$0,00");
  });
  it("costo por unidad: '$850,00 / kg' y sin $0,00 engañoso para costos chicos", () => {
    expect(formatUnitCost("850", "ARS", "kg")).toBe("$850,00 / kg");
    expect(formatUnitCost("0.000500", "ARS", "g")).toBe("$0,0005 / g");
    expect(formatUnitCost("0", "ARS", "kg")).toBe("$0,00 / kg");
  });
  it("porcentaje 31,666… → 31,67 %", () => {
    expect(formatPercent("31.6666666667")).toBe("31,67 %");
    expect(formatPercent("-12.5")).toBe("-12,5 %");
  });
  it("cantidades sin ceros de más", () => {
    expect(formatQuantity("0.750000", "kg")).toBe("0,75 kg");
    expect(formatQuantity("100.000000", "kg")).toBe("100 kg");
  });
});

describe("costo de referencia (dato de entrada)", () => {
  it("se muestra tal como se cargó, sin redondear", () => {
    expect(formatReferenceCost("850.125000", "ARS", "kg")).toBe("$850,125 / kg");
    expect(formatReferenceCost("800.000000", "ARS", "kg")).toBe("$800,00 / kg");
    expect(formatReferenceCost(null, "ARS", "kg")).toBe("—");
  });
});
