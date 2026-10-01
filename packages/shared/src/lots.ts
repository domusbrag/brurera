import { z } from "zod";
import type { AuditLogItemDto } from "./audit";
import type { StockMovementDto } from "./inventory";
import type { PersonRefDto, UnitRefDto } from "./recipes";
import { decimalString, optionalText, requiredText, uuid } from "./validation";

/*
 * Lotes de producto terminado, conservación y vida útil (Fase 4.5). La vida útil
 * se guarda en minutos (semántica exacta); la UI la muestra en horas o días.
 * Las reglas (transiciones, elegibilidad, FEFO) viven en @bakery/domain.
 */

export const CONSERVATION_STATES = ["FRESH", "REFRIGERATED", "FROZEN", "THAWED"] as const;
export type ConservationStateDto = (typeof CONSERVATION_STATES)[number];
export const CONSERVATION_STATE_LABELS: Record<ConservationStateDto, string> = {
  FRESH: "Fresco",
  REFRIGERATED: "Refrigerado",
  FROZEN: "Congelado",
  THAWED: "Descongelado",
};

export const LOT_QUALITY_STATUS_LABELS = {
  AVAILABLE: "Apto",
  BLOCKED: "Bloqueado",
} as const;
export type LotQualityStatusDto = keyof typeof LOT_QUALITY_STATUS_LABELS;

/** Estado operativo derivado de un lote en este momento (no se persiste). */
export const LOT_STATUS_LABELS = {
  AVAILABLE: "Utilizable",
  NEAR_EXPIRY: "Próximo a vencer",
  EXPIRED: "Vencido",
  BLOCKED: "Bloqueado",
  DEPLETED: "Agotado",
} as const;
export type LotStatusDto = keyof typeof LOT_STATUS_LABELS;

export const LOT_INELIGIBILITY_LABELS = {
  DEPLETED: "Agotado",
  BLOCKED: "Bloqueado por calidad",
  EXPIRED: "Vence antes de la fecha",
} as const;
export type LotIneligibilityReasonDto = keyof typeof LOT_INELIGIBILITY_LABELS;

export const PRODUCT_WASTE_REASONS = ["EXPIRED", "DAMAGED", "QUALITY", "OTHER"] as const;
export type ProductWasteReasonDto = (typeof PRODUCT_WASTE_REASONS)[number];
export const PRODUCT_WASTE_REASON_LABELS: Record<ProductWasteReasonDto, string> = {
  EXPIRED: "Vencimiento",
  DAMAGED: "Daño",
  QUALITY: "Calidad",
  OTHER: "Otro",
};

/** Vida útil máxima: 10 años en minutos. Umbral de "próximo a vencer": hasta 366 días. */
export const MAX_SHELF_LIFE_MINUTES = 10 * 366 * 1440;
export const MAX_NEAR_EXPIRY_MINUTES = 366 * 1440;

/* ---------- Configuración de conservación ---------- */

const minutesSchema = (max: number) =>
  z.coerce
    .number({ error: "Número inválido" })
    .int("Debe ser un número entero de minutos")
    .min(1, "Debe ser mayor que cero")
    .max(max, "Valor demasiado grande");

export const conservationStateEntrySchema = z
  .object({
    state: z.enum(CONSERVATION_STATES),
    enabled: z.boolean(),
    shelfLifeMinutes: minutesSchema(MAX_SHELF_LIFE_MINUTES).nullable(),
    allowedAsInitial: z.boolean(),
    notes: optionalText(500),
  })
  .refine((e) => !e.enabled || e.shelfLifeMinutes !== null, {
    message: "Indicá la vida útil del estado habilitado",
    path: ["shelfLifeMinutes"],
  })
  .refine((e) => !e.allowedAsInitial || e.enabled, {
    message: "Sólo un estado habilitado puede ser inicial",
    path: ["allowedAsInitial"],
  });

