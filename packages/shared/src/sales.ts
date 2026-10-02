import { z } from "zod";
import type { ConservationStateDto } from "./lots";
import { REQUESTED_CONSERVATIONS, linePriceFields, type RequestedConservationDto } from "./orders";
import type { PersonRefDto, UnitRefDto } from "./recipes";
import { localDateTimeSchema } from "./timezone";
import { decimalString, optionalText, optionalUuid, requiredText, uuid } from "./validation";

/*
 * Ventas, entregas, precios, cobros y cuenta corriente (Fase 5B). Las reglas
 * (costo por lote, margen, prioridad de precios, estado de cobro) viven en
 * @bakery/domain; aquí los contratos de la API y los rótulos de negocio.
 *
 * Vocabulario visible: Venta, Entrega, Pedido, Lote, Reservado, Disponible,
 * Precio, Seña, Cobro, Pendiente, Cuenta corriente, Costo material, Margen sobre
 * materiales, Crédito a favor.
 */

export const SALE_STATUSES = ["DRAFT", "POSTED", "CANCELLED"] as const;
export type SaleStatusDto = (typeof SALE_STATUSES)[number];
export const SALE_STATUS_LABELS: Record<SaleStatusDto, string> = {
  DRAFT: "Borrador",
  POSTED: "Entregada",
  CANCELLED: "Descartada",
};

export const SALE_PAYMENT_STATUSES = ["UNPAID", "PARTIALLY_PAID", "PAID"] as const;
export type SalePaymentStatusDto = (typeof SALE_PAYMENT_STATUSES)[number];
export const SALE_PAYMENT_STATUS_LABELS: Record<SalePaymentStatusDto, string> = {
  UNPAID: "Sin cobrar",
  PARTIALLY_PAID: "Cobro parcial",
  PAID: "Cobrada",
};

export const PAYMENT_METHODS = ["CASH", "TRANSFER", "DEBIT_CARD", "CREDIT_CARD", "OTHER"] as const;
export type PaymentMethodDto = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethodDto, string> = {
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  DEBIT_CARD: "Tarjeta de débito",
  CREDIT_CARD: "Tarjeta de crédito",
  OTHER: "Otro",
};

export const PAYMENT_KINDS = ["ORDER_ADVANCE", "SALE_PAYMENT", "ON_ACCOUNT"] as const;
export type PaymentKindDto = (typeof PAYMENT_KINDS)[number];
export const PAYMENT_KIND_LABELS: Record<PaymentKindDto, string> = {
  ORDER_ADVANCE: "Seña",
  SALE_PAYMENT: "Cobro de venta",
  ON_ACCOUNT: "Cobro a cuenta",
};

export const APPLICATION_ORIGINS = ["ADVANCE_AUTO", "SALE_PAYMENT", "MANUAL"] as const;
export type ApplicationOriginDto = (typeof APPLICATION_ORIGINS)[number];
export const APPLICATION_ORIGIN_LABELS: Record<ApplicationOriginDto, string> = {
  ADVANCE_AUTO: "Seña aplicada",
  SALE_PAYMENT: "Cobro en la venta",
  MANUAL: "Imputación manual",
};

export const PRICE_SOURCES = [
  "ORDER_QUOTE",
  "CUSTOMER_PRICE_LIST",
  "DEFAULT_PRICE_LIST",
  "PRODUCT_PRICE",
  "MANUAL",
] as const;
export type PriceSourceDto = (typeof PRICE_SOURCES)[number];
export const PRICE_SOURCE_LABELS: Record<PriceSourceDto, string> = {
  ORDER_QUOTE: "Precio acordado del pedido",
  CUSTOMER_PRICE_LIST: "Lista del cliente",
  DEFAULT_PRICE_LIST: "Lista general",
  PRODUCT_PRICE: "Precio del producto",
  MANUAL: "Precio modificado",
};

export const ORDER_PRICING_STATUSES = ["UNPRICED", "QUOTED", "AGREED"] as const;
export type OrderPricingStatusDto = (typeof ORDER_PRICING_STATUSES)[number];
export const ORDER_PRICING_STATUS_LABELS: Record<OrderPricingStatusDto, string> = {
  UNPRICED: "Sin precio acordado",
  QUOTED: "Cotizado",
  AGREED: "Precio acordado",
};

