import { describe, expect, it } from "vitest";
import {
  D,
  LotError,
  applyLotMovement,
  applyOutbound,
  assertTransformation,
  calculateAvailabilityAt,
  calculateUsableUntil,
  canTransform,
  childLotCode,
  compareFefo,
  describeShelfLife,
  isNearExpiry,
  lotEligibilityAt,
  lotOutflow,
  recommendFefo,
  resolveInitialConservation,
  resolveTransformation,
  shelfLifeToMinutes,
  sortFefo,
  type ConservationProfileEntry,
  type LotForAvailability,
} from "../src";

const HOUR = 60;
const DAY = 1440;

const profile = (
  entries: Partial<Record<ConservationProfileEntry["state"], [number, boolean?]>>,
): ConservationProfileEntry[] =>
  (["FRESH", "REFRIGERATED", "FROZEN", "THAWED"] as const).map((state) => {
    const e = entries[state];
    return {
      state,
      enabled: e !== undefined,
      shelfLifeMinutes: e?.[0] ?? null,
      allowedAsInitial: e?.[1] ?? false,
    };
  });

const medialuna = profile({ FRESH: [2 * DAY, true], FROZEN: [30 * DAY], THAWED: [12 * HOUR] });
const panFrances = profile({ FRESH: [1 * DAY, true] });

const lot = (over: Partial<LotForAvailability> & { id: string }): LotForAvailability => ({
  code: over.id,
  conservationState: "FRESH",
  qualityStatus: "AVAILABLE",
  quantity: "100",
  producedAt: new Date("2026-10-01T06:00:00Z"),
  usableUntil: null,
  ...over,
});

describe("transiciones de conservación (MVP)", () => {
  it("permite FRESH → FROZEN, REFRIGERATED → FROZEN y FROZEN → THAWED", () => {
    expect(canTransform("FRESH", "FROZEN")).toBe(true);
    expect(canTransform("REFRIGERATED", "FROZEN")).toBe(true);
    expect(canTransform("FROZEN", "THAWED")).toBe(true);
  });

  it("bloquea transiciones ilógicas y el recongelado", () => {
    expect(canTransform("THAWED", "FROZEN")).toBe(false);
    expect(canTransform("FROZEN", "FRESH")).toBe(false);
    expect(canTransform("FRESH", "THAWED")).toBe(false);
    expect(canTransform("FRESH", "FRESH")).toBe(false);
    expect(() => assertTransformation("THAWED", "FROZEN")).toThrow(
      "Un lote descongelado no puede volver a congelarse.",
    );
  });

  it("un producto no congelable no puede congelarse aunque la transición exista", () => {
    expect(() =>
      resolveTransformation({ from: "FRESH", to: "FROZEN", profile: panFrances }),
    ).toThrow(LotError);
    try {
      resolveTransformation({ from: "FRESH", to: "FROZEN", profile: panFrances });
    } catch (err) {
      expect((err as LotError).code).toBe("CONSERVATION_STATE_DISABLED");
    }
  });

  it("la vida útil del destino sale del perfil del estado destino", () => {
    expect(resolveTransformation({ from: "FRESH", to: "FROZEN", profile: medialuna })).toEqual({
      shelfLifeMinutes: 30 * DAY,
    });
    expect(resolveTransformation({ from: "FROZEN", to: "THAWED", profile: medialuna })).toEqual({
      shelfLifeMinutes: 12 * HOUR,
    });
  });
});

