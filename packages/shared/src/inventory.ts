import { z } from "zod";
import type { CostSourceDto, PersonRefDto, UnitRefDto } from "./recipes";
import { optionalPastInstant } from "./purchases";
import { decimalString, optionalDecimalString, optionalText, uuid } from "./validation";

/*
 * Inventario (Fases 3 y 4). El stock sólo cambia con movimientos: no hay ningún
 * esquema que permita escribir un saldo. Las cantidades se expresan en la unidad
 * base de la materia prima (o de venta del producto terminado) y viajan como string.
 */

export const STOCK_ITEM_TYPES = ["RAW_MATERIAL", "PRODUCT"] as const;
export type StockItemTypeDto = (typeof STOCK_ITEM_TYPES)[number];
export const STOCK_ITEM_TYPE_LABELS: Record<StockItemTypeDto, string> = {
  RAW_MATERIAL: "Materia prima",
  PRODUCT: "Producto terminado",
};

export const STOCK_MOVEMENT_TYPE_LABELS = {
  INITIAL_STOCK: "Stock inicial",
  PURCHASE_RECEIPT: "Recepción de compra",
  ADJUSTMENT_POSITIVE: "Ajuste positivo",
  ADJUSTMENT_NEGATIVE: "Ajuste negativo",
  WASTE: "Merma",
  PRODUCTION_CONSUMPTION: "Consumo de producción",
  PRODUCTION_OUTPUT: "Producción terminada",
} as const;
export type StockMovementTypeDto = keyof typeof STOCK_MOVEMENT_TYPE_LABELS;
export const STOCK_MOVEMENT_TYPES_DTO = Object.keys(
  STOCK_MOVEMENT_TYPE_LABELS,
) as StockMovementTypeDto[];

export const ADJUSTMENT_REASONS = [
  "PHYSICAL_COUNT",
  "DATA_CORRECTION",
  "BREAKAGE",
  "OTHER",
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReason, string> = {
  PHYSICAL_COUNT: "Recuento físico",
  DATA_CORRECTION: "Corrección de datos",
  BREAKAGE: "Rotura",
  OTHER: "Otro",
};

export const WASTE_REASONS = ["EXPIRED", "DAMAGED", "PRODUCTION_LOSS", "QUALITY", "OTHER"] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];
export const WASTE_REASON_LABELS: Record<WasteReason, string> = {
  EXPIRED: "Vencimiento",
  DAMAGED: "Daño",
  PRODUCTION_LOSS: "Pérdida en producción",
  QUALITY: "Calidad",
  OTHER: "Otro",
};

export const STOCK_STATUS_LABELS = {
  OK: "OK",
  LOW: "Bajo mínimo",
  OUT_OF_STOCK: "Sin stock",
} as const;
export type StockStatusDto = keyof typeof STOCK_STATUS_LABELS;

/** Cantidad en unidad base: > 0, hasta 6 decimales. */
export const stockQuantitySchema = () => decimalString({ integers: 14, scale: 6, positive: true });
/** Costo de valorización por unidad base: ≥ 0, hasta 6 decimales. */
export const valuationCostSchema = () => decimalString({ integers: 12, scale: 6 });

const operationFields = {
  rawMaterialId: uuid(),
  warehouseId: uuid(),
  quantity: stockQuantitySchema(),
  /** Fecha de la operación; por defecto, ahora. */
  occurredAt: optionalPastInstant(),
  notes: optionalText(1000),
};

/** Stock inicial: siempre con costo unitario de valorización. */
export const initialStockSchema = z.object({ ...operationFields, unitCost: valuationCostSchema() });
export type InitialStockInput = z.infer<typeof initialStockSchema>;

/**
 * Ajuste. Positivo: sin costo usa el promedio vigente (si no hay, lo exige).
 * Negativo: sale al promedio vigente (el costo no se indica).
 */
