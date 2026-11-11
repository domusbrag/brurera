import { describe, expect, it } from "vitest";
import { matchOption } from "@/components/ui/combobox";
import { describeError, localizeNumbers } from "@/lib/errors";
import {
  COVERAGE_TONE,
  LOT_STATUS_TONE,
  ORDER_STATUS_TONE,
  PAYMENT_STATUS_TONE,
} from "@/lib/status";

describe("errores en lenguaje de negocio", () => {
  it("nunca muestra un código interno como mensaje", () => {
    expect(describeError({ code: "UNKNOWN", message: "", status: 500 })).toMatch(/inesperado/);
    expect(
      describeError({ code: "CONFLICT", message: "INSUFFICIENT_FREE_PRODUCT_STOCK", status: 409 }),
    ).not.toContain("INSUFFICIENT");
    expect(describeError({ code: "NETWORK", message: "fetch failed", status: 0 })).toMatch(
      /conexión/,
    );
  });

  it("pasa montos y cantidades de la API a formato es-AR", () => {
    expect(localizeNumbers("Supera el pendiente de $ 1500.00")).toBe(
      "Supera el pendiente de $1.500,00",
    );
    expect(localizeNumbers("Faltan 2.5 kg")).toBe("Faltan 2,5 kg");
  });

  it("no toca códigos ni fechas", () => {
    expect(localizeNumbers("Lote LOT-20261005-004 vence 2026-10-05")).toBe(
      "Lote LOT-20261005-004 vence 2026-10-05",
    );
  });
});

describe("selector con búsqueda", () => {
  const option = { value: "1", label: "Medialunas de manteca", keywords: "PROD-0007" };
  it("ignora tildes y mayúsculas, y exige todas las palabras", () => {
    expect(matchOption(option, "MEDIALUNA mante")).toBe(true);
    expect(matchOption({ value: "2", label: "Pan de campaña" }, "campana")).toBe(true);
    expect(matchOption(option, "medialunas grasa")).toBe(false);
  });
  it("busca también por código", () => {
    expect(matchOption(option, "prod-0007")).toBe(true);
  });
});

describe("semántica de color de estados", () => {
  it("lo que impide operar es rojo; lo que requiere atención, amarillo", () => {
    expect(COVERAGE_TONE.NOT_COVERED).toBe("danger");
    expect(COVERAGE_TONE.PARTIALLY_COVERED).toBe("warning");
    expect(LOT_STATUS_TONE.EXPIRED).toBe("danger");
    expect(LOT_STATUS_TONE.BLOCKED).toBe("danger");
    expect(LOT_STATUS_TONE.NEAR_EXPIRY).toBe("warning");
    expect(PAYMENT_STATUS_TONE.UNPAID).toBe("warning");
  });
  it("lo terminado es verde y lo cancelado neutro", () => {
    expect(ORDER_STATUS_TONE.DELIVERED).toBe("success");
    expect(PAYMENT_STATUS_TONE.PAID).toBe("success");
    expect(ORDER_STATUS_TONE.CANCELLED).toBe("neutral");
  });
});
