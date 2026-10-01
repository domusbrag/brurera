import { z } from "zod";
import {
  decimalString,
  optionalDate,
  optionalDecimalString,
  optionalText,
  optionalUuid,
  requiredText,
  uuid,
} from "./validation";
import type { PersonRefDto, UnitRefDto } from "./recipes";

/*
 * Compras, recepciones y presentaciones de compra (Fase 3). Los esquemas validan
 * forma y rangos; la pertenencia a la empresa, la compatibilidad de unidades y
 * los estados los valida la API (con @bakery/domain y la base).
 */

export const PURCHASE_STATUSES = [
  "DRAFT",
  "ORDERED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];
export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  DRAFT: "Borrador",
  ORDERED: "Pedida",
  PARTIALLY_RECEIVED: "Recibida en parte",
  RECEIVED: "Recibida",
  CANCELLED: "Cancelada",
};

export const RECEIPT_STATUSES = ["DRAFT", "POSTED", "CANCELLED"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];
export const RECEIPT_STATUS_LABELS: Record<ReceiptStatus, string> = {
  DRAFT: "Borrador",
  POSTED: "Confirmada",
  CANCELLED: "Descartada",
};

/** Fecha de calendario obligatoria (AAAA-MM-DD). */
const requiredDate = () =>
  optionalDate().refine((v): v is string => v !== null, { message: "Obligatorio" });

/** Instante ISO opcional (fecha de recepción, de una merma…); no puede ser futuro. */
export const optionalPastInstant = () =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v === null || v === undefined || v.trim() === "" ? null : v.trim()))
    .pipe(
      z.iso
        .datetime({ offset: true, error: "Fecha y hora inválidas" })
        .refine((v) => Date.parse(v) <= Date.now() + 60_000, "No puede ser una fecha futura")
        .nullable(),
    );

/** Cantidad comercial de compra o recepción: > 0, hasta 4 decimales. */
export const purchaseQuantitySchema = () =>
  decimalString({ integers: 14, scale: 4, positive: true });
/** Precio por unidad de compra: ≥ 0, hasta 6 decimales. */
export const unitPriceSchema = () => decimalString({ integers: 12, scale: 6 });

/* ---------- Presentaciones de compra ---------- */

export const createPresentationSchema = z.object({
  name: requiredText(80),
  /** Unidad en que se compra (bolsa, paquete, maple…). */
  purchaseUnitId: uuid(),
  /** Cuánto de la materia prima trae 1 unidad de compra (25). */
  containedQuantity: decimalString({ integers: 12, scale: 6, positive: true }),
  /** Unidad del contenido (kg); compatible con la unidad base de la materia prima. */
  containedUnitId: uuid(),
});
export type CreatePresentationInput = z.infer<typeof createPresentationSchema>;

/** La conversión no se edita (cambiaría el significado de compras ya hechas): sólo el nombre. */
export const updatePresentationSchema = z.object({ name: requiredText(80) });

