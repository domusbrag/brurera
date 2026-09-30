import { describe, expect, it } from "vitest";
import {
  IncompatibleUnitsError,
  InvalidUnitDefinitionError,
  STANDARD_UNITS,
  areUnitsCompatible,
  convertQuantity,
  validateDerivedUnit,
  type UnitForConversion,
} from "../src/units";

const kg: UnitForConversion = {
  id: "kg",
  code: "kg",
  dimension: "MASS",
  baseUnitId: null,
  conversionFactor: null,
};
const g: UnitForConversion = {
  id: "g",
  code: "g",
  dimension: "MASS",
  baseUnitId: "kg",
  conversionFactor: "0.001",
};
const l: UnitForConversion = {
  id: "l",
  code: "l",
  dimension: "VOLUME",
  baseUnitId: null,
  conversionFactor: null,
};
const ml: UnitForConversion = {
  id: "ml",
  code: "ml",
  dimension: "VOLUME",
  baseUnitId: "l",
  conversionFactor: "0.001",
};
const unidad: UnitForConversion = {
  id: "u",
  code: "unidad",
  dimension: "COUNT",
  baseUnitId: null,
  conversionFactor: null,
};
const docena: UnitForConversion = {
  id: "doc",
  code: "docena",
  dimension: "COUNT",
  baseUnitId: "u",
  conversionFactor: "12",
};
const bolsa: UnitForConversion = {
  id: "b",
  code: "bolsa",
  dimension: "PACKAGING",
  baseUnitId: null,
  conversionFactor: null,
};
const bolsa25: UnitForConversion = {
  id: "b25",
  code: "bolsa25",
  dimension: "MASS",
  baseUnitId: "kg",
  conversionFactor: "25",
};

describe("convertQuantity", () => {
  it("1 kg = 1000 g y 1000 g = 1 kg", () => {
    expect(convertQuantity("1", kg, g).toString()).toBe("1000");
    expect(convertQuantity("1000", g, kg).toString()).toBe("1");
  });

  it("es exacto con decimales (sin errores de punto flotante)", () => {
    expect(
      convertQuantity("0.1", kg, g)
        .plus(convertQuantity("0.2", kg, g))
        .toString(),
    ).toBe("300");
    expect(convertQuantity("1.2345", l, ml).toString()).toBe("1234.5");
  });

  it("convierte entre dos derivadas de la misma raíz", () => {
    expect(convertQuantity("2", bolsa25, g).toString()).toBe("50000");
    expect(convertQuantity("3", docena, unidad).toString()).toBe("36");
  });

  it("identidad: misma unidad devuelve la misma cantidad", () => {
    expect(convertQuantity("7.5", kg, kg).toString()).toBe("7.5");
  });

  it("rechaza masa ↔ volumen (1 kg ≠ 1 litro)", () => {
    expect(() => convertQuantity("1", kg, l)).toThrow(IncompatibleUnitsError);
    expect(() => convertQuantity("1", g, ml)).toThrow(IncompatibleUnitsError);
  });

  it("rechaza unidades de envase sin conversión definida", () => {
    expect(() => convertQuantity("1", bolsa, kg)).toThrow(IncompatibleUnitsError);
    expect(areUnitsCompatible(bolsa, bolsa)).toBe(true);
  });

  it("rechaza conteo ↔ masa", () => {
    expect(() => convertQuantity("1", docena, kg)).toThrow(IncompatibleUnitsError);
  });
});

describe("validateDerivedUnit", () => {
  it("acepta una derivada válida", () => {
    expect(() => validateDerivedUnit("MASS", kg, "0.5")).not.toThrow();
  });

  it("rechaza base de otra dimensión", () => {
    expect(() => validateDerivedUnit("VOLUME", kg, "1")).toThrow(InvalidUnitDefinitionError);
  });

  it("rechaza base que ya es derivada (cadenas de conversión)", () => {
    expect(() => validateDerivedUnit("MASS", g, "10")).toThrow(InvalidUnitDefinitionError);
  });

  it("rechaza factor cero o negativo", () => {
    expect(() => validateDerivedUnit("MASS", kg, "0")).toThrow(InvalidUnitDefinitionError);
  });
});

describe("unidades estándar", () => {
  it("incluye las 8 unidades iniciales con códigos únicos", () => {
    const codes = STANDARD_UNITS.map((u) => u.code);
    expect(codes).toEqual(["kg", "g", "l", "ml", "unidad", "docena", "bolsa", "caja"]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("cada derivada apunta a una raíz estándar de la misma dimensión", () => {
    for (const u of STANDARD_UNITS.filter((x) => x.base)) {
      const base = STANDARD_UNITS.find((x) => x.code === u.base!.code);
      expect(base?.base).toBeUndefined();
      expect(base?.dimension).toBe(u.dimension);
    }
  });
});
