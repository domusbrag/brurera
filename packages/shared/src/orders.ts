import { z } from "zod";
import type { ConservationStateDto } from "./lots";
import type { PersonRefDto, UnitRefDto } from "./recipes";
import type { OrderCommercialDto, OrderLinePriceDto, OrderPricingStatusDto } from "./sales";
import { localDateTimeSchema } from "./timezone";
import { decimalString, optionalText, optionalUuid, requiredText, uuid } from "./validation";

/*
 * Pedidos de clientes, demanda comprometida y necesidades (Fase 5A). Las reglas
 * (FEFO, elegibilidad, cobertura, demanda global) viven en @bakery/domain; aquí
 * los contratos de la API y los rótulos en lenguaje de negocio.
 */

export const ORDER_STATUSES = [
  "DRAFT",
  "CONFIRMED",
  "IN_PREPARATION",
  "READY",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
  "CANCELLED",
] as const;
export type OrderStatusDto = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABELS: Record<OrderStatusDto, string> = {
  DRAFT: "Borrador",
  CONFIRMED: "Confirmado",
  IN_PREPARATION: "En preparación",
  READY: "Listo",
  PARTIALLY_DELIVERED: "Entregado parcialmente",
  DELIVERED: "Entregado",
  CANCELLED: "Cancelado",
};

export const COVERAGE_STATUSES = [
  "FULLY_COVERED",
  "PARTIALLY_COVERED",
  "NOT_COVERED",
  "NEEDS_REPLAN",
] as const;
export type CoverageStatusDto = (typeof COVERAGE_STATUSES)[number];
export const COVERAGE_STATUS_LABELS: Record<CoverageStatusDto, string> = {
  FULLY_COVERED: "Cubierto",
  PARTIALLY_COVERED: "Cobertura parcial",
  NOT_COVERED: "Sin cobertura",
  NEEDS_REPLAN: "Necesita recalcular",
};

export const FULFILLMENT_TYPES = ["PICKUP", "DELIVERY"] as const;
export type FulfillmentTypeDto = (typeof FULFILLMENT_TYPES)[number];
export const FULFILLMENT_TYPE_LABELS: Record<FulfillmentTypeDto, string> = {
  PICKUP: "Retira",
  DELIVERY: "Entrega",
};

export const ORDER_PRIORITIES = ["NORMAL", "HIGH", "URGENT"] as const;
export type OrderPriorityDto = (typeof ORDER_PRIORITIES)[number];
export const ORDER_PRIORITY_LABELS: Record<OrderPriorityDto, string> = {
  NORMAL: "Normal",
  HIGH: "Alta",
  URGENT: "Urgente",
};

export const REQUESTED_CONSERVATIONS = [
  "ANY",
  "FRESH",
  "REFRIGERATED",
  "FROZEN",
  "THAWED",
] as const;
export type RequestedConservationDto = (typeof REQUESTED_CONSERVATIONS)[number];
export const REQUESTED_CONSERVATION_LABELS: Record<RequestedConservationDto, string> = {
  ANY: "Indistinto",
  FRESH: "Fresco",
  REFRIGERATED: "Refrigerado",
  FROZEN: "Congelado",
  THAWED: "Descongelado",
};

export const RESERVATION_STATUSES = ["ACTIVE", "RELEASED", "INVALIDATED", "FULFILLED"] as const;
export type ReservationStatusDto = (typeof RESERVATION_STATUSES)[number];
export const RESERVATION_STATUS_LABELS: Record<ReservationStatusDto, string> = {
  ACTIVE: "Reservado",
  RELEASED: "Liberado",
  INVALIDATED: "Invalidado",
  FULFILLED: "Entregado",
};

export const RESERVATION_RELEASE_REASONS = [
  "ORDER_CANCELLED",
  "ORDER_REPLANNED",
  "LOT_BLOCKED",
  "LOT_WASTE",
  "ORDER_DELIVERED",
] as const;
export type ReservationReleaseReasonDto = (typeof RESERVATION_RELEASE_REASONS)[number];
export const RESERVATION_RELEASE_REASON_LABELS: Record<ReservationReleaseReasonDto, string> = {
  ORDER_CANCELLED: "Pedido cancelado",
  ORDER_REPLANNED: "Cobertura recalculada",
  LOT_BLOCKED: "Lote bloqueado por calidad",
  LOT_WASTE: "Merma del lote",
  ORDER_DELIVERED: "Pedido entregado",
};

