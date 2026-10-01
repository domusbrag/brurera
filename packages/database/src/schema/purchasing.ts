import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { unitsOfMeasure } from "./catalog.js";
import { suppliers } from "./commercial.js";
import {
  costAmount,
  createdAt,
  id,
  normalizedQuantity,
  quantity,
  recipeQuantity,
  unitCost,
  updatedAt,
} from "./common.js";
import { companies } from "./company.js";
import { warehouses } from "./inventory.js";
import { rawMaterials } from "./items.js";
import { users } from "./people.js";

export const purchaseStatus = pgEnum("purchase_status", [
  "DRAFT",
  "ORDERED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
]);
export const purchaseReceiptStatus = pgEnum("purchase_receipt_status", [
  "DRAFT",
  "POSTED",
  "CANCELLED",
]);

/**
 * Presentación de compra de UNA materia prima: "Bolsa 25 kg" = 1 bolsa de ESTA
 * harina contiene 25 kg. La equivalencia pertenece a materia prima +
 * presentación, nunca a la unidad "bolsa". La conversión (unidad de compra,
 * contenido y su unidad) es inmutable: para cambiarla se desactiva y se crea otra.
 */
export const rawMaterialPresentations = pgTable(
  "raw_material_presentations",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    rawMaterialId: uuid().notNull(),
    name: text().notNull(),
    purchaseUnitId: uuid().notNull(),
    containedQuantity: recipeQuantity().notNull(),
    containedUnitId: uuid().notNull(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("raw_material_presentations_company_id_uq").on(t.companyId, t.id),
    // Permite que las líneas de compra referencien (empresa, materia prima, presentación):
    // la base rechaza usar la presentación de otra materia prima.
    unique("raw_material_presentations_material_id_uq").on(t.companyId, t.rawMaterialId, t.id),
    uniqueIndex("raw_material_presentations_material_name_uq").on(
      t.companyId,
      t.rawMaterialId,
      sql`lower(${t.name})`,
    ),
    foreignKey({
      name: "raw_material_presentations_material_fk",
      columns: [t.companyId, t.rawMaterialId],
      foreignColumns: [rawMaterials.companyId, rawMaterials.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "raw_material_presentations_purchase_unit_fk",
      columns: [t.companyId, t.purchaseUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "raw_material_presentations_contained_unit_fk",
      columns: [t.companyId, t.containedUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    check("raw_material_presentations_contained_positive", sql`${t.containedQuantity} > 0`),
  ],
);

/**
 * Compra a un proveedor. DRAFT se edita; ORDERED en adelante sus líneas quedan
 * fijas (trigger). Una compra que no es DRAFT no se borra. Los importes están en
 * la moneda de la empresa; `tax_total` es informativo y no entra al costo.
 */
export const purchases = pgTable(
  "purchases",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    supplierId: uuid().notNull(),
    internalNumber: varchar({ length: 32 }).notNull(),
    supplierDocumentNumber: varchar({ length: 64 }),
    purchaseDate: date().notNull(),
    expectedDate: date(),
    status: purchaseStatus().notNull().default("DRAFT"),
    currencyCode: varchar({ length: 3 }).notNull(),
    notes: text(),
    subtotal: costAmount().notNull().default("0"),
    discountTotal: costAmount().notNull().default("0"),
    taxTotal: costAmount().notNull().default("0"),
    total: costAmount().notNull().default("0"),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    orderedAt: timestamp({ withTimezone: true }),
    orderedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    cancelReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("purchases_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("purchases_company_number_uq").on(t.companyId, t.internalNumber),
    index("purchases_company_status_date_idx").on(t.companyId, t.status, t.purchaseDate),
    index("purchases_company_date_idx").on(t.companyId, t.purchaseDate),
    index("purchases_supplier_idx").on(t.companyId, t.supplierId),
    foreignKey({
      name: "purchases_supplier_fk",
      columns: [t.companyId, t.supplierId],
      foreignColumns: [suppliers.companyId, suppliers.id],
    }).onDelete("restrict"),
    check(
      "purchases_amounts_nonneg",
      sql`${t.subtotal} >= 0 and ${t.discountTotal} >= 0 and ${t.taxTotal} >= 0 and ${t.total} >= 0`,
    ),
    check(
      "purchases_status_dates",
      sql`(${t.status} = 'DRAFT' and ${t.orderedAt} is null and ${t.cancelledAt} is null)
        or (${t.status} in ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED') and ${t.orderedAt} is not null and ${t.cancelledAt} is null)
        or (${t.status} = 'CANCELLED' and ${t.cancelledAt} is not null)`,
    ),
  ],
);

/**
 * Línea de compra. Guarda la cantidad comercial (4 bolsas), el factor a unidad
 * base congelado (25 kg por bolsa) y la cantidad recibida en recepciones
 * confirmadas, que nunca supera lo pedido (CHECK).
 */
export const purchaseLines = pgTable(
  "purchase_lines",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    purchaseId: uuid().notNull(),
    lineNumber: integer().notNull(),
    rawMaterialId: uuid().notNull(),
    presentationId: uuid(),
    purchaseUnitId: uuid().notNull(),
    orderedQuantity: quantity().notNull(),
    receivedQuantity: quantity().notNull().default("0"),
    unitPrice: unitCost().notNull(),
    grossAmount: costAmount().notNull(),
    discountAmount: costAmount().notNull().default("0"),
    netAmount: costAmount().notNull(),
    baseQuantityPerUnit: normalizedQuantity().notNull(),
    orderedBaseQuantity: normalizedQuantity().notNull(),
    notes: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("purchase_lines_company_id_uq").on(t.companyId, t.id),
    unique("purchase_lines_purchase_id_uq").on(t.companyId, t.purchaseId, t.id),
    unique("purchase_lines_purchase_number_uq").on(t.purchaseId, t.lineNumber),
    index("purchase_lines_raw_material_idx").on(t.companyId, t.rawMaterialId),
    foreignKey({
      name: "purchase_lines_purchase_fk",
      columns: [t.companyId, t.purchaseId],
      foreignColumns: [purchases.companyId, purchases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "purchase_lines_raw_material_fk",
      columns: [t.companyId, t.rawMaterialId],
      foreignColumns: [rawMaterials.companyId, rawMaterials.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_lines_presentation_fk",
      columns: [t.companyId, t.rawMaterialId, t.presentationId],
      foreignColumns: [
        rawMaterialPresentations.companyId,
        rawMaterialPresentations.rawMaterialId,
        rawMaterialPresentations.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_lines_unit_fk",
      columns: [t.companyId, t.purchaseUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    check("purchase_lines_quantity_positive", sql`${t.orderedQuantity} > 0`),
    check(
      "purchase_lines_received_range",
      sql`${t.receivedQuantity} >= 0 and ${t.receivedQuantity} <= ${t.orderedQuantity}`,
    ),
    check(
      "purchase_lines_amounts",
      sql`${t.unitPrice} >= 0 and ${t.grossAmount} >= 0 and ${t.discountAmount} >= 0
        and ${t.discountAmount} <= ${t.grossAmount} and ${t.netAmount} = ${t.grossAmount} - ${t.discountAmount}`,
    ),
    check(
      "purchase_lines_base_positive",
      sql`${t.baseQuantityPerUnit} > 0 and ${t.orderedBaseQuantity} > 0`,
    ),
  ],
);

/**
 * Recepción de mercadería contra una compra, en un depósito. Sólo POSTED afecta
 * inventario. POSTED y CANCELLED son inmutables (trigger).
 */
export const purchaseReceipts = pgTable(
  "purchase_receipts",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    purchaseId: uuid().notNull(),
    internalNumber: varchar({ length: 32 }).notNull(),
    warehouseId: uuid().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull(),
    status: purchaseReceiptStatus().notNull().default("DRAFT"),
    documentNumber: varchar({ length: 64 }),
    notes: text(),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    postedAt: timestamp({ withTimezone: true }),
    postedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    cancelledAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("purchase_receipts_company_id_uq").on(t.companyId, t.id),
    unique("purchase_receipts_purchase_id_uq").on(t.companyId, t.purchaseId, t.id),
    uniqueIndex("purchase_receipts_company_number_uq").on(t.companyId, t.internalNumber),
    index("purchase_receipts_purchase_idx").on(t.companyId, t.purchaseId),
    foreignKey({
      name: "purchase_receipts_purchase_fk",
      columns: [t.companyId, t.purchaseId],
      foreignColumns: [purchases.companyId, purchases.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_receipts_warehouse_fk",
      columns: [t.companyId, t.warehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }).onDelete("restrict"),
    check(
      "purchase_receipts_status_dates",
      sql`(${t.status} = 'DRAFT' and ${t.postedAt} is null and ${t.cancelledAt} is null)
        or (${t.status} = 'POSTED' and ${t.postedAt} is not null and ${t.cancelledAt} is null)
        or (${t.status} = 'CANCELLED' and ${t.postedAt} is null and ${t.cancelledAt} is not null)`,
    ),
  ],
);

/**
 * Línea recibida. Referencia la línea de compra DE LA MISMA compra (FK compuesta
 * con purchase_id). Cantidad comercial y normalizada, costo de adquisición por
 * unidad base y valor de inventario: se fijan al confirmar y no se recalculan.
 */
export const purchaseReceiptLines = pgTable(
  "purchase_receipt_lines",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    purchaseId: uuid().notNull(),
    receiptId: uuid().notNull(),
    purchaseLineId: uuid().notNull(),
    rawMaterialId: uuid().notNull(),
    presentationId: uuid(),
    purchaseUnitId: uuid().notNull(),
    baseUnitId: uuid().notNull(),
    orderedQuantity: quantity().notNull(),
    /** Recibido en recepciones confirmadas antes de ésta (fijado al confirmar). */
    previouslyReceivedQuantity: quantity().notNull().default("0"),
    receivedQuantity: quantity().notNull(),
    normalizedBaseQuantity: normalizedQuantity().notNull(),
    acquisitionUnitCostBase: costAmount().notNull(),
    lineInventoryValue: costAmount().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("purchase_receipt_lines_company_id_uq").on(t.companyId, t.id),
    unique("purchase_receipt_lines_receipt_line_uq").on(t.receiptId, t.purchaseLineId),
    index("purchase_receipt_lines_purchase_line_idx").on(t.companyId, t.purchaseLineId),
    foreignKey({
      name: "purchase_receipt_lines_receipt_fk",
      columns: [t.companyId, t.purchaseId, t.receiptId],
      foreignColumns: [
        purchaseReceipts.companyId,
        purchaseReceipts.purchaseId,
        purchaseReceipts.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "purchase_receipt_lines_purchase_line_fk",
      columns: [t.companyId, t.purchaseId, t.purchaseLineId],
      foreignColumns: [purchaseLines.companyId, purchaseLines.purchaseId, purchaseLines.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_receipt_lines_raw_material_fk",
      columns: [t.companyId, t.rawMaterialId],
      foreignColumns: [rawMaterials.companyId, rawMaterials.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_receipt_lines_base_unit_fk",
      columns: [t.companyId, t.baseUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_receipt_lines_purchase_unit_fk",
      columns: [t.companyId, t.purchaseUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    check("purchase_receipt_lines_quantity_positive", sql`${t.receivedQuantity} > 0`),
    check(
      "purchase_receipt_lines_values_nonneg",
      sql`${t.normalizedBaseQuantity} > 0 and ${t.acquisitionUnitCostBase} >= 0 and ${t.lineInventoryValue} >= 0`,
    ),
  ],
);
