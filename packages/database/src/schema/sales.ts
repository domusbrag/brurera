import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { unitsOfMeasure } from "./catalog.js";
import { customers } from "./commercial.js";
import {
  costAmount,
  createdAt,
  id,
  money,
  normalizedQuantity,
  recipeQuantity,
  updatedAt,
} from "./common.js";
import { companies } from "./company.js";
import { stockMovements, warehouses } from "./inventory.js";
import { products } from "./items.js";
import { productLots } from "./lots.js";
import {
  customerOrderLines,
  customerOrders,
  priceSource,
  productLotReservations,
  requestedConservation,
} from "./orders.js";
import { users } from "./people.js";

/*
 * Ventas, precios, cobros y cuenta corriente (Fase 5B, ADR-057 a 062).
 *
 * - SALE: operación comercial concretada. POSTED = la entrega ocurrió (sale el
 *   producto, se congelan costos y precio, se genera deuda). Inmutable.
 * - SALE LOT ALLOCATION: qué lotes concretos salieron y a qué costo (COGS por
 *   identificación específica).
 * - CUSTOMER PAYMENT: dinero recibido. PAYMENT APPLICATION: a qué venta se
 *   aplica (no mueve la cuenta: eso ya ocurrió al registrar el pago).
 * - CUSTOMER ACCOUNT MOVEMENT: ledger append-only de la cuenta del cliente
 *   (+ debe, − crédito a favor); CUSTOMER ACCOUNT BALANCE es su proyección.
 */

/** Porcentaje de margen: puede ser negativo o mayor a 100 (4 decimales). */
const marginPercentage = () => numeric({ precision: 14, scale: 4 });

export const saleStatus = pgEnum("sale_status", ["DRAFT", "POSTED", "CANCELLED"]);
export const salePaymentStatus = pgEnum("sale_payment_status", [
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
]);
export const paymentMethod = pgEnum("payment_method", [
  "CASH",
  "TRANSFER",
  "DEBIT_CARD",
  "CREDIT_CARD",
  "OTHER",
]);
export const customerPaymentKind = pgEnum("customer_payment_kind", [
  "ORDER_ADVANCE",
  "SALE_PAYMENT",
  "ON_ACCOUNT",
]);
/** Sólo POSTED en el MVP: un cobro registrado no se anula (se corrige con un ajuste). */
export const customerPaymentStatus = pgEnum("customer_payment_status", ["POSTED"]);
export const paymentApplicationOrigin = pgEnum("payment_application_origin", [
  "ADVANCE_AUTO",
  "SALE_PAYMENT",
  "MANUAL",
]);
export const customerAccountMovementType = pgEnum("customer_account_movement_type", [
  "SALE_DEBIT",
  "PAYMENT_CREDIT",
  "ADJUSTMENT_DEBIT",
  "ADJUSTMENT_CREDIT",
]);

/* ---------- Listas de precios ---------- */

export const priceLists = pgTable(
  "price_lists",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    code: varchar({ length: 32 }).notNull(),
    name: text().notNull(),
    active: boolean().notNull().default(true),
    isDefault: boolean().notNull().default(false),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("price_lists_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("price_lists_company_code_uq").on(t.companyId, t.code),
    uniqueIndex("price_lists_company_default_uq")
      .on(t.companyId)
      .where(sql`${t.isDefault}`),
    check("price_lists_default_active", sql`not ${t.isDefault} or ${t.active}`),
  ],
);

