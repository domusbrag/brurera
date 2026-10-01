import { z } from "zod";
import {
  decimalString,
  optionalDecimalString,
  optionalText,
  requiredText,
  uuid,
} from "./validation";

/*
 * Recetas versionadas (Fase 2). Los esquemas validan forma y rangos; la
 * compatibilidad de unidades y la pertenencia a la empresa las valida la API
 * (con @bakery/domain y la base).
 */

export const RECIPE_VERSION_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type RecipeVersionStatus = (typeof RECIPE_VERSION_STATUSES)[number];
export const RECIPE_VERSION_STATUS_LABELS: Record<RecipeVersionStatus, string> = {
  DRAFT: "Borrador",
  ACTIVE: "Vigente",
  ARCHIVED: "Archivada",
};

export const COST_STATUS_LABELS = {
  COMPLETE: "Completo",
  INCOMPLETE: "Costo incompleto",
} as const;
export type CostStatusDto = keyof typeof COST_STATUS_LABELS;

export const COST_SOURCE_LABELS = {
  MANUAL_REFERENCE: "Referencia manual",
  PURCHASE_MOVING_AVERAGE: "Promedio ponderado de compras",
  SUPPLIER_QUOTE: "Cotización de proveedor",
  OTHER: "Otro",
} as const;
export type CostSourceDto = keyof typeof COST_SOURCE_LABELS;

/** Cantidad de receta o rendimiento: > 0, hasta 6 decimales (numeric(18,6)). */
export const recipeQuantitySchema = () => decimalString({ integers: 12, scale: 6, positive: true });

/** Merma teórica: 0 ≤ x < 100, hasta 4 decimales. Vacía = sin dato. */
export const wastePercentageSchema = () =>
  optionalDecimalString({ integers: 3, scale: 4 }).refine(
    (v) => v === null || Number(v) < 100,
    "Debe ser menor que 100",
  );

export const recipeIngredientInputSchema = z.object({
  rawMaterialId: uuid(),
  quantity: recipeQuantitySchema(),
  unitId: uuid(),
  notes: optionalText(500),
});
export type RecipeIngredientInput = z.infer<typeof recipeIngredientInputSchema>;

export const MAX_RECIPE_INGREDIENTS = 100;

const versionFields = {
  yieldQuantity: recipeQuantitySchema(),
  yieldUnitId: uuid(),
  wastePercentage: wastePercentageSchema(),
  instructions: optionalText(10_000),
  /** Lista completa: al editar un borrador, reemplaza los ingredientes. */
  ingredients: z.array(recipeIngredientInputSchema).max(MAX_RECIPE_INGREDIENTS).default([]),
};

export const recipeVersionInputSchema = z.object(versionFields);
export type RecipeVersionInput = z.infer<typeof recipeVersionInputSchema>;

/** Alta de receta con su primera versión (borrador) en una sola operación. */
export const createRecipeSchema = z.object({
  productId: uuid(),
  /** Si se omite, se usa el nombre del producto. */
  name: optionalText(200),
  description: optionalText(1000),
  version: recipeVersionInputSchema,
});
export type CreateRecipeInput = z.infer<typeof createRecipeSchema>;

export const updateRecipeSchema = z
  .object({ name: requiredText(200), description: optionalText(1000) })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "No hay cambios para guardar",
  });

/** Edición de un borrador (sólo DRAFT). `ingredients`, si viene, reemplaza la lista. */
export const updateRecipeVersionSchema = z
  .object({
    ...versionFields,
    ingredients: z.array(recipeIngredientInputSchema).max(MAX_RECIPE_INGREDIENTS),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "No hay cambios para guardar",
  });
export type UpdateRecipeVersionInput = z.infer<typeof updateRecipeVersionSchema>;

/**
 * Nueva versión de una receta: copia de `copyFromVersionId` (o de la última
 * versión si se omite) o, si la receta no tiene versiones, desde `version`.
 */
export const createRecipeVersionSchema = z.object({
  copyFromVersionId: uuid().optional(),
  version: recipeVersionInputSchema.optional(),
});

/** Publicar con costo incompleto exige confirmarlo explícitamente. */
export const publishRecipeVersionSchema = z.object({
  acknowledgeIncompleteCost: z.boolean().default(false),
});

export const recipeListQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : undefined)),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  productId: uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const effectiveVersionQuerySchema = z.object({
  at: z.iso.datetime({ offset: true, error: "Fecha y hora ISO 8601" }),
});

export const versionDiffQuerySchema = z.object({ against: uuid().optional() });

/* ---------- Respuestas ---------- */

export interface UnitRefDto {
  id: string;
  code: string;
  symbol: string;
}