export const adjustmentSchema = z
  .object({
    ...operationFields,
    direction: z.enum(["POSITIVE", "NEGATIVE"]),
    reason: z.enum(ADJUSTMENT_REASONS),
    unitCost: optionalDecimalString({ integers: 12, scale: 6 }),
  })
  .refine((v) => v.direction === "POSITIVE" || v.unitCost === null, {
    message: "Una salida se valoriza al costo promedio vigente",
    path: ["unitCost"],
  });
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;

export const wasteSchema = z.object({ ...operationFields, reason: z.enum(WASTE_REASONS) });
export type WasteInput = z.infer<typeof wasteSchema>;

const searchField = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => (v ? v : undefined));
const pageFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export const inventoryListQuerySchema = z.object({
  search: searchField,
  warehouseId: uuid().optional(),
  stockStatus: z.enum(["OK", "LOW", "OUT_OF_STOCK", "below_minimum", "all"]).default("all"),
  ...pageFields,
});

export const movementListQuerySchema = z.object({
  itemType: z.enum(STOCK_ITEM_TYPES).optional(),
  rawMaterialId: uuid().optional(),
  productId: uuid().optional(),
  warehouseId: uuid().optional(),
  movementType: z.enum(STOCK_MOVEMENT_TYPES_DTO as [StockMovementTypeDto]).optional(),
  referenceId: uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  search: searchField,
  ...pageFields,
});

export const lowStockQuerySchema = z.object({ search: searchField, ...pageFields });
export const productStockQuerySchema = z.object({
  search: searchField,
  warehouseId: uuid().optional(),
  /** "in_stock": sólo productos con existencia. */
  stock: z.enum(["all", "in_stock"]).default("all"),
  ...pageFields,
});
export const costHistoryQuerySchema = z.object({ ...pageFields });

/* ---------- Respuestas ---------- */

/** Valorización: null cuando el usuario no tiene inventory.cost.read. */
export interface InventoryValuationDto {
  movingAverageCost: string | null;
  inventoryValue: string | null;
}

export interface InventoryItemDto extends InventoryValuationDto {
  /** Id de la materia prima (las filas son materias primas). */
  id: string;
  rawMaterial: { id: string; code: string; name: string; active: boolean };
  baseUnit: UnitRefDto;
  /** Depósito filtrado, o null si la cantidad es el total de la empresa. */
  warehouse: { id: string; code: string; name: string } | null;
  /** Cantidad en el depósito filtrado o total de la empresa. */
  quantity: string;
  /** Total de la empresa (el mínimo se compara contra este). */
  companyQuantity: string;
  minimumStock: string;
  status: StockStatusDto;
  warehouseCount: number;
}

export interface StockMovementDto {
  id: string;
  sequence: number;
  occurredAt: string;
  createdAt: string;
  movementType: StockMovementTypeDto;
  itemType: StockItemTypeDto;
  /** Materia prima o producto movido (el que corresponda a itemType). */
  item: { id: string; code: string; name: string };
  rawMaterial: { id: string; code: string; name: string } | null;
  product: { id: string; code: string; name: string } | null;
  warehouse: { id: string; code: string; name: string };
  /** Con signo, en unidad base. */
  quantity: string;
  baseUnit: UnitRefDto;
  /** Saldo del depósito después del movimiento. */
  balanceAfter: string;
  unitCost: string | null;
  totalValue: string | null;
  reason: string | null;
  notes: string | null;
  reference: { type: string; id: string; label: string } | null;
  actor: PersonRefDto | null;
}

export interface CostHistoryEntryDto {
  id: number;
  createdAt: string;
  movementId: string;
  movementType: StockMovementTypeDto;
  reference: { type: string; id: string; label: string } | null;
  quantityBefore: string;
  quantityAfter: string;
  valueBefore: string;
  valueAfter: string;
  averageBefore: string | null;
  averageAfter: string | null;
  averageChanged: boolean;
  actor: PersonRefDto | null;
}

