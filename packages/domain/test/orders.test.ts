import { describe, expect, it } from "vitest";
import type { CostingUnit } from "../src/costing";
import {
  OrderError,
  aggregateMaterialDemand,
  allocateFefo,
  assertOrderTransition,
  assertReadyAllowed,
  availabilityForOrder,
  canOrderTransition,
  expandRecipe,
  freeLotQuantity,
  isDemandStatus,
  matchesConservation,
  planCoverage,
  requiredProduction,
  reservationsToInvalidate,
  type LotWithCommitment,
} from "../src/orders";
import { formatCode } from "../src/codes";

const DAY = 86_400_000;
const now = new Date("2026-10-05T12:00:00Z");
const at = (days: number) => new Date(now.getTime() + days * DAY);

const lot = (
  id: string,
  quantity: string,
  usableInDays: number | null,
  extra: Partial<LotWithCommitment> = {},
): LotWithCommitment => ({
  id,
  code: id,
  conservationState: "FRESH",
  qualityStatus: "AVAILABLE",
  quantity,
  producedAt: now,
  usableUntil: usableInDays === null ? null : at(usableInDays),
  committed: "0",
  ...extra,
});

const s = (v: { toString(): string }) => v.toString();

describe("estados del pedido (gate D)", () => {
  it("permite el ciclo DRAFT → CONFIRMED → IN_PREPARATION → READY y cancelar", () => {
    expect(canOrderTransition("DRAFT", "CONFIRMED")).toBe(true);
    expect(canOrderTransition("CONFIRMED", "IN_PREPARATION")).toBe(true);
    expect(canOrderTransition("IN_PREPARATION", "READY")).toBe(true);
    expect(canOrderTransition("READY", "CANCELLED")).toBe(true);
    expect(canOrderTransition("DRAFT", "CANCELLED")).toBe(true);
  });

  it("rechaza transiciones inválidas y CANCELLED es terminal", () => {
    expect(() => assertOrderTransition("DRAFT", "READY")).toThrow(OrderError);
    expect(() => assertOrderTransition("CANCELLED", "CONFIRMED")).toThrow(
      "Un pedido cancelado no puede pasar a confirmado.",
    );
    expect(canOrderTransition("IN_PREPARATION", "CONFIRMED")).toBe(false);
  });

  it("sólo CONFIRMED, IN_PREPARATION y READY generan demanda", () => {
    expect(isDemandStatus("DRAFT")).toBe(false);
    expect(isDemandStatus("CANCELLED")).toBe(false);
    expect(isDemandStatus("CONFIRMED")).toBe(true);
    expect(isDemandStatus("IN_PREPARATION")).toBe(true);
    expect(isDemandStatus("READY")).toBe(true);
  });

  it("código PED-0001 por empresa", () => {
    expect(formatCode("CUSTOMER_ORDER", 1)).toBe("PED-0001");
  });
});

describe("disponibilidad con compromisos (gates E y H)", () => {
  // §4: 300 frescos que vencen el viernes, 400 congelados por 20 días; pedido el sábado.
  const fresh = lot("LOT-A", "300", 2);
  const frozen = lot("LOT-B", "400", 20, { conservationState: "FROZEN" });

  it("§4: físico 700, elegible 400, comprometido 0, disponible 400", () => {
    const a = availabilityForOrder([fresh, frozen], at(3));
    expect(s(a.physicalQuantity)).toBe("700");
    expect(s(a.eligibleQuantity)).toBe("400");
    expect(s(a.committedQuantity)).toBe("0");
    expect(s(a.availableQuantity)).toBe("400");
    expect(s(a.ineligibleByReason.EXPIRED)).toBe("300");
  });

  it("§72: físico 700, elegible 400, comprometido 100 → disponible 300; pedido 500 → reserva 300, producir 200", () => {
    const lots = [fresh, { ...frozen, committed: "100" }];
    const a = availabilityForOrder(lots, at(3));
    expect(s(a.physicalQuantity)).toBe("700");
    expect(s(a.eligibleQuantity)).toBe("400");
    expect(s(a.committedQuantity)).toBe("100");
    expect(s(a.availableQuantity)).toBe("300");
    const r = allocateFefo(lots, "500", at(3));
    expect(s(r.reserved)).toBe("300");
    expect(s(r.missing)).toBe("200");
    expect(s(requiredProduction("500", r.reserved))).toBe("200");
  });

  it("§5: segundo pedido con todo comprometido → reservable 0, producir 200", () => {
    const lots = [fresh, { ...frozen, committed: "400" }];
    const a = availabilityForOrder(lots, at(3));
    expect(s(a.availableQuantity)).toBe("0");
    const r = allocateFefo(lots, "200", at(3));
    expect(r.allocations).toHaveLength(0);
    expect(s(r.missing)).toBe("200");
  });

  it("AVAILABLE = ELIGIBLE − COMMITTED también con varios lotes", () => {
    const lots = [lot("A", "100", 5, { committed: "30" }), lot("B", "50", 9, { committed: "50" })];
    const a = availabilityForOrder(lots, at(1));
    expect(s(a.availableQuantity)).toBe(s(a.eligibleQuantity.minus(a.committedQuantity)));
    expect(s(a.availableQuantity)).toBe("70");
  });

  it("lote bloqueado o vencido no es elegible y su comprometido no se descuenta", () => {
    const lots = [
      lot("A", "100", 5, { qualityStatus: "BLOCKED", committed: "40" }),
      lot("B", "100", 1, { committed: "10" }),
      lot("C", "100", 9),
    ];
    const a = availabilityForOrder(lots, at(3));
    expect(s(a.eligibleQuantity)).toBe("100");
    expect(s(a.committedQuantity)).toBe("0");
    expect(s(a.ineligibleByReason.BLOCKED)).toBe("100");
    expect(s(a.ineligibleByReason.EXPIRED)).toBe("100");
  });

  it("vida útil desconocida se cuenta como utilizable pero se informa", () => {
    const a = availabilityForOrder([lot("A", "80", null, { committed: "20" })], at(30));
    expect(s(a.availableQuantity)).toBe("60");
    expect(s(a.shelfLifeUnknownAvailable)).toBe("60");
  });
});