export const ACCOUNT_MOVEMENT_TYPES = [
  "SALE_DEBIT",
  "PAYMENT_CREDIT",
  "ADJUSTMENT_DEBIT",
  "ADJUSTMENT_CREDIT",
] as const;
export type AccountMovementTypeDto = (typeof ACCOUNT_MOVEMENT_TYPES)[number];
export const ACCOUNT_MOVEMENT_TYPE_LABELS: Record<AccountMovementTypeDto, string> = {
  SALE_DEBIT: "Venta",
  PAYMENT_CREDIT: "Cobro",
  ADJUSTMENT_DEBIT: "Ajuste a cargo del cliente",
  ADJUSTMENT_CREDIT: "Ajuste a favor del cliente",
};

export type AccountBalanceKindDto = "DEBT" | "NONE" | "CREDIT";

/** Texto fijo del margen negativo (UI y vista previa). */
export const NEGATIVE_MARGIN_WARNING =
  "Precio inferior al costo material de los lotes seleccionados.";
export const FEFO_SALE_HINT = "Se utilizarán los lotes más próximos a vencer";

/* ---------- Entradas ---------- */

const quantity = () => decimalString({ integers: 12, scale: 6, positive: true });
const money = () => decimalString({ integers: 12, scale: 2 });
const positiveMoney = () => decimalString({ integers: 12, scale: 2, positive: true });

export const saleLineInputSchema = z.object({
  /** Venta desde pedido: línea del pedido que se entrega. */
  orderLineId: optionalUuid(),
  productId: uuid(),
  quantity: quantity(),
  unitId: optionalUuid(),
  requestedConservation: z.enum(REQUESTED_CONSERVATIONS).default("ANY"),
  ...linePriceFields,
  notes: optionalText(500),
});
export type SaleLineInput = z.infer<typeof saleLineInputSchema>;

const saleLinesSchema = z
  .array(saleLineInputSchema)
  .min(1, "Agregá al menos un producto")
  .max(100, "Máximo 100 productos por venta");

/**
 * Venta (borrador). Desde pedido: `sourceOrderId` (el cliente sale del pedido).
 * Directa: `customerId` (o el Consumidor Final si se omite).
 */
export const createSaleSchema = z.object({
  sourceOrderId: optionalUuid(),
  customerId: optionalUuid(),
  warehouseId: uuid(),
  notes: optionalText(2000),
  lines: saleLinesSchema,
});
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

export const updateSaleSchema = z
  .object({
    customerId: uuid(),
    warehouseId: uuid(),
    notes: optionalText(2000),
    lines: saleLinesSchema,
  })
  .partial();
export type UpdateSaleInput = z.infer<typeof updateSaleSchema>;

export const paymentFields = {
  amount: positiveMoney(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  reference: optionalText(120),
  notes: optionalText(1000),
  /** Hora de pared de la empresa; por defecto, ahora. */
  paymentDate: localDateTimeSchema().optional(),
  /** Uno por intento: reintentar con el mismo id no duplica el cobro. */
  operationId: uuid(),
};

/** Confirmar entrega y venta. Opcionalmente con un cobro en el momento. */
export const postSaleSchema = z.object({
  initialPayment: z
    .object({
      amount: positiveMoney(),
      paymentMethod: z.enum(PAYMENT_METHODS),
      reference: optionalText(120),
      operationId: uuid(),
    })
    .optional(),
});
export type PostSaleInput = z.infer<typeof postSaleSchema>;

export const cancelSaleSchema = z.object({ reason: requiredText(500) });
export type CancelSaleInput = z.infer<typeof cancelSaleSchema>;

export const salePaymentSchema = z.object(paymentFields);
export type SalePaymentInput = z.infer<typeof salePaymentSchema>;

export const orderAdvanceSchema = z.object(paymentFields);
export type OrderAdvanceInput = z.infer<typeof orderAdvanceSchema>;

export const onAccountPaymentSchema = z.object(paymentFields);
export type OnAccountPaymentInput = z.infer<typeof onAccountPaymentSchema>;

/** Imputación manual de crédito de un cobro a una venta pendiente del mismo cliente. */
export const applyPaymentSchema = z.object({
  saleId: uuid(),
  amount: positiveMoney(),
  /** Uno por intento: reintentar con el mismo id no duplica la imputación. */
  operationId: uuid(),
});
export type ApplyPaymentInput = z.infer<typeof applyPaymentSchema>;

export const accountAdjustmentSchema = z.object({
  /** DEBIT: el cliente debe más; CREDIT: a favor del cliente. */
  direction: z.enum(["DEBIT", "CREDIT"]),
  amount: positiveMoney(),
  reason: requiredText(500),
  notes: optionalText(1000),
  /** Uno por intento: reintentar con el mismo id no duplica el ajuste. */
  operationId: uuid(),
});
export type AccountAdjustmentInput = z.infer<typeof accountAdjustmentSchema>;

/** Cotizar un pedido sin precio (pedidos de Fase 5A): fija el precio acordado. */
export const quoteOrderSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: uuid(),
        ...linePriceFields,
      }),
    )
    .max(100)
    .default([]),
});
export type QuoteOrderInput = z.infer<typeof quoteOrderSchema>;

