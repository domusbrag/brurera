import { describe, expect, it } from "vitest";
import { applyInbound } from "../src/inventory";
import { applyLotMovement, lotOutflow } from "../src/lots";
import type { LotWithCommitment } from "../src/orders";
import {
  accountBalanceView,
  allocateAdvances,
  allocateSaleLine,
  assertApplicationFits,
  assertDeliverable,
  averageMaterialCost,
  creditLimitCheck,
  debitCredit,
  derivePaymentStatus,
  freeSellableQuantity,
  isPriceOverride,
  lineAmounts,
  materialMargin,
  orderDeliveryStatus,
  resolveUnitPrice,
  saleBalanceDue,
  saleMaterialCost,
  totals,
} from "../src/sales";

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

describe("§91 costo por lote específico", () => {
  // Lote A: 100 u × $400 = $40.000; Lote B: 100 u × $500 = $50.000.
  const lotA = { quantity: "100", value: "40000", unitCost: "400" };
  const lotB = { quantity: "100", value: "50000", unitCost: "500" };

  it("vender 80 de A + 40 de B cuesta $52.000 (no el promedio)", () => {
    const fromA = lotOutflow({
      lotQuantity: lotA.quantity,
      lotValue: lotA.value,
      unitCost: lotA.unitCost,
      quantity: "80",
    });
    const fromB = lotOutflow({
      lotQuantity: lotB.quantity,
      lotValue: lotB.value,
      unitCost: lotB.unitCost,
      quantity: "40",
    });
    expect(fromA.value.toString()).toBe("32000");
    expect(fromB.value.toString()).toBe("20000");
    const cost = saleMaterialCost([{ materialCost: fromA.value }, { materialCost: fromB.value }]);
    expect(cost.toString()).toBe("52000");
    // El promedio global (450) daría 54.000: NO es el costo de la venta.
    expect(cost.toString()).not.toBe("54000");
  });

  it("§92 stock remanente: 20 de A + 60 de B = $38.000; promedio derivado 475", () => {
    let state = { quantity: "0", inventoryValue: "0", movingAverageCost: null as string | null };
    const prodA = applyInbound(state, "100", "400", { totalValue: "40000" });
    state = {
      quantity: prodA.after.quantity.toString(),
      inventoryValue: prodA.after.inventoryValue.toString(),
      movingAverageCost: prodA.after.movingAverageCost?.toString() ?? null,
    };
    const prodB = applyInbound(state, "100", "500", { totalValue: "50000" });
    expect(prodB.after.inventoryValue.toString()).toBe("90000");
    expect(prodB.after.movingAverageCost?.toString()).toBe("450");
    const sale = applyLotMovement(
      {
        quantity: prodB.after.quantity,
        inventoryValue: prodB.after.inventoryValue,
        movingAverageCost: prodB.after.movingAverageCost,
      },
      "-120",
      "-52000",
    );
    expect(sale.after.quantity.toString()).toBe("80");
    expect(sale.after.inventoryValue.toString()).toBe("38000");
    expect(sale.after.movingAverageCost?.toString()).toBe("475");
    expect(averageMaterialCost("80", "38000")?.toString()).toBe("475");
    expect(sale.averageChanged).toBe(true);
  });

  it("sin stock el promedio derivado es null", () => {
    const out = applyLotMovement(
      { quantity: "10", inventoryValue: "1000", movingAverageCost: "100" },
      "-10",
      "-1000",
    );
    expect(out.after.movingAverageCost).toBeNull();
    expect(averageMaterialCost("0", "0")).toBeNull();
  });
});

describe("§93 margen sobre materiales", () => {
  it("precio $800 × 120 = $96.000; costo $52.000 → margen $44.000 / 45,83 %", () => {
    const amounts = lineAmounts({ quantity: "120", unitPrice: "800" });
    expect(amounts.net.toString()).toBe("96000");
    const m = materialMargin(amounts.net, "52000");
    expect(m.amount.toString()).toBe("44000");
    expect(m.percentage?.toFixed(2)).toBe("45.83");
    expect(m.percentage?.toString()).toBe("45.8333");
  });

  it("margen negativo permitido", () => {
    const m = materialMargin("300", "400");
    expect(m.amount.toString()).toBe("-100");
    expect(m.percentage?.toString()).toBe("-33.3333");
  });

  it("neto 0: sin porcentaje", () => {
    expect(materialMargin("0", "10").percentage).toBeNull();
  });
});