/** Precio de un producto en una lista, por unidad de venta del producto. */
export const priceListItems = pgTable(
  "price_list_items",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    priceListId: uuid().notNull(),
    productId: uuid().notNull(),
    unitPrice: money().notNull(),
    active: boolean().notNull().default(true),
    updatedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("price_list_items_list_product_uq").on(t.companyId, t.priceListId, t.productId),
    index("price_list_items_product_idx").on(t.companyId, t.productId),
    foreignKey({
      name: "price_list_items_list_fk",
      columns: [t.companyId, t.priceListId],
      foreignColumns: [priceLists.companyId, priceLists.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_list_items_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    check("price_list_items_price_nonneg", sql`${t.unitPrice} >= 0`),
  ],
);

/* ---------- Ventas ---------- */

/**
 * Venta. Estado comercial/físico (DRAFT → POSTED | CANCELLED) separado del
 * estado de cobro (derivado de Σ aplicaciones = paid_amount). Costos y margen
 * nacen al postear y no cambian más.
 */
export const sales = pgTable(
  "sales",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    internalCode: varchar({ length: 32 }).notNull(),
    customerId: uuid().notNull(),
    sourceOrderId: uuid(),
    warehouseId: uuid().notNull(),
    status: saleStatus().notNull().default("DRAFT"),
    paymentStatus: salePaymentStatus().notNull().default("UNPAID"),
    /** Instante de la entrega/venta (se fija al postear). */
    saleDate: timestamp({ withTimezone: true }),
    priceListId: uuid(),
    subtotal: money().notNull().default("0"),
    discountTotal: money().notNull().default("0"),
    total: money().notNull().default("0"),
    /** Σ aplicaciones de pagos (custodiado por trigger). */
    paidAmount: money().notNull().default("0"),
    materialCostTotal: costAmount(),
    grossMarginAmount: costAmount(),
    grossMarginPercentage: marginPercentage(),
    currency: varchar({ length: 3 }).notNull(),
    notes: text(),
    /** Se posteó con el saldo proyectado del cliente por encima de su límite. */
    creditLimitExceeded: boolean().notNull().default(false),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    postedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    postedAt: timestamp({ withTimezone: true }),
    cancelledByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("sales_company_id_uq").on(t.companyId, t.id),
    // Destino de FKs que exigen el mismo cliente (pagos, aplicaciones, ledger).
    unique("sales_company_id_customer_uq").on(t.companyId, t.id, t.customerId),
    uniqueIndex("sales_company_code_uq").on(t.companyId, t.internalCode),
    index("sales_company_date_idx").on(t.companyId, t.saleDate),
    index("sales_company_status_date_idx").on(t.companyId, t.status, t.saleDate),
    index("sales_company_customer_date_idx").on(t.companyId, t.customerId, t.saleDate),
    index("sales_company_payment_status_idx").on(t.companyId, t.paymentStatus, t.saleDate),
    index("sales_company_order_idx")
      .on(t.companyId, t.sourceOrderId)
      .where(sql`${t.sourceOrderId} is not null`),
    foreignKey({
      name: "sales_customer_fk",
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }).onDelete("restrict"),
    // El pedido de origen es del mismo cliente (destino declarado en la migración 0010).
    foreignKey({
      name: "sales_order_fk",
      columns: [t.companyId, t.sourceOrderId, t.customerId],
      foreignColumns: [customerOrders.companyId, customerOrders.id, customerOrders.customerId],
    }).onDelete("restrict"),
    foreignKey({
      name: "sales_warehouse_fk",
      columns: [t.companyId, t.warehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sales_price_list_fk",
      columns: [t.companyId, t.priceListId],
      foreignColumns: [priceLists.companyId, priceLists.id],
    }).onDelete("restrict"),
    check(
      "sales_status_data",
      sql`(${t.status} = 'DRAFT' and ${t.postedAt} is null and ${t.saleDate} is null and ${t.cancelledAt} is null and ${t.materialCostTotal} is null)
        or (${t.status} = 'POSTED' and ${t.postedAt} is not null and ${t.saleDate} is not null and ${t.cancelledAt} is null and ${t.materialCostTotal} is not null and ${t.grossMarginAmount} is not null)
        or (${t.status} = 'CANCELLED' and ${t.cancelledAt} is not null and ${t.postedAt} is null)`,
    ),
    check(
      "sales_amounts",
      sql`${t.subtotal} >= 0 and ${t.discountTotal} >= 0 and ${t.total} >= 0 and ${t.total} = ${t.subtotal} - ${t.discountTotal}
        and ${t.paidAmount} >= 0 and ${t.paidAmount} <= ${t.total}`,
    ),
    check(
      "sales_payment_status",
      sql`(${t.status} <> 'POSTED' and ${t.paymentStatus} = 'UNPAID' and ${t.paidAmount} = 0)
        or (${t.status} = 'POSTED' and (
          (${t.paidAmount} >= ${t.total} and ${t.paymentStatus} = 'PAID')
          or (${t.paidAmount} = 0 and ${t.total} > 0 and ${t.paymentStatus} = 'UNPAID')
          or (${t.paidAmount} > 0 and ${t.paidAmount} < ${t.total} and ${t.paymentStatus} = 'PARTIALLY_PAID')))`,
    ),
  ],
);

/**
 * Línea de venta. Precio por unidad de venta del producto; neto =
 * round2(cantidad normalizada × precio) − descuento. `agreed_unit_price` es el
 * precio acordado (cotización del pedido o precio vigente al cargar): si el
 * precio final difiere, `price_override_reason` es obligatorio.
 */
export const saleLines = pgTable(
  "sale_lines",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    saleId: uuid().notNull(),
    sourceOrderLineId: uuid(),
    productId: uuid().notNull(),
    quantity: recipeQuantity().notNull(),
    unitId: uuid().notNull(),
    normalizedQuantity: normalizedQuantity().notNull(),
    saleUnitId: uuid().notNull(),
    requestedConservation: requestedConservation().notNull().default("ANY"),
    unitPrice: money().notNull(),
    discountAmount: money().notNull().default("0"),
    netAmount: money().notNull(),
    priceSource: priceSource().notNull(),
    agreedUnitPrice: money(),
    agreedDiscountAmount: money(),
    priceOverrideReason: text(),
    materialCost: costAmount(),
    averageLotUnitCost: costAmount(),
    grossMarginAmount: costAmount(),
    grossMarginPercentage: marginPercentage(),
    notes: text(),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("sale_lines_company_id_uq").on(t.companyId, t.id),
    unique("sale_lines_company_sale_id_uq").on(t.companyId, t.saleId, t.id),
    unique("sale_lines_company_product_id_uq").on(t.companyId, t.productId, t.id),
    index("sale_lines_sale_idx").on(t.companyId, t.saleId, t.sortOrder),
    index("sale_lines_product_idx").on(t.companyId, t.productId),
    index("sale_lines_order_line_idx")
      .on(t.companyId, t.sourceOrderLineId)
      .where(sql`${t.sourceOrderLineId} is not null`),
    foreignKey({
      name: "sale_lines_sale_fk",
      columns: [t.companyId, t.saleId],
      foreignColumns: [sales.companyId, sales.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sale_lines_order_line_fk",
      columns: [t.companyId, t.productId, t.sourceOrderLineId],
      foreignColumns: [
        customerOrderLines.companyId,
        customerOrderLines.productId,
        customerOrderLines.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "sale_lines_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sale_lines_unit_fk",
      columns: [t.companyId, t.unitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sale_lines_sale_unit_fk",
      columns: [t.companyId, t.saleUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    check(
      "sale_lines_amounts",
      sql`${t.quantity} > 0 and ${t.normalizedQuantity} > 0 and ${t.unitPrice} >= 0
        and ${t.discountAmount} >= 0 and ${t.netAmount} >= 0`,
    ),
    check(
      "sale_lines_override_reason",
      sql`${t.priceSource} <> 'MANUAL' or (${t.priceOverrideReason} is not null and length(trim(${t.priceOverrideReason})) > 0)`,
    ),
  ],
);

/**
 * Evidencia histórica de qué lote se vendió y a qué costo (identificación
 * específica). Una fila por lote retirado; append-only. El movimiento SALE la
 * referencia con source_line_id = id (idempotencia del ledger).
 */
export const saleLotAllocations = pgTable(
  "sale_lot_allocations",
  {
    id: uuid().primaryKey(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    saleId: uuid().notNull(),
    saleLineId: uuid().notNull(),
    productId: uuid().notNull(),
    productLotId: uuid().notNull(),
    reservationId: uuid(),
    warehouseId: uuid().notNull(),
    quantity: normalizedQuantity().notNull(),
    unitId: uuid().notNull(),
    unitMaterialCost: costAmount().notNull(),
    materialCost: costAmount().notNull(),
    stockMovementId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("sale_lot_allocations_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("sale_lot_allocations_movement_uq").on(t.companyId, t.stockMovementId),
    index("sale_lot_allocations_sale_idx").on(t.companyId, t.saleId),
    index("sale_lot_allocations_lot_idx").on(t.companyId, t.productLotId),
    foreignKey({
      name: "sale_lot_allocations_line_fk",
      columns: [t.companyId, t.saleId, t.saleLineId],
      foreignColumns: [saleLines.companyId, saleLines.saleId, saleLines.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sale_lot_allocations_line_product_fk",
      columns: [t.companyId, t.productId, t.saleLineId],
      foreignColumns: [saleLines.companyId, saleLines.productId, saleLines.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sale_lot_allocations_lot_fk",
      columns: [t.companyId, t.productId, t.productLotId],
      foreignColumns: [productLots.companyId, productLots.productId, productLots.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sale_lot_allocations_reservation_fk",
      columns: [t.companyId, t.reservationId],
      foreignColumns: [productLotReservations.companyId, productLotReservations.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sale_lot_allocations_warehouse_fk",
      columns: [t.companyId, t.warehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sale_lot_allocations_unit_fk",
      columns: [t.companyId, t.unitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sale_lot_allocations_movement_fk",
      columns: [t.companyId, t.stockMovementId],
      foreignColumns: [stockMovements.companyId, stockMovements.id],
    }).onDelete("restrict"),
    check(
      "sale_lot_allocations_amounts",
      sql`${t.quantity} > 0 and ${t.unitMaterialCost} >= 0 and ${t.materialCost} >= 0`,
    ),
  ],
);

/* ---------- Cobros ---------- */

/**
 * Dinero recibido de un cliente. Nace POSTED (genera PAYMENT_CREDIT) y es
 * inmutable: un error se corrige con un ajuste de cuenta autorizado (ADR-061).
 * `operation_id` (uno por intento del cliente) hace idempotente el registro.
 */
export const customerPayments = pgTable(
  "customer_payments",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    internalCode: varchar({ length: 32 }).notNull(),
    customerId: uuid().notNull(),
    kind: customerPaymentKind().notNull(),
    /** Seña: pedido al que se anticipó. */
    sourceOrderId: uuid(),
    /** Cobro registrado desde una venta (informativo; la aplicación es la que cuenta). */
    sourceSaleId: uuid(),
    status: customerPaymentStatus().notNull().default("POSTED"),
    paymentDate: timestamp({ withTimezone: true }).notNull(),
    amount: money().notNull(),
    paymentMethod: paymentMethod().notNull(),
    reference: varchar({ length: 120 }),
    notes: text(),
    operationId: uuid().notNull(),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    postedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    postedAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("customer_payments_company_id_uq").on(t.companyId, t.id),
    unique("customer_payments_company_id_customer_uq").on(t.companyId, t.id, t.customerId),
    uniqueIndex("customer_payments_company_code_uq").on(t.companyId, t.internalCode),
    uniqueIndex("customer_payments_company_operation_uq").on(t.companyId, t.operationId),
    index("customer_payments_customer_date_idx").on(t.companyId, t.customerId, t.paymentDate),
    index("customer_payments_company_date_idx").on(t.companyId, t.paymentDate),
    index("customer_payments_order_idx")
      .on(t.companyId, t.sourceOrderId)
      .where(sql`${t.sourceOrderId} is not null`),
    foreignKey({
      name: "customer_payments_customer_fk",
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "customer_payments_order_fk",
      columns: [t.companyId, t.sourceOrderId, t.customerId],
      foreignColumns: [customerOrders.companyId, customerOrders.id, customerOrders.customerId],
    }).onDelete("restrict"),
    foreignKey({
      name: "customer_payments_sale_fk",
      columns: [t.companyId, t.sourceSaleId, t.customerId],
      foreignColumns: [sales.companyId, sales.id, sales.customerId],
    }).onDelete("restrict"),
    check("customer_payments_amount", sql`${t.amount} > 0`),
    check(
      "customer_payments_kind",
      sql`(${t.kind} = 'ORDER_ADVANCE' and ${t.sourceOrderId} is not null)
        or (${t.kind} = 'SALE_PAYMENT' and ${t.sourceSaleId} is not null)
        or (${t.kind} = 'ON_ACCOUNT' and ${t.sourceOrderId} is null and ${t.sourceSaleId} is null)`,
    ),
  ],
);

/**
 * Aplicación de un pago a una venta (mismo cliente, por FK). No es un
 * movimiento financiero: el crédito ya se registró con el pago. Append-only;
 * Σ por venta ≤ total y Σ por pago ≤ monto (trigger).
 */
export const customerPaymentApplications = pgTable(
  "customer_payment_applications",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    paymentId: uuid().notNull(),
    saleId: uuid().notNull(),
    customerId: uuid().notNull(),
    amount: money().notNull(),
    origin: paymentApplicationOrigin().notNull(),
    /** Imputación manual: id del intento (idempotencia, único por empresa). */
    operationId: uuid(),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("customer_payment_applications_sale_idx").on(t.companyId, t.saleId),
    index("customer_payment_applications_payment_idx").on(t.companyId, t.paymentId),
    uniqueIndex("customer_payment_applications_operation_uq")
      .on(t.companyId, t.operationId)
      .where(sql`${t.operationId} is not null`),
    foreignKey({
      name: "customer_payment_applications_payment_fk",
      columns: [t.companyId, t.paymentId, t.customerId],
      foreignColumns: [
        customerPayments.companyId,
        customerPayments.id,
        customerPayments.customerId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "customer_payment_applications_sale_fk",
      columns: [t.companyId, t.saleId, t.customerId],
      foreignColumns: [sales.companyId, sales.id, sales.customerId],
    }).onDelete("restrict"),
    check("customer_payment_applications_amount", sql`${t.amount} > 0`),
  ],
);

/* ---------- Cuenta corriente ---------- */

/**
 * Ledger de la cuenta del cliente: FUENTE DE VERDAD. Append-only. Signo:
 * positivo = el cliente debe, negativo = crédito a favor. Una venta genera un
 * único SALE_DEBIT y un pago un único PAYMENT_CREDIT (índices únicos).
 */
export const customerAccountMovements = pgTable(
  "customer_account_movements",
  {
    id: id(),
    sequence: bigserial({ mode: "number" }).notNull(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    customerId: uuid().notNull(),
    movementType: customerAccountMovementType().notNull(),
    signedAmount: money().notNull(),
    balanceAfter: money().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    saleId: uuid(),
    paymentId: uuid(),
    reason: text(),
    notes: text(),
    /** Ajuste: id del intento (idempotencia, único por empresa). */
    operationId: uuid(),
    actorUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("customer_account_movements_company_id_uq").on(t.companyId, t.id),
    unique("customer_account_movements_sequence_uq").on(t.sequence),
    uniqueIndex("customer_account_movements_sale_uq")
      .on(t.companyId, t.saleId)
      .where(sql`${t.movementType} = 'SALE_DEBIT'`),
    uniqueIndex("customer_account_movements_payment_uq")
      .on(t.companyId, t.paymentId)
      .where(sql`${t.movementType} = 'PAYMENT_CREDIT'`),
    uniqueIndex("customer_account_movements_operation_uq")
      .on(t.companyId, t.operationId)
      .where(sql`${t.operationId} is not null`),
    check(
      "customer_account_movements_operation_adjustment",
      sql`${t.operationId} is null or ${t.movementType} in ('ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT')`,
    ),
    index("customer_account_movements_customer_idx").on(t.companyId, t.customerId, t.sequence),
    index("customer_account_movements_customer_date_idx").on(
      t.companyId,
      t.customerId,
      t.occurredAt,
    ),
    index("customer_account_movements_company_date_idx").on(t.companyId, t.occurredAt),
    foreignKey({
      name: "customer_account_movements_customer_fk",
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "customer_account_movements_sale_fk",
      columns: [t.companyId, t.saleId, t.customerId],
      foreignColumns: [sales.companyId, sales.id, sales.customerId],
    }).onDelete("restrict"),
    foreignKey({
      name: "customer_account_movements_payment_fk",
      columns: [t.companyId, t.paymentId, t.customerId],
      foreignColumns: [
        customerPayments.companyId,
        customerPayments.id,
        customerPayments.customerId,
      ],
    }).onDelete("restrict"),
    check(
      "customer_account_movements_sign",
      sql`(${t.movementType} in ('SALE_DEBIT', 'ADJUSTMENT_DEBIT') and ${t.signedAmount} > 0)
        or (${t.movementType} in ('PAYMENT_CREDIT', 'ADJUSTMENT_CREDIT') and ${t.signedAmount} < 0)`,
    ),
    check(
      "customer_account_movements_reference",
      sql`(${t.movementType} = 'SALE_DEBIT' and ${t.saleId} is not null and ${t.paymentId} is null)
        or (${t.movementType} = 'PAYMENT_CREDIT' and ${t.paymentId} is not null and ${t.saleId} is null)
        or (${t.movementType} in ('ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT') and ${t.saleId} is null and ${t.paymentId} is null
            and ${t.reason} is not null and length(trim(${t.reason})) > 0)`,
    ),
  ],
);

/**
 * Saldo de la cuenta del cliente: PROYECCIÓN del ledger, custodiada por trigger
 * (sólo cambia con un movimiento nuevo y saldo = anterior + movimiento). Puede
 * ser negativo (crédito a favor).
 */
export const customerAccountBalances = pgTable(
  "customer_account_balances",
  {
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    customerId: uuid().notNull(),
    balance: money().notNull().default("0"),
    lastMovementId: uuid(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.customerId] }),
    index("customer_account_balances_balance_idx").on(t.companyId, t.balance),
    foreignKey({
      name: "customer_account_balances_customer_fk",
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "customer_account_balances_last_movement_fk",
      columns: [t.companyId, t.lastMovementId],
      foreignColumns: [customerAccountMovements.companyId, customerAccountMovements.id],
    }).onDelete("restrict"),
  ],
);