export const priceListSchema = z.object({
  code: optionalText(32),
  name: requiredText(120),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
  notes: optionalText(1000),
});
export type PriceListInput = z.infer<typeof priceListSchema>;
export const updatePriceListSchema = priceListSchema.partial();
export type UpdatePriceListInput = z.infer<typeof updatePriceListSchema>;

export const priceListItemSchema = z.object({
  unitPrice: money(),
  active: z.boolean().default(true),
});
export type PriceListItemInput = z.infer<typeof priceListItemSchema>;

const pageFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
const flag = () =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true");
const search = () =>
  z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : undefined));

export const saleListQuerySchema = z.object({
  search: search(),
  status: z.enum([...SALE_STATUSES, "all"]).default("all"),
  paymentStatus: z.enum(SALE_PAYMENT_STATUSES).optional(),
  customerId: uuid().optional(),
  orderId: uuid().optional(),
  /** "order": con pedido; "direct": venta directa. */
  origin: z.enum(["order", "direct"]).optional(),
  /** Sólo ventas entregadas con saldo pendiente de cobro. */
  pendingOnly: flag(),
  /** Fechas de calendario en la zona de la empresa (inclusive). */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  ...pageFields,
});

export const priceListQuerySchema = z.object({
  search: search(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  ...pageFields,
});

export const resolvePricesQuerySchema = z.object({
  customerId: optionalUuid(),
  productIds: z
    .string()
    .transform((v) => v.split(",").filter(Boolean))
    .pipe(z.array(z.string().uuid()).min(1).max(100)),
});

export const accountMovementsQuerySchema = z.object({ ...pageFields });

export const receivablesQuerySchema = z.object({
  search: search(),
  /** debt: deben; credit: crédito a favor; all: todos con movimientos. */
  balance: z.enum(["debt", "credit", "all"]).default("debt"),
  ...pageFields,
});

export const paymentListQuerySchema = z.object({
  customerId: uuid().optional(),
  orderId: uuid().optional(),
  kind: z.enum(PAYMENT_KINDS).optional(),
  /** Sólo cobros con crédito sin imputar. */
  unappliedOnly: flag(),
  ...pageFields,
});

/* ---------- Respuestas ---------- */

type Ref = { id: string; code: string; name: string };

export interface MarginDto {
  amount: string;
  /** null si el neto es 0. */
  percentage: string | null;
}

export interface SaleListItemDto {
  id: string;
  code: string;
  status: SaleStatusDto;
  paymentStatus: SalePaymentStatusDto;
  /** Fecha de la venta (entrega) o de creación si es borrador. */
  date: string;
  dateLocal: string;
  customer: Ref;
  order: { id: string; code: string } | null;
  /** Montos: null sin price_lists.read. */
  total: string | null;
  pending: string | null;
  /** null sin sales.margin.read o en borrador. */
  margin: MarginDto | null;
  currency: string;
}

export interface SaleLotDto {
  lot: {
    id: string;
    code: string;
    conservationState: ConservationStateDto;
    usableUntil: string | null;
  };
  quantity: string;
  /** Viene de la reserva del pedido (true) o de stock libre (false). */
  fromReservation: boolean;
  /** null sin sales.cost.read. */
  unitCost: string | null;
  materialCost: string | null;
}

export interface SaleLinePriceDto {
  unitPrice: string;
  discountAmount: string;
  netAmount: string;
  priceSource: PriceSourceDto;
  /** Lo acordado / vigente al cargar la línea. */
  agreedUnitPrice: string | null;
  agreedDiscountAmount: string | null;
  /** neto − neto acordado (negativo = se cobra menos). */
  difference: string | null;
  overrideReason: string | null;
}

export interface SaleLineDto {
  id: string;
  sortOrder: number;
  product: Ref;
  orderLineId: string | null;
  quantity: string;
  unit: UnitRefDto;
  normalizedQuantity: string;
  saleUnit: UnitRefDto;
  requestedConservation: RequestedConservationDto;
  notes: string | null;
  /** null sin price_lists.read. */
  price: SaleLinePriceDto | null;
  /** Costo material real (Σ lotes); null sin sales.cost.read o en borrador. */
  materialCost: string | null;
  averageLotUnitCost: string | null;
  margin: MarginDto | null;
  lots: SaleLotDto[];
}

export interface SalePaymentRefDto {
  paymentId: string;
  code: string;
  kind: PaymentKindDto;
  method: PaymentMethodDto;
  paymentDate: string;
  amount: string;
  origin: ApplicationOriginDto;
  appliedAt: string;
}

export interface SaleActionsDto {
  canEdit: boolean;
  canPost: boolean;
  canCancel: boolean;
  canRegisterPayment: boolean;
}

export interface SaleDetailDto {
  id: string;
  code: string;
  status: SaleStatusDto;
  paymentStatus: SalePaymentStatusDto;
  customer: Ref & { walkIn: boolean };
  order: { id: string; code: string; status: string } | null;
  warehouse: { id: string; code: string; name: string };
  saleDate: string | null;
  saleDateLocal: string | null;
  timezone: string;
  currency: string;
  notes: string | null;
  /** null sin price_lists.read. */
  amounts: {
    subtotal: string;
    discountTotal: string;
    total: string;
    paid: string;
    pending: string;
  } | null;
  materialCost: string | null;
  margin: MarginDto | null;
  creditLimitExceeded: boolean;
  lines: SaleLineDto[];
  /** null sin payments.read. */
  payments: SalePaymentRefDto[] | null;
  createdAt: string;
  createdBy: PersonRefDto | null;
  postedAt: string | null;
  postedBy: PersonRefDto | null;
  cancelledAt: string | null;
  cancelledBy: PersonRefDto | null;
  cancelReason: string | null;
  canSeePrices: boolean;
  canSeeCosts: boolean;
  canSeeMargin: boolean;
  actions: SaleActionsDto;
}

export interface SalePreviewIssueDto {
  code:
    | "INSUFFICIENT_FREE_PRODUCT_STOCK"
    | "DELIVERY_EXCEEDS_PENDING"
    | "ORDER_NOT_DELIVERABLE"
    | "ORDER_UNPRICED"
    | "NEGATIVE_MARGIN"
    | "CREDIT_LIMIT_EXCEEDED"
    | "RESERVATION_UNUSABLE";
  message: string;
  /** true: impide confirmar; false: sólo advierte. */
  blocking: boolean;
}

export interface SalePreviewLineDto {
  lineId: string;
  product: Ref;
  saleUnit: UnitRefDto;
  quantity: string;
  /** Lo que sale de las reservas del pedido. */
  fromReservations: string;
  missing: string;
  lots: SaleLotDto[];
  netAmount: string | null;
  materialCost: string | null;
  margin: MarginDto | null;
}

export interface SalePreviewDto {
  saleId: string;
  canPost: boolean;
  lines: SalePreviewLineDto[];
  total: string | null;
  materialCost: string | null;
  margin: MarginDto | null;
  /** Señas del pedido que se aplicarán automáticamente. */
  advances: { available: string; toApply: string; remainingCredit: string } | null;
  credit: {
    limit: string | null;
    currentBalance: string;
    projectedBalance: string;
    exceeded: boolean;
  } | null;
  issues: SalePreviewIssueDto[];
}

export interface SaleOperationResultDto {
  sale: SaleDetailDto;
  /** Avisos de la operación (límite de crédito, crédito a favor...). */
  warnings: string[];
}

export interface PaymentApplicationDto {
  sale: { id: string; code: string };
  amount: string;
  origin: ApplicationOriginDto;
  createdAt: string;
}

export interface CustomerPaymentDto {
  id: string;
  code: string;
  kind: PaymentKindDto;
  customer: Ref;
  order: { id: string; code: string } | null;
  sale: { id: string; code: string } | null;
  paymentDate: string;
  paymentDateLocal: string;
  method: PaymentMethodDto;
  reference: string | null;
  notes: string | null;
  amount: string;
  applied: string;
  unapplied: string;
  applications: PaymentApplicationDto[];
  createdBy: PersonRefDto | null;
  createdAt: string;
}

export interface PaymentResultDto {
  payment: CustomerPaymentDto;
  replayed: boolean;
  warnings: string[];
}

export interface AccountMovementDto {
  id: string;
  sequence: number;
  occurredAt: string;
  occurredAtLocal: string;
  type: AccountMovementTypeDto;
  description: string;
  /** Debe (el cliente debe más). */
  debit: string | null;
  /** Haber (pago o ajuste a favor). */
  credit: string | null;
  balanceAfter: string;
  sale: { id: string; code: string } | null;
  payment: { id: string; code: string } | null;
  reason: string | null;
  actor: PersonRefDto | null;
}

export interface PendingSaleDto {
  id: string;
  code: string;
  saleDate: string;
  total: string;
  paid: string;
  pending: string;
  paymentStatus: SalePaymentStatusDto;
}

export interface CustomerAccountDto {
  customer: Ref & { creditLimit: string | null; walkIn: boolean };
  currency: string;
  /** Saldo con signo: positivo = debe; negativo = crédito a favor. */
  balance: string;
  balanceKind: AccountBalanceKindDto;
  balanceAmount: string;
  /** Crédito de cobros todavía sin imputar a ventas. */
  unappliedCredit: string;
  pendingSales: PendingSaleDto[];
  unappliedPayments: { id: string; code: string; kind: PaymentKindDto; unapplied: string }[];
  movements: {
    items: AccountMovementDto[];
    total: number;
    page: number;
    pageSize: number;
  };
  canAdjust: boolean;
  canRegisterPayment: boolean;
  /** Sólo en la respuesta de un ajuste: true si fue un reintento del mismo ajuste. */
  replayed?: boolean;
}

export interface ReceivableDto {
  /** Id del cliente (clave de la fila). */
  id: string;
  customer: Ref;
  balance: string;
  balanceKind: AccountBalanceKindDto;
  balanceAmount: string;
  creditLimit: string | null;
  creditLimitExceeded: boolean;
  pendingSales: number;
  oldestPendingSaleDate: string | null;
  lastMovementAt: string | null;
}

export interface PriceListDto {
  id: string;
  code: string;
  name: string;
  active: boolean;
  isDefault: boolean;
  notes: string | null;
  itemCount: number;
  customerCount: number;
  updatedAt: string;
}

export interface PriceListItemDto {
  product: Ref & { active: boolean };
  saleUnit: UnitRefDto;
  /** Precio en la lista (null si el producto no está en la lista). */
  unitPrice: string | null;
  active: boolean;
  /** Precio base del producto (referencia). */
  productPrice: string;
  updatedAt: string | null;
}

export interface PriceListDetailDto extends PriceListDto {
  items: PriceListItemDto[];
  canManage: boolean;
}

export interface ResolvedPriceDto {
  productId: string;
  unitPrice: string;
  source: PriceSourceDto;
  priceList: { id: string; code: string; name: string } | null;
}

/** Lo comercial de un pedido (Fase 5B): precio acordado, entregas, señas y ventas. */
export interface OrderCommercialDto {
  pricingStatus: OrderPricingStatusDto;
  priceList: { id: string; code: string; name: string } | null;
  /** null sin price_lists.read o sin precio acordado. */
  quotedSubtotal: string | null;
  quotedDiscountTotal: string | null;
  quotedTotal: string | null;
  firstDeliveredAt: string | null;
  deliveredAt: string | null;
  /** null sin payments.read. */
  advances: {
    total: string;
    applied: string;
    available: string;
    payments: {
      id: string;
      code: string;
      paymentDate: string;
      amount: string;
      method: PaymentMethodDto;
    }[];
  } | null;
  /** null sin sales.read. */
  sales:
    | {
        id: string;
        code: string;
        status: SaleStatusDto;
        paymentStatus: SalePaymentStatusDto;
        date: string;
        total: string | null;
      }[]
    | null;
}

export interface OrderLinePriceDto {
  unitPrice: string;
  discountAmount: string;
  netAmount: string;
  priceSource: PriceSourceDto;
  overrideReason: string | null;
}