describe("vida útil", () => {
  it("convierte horas y días a minutos exactos", () => {
    expect(shelfLifeToMinutes("36", "HOURS")).toBe(2160);
    expect(shelfLifeToMinutes("2", "DAYS")).toBe(2880);
    expect(shelfLifeToMinutes("1.5", "HOURS")).toBe(90);
  });

  it("rechaza cero, negativos y fracciones de minuto", () => {
    expect(() => shelfLifeToMinutes("0", "DAYS")).toThrow(LotError);
    expect(() => shelfLifeToMinutes("-1", "HOURS")).toThrow(LotError);
    expect(() => shelfLifeToMinutes("0.001", "HOURS")).toThrow(LotError);
  });

  it("muestra días si son exactos, si no horas", () => {
    expect(describeShelfLife(2880)).toEqual({ value: "2", unit: "DAYS" });
    expect(describeShelfLife(720)).toEqual({ value: "12", unit: "HOURS" });
    expect(describeShelfLife(90)).toEqual({ value: "1.5", unit: "HOURS" });
  });

  it("usableUntil = cambio de estado + vida útil", () => {
    const at = new Date("2026-10-02T10:00:00Z");
    expect(calculateUsableUntil(at, 30 * DAY).toISOString()).toBe("2026-11-01T10:00:00.000Z");
    expect(calculateUsableUntil(at, 12 * HOUR).toISOString()).toBe("2026-10-02T22:00:00.000Z");
  });
});

describe("estado inicial de un lote de producción", () => {
  it("por defecto el estado inicial configurado", () => {
    expect(
      resolveInitialConservation({ profile: medialuna, defaultInitialState: "FRESH" }),
    ).toEqual({ state: "FRESH", shelfLifeMinutes: 2 * DAY });
  });

  it("no hardcodea FRESH: un producto que nace congelado", () => {
    const congelado = profile({ FROZEN: [60 * DAY, true], THAWED: [DAY] });
    expect(
      resolveInitialConservation({ profile: congelado, defaultInitialState: "FROZEN" }),
    ).toEqual({ state: "FROZEN", shelfLifeMinutes: 60 * DAY });
  });

  it("un estado pedido debe estar permitido como inicial", () => {
    expect(() =>
      resolveInitialConservation({
        profile: medialuna,
        defaultInitialState: "FRESH",
        requested: "FROZEN",
      }),
    ).toThrow("Congelado no está habilitado como estado inicial");
  });

  it("sin configuración: FRESH con vida útil desconocida (no se inventa)", () => {
    expect(resolveInitialConservation({ profile: profile({}), defaultInitialState: null })).toEqual(
      { state: "FRESH", shelfLifeMinutes: null },
    );
  });
});

describe("salida de un lote (valor al costo del lote)", () => {
  it("parcial: cantidad × costo unitario del lote", () => {
    const out = lotOutflow({
      lotQuantity: "500",
      lotValue: "50000",
      unitCost: "100",
      quantity: "300",
    });
    expect(out.value.toString()).toBe("30000");
    expect(out.remainingQuantity.toString()).toBe("200");
    expect(out.remainingValue.toString()).toBe("20000");
  });

  it("total: se lleva el valor remanente exacto (absorbe el redondeo)", () => {
    const out = lotOutflow({
      lotQuantity: "3",
      lotValue: "100",
      unitCost: "33.333333",
      quantity: "3",
    });
    expect(out.value.toString()).toBe("100");
    expect(out.remainingValue.toString()).toBe("0");
  });

  it("INSUFFICIENT_LOT_QUANTITY: nunca deja un lote negativo", () => {
    expect(() =>
      lotOutflow({ lotQuantity: "200", lotValue: "1", unitCost: "0.005", quantity: "300" }),
    ).toThrow(expect.objectContaining({ code: "INSUFFICIENT_LOT_QUANTITY" }));
  });
});

