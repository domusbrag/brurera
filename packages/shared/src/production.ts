import { z } from "zod";
import type { CostSourceDto, CostStatusDto, PersonRefDto, UnitRefDto } from "./recipes";
import {
  decimalString,
  optionalDate,
  optionalText,
  optionalUuid,
  requiredText,
  uuid,
} from "./validation";

/*
 * Producción (Fase 4). Los esquemas validan forma y rangos; la empresa, la
 * receta, las unidades compatibles, los estados y el stock los valida la API
 * (con @bakery/domain y la base).
 */

export const PRODUCTION_STATUSES = [
  "DRAFT",
  "PLANNED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;
export type ProductionStatusDto = (typeof PRODUCTION_STATUSES)[number];
export const PRODUCTION_STATUS_LABELS: Record<ProductionStatusDto, string> = {
  DRAFT: "Borrador",
  PLANNED: "Planificada",
  IN_PROGRESS: "En curso",
  COMPLETED: "Completada",
  CANCELLED: "Cancelada",
};

export const PRODUCTION_LINE_TYPE_LABELS = {
  RECIPE: "Receta",
  EXTRA: "Consumo extra",
} as const;
export type ProductionLineTypeDto = keyof typeof PRODUCTION_LINE_TYPE_LABELS;

/** Fecha de calendario obligatoria (AAAA-MM-DD). */
const requiredDate = () =>
  optionalDate().refine((v): v is string => v !== null, { message: "Obligatorio" });

/** Cantidad a producir u obtenida: > 0, hasta 6 decimales. */
export const outputQuantitySchema = () => decimalString({ integers: 12, scale: 6, positive: true });
/** Consumo real: ≥ 0 (un ingrediente puede no usarse), hasta 6 decimales. */
export const consumptionQuantitySchema = () => decimalString({ integers: 12, scale: 6 });

export const createProductionOrderSchema = z.object({
  productId: uuid(),
  scheduledFor: requiredDate(),
  plannedOutputQuantity: outputQuantitySchema(),
  /** Unidad de la cantidad; por defecto la unidad de venta del producto. */
  plannedOutputUnitId: optionalUuid(),
  /** Versión de receta elegida; por defecto la vigente en la fecha programada. */
  recipeVersionId: optionalUuid(),
  sourceWarehouseId: uuid(),
  outputWarehouseId: uuid(),
  responsibleEmployeeId: optionalUuid(),
  batchCode: optionalText(40),
  notes: optionalText(1000),
});
export type CreateProductionOrderInput = z.infer<typeof createProductionOrderSchema>;

/**
 * Edición. En DRAFT se puede cambiar todo; desde PLANNED sólo responsable, lote
 * y notas (el resto queda fijado al planificar).
 */
export const updateProductionOrderSchema = z
  .object({
    productId: uuid(),
    scheduledFor: requiredDate(),
    plannedOutputQuantity: outputQuantitySchema(),
    plannedOutputUnitId: optionalUuid(),
    recipeVersionId: optionalUuid(),
    sourceWarehouseId: uuid(),
    outputWarehouseId: uuid(),
    responsibleEmployeeId: optionalUuid(),
    batchCode: optionalText(40),
    notes: optionalText(1000),
  })
  .partial();
export type UpdateProductionOrderInput = z.infer<typeof updateProductionOrderSchema>;

/** Campos que se pueden cambiar con la orden planificada o en curso. */
export const PRODUCTION_OPERATIONAL_FIELDS = [
  "responsibleEmployeeId",
  "batchCode",
  "notes",
] as const;

export const cancelProductionSchema = z.object({ reason: optionalText(500) });

export const productionActualsSchema = z
  .object({
    lines: z
      .array(
        z.object({
          lineId: uuid(),
          quantity: consumptionQuantitySchema(),
          unitId: uuid(),
        }),
      )
      .max(200)
      .optional(),
    actualOutputQuantity: outputQuantitySchema().optional(),
    actualOutputUnitId: uuid().optional(),
    notes: optionalText(1000),
  })
  .refine((v) => (v.actualOutputQuantity === undefined) === (v.actualOutputUnitId === undefined), {
    message: "Indicá cantidad y unidad de la salida real",
    path: ["actualOutputUnitId"],
  });
export type ProductionActualsInput = z.infer<typeof productionActualsSchema>;

export const extraMaterialSchema = z.object({
  rawMaterialId: uuid(),
  quantity: outputQuantitySchema(),
  unitId: uuid(),
  /** Motivo obligatorio: queda en la orden y en la auditoría. */
  notes: requiredText(500),
});
export type ExtraMaterialInput = z.infer<typeof extraMaterialSchema>;

const searchField = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => (v ? v : undefined));