export const REQUIREMENT_STATUSES = [
  "OPEN",
  "PRODUCTION_CREATED",
  "SATISFIED",
  "CANCELLED",
] as const;
export type RequirementStatusDto = (typeof REQUIREMENT_STATUSES)[number];
export const REQUIREMENT_STATUS_LABELS: Record<RequirementStatusDto, string> = {
  OPEN: "Pendiente",
  PRODUCTION_CREATED: "Orden de producción creada",
  SATISFIED: "Cumplida",
  CANCELLED: "Cancelada",
};

/** Problemas de una necesidad de producción que impiden calcular sus ingredientes. */
export const REQUIREMENT_PROBLEMS = ["NO_RECIPE_FOR_PRODUCTION", "RECIPE_NOT_USABLE"] as const;
export type RequirementProblemDto = (typeof REQUIREMENT_PROBLEMS)[number];
export const REQUIREMENT_PROBLEM_LABELS: Record<RequirementProblemDto, string> = {
  NO_RECIPE_FOR_PRODUCTION: "Sin receta activa",
  RECIPE_NOT_USABLE: "La receta no se puede escalar",
};

/** Avisos y riesgos de un pedido, en lenguaje de negocio. */
export const ORDER_ISSUE_LABELS = {
  TO_PRODUCE: "Falta producir",
  MATERIAL_SHORTAGE: "Falta materia prima",
  NEEDS_REPLAN: "Necesita recalcular",
  LOT_BLOCKED: "Lote bloqueado",
  LOT_WASTE: "Lote con merma",
  NO_RECIPE: "Sin receta",
  PRODUCTION_CANCELLED: "Producción cancelada",
  NEW_STOCK_AVAILABLE: "Hay stock nuevo",
  NEWER_RECIPE: "Receta nueva publicada",
  SHELF_LIFE_UNKNOWN: "Lote sin vida útil",
} as const;
export type OrderIssueCode = keyof typeof ORDER_ISSUE_LABELS;

export const ORDER_INELIGIBILITY_LABELS = {
  EXPIRED: "Vence antes de la fecha",
  BLOCKED: "Bloqueado por calidad",
  CONSERVATION_MISMATCH: "Otra conservación",
} as const;
export type OrderIneligibilityReasonDto = keyof typeof ORDER_INELIGIBILITY_LABELS;

/* ---------- Entradas ---------- */

const quantity = () => decimalString({ integers: 12, scale: 6, positive: true });

/** Precio de una línea (pedido o venta). Sin unitPrice = precio vigente / acordado. */
export const linePriceFields = {
  unitPrice: decimalString({ integers: 12, scale: 2 }).optional(),
  discountAmount: decimalString({ integers: 12, scale: 2 }).optional(),
  /** Obligatorio si el precio o el descuento difieren de lo acordado / vigente. */
  priceOverrideReason: optionalText(500),
};

export const orderLineInputSchema = z.object({
  /** Al replanificar: id de la línea existente que se modifica (sin id = línea nueva). */
  id: optionalUuid(),
  productId: uuid(),
  quantity: quantity(),
  /** Unidad de la cantidad; por defecto la unidad de venta del producto. */
  unitId: optionalUuid(),
  requestedConservation: z.enum(REQUESTED_CONSERVATIONS).default("ANY"),
  ...linePriceFields,
  notes: optionalText(500),
});
export type OrderLineInput = z.infer<typeof orderLineInputSchema>;

const linesSchema = z
  .array(orderLineInputSchema)
  .min(1, "Agregá al menos un producto")
  .max(100, "Máximo 100 productos por pedido");

/** Datos del pedido que NO cambian la planificación: editables con el pedido confirmado. */
const infoFields = {
  fulfillmentType: z.enum(FULFILLMENT_TYPES).default("PICKUP"),
  deliveryAddress: optionalText(500),
  contactName: optionalText(120),
  contactPhone: optionalText(50),
  eventName: optionalText(200),
  priority: z.enum(ORDER_PRIORITIES).default("NORMAL"),
  notes: optionalText(2000),
};
export const ORDER_INFO_FIELDS = [
  "fulfillmentType",
  "deliveryAddress",
  "contactName",
  "contactPhone",
  "eventName",
  "priority",
  "notes",
] as const;

/**
 * Alta de un pedido (borrador). `requestedAt` es hora de pared de la EMPRESA
 * ("2026-10-10T10:00"): la API la interpreta con Company.timezone.
 */