export interface PresentationDto {
  id: string;
  rawMaterialId: string;
  name: string;
  purchaseUnit: { id: string; code: string; symbol: string };
  containedQuantity: string;
  containedUnit: { id: string; code: string; symbol: string };
  /** Equivalencia en la unidad base de la materia prima (25 kg). */
  baseQuantity: string;
  baseUnit: { id: string; code: string; symbol: string };
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/* ---------- Compras ---------- */

export const MAX_PURCHASE_LINES = 100;

export const purchaseLineInputSchema = z
  .object({
    rawMaterialId: uuid(),
    presentationId: optionalUuid(),
    /** Obligatoria sin presentación; con presentación se toma la de la presentación. */
    purchaseUnitId: optionalUuid(),
    quantity: purchaseQuantitySchema(),
    unitPrice: unitPriceSchema(),
    discountAmount: optionalDecimalString({ integers: 12, scale: 2 }),
    notes: optionalText(500),
  })
  .refine((v) => v.presentationId !== null || v.purchaseUnitId !== null, {
    message: "Elegí una presentación o una unidad de compra",
    path: ["purchaseUnitId"],
  });
export type PurchaseLineInput = z.infer<typeof purchaseLineInputSchema>;

const purchaseHeaderFields = {
  supplierId: uuid(),
  purchaseDate: requiredDate(),
  expectedDate: optionalDate(),
  supplierDocumentNumber: optionalText(64),
  notes: optionalText(2000),
  /** Impuestos informativos: suman al total, no al costo de inventario. */
  taxTotal: optionalDecimalString({ integers: 12, scale: 2 }),
};

export const createPurchaseSchema = z.object({
  ...purchaseHeaderFields,
  lines: z.array(purchaseLineInputSchema).max(MAX_PURCHASE_LINES).default([]),
});
export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>;

/**
 * Edición. En borrador se edita todo (`lines` reemplaza la lista). Pedida o
 * recibida en parte, sólo notas, fecha esperada y documento del proveedor.
 */
export const updatePurchaseSchema = z
  .object({
    ...purchaseHeaderFields,
    lines: z.array(purchaseLineInputSchema).max(MAX_PURCHASE_LINES),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "No hay cambios para guardar",
  });
export type UpdatePurchaseInput = z.infer<typeof updatePurchaseSchema>;
/** Campos editables fuera de borrador. */
export const PURCHASE_ALWAYS_EDITABLE = [
  "notes",
  "expectedDate",
  "supplierDocumentNumber",
] as const;

export const cancelPurchaseSchema = z.object({ reason: optionalText(500) });

export const purchaseListQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** Un estado, "open" (pedidas o recibidas en parte) o "all". */
  status: z.enum([...PURCHASE_STATUSES, "open", "all"]).default("all"),
  supplierId: uuid().optional(),
  rawMaterialId: uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export interface PurchaseLineDto {
  id: string;
  lineNumber: number;
  rawMaterial: { id: string; code: string; name: string; baseUnit: UnitRefDto };
  presentation: { id: string; name: string } | null;
  purchaseUnit: UnitRefDto;
  orderedQuantity: string;
  receivedQuantity: string;
  pendingQuantity: string;
  unitPrice: string;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
  /** Unidades base por unidad de compra (25 kg por bolsa), congelado en la línea. */
  baseQuantityPerUnit: string;
  orderedBaseQuantity: string;
  /** Neto / cantidad base pedida (sin impuestos). */
  acquisitionUnitCost: string;
  notes: string | null;
}

export interface PurchaseReceiptSummaryDto {
  id: string;
  number: string;
  status: ReceiptStatus;
  warehouse: { id: string; code: string; name: string };
  receivedAt: string;
  documentNumber: string | null;
  postedAt: string | null;
  postedBy: PersonRefDto | null;
  lineCount: number;
  inventoryValue: string;
}

export interface PurchaseDto {
  id: string;
  number: string;
  status: PurchaseStatus;
  supplier: { id: string; code: string; name: string };
  supplierDocumentNumber: string | null;
  purchaseDate: string;
  expectedDate: string | null;
  currency: string;
  notes: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  /** Valor neto recibido / pendiente (proporcional a lo recibido de cada línea). */
  receivedAmount: string;
  pendingAmount: string;
  lines: PurchaseLineDto[];
  receipts: PurchaseReceiptSummaryDto[];
  createdBy: PersonRefDto | null;
  createdAt: string;
  updatedAt: string;
  orderedAt: string | null;
  orderedBy: PersonRefDto | null;
  cancelledAt: string | null;
  cancelledBy: PersonRefDto | null;
  cancelReason: string | null;
}

export interface PurchaseListItemDto {
  id: string;
  number: string;
  status: PurchaseStatus;
  supplier: { id: string; code: string; name: string };
  purchaseDate: string;
  expectedDate: string | null;
  currency: string;
  total: string;
  receivedAmount: string;
  pendingAmount: string;
  lineCount: number;
}

/* ---------- Recepciones ---------- */

export const receiptLineInputSchema = z.object({
  purchaseLineId: uuid(),
  /** Cantidad recibida ahora, en la unidad de compra de la línea. 0 = no llegó. */
  quantity: decimalString({ integers: 14, scale: 4 }),
});

const receiptFields = {
  warehouseId: uuid(),
  /** Momento de la recepción; por defecto, ahora. */
  receivedAt: optionalPastInstant(),
  documentNumber: optionalText(64),
  notes: optionalText(2000),
  lines: z
    .array(receiptLineInputSchema)
    .max(MAX_PURCHASE_LINES)
    .refine((lines) => lines.some((l) => Number(l.quantity) > 0), {
      message: "Indicá la cantidad recibida de al menos una línea",
    }),
};

export const createReceiptSchema = z.object(receiptFields);
export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;

export const updateReceiptSchema = z
  .object(receiptFields)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "No hay cambios para guardar",
  });
export type UpdateReceiptInput = z.infer<typeof updateReceiptSchema>;

export interface ReceiptLineDto {
  id: string;
  purchaseLineId: string;
  rawMaterial: { id: string; code: string; name: string };
  presentation: { id: string; name: string } | null;
  purchaseUnit: UnitRefDto;
  baseUnit: UnitRefDto;
  orderedQuantity: string;
  /** Recibido en recepciones confirmadas ANTES de ésta (al confirmar se congela). */
  previouslyReceivedQuantity: string;
  pendingQuantity: string;
  receivedQuantity: string;
  normalizedBaseQuantity: string;
  acquisitionUnitCost: string;
  lineInventoryValue: string;
}

export interface ReceiptDto {
  id: string;
  number: string;
  status: ReceiptStatus;
  purchase: { id: string; number: string; status: PurchaseStatus; supplierName: string };
  warehouse: { id: string; code: string; name: string };
  receivedAt: string;
  documentNumber: string | null;
  notes: string | null;
  currency: string;
  inventoryValue: string;
  lines: ReceiptLineDto[];
  createdBy: PersonRefDto | null;
  createdAt: string;
  postedAt: string | null;
  postedBy: PersonRefDto | null;
}
