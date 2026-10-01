import { describe, expect, it } from "vitest";
import { formatCode, normalizeCode } from "../src/codes";

describe("códigos internos", () => {
  it("formatea con prefijo y 4 dígitos", () => {
    expect(formatCode("CUSTOMER", 1)).toBe("CLI-0001");
    expect(formatCode("SUPPLIER", 42)).toBe("PROV-0042");
    expect(formatCode("RAW_MATERIAL", 7)).toBe("MP-0007");
    expect(formatCode("PRODUCT", 12345)).toBe("PROD-12345");
  });

  it("rechaza secuencias inválidas", () => {
    expect(() => formatCode("CUSTOMER", 0)).toThrow(RangeError);
    expect(() => formatCode("CUSTOMER", 1.5)).toThrow(RangeError);
  });

  it("normaliza códigos manuales", () => {
    expect(normalizeCode("  cli-9 ")).toBe("CLI-9");
  });
});