describe("movimientos de lote sobre el costo del producto", () => {
  const state = { quantity: "500", inventoryValue: "50000", movingAverageCost: "100" };

  it("transformación: OUT + IN = cantidad, valor y promedio sin cambio", () => {
    const out = applyLotMovement(state, "-300", "-30000");
    const back = applyLotMovement(
      {
        quantity: out.after.quantity,
        inventoryValue: out.after.inventoryValue,
        movingAverageCost: out.after.movingAverageCost,
      },
      "300",
      "30000",
    );
    expect(back.after.quantity.toString()).toBe("500");
    expect(back.after.inventoryValue.toString()).toBe("50000");
    expect(back.after.movingAverageCost?.toString()).toBe("100");
    expect(out.averageChanged || back.averageChanged).toBe(false);
  });

  it("merma: baja cantidad y valor al costo del lote; el promedio no cambia", () => {
    const waste = applyLotMovement(state, "-20", "-2000");
    expect(waste.after.quantity.toString()).toBe("480");
    expect(waste.after.inventoryValue.toString()).toBe("48000");
    expect(waste.after.movingAverageCost?.toString()).toBe("100");
    // Mismo criterio que una salida común (applyOutbound): el promedio se conserva.
    expect(applyOutbound(state, "20").after.movingAverageCost?.toString()).toBe("100");
  });

  it("nunca deja el producto en negativo", () => {
    expect(() => applyLotMovement(state, "-600", "-60000")).toThrow(
      expect.objectContaining({ code: "INSUFFICIENT_STOCK" }),
    );
  });
});

describe("elegibilidad", () => {
  const at = new Date("2026-10-03T18:00:00Z");

  it("vencido, bloqueado y agotado no son elegibles", () => {
    expect(
      lotEligibilityAt(lot({ id: "v", usableUntil: new Date("2026-10-02T20:00:00Z") }), at),
    ).toEqual({ eligible: false, reason: "EXPIRED" });
    expect(lotEligibilityAt(lot({ id: "b", qualityStatus: "BLOCKED" }), at)).toEqual({
      eligible: false,
      reason: "BLOCKED",
    });
    expect(lotEligibilityAt(lot({ id: "a", quantity: "0" }), at)).toEqual({
      eligible: false,
      reason: "DEPLETED",
    });
  });

  it("utilizable hasta el instante exacto de usableUntil", () => {
    expect(lotEligibilityAt(lot({ id: "x", usableUntil: at }), at).eligible).toBe(true);
    expect(
      lotEligibilityAt(lot({ id: "x", usableUntil: new Date(at.getTime() - 1) }), at).eligible,
    ).toBe(false);
  });

  it("conservación y calidad son ejes distintos: congelado no es bloqueado", () => {
    expect(lotEligibilityAt(lot({ id: "f", conservationState: "FROZEN" }), at).eligible).toBe(true);
  });

  it("próximo a vencer: dentro del umbral y todavía utilizable", () => {
    const soon = lot({ id: "s", usableUntil: new Date("2026-10-04T06:00:00Z") });
    expect(isNearExpiry(soon, at, 24 * HOUR)).toBe(true);
    expect(isNearExpiry(soon, at, 6 * HOUR)).toBe(false);
    expect(isNearExpiry(lot({ id: "n" }), at, 24 * HOUR)).toBe(false);
  });
});

describe("FEFO", () => {
  it("primero vence antes; sin vencimiento al final; luego producido antes", () => {
    const lots = [
      lot({ id: "sin-vto" }),
      lot({ id: "congelado-viejo", usableUntil: new Date("2026-11-01T00:00:00Z") }),
      lot({
        id: "fresco-b",
        usableUntil: new Date("2026-10-03T00:00:00Z"),
        producedAt: new Date("2026-10-02T06:00:00Z"),
      }),
      lot({
        id: "fresco-a",
        usableUntil: new Date("2026-10-03T00:00:00Z"),
        producedAt: new Date("2026-10-01T06:00:00Z"),
      }),
    ];
    expect(sortFefo(lots).map((l) => l.id)).toEqual([
      "fresco-a",
      "fresco-b",
      "congelado-viejo",
      "sin-vto",
    ]);
    expect(compareFefo(lots[0]!, lots[0]!)).toBe(0);
  });

  it("no es FIFO ciego: un congelado más viejo va después de un fresco que vence antes", () => {
    const congelado = lot({
      id: "C",
      conservationState: "FROZEN",
      producedAt: new Date("2026-09-01T00:00:00Z"),
      usableUntil: new Date("2026-10-20T00:00:00Z"),
    });
    const fresco = lot({
      id: "F",
      producedAt: new Date("2026-10-02T00:00:00Z"),
      usableUntil: new Date("2026-10-04T00:00:00Z"),
    });
    expect(sortFefo([congelado, fresco]).map((l) => l.id)).toEqual(["F", "C"]);
  });

  it("recomienda lotes elegibles en orden FEFO sin asignar nada", () => {
    const at = new Date("2026-10-03T12:00:00Z");
    const rec = recommendFefo(
      [
        lot({ id: "A", quantity: "50", usableUntil: new Date("2026-10-04T00:00:00Z") }),
        lot({ id: "B", quantity: "80", usableUntil: new Date("2026-10-10T00:00:00Z") }),
        lot({ id: "V", quantity: "999", usableUntil: new Date("2026-10-02T00:00:00Z") }),
      ],
      "100",
      at,
    );
    expect(rec.allocations.map((a) => [a.lot.id, a.quantity.toString()])).toEqual([
      ["A", "50"],
      ["B", "50"],
    ]);
    expect(rec.missing.toString()).toBe("0");
  });
});