export const conservationProfileSchema = z
  .object({
    defaultInitialState: z.enum(CONSERVATION_STATES),
    nearExpiryMinutes: minutesSchema(MAX_NEAR_EXPIRY_MINUTES),
    states: z.array(conservationStateEntrySchema).min(1).max(CONSERVATION_STATES.length),
  })
  .refine((v) => new Set(v.states.map((s) => s.state)).size === v.states.length, {
    message: "Cada estado se configura una sola vez",
    path: ["states"],
  })
  .refine(
    (v) =>
      v.states.some((s) => s.state === v.defaultInitialState && s.enabled && s.allowedAsInitial),
    {
      message: "El estado inicial por defecto debe estar habilitado y permitido como inicial",
      path: ["defaultInitialState"],
    },
  );
export type ConservationProfileInput = z.infer<typeof conservationProfileSchema>;

export interface ConservationStateEntryDto {
  state: ConservationStateDto;
  enabled: boolean;
  shelfLifeMinutes: number | null;
  allowedAsInitial: boolean;
  notes: string | null;
}

export interface ConservationProfileDto {
  product: { id: string; code: string; name: string; active: boolean };
  saleUnit: UnitRefDto;
  /** false hasta que se guarde una configuración (los lotes nacen frescos sin vida útil). */
  configured: boolean;
  defaultInitialState: ConservationStateDto;
  nearExpiryMinutes: number;
  /** Siempre los cuatro estados, en orden. */
  states: ConservationStateEntryDto[];
  updatedAt: string | null;
  updatedBy: PersonRefDto | null;
}

/* ---------- Operaciones sobre lotes ---------- */

const lotQuantitySchema = () => decimalString({ integers: 14, scale: 6, positive: true });

/** Congelar / descongelar (parcial o total). `operationId` hace idempotente el reintento. */
export const transformLotSchema = z.object({
  targetState: z.enum(CONSERVATION_STATES),
  quantity: lotQuantitySchema(),
  operationId: uuid(),
  notes: optionalText(1000),
});
export type TransformLotInput = z.infer<typeof transformLotSchema>;

export const lotWasteSchema = z.object({
  quantity: lotQuantitySchema(),
  reason: z.enum(PRODUCT_WASTE_REASONS),
  operationId: uuid(),
  notes: optionalText(1000),
});
export type LotWasteInput = z.infer<typeof lotWasteSchema>;

export const blockLotSchema = z.object({ reason: requiredText(500) });
export type BlockLotInput = z.infer<typeof blockLotSchema>;

/** Al completar una producción: estado de conservación inicial del lote (opcional). */
export const completeProductionSchema = z
  .object({ conservationState: z.enum(CONSERVATION_STATES).optional() })
  .default({});
export type CompleteProductionInput = z.infer<typeof completeProductionSchema>;

/* ---------- Consultas ---------- */

const pageFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export const productLotsQuerySchema = z.object({
  warehouseId: uuid().optional(),
  /** "active": con saldo; "all": también agotados (histórico). */
  scope: z.enum(["active", "all"]).default("active"),
  ...pageFields,
});

/** Momento futuro (o pasado) a evaluar, ISO 8601 con zona. */
export const availabilityQuerySchema = z.object({
  at: z.iso.datetime({ offset: true, error: "Fecha y hora inválidas" }),
  warehouseId: uuid().optional(),
});

export const expiringQuerySchema = z.object({
  /** Ventana en horas; si no se indica, el umbral configurado de cada producto. */
  withinHours: z.coerce.number().int().min(1).max(8784).optional(),
  status: z.enum(["all", "near_expiry", "expired"]).default("all"),
  warehouseId: uuid().optional(),
  productId: uuid().optional(),
  ...pageFields,
});

/* ---------- Respuestas ---------- */

export type ConservationBreakdownDto = Record<ConservationStateDto, string>;

