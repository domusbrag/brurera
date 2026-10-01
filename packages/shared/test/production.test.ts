import { describe, expect, it } from "vitest";
import { PERMISSIONS as P } from "../src/permissions";
import {
  createProductionOrderSchema,
  extraMaterialSchema,
  listItemWithoutCosts,
  productionActualsSchema,
  withoutProductionCosts,
  type ProductionOrderDto,
  type ProductionOrderListItemDto,
} from "../src/production";
import { SYSTEM_ROLES } from "../src/roles";

const UUID = "11111111-1111-4111-8111-111111111111";
const unit = { id: UUID, code: "kg", symbol: "kg" };

describe("esquemas de producción", () => {
  const order = {
    productId: UUID,
    scheduledFor: "2026-10-01",
    plannedOutputQuantity: "100",
    sourceWarehouseId: UUID,
    outputWarehouseId: UUID,
  };

  it("cantidad a producir > 0 con coma decimal; fecha obligatoria", () => {
    expect(
      createProductionOrderSchema.safeParse({ ...order, plannedOutputQuantity: "96,5" }).data
        ?.plannedOutputQuantity,
    ).toBe("96.5");
    expect(
      createProductionOrderSchema.safeParse({ ...order, plannedOutputQuantity: "0" }).success,
    ).toBe(false);
    expect(createProductionOrderSchema.safeParse({ ...order, scheduledFor: "" }).success).toBe(
      false,
    );
  });

  it("consumo real ≥ 0; salida real con cantidad y unidad juntas", () => {
    const line = (quantity: string) => ({ lines: [{ lineId: UUID, unitId: UUID, quantity }] });
    expect(productionActualsSchema.safeParse(line("0")).success).toBe(true);
    expect(productionActualsSchema.safeParse(line("-1")).success).toBe(false);
    expect(productionActualsSchema.safeParse({ actualOutputQuantity: "96" }).success).toBe(false);
    expect(
      productionActualsSchema.safeParse({ actualOutputQuantity: "96", actualOutputUnitId: UUID })
        .success,
    ).toBe(true);
  });

  it("el consumo extra exige motivo", () => {
    const extra = { rawMaterialId: UUID, quantity: "1", unitId: UUID };
    expect(extraMaterialSchema.safeParse(extra).success).toBe(false);
    expect(extraMaterialSchema.safeParse({ ...extra, notes: "  " }).success).toBe(false);
    expect(extraMaterialSchema.safeParse({ ...extra, notes: "Masa seca" }).success).toBe(true);
  });
});

describe("visibilidad de costos", () => {
  const line = {
    id: UUID,
    lineNumber: 1,
    lineType: "RECIPE" as const,
    rawMaterial: { id: UUID, code: "MP-0001", name: "Harina", active: true },
    baseUnit: unit,
    plannedQuantity: "75",
    plannedUnit: unit,
    plannedNormalized: "75",
    actualQuantity: "77",
    actualUnit: unit,
    actualNormalized: "77",
    variance: { quantity: "2", percentage: "2.6667" },
    plannedUnitCost: "1000",
    plannedCostSource: "PURCHASE_MOVING_AVERAGE" as const,
    plannedCost: "75000",
    actualUnitCost: "1000",
    actualCost: "77000",
    notes: null,
    consumptionMovementId: UUID,
  };

  it("withoutProductionCosts quita importes y conserva cantidades y diferencias", () => {
    const dto = {
      materials: [line],
      costs: {
        currency: "ARS",
        planned: null,
        actual: { total: "77000", unit: "802" },
        variance: null,
      },
      canSeeCosts: true,
      actualOutputNormalized: "96",
    } as unknown as ProductionOrderDto;
    const redacted = withoutProductionCosts(dto);
    expect(redacted.costs).toBeNull();
    expect(redacted.canSeeCosts).toBe(false);
    expect(redacted.materials[0]).toMatchObject({
      plannedUnitCost: null,
      plannedCostSource: null,
      plannedCost: null,
      actualUnitCost: null,
      actualCost: null,
      actualNormalized: "77",
      variance: { quantity: "2", percentage: "2.6667" },
    });
    expect(redacted.actualOutputNormalized).toBe("96");
    expect(dto.materials[0]!.actualCost).toBe("77000");
  });

  it("listItemWithoutCosts quita el costo real del listado", () => {
    const item = { code: "OP-0001", actualMaterialCost: "77400" } as ProductionOrderListItemDto;
    expect(listItemWithoutCosts(item)).toMatchObject({ code: "OP-0001", actualMaterialCost: null });
  });

  it("roles: Producción opera sin costos; Administración lee con costos; Compras no ve producción", () => {
    const perms = (code: string) => SYSTEM_ROLES.find((r) => r.code === code)!.permissions;
    expect(perms("PRODUCTION")).toEqual(
      expect.arrayContaining([
        P.PRODUCTION_ORDERS_CREATE,
        P.PRODUCTION_ORDERS_PLAN,
        P.PRODUCTION_ORDERS_START,
        P.PRODUCTION_ORDERS_COMPLETE,
        P.PRODUCTION_ORDERS_CANCEL,
        P.PRODUCTION_ORDERS_ADD_EXTRA_MATERIAL,
      ]),
    );
    expect(perms("PRODUCTION")).not.toContain(P.PRODUCTION_COST_READ);
    expect(perms("ADMINISTRATION")).toEqual(
      expect.arrayContaining([P.PRODUCTION_ORDERS_READ, P.PRODUCTION_COST_READ]),
    );
    expect(perms("ADMINISTRATION")).not.toContain(P.PRODUCTION_ORDERS_UPDATE);
    expect(perms("PURCHASING").some((p) => p.startsWith("production"))).toBe(false);
    expect(perms("WAREHOUSE")).toContain(P.INVENTORY_READ);
    expect(perms("ADMIN")).toEqual(expect.arrayContaining(Object.values(P)));
  });
});