export const createOrderSchema = z.object({
  customerId: uuid(),
  requestedAt: localDateTimeSchema(),
  ...infoFields,
  lines: linesSchema,
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/** Edición: en DRAFT, todo; confirmado, sólo los datos informativos (sin cantidades ni fecha). */
export const updateOrderSchema = z
  .object({
    customerId: uuid(),
    requestedAt: localDateTimeSchema(),
    fulfillmentType: z.enum(FULFILLMENT_TYPES),
    deliveryAddress: optionalText(500),
    contactName: optionalText(120),
    contactPhone: optionalText(50),
    eventName: optionalText(200),
    priority: z.enum(ORDER_PRIORITIES),
    notes: optionalText(2000),
    lines: linesSchema,
  })
  .partial();
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

/** Vista previa de cobertura de un pedido sin guardar (o de otro plan del mismo pedido). */
export const coveragePreviewSchema = z.object({
  requestedAt: localDateTimeSchema(),
  lines: linesSchema,
});
export type CoveragePreviewInput = z.infer<typeof coveragePreviewSchema>;

/** `operationId` (uno por intento) hace idempotente el reintento. */
export const confirmOrderSchema = z.object({ operationId: uuid() });

/** REPLAN: cambios explícitos (fecha y/o líneas); sin cambios = actualizar cobertura. */
export const replanPreviewSchema = z.object({
  requestedAt: localDateTimeSchema().optional(),
  lines: linesSchema.optional(),
});
export type ReplanPreviewInput = z.infer<typeof replanPreviewSchema>;
export const replanOrderSchema = replanPreviewSchema.extend({ operationId: uuid() });
export type ReplanOrderInput = z.infer<typeof replanOrderSchema>;

export const cancelOrderSchema = z.object({
  reason: requiredText(500),
  operationId: uuid(),
  /** Un pedido LISTO sólo se cancela con advertencia explícita. */
  confirmReady: z.boolean().default(false),
});
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

const pageFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
const flag = () =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true");

export const orderListQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : undefined)),
  status: z.enum([...ORDER_STATUSES, "active", "all"]).default("active"),
  coverage: z.enum(COVERAGE_STATUSES).optional(),
  customerId: uuid().optional(),
  priority: z.enum(ORDER_PRIORITIES).optional(),
  /** Fechas de calendario en la zona de la empresa (inclusive). */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Sólo pedidos con entrega desde ahora. */
  upcoming: flag(),
  /** Sólo pedidos con producto sin reservar. */
  withShortage: flag(),
  ...pageFields,
});

export const materialDemandQuerySchema = z.object({
  /** Horizonte: pedidos con entrega hasta esta hora de pared de la empresa. */
  until: localDateTimeSchema().optional(),
  shortageOnly: flag(),
  ...pageFields,
});

export const planningQuerySchema = z.object({
  until: localDateTimeSchema().optional(),
  ...pageFields,
});

/* ---------- Respuestas ---------- */

type Ref = { id: string; code: string; name: string };

export interface OrderListItemDto {
  id: string;
  code: string;
  customer: Ref;
  requestedAt: string;
  /** Hora de pared en la zona de la empresa ("2026-10-10T10:00"). */
  requestedAtLocal: string;
  fulfillmentType: FulfillmentTypeDto;
  priority: OrderPriorityDto;
  status: OrderStatusDto;
  /** null en borrador (todavía no hay plan). */
  coverageStatus: CoverageStatusDto | null;
  planRevision: number;
  eventName: string | null;
  /** "500 kg Medialunas · 100 un Sándwiches". */
  products: { name: string; quantity: string; unit: string }[];
  /** Producto sin reservar (a producir o sin receta). */
  shortages: { name: string; quantity: string; unit: string }[];
  pricingStatus: OrderPricingStatusDto;
}

export interface OrderLotCoverageDto {
  id: string;
  code: string;
  conservationState: ConservationStateDto;
  warehouse: { id: string; code: string; name: string };
  usableUntil: string | null;
  physical: string;
  committed: string;
  available: string;
  eligible: boolean;
  reason: OrderIneligibilityReasonDto | null;
  /** Cuánto de este lote reservaría (vista previa) o reserva (plan) el pedido. */
  reserve: string;
}

export interface MaterialNeedDto {
  rawMaterial: Ref;
  unit: UnitRefDto;
  /** Necesidad de este pedido (o de esta línea). */
  required: string;
}

