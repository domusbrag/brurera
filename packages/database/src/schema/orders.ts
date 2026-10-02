import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
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
import { createdAt, id, money, normalizedQuantity, recipeQuantity, updatedAt } from "./common.js";
import { companies } from "./company.js";
import { products, rawMaterials } from "./items.js";
import { productLots } from "./lots.js";
import { users } from "./people.js";
import { productionOrders } from "./production.js";
import { recipeVersions, recipes } from "./recipes.js";

/*
 * Pedidos de clientes, reservas de lotes y necesidades (Fase 5A, ADR-050 a 055).
 *
 * - El pedido es un COMPROMISO FUTURO: confirmar reserva lotes de producto
 *   terminado (sin mover stock) y registra lo que falta producir y las materias
 *   primas que eso requiere (sin reservarlas).
 * - Cada confirmación o replanificación es una revisión del plan (plan_revision):
 *   reservas y necesidades de revisiones anteriores no se borran, se liberan o
 *   cancelan.
 */

export const customerOrderStatus = pgEnum("customer_order_status", [
  "DRAFT",
  "CONFIRMED",
  "IN_PREPARATION",
  "READY",
  "CANCELLED",
  // Fase 5B: entrega (una o varias ventas desde el pedido).
  "PARTIALLY_DELIVERED",
  "DELIVERED",
]);
/**
 * Cotización del pedido (Fase 5B, ADR-060): UNPRICED = sin precio (pedidos de
 * Fase 5A; no se inventa); QUOTED = borrador con el precio vigente;
 * AGREED = congelado al confirmar (o al cotizar explícitamente un pedido sin precio).
 */
export const orderPricingStatus = pgEnum("order_pricing_status", ["UNPRICED", "QUOTED", "AGREED"]);
/** De dónde salió un precio (cotización del pedido, listas, precio del producto o manual). */
export const priceSource = pgEnum("price_source", [
  "ORDER_QUOTE",
  "CUSTOMER_PRICE_LIST",
  "DEFAULT_PRICE_LIST",
  "PRODUCT_PRICE",
  "MANUAL",
]);
export const orderCoverageStatus = pgEnum("order_coverage_status", [
  "FULLY_COVERED",
  "PARTIALLY_COVERED",
  "NOT_COVERED",
  "NEEDS_REPLAN",
]);
export const fulfillmentType = pgEnum("fulfillment_type", ["PICKUP", "DELIVERY"]);
export const orderPriority = pgEnum("order_priority", ["NORMAL", "HIGH", "URGENT"]);
export const requestedConservation = pgEnum("requested_conservation", [
  "ANY",
  "FRESH",
  "REFRIGERATED",
  "FROZEN",
  "THAWED",
]);
export const lotReservationStatus = pgEnum("lot_reservation_status", [
  "ACTIVE",
  "RELEASED",
  "INVALIDATED",
  "FULFILLED",
]);
export const reservationReleaseReason = pgEnum("reservation_release_reason", [
  "ORDER_CANCELLED",
  "ORDER_REPLANNED",
  "LOT_BLOCKED",
  "LOT_WASTE",
]);
export const orderRequirementStatus = pgEnum("order_requirement_status", [
  "OPEN",
  "PRODUCTION_CREATED",
  "SATISFIED",
  "CANCELLED",
]);
export const orderRequirementProblem = pgEnum("order_requirement_problem", [
  "NO_RECIPE_FOR_PRODUCTION",
  "RECIPE_NOT_USABLE",
]);

/**
 * Pedido de un cliente. `requested_at` es el instante comprometido (UTC); la UI
 * lo presenta e interpreta en la zona de la empresa. `coverage_status` es la
 * cobertura del plan vigente (null en borrador); NEEDS_REPLAN se deriva además
 * de reservas invalidadas por calidad o merma (sin bloquear el pedido, ADR-052).
 */