describe("conservación pedida (gate F)", () => {
  const fresh = lot("F", "100", 5);
  const frozen = lot("Z", "100", 30, { conservationState: "FROZEN" });

  it("FROZEN sólo acepta congelado; ANY acepta todo", () => {
    expect(matchesConservation("FROZEN", "FRESH")).toBe(false);
    expect(matchesConservation("FROZEN", "FROZEN")).toBe(true);
    expect(matchesConservation("ANY", "THAWED")).toBe(true);
  });

  it("un lote fresco no satisface una línea de congelados", () => {
    const r = allocateFefo([fresh, frozen], "150", at(1), "FROZEN");
    expect(r.allocations.map((a) => a.lot.id)).toEqual(["Z"]);
    expect(s(r.missing)).toBe("50");
    const a = availabilityForOrder([fresh, frozen], at(1), "FROZEN");
    expect(s(a.ineligibleByReason.CONSERVATION_MISMATCH)).toBe("100");
  });
});

describe("asignación FEFO (gate G)", () => {
  it("primero el que vence antes, después producido antes, después código; nunca más que lo libre", () => {
    const older = new Date(now.getTime() - DAY);
    const lots = [
      lot("C", "100", null),
      lot("B", "100", 4, { producedAt: now }),
      lot("A", "100", 4, { producedAt: older, committed: "70" }),
      lot("D", "100", 2),
    ];
    const r = allocateFefo(lots, "250", at(1));
    expect(r.allocations.map((a) => [a.lot.id, s(a.quantity)])).toEqual([
      ["D", "100"],
      ["A", "30"],
      ["B", "100"],
      ["C", "20"],
    ]);
    expect(s(r.missing)).toBe("0");
  });

  it("suma de reservas nunca supera el saldo físico", () => {
    const r = allocateFefo([lot("A", "100", 5, { committed: "100" })], "10", at(1));
    expect(r.allocations).toHaveLength(0);
  });
});

describe("cobertura", () => {
  it("FULLY / PARTIALLY / NOT_COVERED", () => {
    expect(planCoverage([{ requested: "500", reserved: "500" }])).toBe("FULLY_COVERED");
    expect(planCoverage([{ requested: "500", reserved: "400" }])).toBe("PARTIALLY_COVERED");
    expect(planCoverage([{ requested: "200", reserved: "0" }])).toBe("NOT_COVERED");
    expect(
      planCoverage([
        { requested: "1", reserved: "1" },
        { requested: "1", reserved: "0" },
      ]),
    ).toBe("PARTIALLY_COVERED");
  });

  it("READY exige cobertura completa", () => {
    expect(() =>
      assertReadyAllowed("PARTIALLY_COVERED", [{ requested: "10", reserved: "5" }]),
    ).toThrow(OrderError);
    expect(() => assertReadyAllowed("NEEDS_REPLAN", [{ requested: "10", reserved: "10" }])).toThrow(
      "Sólo un pedido con todo su producto reservado puede marcarse como listo.",
    );
    expect(() =>
      assertReadyAllowed("FULLY_COVERED", [{ requested: "10", reserved: "10" }]),
    ).not.toThrow();
  });
});

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