describe("disponibilidad a una fecha (ejemplo obligatorio §18 / §54)", () => {
  // Pedido para el sábado 2026-10-10 18:00 (UTC-3 → 21:00 UTC).
  const saturday = new Date("2026-10-10T21:00:00Z");
  const lotA = lot({
    id: "A",
    quantity: "300",
    conservationState: "FRESH",
    usableUntil: new Date("2026-10-09T23:00:00Z"), // viernes 20:00
  });
  const lotB = lot({
    id: "B",
    quantity: "400",
    conservationState: "FROZEN",
    usableUntil: new Date("2026-10-30T12:00:00Z"), // dentro de 20 días
  });

  it("físico 700, apto para el sábado 400, no elegible 300 por vencimiento", () => {
    const r = calculateAvailabilityAt([lotA, lotB], saturday);
    expect(r.physicalQuantity.toString()).toBe("700");
    expect(r.eligibleQuantity.toString()).toBe("400");
    expect(r.ineligibleQuantity.toString()).toBe("300");
    expect(r.ineligibleByReason.EXPIRED.toString()).toBe("300");
    expect(r.physicalByState.FRESH.toString()).toBe("300");
    expect(r.physicalByState.FROZEN.toString()).toBe("400");
    expect(r.eligibleByState.FROZEN.toString()).toBe("400");
    expect(r.lots.map((l) => [l.id, l.eligible, l.reason])).toEqual([
      ["A", false, "EXPIRED"],
      ["B", true, null],
    ]);
  });

  it("agotados no cuentan; bloqueados son físicos pero no elegibles", () => {
    const r = calculateAvailabilityAt(
      [lotB, lot({ id: "Z", quantity: "0" }), lot({ id: "Q", qualityStatus: "BLOCKED" })],
      saturday,
    );
    expect(r.physicalQuantity.toString()).toBe("500");
    expect(r.eligibleQuantity.toString()).toBe("400");
    expect(r.ineligibleByReason.BLOCKED.toString()).toBe("100");
    expect(r.lots.map((l) => l.id)).toEqual(["B", "Q"]);
  });

  it("sin vida útil configurada: elegible pero informado", () => {
    const r = calculateAvailabilityAt([lot({ id: "U", quantity: "10" })], saturday);
    expect(r.eligibleQuantity.toString()).toBe("10");
    expect(r.shelfLifeUnknownQuantity.toString()).toBe("10");
  });

  it("suma con precisión decimal", () => {
    const r = calculateAvailabilityAt(
      [lot({ id: "1", quantity: "0.1" }), lot({ id: "2", quantity: "0.2" })],
      saturday,
    );
    expect(r.physicalQuantity.eq(new D("0.3"))).toBe(true);
  });
});

describe("códigos de lote hijo", () => {
  it("padre + número de hijo", () => {
    expect(childLotCode("LOT-20261001-005", 1)).toBe("LOT-20261001-005.1");
    expect(childLotCode("LOT-20261001-005.1", 2)).toBe("LOT-20261001-005.1.2");
    expect(() => childLotCode("X", 0)).toThrow(RangeError);
  });
});