/** Cobertura de una línea: qué hay, qué sirve, qué está comprometido y qué falta. */
export interface LineCoverageDto {
  product: Ref;
  unit: UnitRefDto;
  requestedConservation: RequestedConservationDto;
  requested: string;
  physical: string;
  eligible: string;
  /** Comprometido por OTROS pedidos sobre lotes elegibles. */
  committed: string;
  available: string;
  /** Lo que reserva (o reservaría) este pedido. */
  reserve: string;
  toProduce: string;
  /** Sin receta usable: queda sin cubrir. */
  uncovered: string;
  ineligible: { reason: OrderIneligibilityReasonDto; quantity: string; label: string }[];
  shelfLifeUnknown: string;
  recipe: { id: string; versionId: string; versionNumber: number } | null;
  problem: RequirementProblemDto | null;
  /** Explicación en palabras ("Hay 700 kg; 300 vencen antes…"). */
  explanation: string[];
  materials: MaterialNeedDto[];
  lots: OrderLotCoverageDto[];
}

export interface MaterialProjectionDto extends MaterialNeedDto {
  currentStock: string;
  /** Demanda de otros pedidos confirmados (sin este). */
  otherOrdersDemand: string;
  projectedShortage: string;
  preferredSupplier: { id: string; name: string } | null;
}

export interface CoveragePreviewDto {
  requestedAt: string;
  requestedAtLocal: string;
  timezone: string;
  coverageStatus: CoverageStatusDto;
  lines: LineCoverageDto[];
  materials: MaterialProjectionDto[];
}

export interface OrderLineDto {
  id: string;
  sortOrder: number;
  product: Ref;
  requestedQuantity: string;
  unit: UnitRefDto;
  normalizedQuantity: string;
  saleUnit: UnitRefDto;
  requestedConservation: RequestedConservationDto;
  notes: string | null;
  /** Precio vigente del producto según la lista del cliente (null sin price_lists.read). */
  informativePrice: string | null;
  /** Precio cotizado / acordado de la línea (null sin precio o sin price_lists.read). */
  price: OrderLinePriceDto | null;
  /** Entregado (Σ ventas confirmadas) y pendiente de entregar, en unidad de venta. */
  delivered: string;
  pendingDelivery: string;
  /** Cobertura del plan vigente (null en borrador). */
  physical: string | null;
  eligible: string | null;
  committedByOthers: string | null;
  reserved: string;
  toProduce: string;
  uncovered: string;
  /** Disponible hoy para esta línea además de lo reservado (aviso de "recalcular"). */
  newlyAvailable: string;
}

export interface OrderReservationDto {
  id: string;
  lineId: string;
  product: Ref;
  lot: {
    id: string;
    code: string;
    conservationState: ConservationStateDto;
    usableUntil: string | null;
    warehouse: { id: string; code: string; name: string };
  };
  quantity: string;
  /** Ya entregado de esta reserva (venta desde el pedido). */
  fulfilledQuantity: string;
  unit: UnitRefDto;
  planRevision: number;
  status: ReservationStatusDto;
  reservedAt: string;
  releasedAt: string | null;
  releaseReason: ReservationReleaseReasonDto | null;
}

export interface OrderProductionRequirementDto {
  id: string;
  lineId: string;
  product: Ref;
  quantity: string;
  unit: UnitRefDto;
  recipe: { id: string; versionId: string; versionNumber: number } | null;
  problem: RequirementProblemDto | null;
  planRevision: number;
  status: RequirementStatusDto;
  productionOrder: { id: string; code: string; status: string } | null;
  materials: MaterialNeedDto[];
  createdAt: string;
}

export interface OrderIssueDto {
  code: OrderIssueCode;
  message: string;
}

export interface OrderActionsDto {
  canEdit: boolean;
  canConfirm: boolean;
  canReplan: boolean;
  canCancel: boolean;
  canStartPreparation: boolean;
  canMarkReady: boolean;
  /** Por qué no puede pasar a listo (si corresponde). */
  readyBlockedReason: string | null;
  /** Registrar entrega y venta (pedido LISTO o entregado parcialmente). */
  canDeliver: boolean;
  deliverBlockedReason: string | null;
  /** Cotizar un pedido confirmado sin precio acordado (pedidos anteriores a 5B). */
  canQuote: boolean;
  canRegisterAdvance: boolean;
}