describe("materias primas desde la receta (gate J)", () => {
  it("§73: faltan 200 kg de pan, receta 100 kg = 75 harina + 0,8 sal → 150 harina, 1,6 sal", () => {
    const r = expandRecipe({
      quantity: "200",
      saleUnit: kg,
      recipeYieldQuantity: "100",
      recipeYieldUnit: kg,
      ingredients: [
        {
          rawMaterialId: "harina",
          rawMaterialCode: "MP-1",
          rawMaterialName: "Harina",
          quantity: "75",
          unit: kg,
          baseUnit: kg,
        },
        {
          rawMaterialId: "sal",
          rawMaterialCode: "MP-2",
          rawMaterialName: "Sal",
          quantity: "800",
          unit: g,
          baseUnit: kg,
        },
      ],
    });
    expect(s(r.scaleFactor)).toBe("2");
    expect(r.materials.map((m) => [m.rawMaterialId, s(m.required)])).toEqual([
      ["harina", "150"],
      ["sal", "1.6"],
    ]);
  });

  it("suma una materia prima repetida en la receta", () => {
    const r = expandRecipe({
      quantity: "100",
      saleUnit: kg,
      recipeYieldQuantity: "100",
      recipeYieldUnit: kg,
      ingredients: [
        {
          rawMaterialId: "h",
          rawMaterialCode: "MP-1",
          rawMaterialName: "H",
          quantity: "50",
          unit: kg,
          baseUnit: kg,
        },
        {
          rawMaterialId: "h",
          rawMaterialCode: "MP-1",
          rawMaterialName: "H",
          quantity: "25",
          unit: kg,
          baseUnit: kg,
        },
      ],
    });
    expect(s(r.materials[0]!.required)).toBe("75");
  });
});

describe("demanda global de materias primas (gate K)", () => {
  it("§74: pedido A 7 + pedido B 5 con stock 10 → demanda 12, faltante 2", () => {
    const [line] = aggregateMaterialDemand(new Map([["harina", "10"]]), [
      { rawMaterialId: "harina", quantity: "7" },
      { rawMaterialId: "harina", quantity: "5" },
    ]);
    expect(s(line!.openOrderDemand)).toBe("12");
    expect(s(line!.currentStock)).toBe("10");
    expect(s(line!.availableAfterDemand)).toBe("-2");
    expect(s(line!.shortage)).toBe("2");
  });

  it("sin stock registrado, todo es faltante; con sobrante, faltante 0", () => {
    const lines = aggregateMaterialDemand(new Map([["sal", "5"]]), [
      { rawMaterialId: "harina", quantity: "3" },
      { rawMaterialId: "sal", quantity: "1" },
    ]);
    expect(lines.map((l) => [l.rawMaterialId, s(l.shortage)])).toEqual([
      ["harina", "3"],
      ["sal", "0"],
    ]);
  });
});

describe("invalidación por merma y transformación (gates O y P)", () => {
  const res = (
    id: string,
    quantity: string,
    priority: "NORMAL" | "HIGH" | "URGENT",
    days: number,
  ) => ({
    id,
    quantity,
    priority,
    requestedAt: at(days),
    reservedAt: now,
  });

  it("§82: lote 100, reservado 80, merma 50 → la reserva se invalida y se conservan 50", () => {
    const out = reservationsToInvalidate([res("r1", "80", "NORMAL", 3)], "50");
    expect(out.map((o) => [o.reservation.id, s(o.keep)])).toEqual([["r1", "50"]]);
  });

  it("sin exceso no invalida nada", () => {
    expect(reservationsToInvalidate([res("r1", "40", "NORMAL", 3)], "50")).toEqual([]);
  });

  it("sacrifica primero menor prioridad y entrega más lejana", () => {
    const out = reservationsToInvalidate(
      [
        res("urgente", "40", "URGENT", 9),
        res("lejano", "30", "NORMAL", 9),
        res("cerca", "30", "NORMAL", 1),
      ],
      "50",
    );
    expect(out.map((o) => [o.reservation.id, s(o.keep)])).toEqual([
      ["lejano", "0"],
      ["cerca", "10"],
    ]);
  });

  it("§83: lote 100 con 80 reservados → sólo 20 transformables", () => {
    expect(s(freeLotQuantity("100", "80"))).toBe("20");
    expect(s(freeLotQuantity("50", "80"))).toBe("0");
  });
});