export interface InventoryCostDto {
  rawMaterial: { id: string; code: string; name: string };
  baseUnit: UnitRefDto;
  currency: string;
  quantity: string;
  inventoryValue: string;
  movingAverageCost: string | null;
  lastUpdatedAt: string | null;
  referenceCost: string | null;
  effectiveCost: string | null;
  effectiveCostSource: CostSourceDto | null;
}

export interface InventoryDetailDto {
  rawMaterial: {
    id: string;
    code: string;
    name: string;
    active: boolean;
    minimumStock: string;
    preferredSupplier: { id: string; name: string } | null;
  };
  baseUnit: UnitRefDto;
  currency: string;
  quantity: string;
  status: StockStatusDto;
  shortage: string;
  byWarehouse: { warehouse: { id: string; code: string; name: string }; quantity: string }[];
  movingAverageCost: string | null;
  inventoryValue: string | null;
  referenceCost: string | null;
  /** Costo que usan las recetas hoy y su origen (null si no hay ninguno). */
  effectiveCost: string | null;
  effectiveCostSource: CostSourceDto | null;
  lastPurchase: {
    receiptId: string;
    receiptNumber: string;
    purchaseId: string;
    purchaseNumber: string;
    supplierName: string;
    receivedAt: string;
    unitCost: string | null;
  } | null;
  canSeeCosts: boolean;
}

export interface LowStockItemDto {
  id: string;
  rawMaterial: { id: string; code: string; name: string };
  baseUnit: UnitRefDto;
  quantity: string;
  minimumStock: string;
  shortage: string;
  status: StockStatusDto;
  preferredSupplier: { id: string; name: string } | null;
}

/** Resultado de una operación de inventario (stock inicial, ajuste, merma). */
export interface StockOperationResultDto {
  movement: StockMovementDto;
  warehouseQuantityBefore: string;
  warehouseQuantityAfter: string;
  companyQuantityAfter: string;
}

/* ---------- Producto terminado (Fase 4) ---------- */

/** Fila del stock de productos terminados (valorización: null sin inventory.cost.read). */
export interface ProductStockItemDto extends InventoryValuationDto {
  /** Id del producto. */
  id: string;
  product: { id: string; code: string; name: string; active: boolean };
  saleUnit: UnitRefDto;
  /** Depósito filtrado, o null si la cantidad es el total de la empresa. */
  warehouse: { id: string; code: string; name: string } | null;
  quantity: string;
  companyQuantity: string;
  warehouseCount: number;
  lastProduction: { id: string; code: string; completedAt: string } | null;
}

export interface ProductStockDetailDto extends InventoryValuationDto {
  product: {
    id: string;
    code: string;
    name: string;
    active: boolean;
    controlsStock: boolean;
    salePrice: string;
  };
  saleUnit: UnitRefDto;
  currency: string;
  quantity: string;
  byWarehouse: { warehouse: { id: string; code: string; name: string }; quantity: string }[];
  /** Margen teórico actual: precio de venta − costo promedio material (con costos visibles). */
  theoreticalMargin: { amount: string; percentage: string | null } | null;
  recentProductions: {
    id: string;
    code: string;
    batchCode: string | null;
    completedAt: string;
    quantity: string;
    unitCost: string | null;
  }[];
  activeRecipe: {
    recipeId: string;
    name: string;
    versionId: string | null;
    versionNumber: number | null;
  } | null;
  canSeeCosts: boolean;
}

export interface ProductCostHistoryEntryDto {
  id: number;
  createdAt: string;
  movementId: string;
  productionOrder: { id: string; code: string } | null;
  quantityBefore: string;
  quantityAfter: string;
  valueBefore: string;
  valueAfter: string;
  averageBefore: string | null;
  averageAfter: string | null;
  batchQuantity: string;
  batchUnitCost: string;
  batchValue: string;
  averageChanged: boolean;
  actor: PersonRefDto | null;
}

export interface ProductCostDto {
  product: { id: string; code: string; name: string };
  saleUnit: UnitRefDto;
  currency: string;
  quantity: string;
  inventoryValue: string;
  movingAverageCost: string | null;
  lastUpdatedAt: string | null;
}