export interface OrderDetailDto {
  id: string;
  code: string;
  status: OrderStatusDto;
  coverageStatus: CoverageStatusDto | null;
  planRevision: number;
  customer: Ref & { phone: string | null; address: string | null };
  /** false: sin customers.read no se muestran contacto, teléfono ni direcciones. */
  canSeeCustomerDetails: boolean;
  requestedAt: string;
  requestedAtLocal: string;
  timezone: string;
  fulfillmentType: FulfillmentTypeDto;
  deliveryAddress: string | null;
  contactName: string | null;
  contactPhone: string | null;
  eventName: string | null;
  priority: OrderPriorityDto;
  notes: string | null;
  currency: string;
  createdAt: string;
  createdBy: PersonRefDto | null;
  confirmedAt: string | null;
  confirmedBy: PersonRefDto | null;
  cancelledAt: string | null;
  cancelledBy: PersonRefDto | null;
  cancelReason: string | null;
  preparationStartedAt: string | null;
  readyAt: string | null;
  lines: OrderLineDto[];
  reservations: OrderReservationDto[];
  productionRequirements: OrderProductionRequirementDto[];
  materials: MaterialProjectionDto[];
  issues: OrderIssueDto[];
  commercial: OrderCommercialDto;
  actions: OrderActionsDto;
}

export interface OrderOperationResultDto {
  order: OrderDetailDto;
  replayed: boolean;
  /** Avisos de negocio de la operación (p. ej. seña que queda como crédito). */
  warnings?: string[];
}

export interface ReplanPreviewDto {
  revisionFrom: number;
  revisionTo: number;
  currentCoverage: CoverageStatusDto | null;
  proposed: CoveragePreviewDto;
  /** Reservas activas que se liberarán. */
  releasedLots: { code: string; product: string; quantity: string; unit: string }[];
  /** Reservas nuevas que se tomarán. */
  newLots: { code: string; product: string; quantity: string; unit: string }[];
  productionChange: { product: string; unit: string; before: string; after: string }[];
  materialChange: { rawMaterial: string; unit: string; before: string; after: string }[];
}

/* ---------- Planificación ---------- */

export interface ProductionNeedDto {
  product: Ref;
  unit: UnitRefDto;
  /** Total a producir (necesidades abiertas). */
  quantity: string;
  /** Sin receta usable (no se puede producir todavía). */
  withoutRecipe: string;
  earliestRequestedAt: string;
  orders: {
    orderId: string;
    orderCode: string;
    requestedAt: string;
    requirementId: string;
    quantity: string;
    status: RequirementStatusDto;
    productionOrder: { id: string; code: string } | null;
    problem: RequirementProblemDto | null;
  }[];
}

export interface MaterialDemandDto {
  rawMaterial: Ref;
  unit: UnitRefDto;
  currentStock: string;
  openOrderDemand: string;
  availableAfterDemand: string;
  shortage: string;
  preferredSupplier: { id: string; name: string } | null;
  earliestRequestedAt: string;
  orders: { orderId: string; orderCode: string; requestedAt: string; quantity: string }[];
}

export interface OrderRiskDto {
  order: {
    id: string;
    code: string;
    requestedAt: string;
    requestedAtLocal: string;
    priority: OrderPriorityDto;
    status: OrderStatusDto;
    coverageStatus: CoverageStatusDto | null;
  };
  customer: string;
  problems: OrderIssueDto[];
}

/** Datos para prellenar una orden de producción desde la necesidad de un pedido. */
export interface OrderRequirementDto {
  id: string;
  order: { id: string; code: string; requestedAt: string; requestedAtLocal: string };
  product: Ref;
  quantity: string;
  unit: UnitRefDto;
  recipe: { id: string; versionId: string; versionNumber: number } | null;
  status: RequirementStatusDto;
  problem: RequirementProblemDto | null;
  /** Fecha requerida (calendario de la empresa) = fecha de entrega del pedido. */
  requiredBy: string;
  suggestedSourceWarehouseId: string | null;
  suggestedOutputWarehouseId: string | null;
  productionOrder: { id: string; code: string; status: string } | null;
  /** Por qué no se puede crear una orden (ya existe, sin receta, pedido cancelado…). */
  blockedReason: string | null;
}

/** Reservas que pesan sobre un lote (detalle de lote). */
export interface LotReservationDto {
  id: string;
  order: { id: string; code: string; requestedAt: string; status: OrderStatusDto };
  /** null sin customers.read. */
  customer: string | null;
  quantity: string;
  planRevision: number;
  reservedAt: string;
}

export interface LotCommitmentDto {
  committedQuantity: string;
  freeQuantity: string;
  /** null sin orders.read. */
  reservations: LotReservationDto[] | null;
}