export const productionListQuerySchema = z.object({
  search: searchField,
  status: z.enum([...PRODUCTION_STATUSES, "open", "all"]).default("all"),
  productId: uuid().optional(),
  responsibleEmployeeId: uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/* ---------- Respuestas ---------- */

export interface ProductionRefDto {
  id: string;
  code: string;
  name: string;
}

export interface ProductionOrderListItemDto {
  id: string;
  code: string;
  status: ProductionStatusDto;
  product: ProductionRefDto;
  scheduledFor: string;
  plannedOutputNormalized: string;
  actualOutputNormalized: string | null;
  saleUnit: UnitRefDto;
  responsible: { id: string; name: string } | null;
  recipeVersion: { id: string; versionNumber: number };
  batchCode: string | null;
  currency: string;
  /** null sin production.cost.read o si no está completada. */
  actualMaterialCost: string | null;
}

export interface QuantityVarianceDto {
  quantity: string;
  /** null si no había plan (consumo extra). */
  percentage: string | null;
}

export interface ProductionMaterialLineDto {
  /** null en el plan en vivo de un borrador (todavía no hay líneas guardadas). */
  id: string | null;
  lineNumber: number;
  lineType: ProductionLineTypeDto;
  rawMaterial: { id: string; code: string; name: string; active: boolean };
  baseUnit: UnitRefDto;
  plannedQuantity: string | null;
  plannedUnit: UnitRefDto | null;
  plannedNormalized: string | null;
  actualQuantity: string | null;
  actualUnit: UnitRefDto | null;
  actualNormalized: string | null;
  variance: QuantityVarianceDto | null;
  /** Costos: null sin production.cost.read. */
  plannedUnitCost: string | null;
  plannedCostSource: CostSourceDto | null;
  plannedCost: string | null;
  actualUnitCost: string | null;
  actualCost: string | null;
  notes: string | null;
  consumptionMovementId: string | null;
}

export interface AvailabilityLineDto {
  rawMaterial: { id: string; code: string; name: string };
  baseUnit: UnitRefDto;
  /** Necesario: plan (PLANNED/DRAFT) o consumo real cargado (IN_PROGRESS). */
  required: string;
  available: string;
  /** disponible − necesario (negativo = faltante). */
  difference: string;
  missing: string;
  status: "OK" | "SHORT";
}

export interface ProductionAvailabilityDto {
  warehouse: { id: string; code: string; name: string };
  basis: "PLANNED" | "ACTUAL";
  lines: AvailabilityLineDto[];
  sufficient: boolean;
}

export interface ProductionCostsDto {
  currency: string;
  planned: {
    status: CostStatusDto;
    total: string | null;
    unit: string | null;
    missing: string[];
  } | null;
  actual: { total: string; unit: string } | null;
  /**
   * En curso: costo material ESTIMADO del consumo cargado al promedio vigente de
   * cada materia prima (el real se fija al completar). unit: null sin salida real.
   */
  estimated: { status: CostStatusDto; total: string | null; unit: string | null } | null;
  /** real − esperado (sólo con ambos completos). */
  variance: { total: string; unit: string; percentage: string | null } | null;
}

export interface ProductionIssueDto {
  code: string;
  message: string;
}

export interface ProductionOrderDto {
  id: string;
  code: string;
  status: ProductionStatusDto;
  product: {
    id: string;
    code: string;
    name: string;
    active: boolean;
    controlsStock: boolean;
  };
  recipe: { id: string; name: string };
  recipeVersion: {
    id: string;
    versionNumber: number;
    status: "DRAFT" | "ACTIVE" | "ARCHIVED";
    yieldQuantity: string;
    yieldUnit: UnitRefDto;
  };
  /** Versión vigente hoy para la fecha programada, si es distinta de la elegida (sólo DRAFT). */
  suggestedVersion: { id: string; versionNumber: number } | null;
  sourceWarehouse: { id: string; code: string; name: string };
  outputWarehouse: { id: string; code: string; name: string };
  scheduledFor: string;
  plannedOutputQuantity: string;
  plannedOutputUnit: UnitRefDto;
  plannedOutputNormalized: string;
  saleUnit: UnitRefDto;
  scaleFactor: string | null;
  theoreticalWastePercentage: string | null;
  actualOutputQuantity: string | null;
  actualOutputUnit: UnitRefDto | null;
  actualOutputNormalized: string | null;
  output: { variance: string; variancePercentage: string; yieldPerformance: string } | null;
  batchCode: string | null;
  /** Lote de producto terminado que originó al completarse (Fase 4.5). */
  productLot: {
    id: string;
    code: string;
    conservationState: "FRESH" | "REFRIGERATED" | "FROZEN" | "THAWED";
    usableUntil: string | null;
  } | null;
  responsible: { id: string; name: string } | null;
  notes: string | null;
  cancelReason: string | null;
  /** Líneas guardadas, o el plan calculado en vivo en DRAFT (`materialsArePreview`). */
  materials: ProductionMaterialLineDto[];
  materialsArePreview: boolean;
  availability: ProductionAvailabilityDto | null;
  /** null sin production.cost.read. */
  costs: ProductionCostsDto | null;
  /** Bloqueos para el próximo paso (materia prima inactiva, producto sin stock…). */
  issues: ProductionIssueDto[];
  createdAt: string;
  createdBy: PersonRefDto | null;
  plannedAt: string | null;
  plannedBy: PersonRefDto | null;
  startedAt: string | null;
  startedBy: PersonRefDto | null;
  completedAt: string | null;
  completedBy: PersonRefDto | null;
  cancelledAt: string | null;
  cancelledBy: PersonRefDto | null;
  canSeeCosts: boolean;
}

export interface ProductionCostComparisonDto {
  currency: string;
  output: {
    planned: string;
    actual: string | null;
    unit: UnitRefDto;
    variance: string | null;
    variancePercentage: string | null;
    yieldPerformance: string | null;
  };
  materials: {
    lineType: ProductionLineTypeDto;
    rawMaterial: { id: string; code: string; name: string };
    baseUnit: UnitRefDto;
    plannedQuantity: string | null;
    actualQuantity: string | null;
    variance: QuantityVarianceDto | null;
    plannedCost: string | null;
    actualCost: string | null;
  }[];
  costs: ProductionCostsDto;
}

export interface ResponsibleOptionDto {
  id: string;
  name: string;
}

/**
 * Quita los importes de una orden para quien no tiene production.cost.read.
 * Las cantidades operativas (plan, real, diferencias, stock) se conservan.
 * La API la aplica siempre antes de responder.
 */
export function withoutProductionCosts(order: ProductionOrderDto): ProductionOrderDto {
  return {
    ...order,
    costs: null,
    canSeeCosts: false,
    materials: order.materials.map((line) => ({
      ...line,
      plannedUnitCost: null,
      plannedCostSource: null,
      plannedCost: null,
      actualUnitCost: null,
      actualCost: null,
    })),
  };
}

export function listItemWithoutCosts(item: ProductionOrderListItemDto): ProductionOrderListItemDto {
  return { ...item, actualMaterialCost: null };
}