export const customerOrders = pgTable(
  "customer_orders",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    internalCode: varchar({ length: 32 }).notNull(),
    customerId: uuid().notNull(),
    status: customerOrderStatus().notNull().default("DRAFT"),
    coverageStatus: orderCoverageStatus(),
    requestedAt: timestamp({ withTimezone: true }).notNull(),
    fulfillmentType: fulfillmentType().notNull().default("PICKUP"),
    deliveryAddress: text(),
    contactName: text(),
    contactPhone: varchar({ length: 50 }),
    eventName: text(),
    priority: orderPriority().notNull().default("NORMAL"),
    notes: text(),
    /** 0 en borrador; 1 al confirmar; +1 en cada replanificación. */
    planRevision: integer().notNull().default(0),
    confirmedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    confirmedAt: timestamp({ withTimezone: true }),
    preparationStartedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    preparationStartedAt: timestamp({ withTimezone: true }),
    readyByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    readyAt: timestamp({ withTimezone: true }),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    cancelledByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelReason: text(),
    /* Fase 5B: cotización y entrega. */
    pricingStatus: orderPricingStatus().notNull().default("QUOTED"),
    /**
     * Lista con que se cotizó (informativa: el precio de cada línea queda congelado).
     * FK compuesta declarada sólo en la migración 0010 (evita el ciclo orders ↔ sales).
     */
    priceListId: uuid(),
    quotedSubtotal: money(),
    quotedDiscountTotal: money(),
    quotedTotal: money(),
    firstDeliveredAt: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    deliveredByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    unique("customer_orders_company_id_uq").on(t.companyId, t.id),
    // Destino de FKs que exigen el mismo cliente (ventas y señas del pedido).
    unique("customer_orders_company_id_customer_uq").on(t.companyId, t.id, t.customerId),
    uniqueIndex("customer_orders_company_code_uq").on(t.companyId, t.internalCode),
    index("customer_orders_company_requested_idx").on(t.companyId, t.requestedAt),
    index("customer_orders_company_status_requested_idx").on(t.companyId, t.status, t.requestedAt),
    index("customer_orders_company_customer_idx").on(t.companyId, t.customerId, t.requestedAt),
    index("customer_orders_company_coverage_idx").on(t.companyId, t.coverageStatus),
    foreignKey({
      name: "customer_orders_customer_fk",
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }).onDelete("restrict"),
    // Estados comparados como texto: PARTIALLY_DELIVERED / DELIVERED se agregan en la
    // misma transacción de la migración 0010.
    check(
      "customer_orders_status_data",
      sql`(${t.status}::text = 'DRAFT' and ${t.planRevision} = 0 and ${t.coverageStatus} is null and ${t.confirmedAt} is null and ${t.cancelledAt} is null)
        or (${t.status}::text in ('CONFIRMED', 'IN_PREPARATION', 'READY', 'PARTIALLY_DELIVERED', 'DELIVERED') and ${t.planRevision} >= 1 and ${t.coverageStatus} is not null and ${t.confirmedAt} is not null and ${t.cancelledAt} is null)
        or (${t.status}::text = 'CANCELLED' and ${t.cancelledAt} is not null)`,
    ),
    check(
      "customer_orders_delivery",
      sql`(${t.status}::text in ('PARTIALLY_DELIVERED', 'DELIVERED')) = (${t.firstDeliveredAt} is not null) or ${t.status}::text = 'CANCELLED'`,
    ),
    check(
      "customer_orders_delivered",
      sql`(${t.status}::text = 'DELIVERED') = (${t.deliveredAt} is not null)`,
    ),
    check(
      "customer_orders_pricing",
      sql`(${t.pricingStatus} = 'UNPRICED' and ${t.quotedTotal} is null and ${t.quotedSubtotal} is null and ${t.quotedDiscountTotal} is null)
        or (${t.pricingStatus} in ('QUOTED', 'AGREED') and ${t.quotedTotal} is not null and ${t.quotedSubtotal} is not null and ${t.quotedDiscountTotal} is not null
            and ${t.quotedTotal} = ${t.quotedSubtotal} - ${t.quotedDiscountTotal} and ${t.quotedTotal} >= 0)`,
    ),
    check(
      "customer_orders_agreed_when_confirmed",
      sql`${t.pricingStatus} <> 'QUOTED' or ${t.status}::text in ('DRAFT', 'CANCELLED')`,
    ),
    check(
      "customer_orders_ready_covered",
      sql`${t.status} <> 'READY' or ${t.coverageStatus} = 'FULLY_COVERED'`,
    ),
  ],
);