describe("precios", () => {
  it("prioridad: acordado → lista del cliente → lista default → producto", () => {
    expect(
      resolveUnitPrice({ agreed: "700", customerList: "750", defaultList: "780", productPrice: "800" }),
    ).toMatchObject({ source: "ORDER_QUOTE" });
    expect(
      resolveUnitPrice({ customerList: "750", defaultList: "780", productPrice: "800" }).source,
    ).toBe("CUSTOMER_PRICE_LIST");
    expect(resolveUnitPrice({ defaultList: "780", productPrice: "800" }).unitPrice.toString()).toBe(
      "780",
    );
    expect(resolveUnitPrice({ customerList: null, productPrice: "800" }).source).toBe(
      "PRODUCT_PRICE",
    );
  });

  it("importes de línea con descuento y redondeo a 2 decimales", () => {
    const l = lineAmounts({ quantity: "3", unitPrice: "333.335", discountAmount: "0.01" });
    expect(l.gross.toFixed(2)).toBe("1000.01");
    expect(l.net.toFixed(2)).toBe("1000.00");
    expect(() => lineAmounts({ quantity: "1", unitPrice: "10", discountAmount: "11" })).toThrow(
      expect.objectContaining({ code: "DISCOUNT_EXCEEDS_AMOUNT" }),
    );
    const t = totals([l, lineAmounts({ quantity: "2", unitPrice: "5" })]);
    expect(t.subtotal.toFixed(2)).toBe("1010.01");
    expect(t.discountTotal.toFixed(2)).toBe("0.01");
    expect(t.total.toFixed(2)).toBe("1010.00");
  });

  it("override = precio o descuento distinto de lo acordado", () => {
    expect(isPriceOverride({ unitPrice: "800", agreedUnitPrice: "800.00" })).toBe(false);
    expect(isPriceOverride({ unitPrice: "750", agreedUnitPrice: "800" })).toBe(true);
    expect(
      isPriceOverride({ unitPrice: "800", discountAmount: "5", agreedUnitPrice: "800" }),
    ).toBe(true);
  });
});

describe("asignación de lotes a una venta", () => {
  it("consume primero las reservas del pedido y no rehace FEFO global", () => {
    const reserved = lot("R", "50", 5, { committed: "50" });
    const older = lot("F", "100", 1);
    const r = allocateSaleLine({
      quantity: "30",
      reservations: [{ id: "res-1", lot: reserved, remaining: "50" }],
      freeLots: [older],
      at: now,
    });
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0]).toMatchObject({ reservationId: "res-1" });
    expect(r.allocations[0]!.lot.id).toBe("R");
    expect(r.fromReservations.toString()).toBe("30");
    expect(r.missing.toString()).toBe("0");
  });

  it("lo que falta sale de stock libre FEFO y nunca de lo reservado a otro", () => {
    const reserved = lot("R", "50", 5, { committed: "50" });
    const otherOrder = lot("X", "40", 1, { committed: "40" });
    const free = lot("F", "100", 3, { committed: "20" });
    const r = allocateSaleLine({
      quantity: "100",
      reservations: [{ id: "res-1", lot: reserved, remaining: "50" }],
      freeLots: [otherOrder, free],
      at: now,
    });
    expect(r.allocations.map((a) => [a.lot.id, a.quantity.toString()])).toEqual([
      ["R", "50"],
      ["F", "50"],
    ]);
    expect(r.missing.toString()).toBe("0");
  });

  it("venta directa sin stock libre suficiente informa faltante", () => {
    const free = lot("F", "100", 3, { committed: "70" });
    const r = allocateSaleLine({ quantity: "40", reservations: [], freeLots: [free], at: now });
    expect(r.missing.toString()).toBe("10");
    expect(freeSellableQuantity([free], now).toString()).toBe("30");
  });

  it("excluye vencidos, bloqueados y otra conservación", () => {
    const lots = [
      lot("V", "10", -1),
      lot("B", "10", 3, { qualityStatus: "BLOCKED" }),
      lot("Z", "10", 3, { conservationState: "FROZEN" }),
      lot("OK", "10", 3),
    ];
    expect(freeSellableQuantity(lots, now, "FRESH").toString()).toBe("10");
    const r = allocateSaleLine({
      quantity: "5",
      reservations: [],
      freeLots: lots,
      at: now,
      requested: "FRESH",
    });
    expect(r.allocations.map((a) => a.lot.id)).toEqual(["OK"]);
  });

  it("una reserva sobre un lote vencido no se usa", () => {
    const expired = lot("E", "10", -1, { committed: "10" });
    const r = allocateSaleLine({
      quantity: "5",
      reservations: [{ id: "res", lot: expired, remaining: "10" }],
      freeLots: [],
      at: now,
    });
    expect(r.missing.toString()).toBe("5");
  });
});