/** Costo teórico calculado (mismo formato que RecipeCostWire de @bakery/domain). */
export interface TheoreticalCostDto {
  status: CostStatusDto;
  currency: string;
  ingredients: {
    rawMaterialId: string;
    rawMaterialCode: string;
    rawMaterialName: string;
    quantity: string;
    unit: UnitRefDto;
    normalizedQuantity: string;
    baseUnit: UnitRefDto;
    referenceCost: string | null;
    costSource: CostSourceDto | null;
    cost: string | null;
  }[];
  missingCosts: { rawMaterialId: string; rawMaterialCode: string; rawMaterialName: string }[];
  totalCost: string | null;
  yieldQuantity: string;
  yieldUnit: UnitRefDto;
  normalizedYield: string;
  saleUnit: UnitRefDto;
  unitCost: string | null;
  /** Precio de venta vigente del producto; se muestra aunque el costo esté incompleto. */
  salePrice: string | null;
  grossMargin: { salePrice: string; amount: string; percentage: string | null } | null;
}

/** Snapshot persistido al publicar: inmutable. */
export interface CostSnapshotDto {
  id: string;
  calculatedAt: string;
  currency: string;
  status: CostStatusDto;
  totalCost: string | null;
  yieldQuantity: string;
  yieldUnit: { code: string; symbol: string };
  normalizedYield: string;
  saleUnit: { code: string; symbol: string };
  unitCost: string | null;
  salePrice: string | null;
  grossMargin: { amount: string; percentage: string | null } | null;
  lines: {
    rawMaterialId: string;
    rawMaterialCode: string;
    rawMaterialName: string;
    quantity: string;
    unit: { code: string; symbol: string };
    normalizedQuantity: string;
    baseUnit: { code: string; symbol: string };
    referenceCost: string | null;
    costSource: CostSourceDto | null;
    ingredientCost: string | null;
  }[];
}

export interface PersonRefDto {
  id: string;
  displayName: string;
}

export interface RecipeVersionSummaryDto {
  id: string;
  versionNumber: number;
  status: RecipeVersionStatus;
  yieldQuantity: string;
  yieldUnit: UnitRefDto;
  wastePercentage: string | null;
  createdAt: string;
  createdBy: PersonRefDto | null;
  effectiveFrom: string | null;
  publishedAt: string | null;
  publishedBy: PersonRefDto | null;
  archivedAt: string | null;
  /** Resumen del snapshot de publicación (null en borradores). */
  snapshot: {
    status: CostStatusDto;
    currency: string;
    totalCost: string | null;
    unitCost: string | null;
    saleUnitSymbol: string;
  } | null;
}

export interface RecipeProductDto {
  id: string;
  code: string;
  name: string;
  active: boolean;
  saleUnit: UnitRefDto;
  salePrice: string;
}

export interface RecipeIngredientDto {
  id: string;
  rawMaterial: {
    id: string;
    code: string;
    name: string;
    active: boolean;
    baseUnit: UnitRefDto;
    referenceCost: string | null;
    referenceCostSource: CostSourceDto;
  };
  quantity: string;
  unit: UnitRefDto;
  sortOrder: number;
  notes: string | null;
}

export interface RecipeVersionDto extends RecipeVersionSummaryDto {
  recipe: { id: string; name: string; active: boolean };
  product: RecipeProductDto;
  instructions: string | null;
  ingredients: RecipeIngredientDto[];
}

export interface RecipeDto {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  product: RecipeProductDto;
  activeVersionId: string | null;
  draftVersionId: string | null;
  /** Todas las versiones, de la más nueva a la más vieja. */
  versions: RecipeVersionSummaryDto[];
  createdAt: string;
  updatedAt: string;
}

export interface RecipeListItemDto {
  id: string;
  name: string;
  active: boolean;
  product: { id: string; code: string; name: string; saleUnit: UnitRefDto };
  activeVersion: {
    id: string;
    versionNumber: number;
    yieldQuantity: string;
    yieldUnit: UnitRefDto;
    publishedAt: string | null;
  } | null;
  draftVersion: { id: string; versionNumber: number } | null;
  /** Costo teórico ACTUAL de la versión vigente (null si no hay vigente). */
  currentCost: {
    status: CostStatusDto;
    currency: string;
    unitCost: string | null;
    missingCount: number;
  } | null;
  updatedAt: string;
}

export interface CostVariationDto {
  amount: string;
  percentage: string | null;
}

/** Costo de una versión: snapshot de publicación (si existe) y costo teórico actual. */
export interface RecipeVersionCostDto {
  version: { id: string; versionNumber: number; status: RecipeVersionStatus };
  snapshot: CostSnapshotDto | null;
  current: TheoreticalCostDto;
  /** Variación del costo unitario snapshot → actual (sólo si ambos están completos). */
  unitCostVariation: CostVariationDto | null;
}

export interface RecipeVersionDiffDto {
  from: { id: string; versionNumber: number } | null;
  to: { id: string; versionNumber: number };
  added: { rawMaterialId: string; rawMaterialName: string; quantity: string; unit: UnitRefDto }[];
  removed: { rawMaterialId: string; rawMaterialName: string; quantity: string; unit: UnitRefDto }[];
  changed: {
    rawMaterialId: string;
    rawMaterialName: string;
    from: { quantity: string; unit: UnitRefDto };
    to: { quantity: string; unit: UnitRefDto };
  }[];
  yield: {
    from: { quantity: string; unit: UnitRefDto };
    to: { quantity: string; unit: UnitRefDto };
  } | null;
  waste: { from: string | null; to: string | null } | null;
  instructionsChanged: boolean;
  hasChanges: boolean;
}
