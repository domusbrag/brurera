import type {
  ConservationStateDto,
  CoverageStatusDto,
  LotStatusDto,
  OrderStatusDto,
  ProductionStatusDto,
  PurchaseStatus,
  ReceiptStatus,
  RecipeVersionStatus,
  SalePaymentStatusDto,
  SaleStatusDto,
  StockStatusDto,
} from "@bakery/shared";

/*
 * Semántica única de color para todos los estados de la aplicación
 * (docs/UX_TERMINOLOGY.md → «Estados y colores»):
 *
 * - success: terminado o en orden (listo, entregado, cobrado, utilizable).
 * - warning: requiere atención pronto (cobertura parcial, sin cobrar, por vencer).
 * - danger:  impide operar o ya es un problema (sin cobertura, vencido, bloqueado).
 * - info:    en curso, esperando el próximo paso (confirmado, planificada, pedida).
 * - neutral: borrador, cancelado, agotado, archivado: no requiere acción.
 */
export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export const ORDER_STATUS_TONE: Record<OrderStatusDto, Tone> = {
  DRAFT: "neutral",
  CONFIRMED: "info",
  IN_PREPARATION: "info",
  READY: "success",
  PARTIALLY_DELIVERED: "warning",
  DELIVERED: "success",
  CANCELLED: "neutral",
};

export const COVERAGE_TONE: Record<CoverageStatusDto, Tone> = {
  FULLY_COVERED: "success",
  PARTIALLY_COVERED: "warning",
  NOT_COVERED: "danger",
  NEEDS_REPLAN: "danger",
};

export const PRODUCTION_STATUS_TONE: Record<ProductionStatusDto, Tone> = {
  DRAFT: "neutral",
  PLANNED: "info",
  IN_PROGRESS: "info",
  COMPLETED: "success",
  CANCELLED: "neutral",
};

export const PURCHASE_STATUS_TONE: Record<PurchaseStatus, Tone> = {
  DRAFT: "neutral",
  ORDERED: "info",
  PARTIALLY_RECEIVED: "warning",
  RECEIVED: "success",
  CANCELLED: "neutral",
};

export const RECEIPT_STATUS_TONE: Record<ReceiptStatus, Tone> = {
  DRAFT: "neutral",
  POSTED: "success",
  CANCELLED: "neutral",
};

export const SALE_STATUS_TONE: Record<SaleStatusDto, Tone> = {
  DRAFT: "neutral",
  POSTED: "success",
  CANCELLED: "neutral",
};

export const PAYMENT_STATUS_TONE: Record<SalePaymentStatusDto, Tone> = {
  UNPAID: "warning",
  PARTIALLY_PAID: "warning",
  PAID: "success",
};

export const LOT_STATUS_TONE: Record<LotStatusDto, Tone> = {
  AVAILABLE: "success",
  NEAR_EXPIRY: "warning",
  EXPIRED: "danger",
  BLOCKED: "danger",
  DEPLETED: "neutral",
};

export const STOCK_STATUS_TONE: Record<StockStatusDto, Tone> = {
  OK: "success",
  LOW: "warning",
  OUT_OF_STOCK: "danger",
};

export const RECIPE_VERSION_TONE: Record<RecipeVersionStatus, Tone> = {
  DRAFT: "neutral",
  ACTIVE: "success",
  ARCHIVED: "neutral",
};

/** La conservación es un atributo del lote, no un estado: se muestra como etiqueta. */
export const CONSERVATION_STATES_ORDER: ConservationStateDto[] = [
  "FRESH",
  "REFRIGERATED",
  "FROZEN",
  "THAWED",
];