describe("entregas", () => {
  it("no se puede entregar más que lo pendiente", () => {
    expect(assertDeliverable({ ordered: "100", delivered: "60", quantity: "40" }).toString()).toBe(
      "40",
    );
    expect(() => assertDeliverable({ ordered: "100", delivered: "60", quantity: "41" })).toThrow(
      expect.objectContaining({ code: "DELIVERY_EXCEEDS_PENDING" }),
    );
  });

  it("estado del pedido según lo entregado", () => {
    expect(
      orderDeliveryStatus([
        { ordered: "100", delivered: "100" },
        { ordered: "10", delivered: "0" },
      ]),
    ).toBe("PARTIALLY_DELIVERED");
    expect(orderDeliveryStatus([{ ordered: "100", delivered: "100" }])).toBe("DELIVERED");
  });
});

describe("cobros", () => {
  it("estado de cobro derivado de lo aplicado", () => {
    expect(derivePaymentStatus("1000", "0")).toBe("UNPAID");
    expect(derivePaymentStatus("1000", "400")).toBe("PARTIALLY_PAID");
    expect(derivePaymentStatus("1000", "1000")).toBe("PAID");
    expect(derivePaymentStatus("0", "0")).toBe("PAID");
    expect(saleBalanceDue("1000", "400").toString()).toBe("600");
  });

  it("PAYMENT_EXCEEDS_SALE_BALANCE", () => {
    expect(() => assertApplicationFits({ total: "1000", applied: "400", amount: "600.01" })).toThrow(
      expect.objectContaining({ code: "PAYMENT_EXCEEDS_SALE_BALANCE" }),
    );
    expect(() => assertApplicationFits({ total: "1000", applied: "0", amount: "0" })).toThrow(
      expect.objectContaining({ code: "AMOUNT_NOT_POSITIVE" }),
    );
    expect(() =>
      assertApplicationFits({ total: "1000", applied: "400", amount: "600" }),
    ).not.toThrow();
  });

  it("señas: se aplican hasta el total de la venta; el excedente queda a favor", () => {
    const res = allocateAdvances(
      [
        { id: "a", available: "300" },
        { id: "b", available: "500" },
      ],
      "600",
    );
    expect(res.map((r) => [r.advance.id, r.amount.toString()])).toEqual([
      ["a", "300"],
      ["b", "300"],
    ]);
    expect(allocateAdvances([{ id: "a", available: "300" }], "0")).toEqual([]);
  });
});

describe("cuenta corriente", () => {
  it("saldo con signo: positivo debe, negativo crédito a favor", () => {
    expect(accountBalanceView("1500")).toMatchObject({ kind: "DEBT" });
    expect(accountBalanceView("-200").amount.toString()).toBe("200");
    expect(accountBalanceView("-200").kind).toBe("CREDIT");
    expect(accountBalanceView("0").kind).toBe("NONE");
    expect(debitCredit("100").debit?.toString()).toBe("100");
    expect(debitCredit("-100").credit?.toString()).toBe("100");
  });

  it("límite de crédito: sólo advierte", () => {
    const r = creditLimitCheck({
      creditLimit: "10000",
      currentBalance: "8000",
      saleTotal: "5000",
      initialPayment: "1000",
    });
    expect(r.projectedBalance.toString()).toBe("12000");
    expect(r.exceeded).toBe(true);
    expect(r.excess.toString()).toBe("2000");
    expect(
      creditLimitCheck({ creditLimit: null, currentBalance: "1e9", saleTotal: "1" }).exceeded,
    ).toBe(false);
  });
});