export interface ProductLotDto {
  id: string;
  code: string;
  product: { id: string; code: string; name: string };
  productionOrder: { id: string; code: string };
  parentLot: { id: string; code: string } | null;
  warehouse: { id: string; code: string; name: string };
  conservationState: ConservationStateDto;
  qualityStatus: LotQualityStatusDto;
  qualityReason: string | null;
  /** Estado operativo derivado ahora (agotado, bloqueado, vencido, próximo a vencer, utilizable). */
  status: LotStatusDto;
  producedAt: string;
  stateChangedAt: string;
  /** null = vida útil no configurada (no se inventa una). */
  usableUntil: string | null;
  shelfLifeMinutes: number | null;
  /** Minutos hasta usableUntil (negativo si ya venció); null sin vida útil. */
  minutesRemaining: number | null;
  initialQuantity: string;
  quantity: string;
  unit: UnitRefDto;
  /** Costo material: null sin inventory.cost.read. */
  unitMaterialCost: string | null;
  value: string | null;
  /** Estados a los que se puede transformar hoy según reglas y perfil del producto. */
  transformTargets: ConservationStateDto[];
  createdAt: string;
}

export interface TransformOptionDto {
  targetState: ConservationStateDto;
  allowed: boolean;
  /** Motivo de negocio cuando no se permite. */
  reason: string | null;
  shelfLifeMinutes: number | null;
}

export interface ProductLotDetailDto extends ProductLotDto {
  initialValue: string | null;
  notes: string | null;
  createdBy: PersonRefDto | null;
  children: {
    id: string;
    code: string;
    conservationState: ConservationStateDto;
    initialQuantity: string;
    quantity: string;
    createdAt: string;
  }[];
  transformOptions: TransformOptionDto[];
  movements: StockMovementDto[];
  audit: AuditLogItemDto[];
  canSeeCosts: boolean;
}

export interface LotOperationResultDto {
  lot: ProductLotDto;
  /** Lote hijo creado por una transformación. */
  childLot: ProductLotDto | null;
  movements: StockMovementDto[];
  /** true si la operación ya se había aplicado (reintento idempotente). */
  replayed: boolean;
}

export interface AvailabilityLotDto {
  id: string;
  code: string;
  conservationState: ConservationStateDto;
  qualityStatus: LotQualityStatusDto;
  warehouse: { id: string; code: string; name: string };
  quantity: string;
  producedAt: string;
  usableUntil: string | null;
  eligible: boolean;
  reason: LotIneligibilityReasonDto | null;
  /** Orden FEFO (1 = primero en usarse). */
  fefoRank: number;
}

/** Resultado de calculateProductAvailabilityAt: físico vs. utilizable en una fecha. */
export interface ProductAvailabilityDto {
  product: { id: string; code: string; name: string };
  unit: UnitRefDto;
  warehouse: { id: string; code: string; name: string } | null;
  requestedAt: string;
  physicalQuantity: string;
  eligibleQuantity: string;
  ineligibleQuantity: string;
  ineligibleByReason: { EXPIRED: string; BLOCKED: string };
  physicalByState: ConservationBreakdownDto;
  eligibleByState: ConservationBreakdownDto;
  /** Elegible pero sin vida útil configurada (se informa, no se excluye). */
  shelfLifeUnknownQuantity: string;
  /** Razones en lenguaje de negocio ("300 vencen antes de la fecha"). */
  reasons: { reason: LotIneligibilityReasonDto; quantity: string; label: string }[];
  lots: AvailabilityLotDto[];
}

export interface ExpiringLotDto extends ProductLotDto {
  nearExpiryMinutes: number;
}

/** Resumen por producto para Stock → Productos terminados. */
export interface ProductLotSummaryDto {
  physicalQuantity: string;
  byState: ConservationBreakdownDto;
  usableNow: string;
  nearExpiry: string;
  expired: string;
  blocked: string;
  shelfLifeUnknown: string;
}