/**
 * Línea del pedido. En borrador se reemplazan libremente; con el pedido
 * confirmado sólo cambian por REPLAN (las quitadas quedan con removed_at: sus
 * reservas históricas siguen apuntándolas).
 */
export const customerOrderLines = pgTable(
  "customer_order_lines",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    customerOrderId: uuid().notNull(),
    productId: uuid().notNull(),
    requestedQuantity: recipeQuantity().notNull(),
    unitId: uuid().notNull(),
    /** Cantidad en la unidad de venta del producto (unidad del stock). */
    normalizedQuantity: normalizedQuantity().notNull(),
    saleUnitId: uuid().notNull(),
    requestedConservation: requestedConservation().notNull().default("ANY"),
    notes: text(),
    sortOrder: integer().notNull().default(0),
    removedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /* Fase 5B: precio cotizado por unidad de venta (null si el pedido no tiene precio). */
    quotedUnitPrice: money(),
    quotedDiscountAmount: money(),
    quotedNetAmount: money(),
    priceSource: priceSource(),
    priceOverrideReason: text(),
  },
  (t) => [
    unique("customer_order_lines_company_id_uq").on(t.companyId, t.id),
    // Destino de FKs (empresa, pedido, línea) y (empresa, producto, línea).
    unique("customer_order_lines_company_order_id_uq").on(t.companyId, t.customerOrderId, t.id),
    unique("customer_order_lines_company_product_id_uq").on(t.companyId, t.productId, t.id),
    index("customer_order_lines_order_idx").on(t.companyId, t.customerOrderId, t.sortOrder),
    index("customer_order_lines_product_idx").on(t.companyId, t.productId),
    foreignKey({
      name: "customer_order_lines_order_fk",
      columns: [t.companyId, t.customerOrderId],
      foreignColumns: [customerOrders.companyId, customerOrders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "customer_order_lines_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "customer_order_lines_unit_fk",
      columns: [t.companyId, t.unitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "customer_order_lines_sale_unit_fk",
      columns: [t.companyId, t.saleUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    check(
      "customer_order_lines_quantities",
      sql`${t.requestedQuantity} > 0 and ${t.normalizedQuantity} > 0`,
    ),
    check(
      "customer_order_lines_quote",
      sql`(${t.quotedUnitPrice} is null and ${t.quotedDiscountAmount} is null and ${t.quotedNetAmount} is null and ${t.priceSource} is null)
        or (${t.quotedUnitPrice} >= 0 and ${t.quotedDiscountAmount} >= 0 and ${t.quotedNetAmount} >= 0 and ${t.priceSource} is not null)`,
    ),
    check(
      "customer_order_lines_override_reason",
      sql`${t.priceSource} is distinct from 'MANUAL' or (${t.priceOverrideReason} is not null and length(trim(${t.priceOverrideReason})) > 0)`,
    ),
  ],
);

/**
 * Reserva DURA de producto terminado sobre un LOTE (no sobre el producto): este
 * stock está comprometido comercialmente con el pedido. No es un movimiento de
 * stock. Comprometido = quantity − fulfilled_quantity de las ACTIVE; Σ por lote ≤
 * saldo del lote (trigger). Inmutable salvo el cumplimiento por ventas (Fase 5B:
 * fulfilled_quantity sólo crece) y el paso ACTIVE → RELEASED / INVALIDATED /
 * FULFILLED (FULFILLED ⇔ cumplida por completo).
 */
export const productLotReservations = pgTable(
  "product_lot_reservations",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    customerOrderId: uuid().notNull(),
    orderLineId: uuid().notNull(),
    productId: uuid().notNull(),
    productLotId: uuid().notNull(),
    quantity: normalizedQuantity().notNull(),
    unitId: uuid().notNull(),
    planRevision: integer().notNull(),
    status: lotReservationStatus().notNull().default("ACTIVE"),
    reservedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp({ withTimezone: true }),
    releaseReason: reservationReleaseReason(),
    releasedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    /** Reserva reducida por una merma: la nueva reemplaza (por menos) a la invalidada. */
    replacesReservationId: uuid(),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    /** Cantidad ya entregada por ventas desde esta reserva (Fase 5B). */
    fulfilledQuantity: normalizedQuantity().notNull().default("0"),
  },
  (t) => [
    unique("product_lot_reservations_company_id_uq").on(t.companyId, t.id),
    index("product_lot_reservations_lot_active_idx")
      .on(t.companyId, t.productLotId)
      .where(sql`${t.status} = 'ACTIVE'`),
    index("product_lot_reservations_order_idx").on(t.companyId, t.customerOrderId, t.planRevision),
    index("product_lot_reservations_product_active_idx")
      .on(t.companyId, t.productId)
      .where(sql`${t.status} = 'ACTIVE'`),
    foreignKey({
      name: "product_lot_reservations_order_fk",
      columns: [t.companyId, t.customerOrderId],
      foreignColumns: [customerOrders.companyId, customerOrders.id],
    }).onDelete("restrict"),
    // La línea es del mismo pedido y del mismo producto que el lote.
    foreignKey({
      name: "product_lot_reservations_line_fk",
      columns: [t.companyId, t.customerOrderId, t.orderLineId],
      foreignColumns: [
        customerOrderLines.companyId,
        customerOrderLines.customerOrderId,
        customerOrderLines.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_lot_reservations_line_product_fk",
      columns: [t.companyId, t.productId, t.orderLineId],
      foreignColumns: [
        customerOrderLines.companyId,
        customerOrderLines.productId,
        customerOrderLines.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_lot_reservations_lot_fk",
      columns: [t.companyId, t.productId, t.productLotId],
      foreignColumns: [productLots.companyId, productLots.productId, productLots.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_lot_reservations_unit_fk",
      columns: [t.companyId, t.unitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_lot_reservations_replaces_fk",
      columns: [t.companyId, t.replacesReservationId],
      foreignColumns: [t.companyId, t.id],
    }).onDelete("restrict"),
    check("product_lot_reservations_quantity", sql`${t.quantity} > 0 and ${t.planRevision} >= 1`),
    check(
      "product_lot_reservations_fulfilled",
      sql`${t.fulfilledQuantity} >= 0 and ${t.fulfilledQuantity} <= ${t.quantity}
        and (${t.status} <> 'FULFILLED' or ${t.fulfilledQuantity} = ${t.quantity})
        and (${t.status} <> 'ACTIVE' or ${t.fulfilledQuantity} < ${t.quantity})`,
    ),
    check(
      "product_lot_reservations_release",
      sql`(${t.status} = 'ACTIVE' and ${t.releasedAt} is null and ${t.releaseReason} is null)
        or (${t.status} = 'FULFILLED' and ${t.releasedAt} is not null)
        or (${t.status} in ('RELEASED', 'INVALIDATED') and ${t.releasedAt} is not null and ${t.releaseReason} is not null)`,
    ),
  ],
);

/**
 * Necesidad de producción de una línea (demanda productiva, no stock): lo que
 * falta después de reservar. Fija la versión de receta vigente al planificar
 * (sin receta usable: recipe null y `problem`, sin materias primas inventadas).
 */
export const orderProductionRequirements = pgTable(
  "order_production_requirements",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    customerOrderId: uuid().notNull(),
    orderLineId: uuid().notNull(),
    productId: uuid().notNull(),
    requiredOutputQuantity: normalizedQuantity().notNull(),
    outputUnitId: uuid().notNull(),
    recipeId: uuid(),
    recipeVersionId: uuid(),
    problem: orderRequirementProblem(),
    planRevision: integer().notNull(),
    status: orderRequirementStatus().notNull().default("OPEN"),
    linkedProductionOrderId: uuid(),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    closedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique("order_production_requirements_company_id_uq").on(t.companyId, t.id),
    unique("order_production_requirements_company_product_id_uq").on(
      t.companyId,
      t.productId,
      t.id,
    ),
    index("order_production_requirements_order_idx").on(
      t.companyId,
      t.customerOrderId,
      t.planRevision,
    ),
    index("order_production_requirements_product_idx").on(t.companyId, t.productId, t.status),
    index("order_production_requirements_production_idx").on(
      t.companyId,
      t.linkedProductionOrderId,
    ),
    foreignKey({
      name: "order_production_requirements_order_fk",
      columns: [t.companyId, t.customerOrderId],
      foreignColumns: [customerOrders.companyId, customerOrders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_production_requirements_line_fk",
      columns: [t.companyId, t.customerOrderId, t.orderLineId],
      foreignColumns: [
        customerOrderLines.companyId,
        customerOrderLines.customerOrderId,
        customerOrderLines.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_production_requirements_line_product_fk",
      columns: [t.companyId, t.productId, t.orderLineId],
      foreignColumns: [
        customerOrderLines.companyId,
        customerOrderLines.productId,
        customerOrderLines.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_production_requirements_unit_fk",
      columns: [t.companyId, t.outputUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_production_requirements_recipe_fk",
      columns: [t.companyId, t.productId, t.recipeId],
      foreignColumns: [recipes.companyId, recipes.productId, recipes.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_production_requirements_version_fk",
      columns: [t.companyId, t.recipeId, t.recipeVersionId],
      foreignColumns: [recipeVersions.companyId, recipeVersions.recipeId, recipeVersions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_production_requirements_production_fk",
      columns: [t.companyId, t.linkedProductionOrderId],
      foreignColumns: [productionOrders.companyId, productionOrders.id],
    }).onDelete("restrict"),
    check(
      "order_production_requirements_quantity",
      sql`${t.requiredOutputQuantity} > 0 and ${t.planRevision} >= 1`,
    ),
    check(
      "order_production_requirements_recipe",
      sql`(${t.problem} is null and ${t.recipeId} is not null and ${t.recipeVersionId} is not null)
        or (${t.problem} is not null and ${t.recipeVersionId} is null)`,
    ),
    check(
      "order_production_requirements_link",
      sql`(${t.status} = 'OPEN' and ${t.linkedProductionOrderId} is null)
        or (${t.status} = 'PRODUCTION_CREATED' and ${t.linkedProductionOrderId} is not null)
        or ${t.status} in ('SATISFIED', 'CANCELLED')`,
    ),
  ],
);

/**
 * Snapshot de materias primas que requiere una necesidad de producción, con la
 * versión de receta fijada. Proyección de demanda: NO mueve ni reserva stock.
 */
export const orderMaterialRequirements = pgTable(
  "order_material_requirements",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    orderProductionRequirementId: uuid().notNull(),
    customerOrderId: uuid().notNull(),
    rawMaterialId: uuid().notNull(),
    requiredQuantity: normalizedQuantity().notNull(),
    baseUnitId: uuid().notNull(),
    recipeVersionId: uuid().notNull(),
    planRevision: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("order_material_requirements_requirement_material_uq").on(
      t.orderProductionRequirementId,
      t.rawMaterialId,
    ),
    index("order_material_requirements_material_idx").on(t.companyId, t.rawMaterialId),
    index("order_material_requirements_order_idx").on(t.companyId, t.customerOrderId),
    foreignKey({
      name: "order_material_requirements_requirement_fk",
      columns: [t.companyId, t.orderProductionRequirementId],
      foreignColumns: [orderProductionRequirements.companyId, orderProductionRequirements.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_material_requirements_order_fk",
      columns: [t.companyId, t.customerOrderId],
      foreignColumns: [customerOrders.companyId, customerOrders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_material_requirements_raw_material_fk",
      columns: [t.companyId, t.rawMaterialId],
      foreignColumns: [rawMaterials.companyId, rawMaterials.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_material_requirements_unit_fk",
      columns: [t.companyId, t.baseUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    check("order_material_requirements_quantity", sql`${t.requiredQuantity} > 0`),
  ],
);

/**
 * Idempotencia de confirmar / replanificar / cancelar: el `operationId` de cada
 * intento queda registrado; un reintento devuelve el resultado ya aplicado.
 */
export const customerOrderOperations = pgTable(
  "customer_order_operations",
  {
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    operationId: uuid().notNull(),
    customerOrderId: uuid().notNull(),
    action: varchar({ length: 32 }).notNull(),
    planRevision: integer().notNull(),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.operationId] }),
    foreignKey({
      name: "customer_order_operations_order_fk",
      columns: [t.companyId, t.customerOrderId],
      foreignColumns: [customerOrders.companyId, customerOrders.id],
    }).onDelete("restrict"),
  ],
);
