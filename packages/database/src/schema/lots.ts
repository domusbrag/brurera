import { sql } from "drizzle-orm";
import {
  boolean,
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
import { costAmount, createdAt, id, normalizedQuantity, updatedAt } from "./common.js";
import { companies } from "./company.js";
import { stockMovements, warehouses } from "./inventory.js";
import { products } from "./items.js";
import { users } from "./people.js";
import { productionOrders } from "./production.js";

/*
 * Lotes de producto terminado, conservación y vida útil (Fase 4.5, ADR-043 a 046).
 * La vida útil pertenece al lote (producido en un momento y bajo una condición),
 * no al producto: el producto sólo define su perfil de conservación.
 */

export const conservationState = pgEnum("conservation_state", [
  "FRESH",
  "REFRIGERATED",
  "FROZEN",
  "THAWED",
]);
export const lotQualityStatus = pgEnum("lot_quality_status", ["AVAILABLE", "BLOCKED"]);

/** Configuración de conservación del producto: estado inicial por defecto y umbral de vencimiento. */
export const productConservationSettings = pgTable(
  "product_conservation_settings",
  {
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    productId: uuid().notNull(),
    /** Estado con que nace un lote si no se elige otro (debe estar habilitado como inicial). */
    defaultInitialState: conservationState().notNull().default("FRESH"),
    /** "Próximo a vencer": vence dentro de estos minutos. */
    nearExpiryMinutes: integer().notNull().default(1440),
    updatedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.productId] }),
    foreignKey({
      name: "product_conservation_settings_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    check(
      "product_conservation_settings_near_expiry",
      sql`${t.nearExpiryMinutes} > 0 and ${t.nearExpiryMinutes} <= 527040`,
    ),
  ],
);

/**
 * Perfil de conservación: una fila por producto + estado. `shelf_life_minutes`
 * es la vida útil normalizada (la UI la muestra en horas o días).
 */
export const productConservationProfiles = pgTable(
  "product_conservation_profiles",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    productId: uuid().notNull(),
    state: conservationState().notNull(),
    enabled: boolean().notNull().default(false),
    shelfLifeMinutes: integer(),
    allowedAsInitial: boolean().notNull().default(false),
    notes: text(),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("product_conservation_profiles_product_state_uq").on(
      t.companyId,
      t.productId,
      t.state,
    ),
    foreignKey({
      name: "product_conservation_profiles_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    check(
      "product_conservation_profiles_shelf_life",
      sql`(not ${t.enabled} or (${t.shelfLifeMinutes} is not null and ${t.shelfLifeMinutes} > 0 and ${t.shelfLifeMinutes} <= 5270400))
        and (${t.shelfLifeMinutes} is null or ${t.shelfLifeMinutes} > 0)`,
    ),
    check("product_conservation_profiles_initial", sql`not ${t.allowedAsInitial} or ${t.enabled}`),
  ],
);

/**
 * Lote de producto terminado. El lote raíz nace de una orden de producción
 * COMPLETED (código = batch_code de la orden); los hijos nacen de una
 * transformación de conservación (parent_lot_id) y conservan orden de origen,
 * fecha de producción y costo unitario. Inmutable salvo calidad y notas
 * (trigger); nunca se borra. La cantidad actual vive en product_lot_balances.
 */
export const productLots = pgTable(
  "product_lots",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    productId: uuid().notNull(),
    productionOrderId: uuid().notNull(),
    parentLotId: uuid(),
    lotCode: varchar({ length: 60 }).notNull(),
    warehouseId: uuid().notNull(),
    conservationState: conservationState().notNull(),
    producedAt: timestamp({ withTimezone: true }).notNull(),
    stateChangedAt: timestamp({ withTimezone: true }).notNull(),
    /** null = vida útil no configurada para el estado (no se inventa una). */
    usableUntil: timestamp({ withTimezone: true }),
    /** Vida útil (minutos) con que se calculó usable_until, para trazabilidad. */
    shelfLifeMinutes: integer(),
    initialQuantity: normalizedQuantity().notNull(),
    unitId: uuid().notNull(),
    /** Costo material por unidad de venta (heredado sin cambios en transformaciones). */
    unitMaterialCost: costAmount().notNull(),
    /** Valor material con que nació el lote. */
    initialValue: costAmount().notNull(),
    qualityStatus: lotQualityStatus().notNull().default("AVAILABLE"),
    qualityReason: text(),
    notes: text(),
    /** Operación que creó el lote (idempotencia de transformaciones). */
    operationId: uuid(),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("product_lots_company_id_uq").on(t.companyId, t.id),
    // Destino de FKs (empresa, producto, lote): un movimiento o saldo no puede apuntar
    // a un lote de otro producto.
    unique("product_lots_company_product_id_uq").on(t.companyId, t.productId, t.id),
    uniqueIndex("product_lots_company_code_uq").on(t.companyId, t.lotCode),
    uniqueIndex("product_lots_company_operation_uq")
      .on(t.companyId, t.operationId)
      .where(sql`${t.operationId} is not null`),
    // Un solo lote raíz por orden de producción.
    uniqueIndex("product_lots_root_order_uq")
      .on(t.companyId, t.productionOrderId)
      .where(sql`${t.parentLotId} is null`),
    index("product_lots_company_product_idx").on(t.companyId, t.productId, t.usableUntil),
    index("product_lots_parent_idx").on(t.companyId, t.parentLotId),
    index("product_lots_company_usable_idx").on(t.companyId, t.usableUntil),
    foreignKey({
      name: "product_lots_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_lots_order_fk",
      columns: [t.companyId, t.productionOrderId],
      foreignColumns: [productionOrders.companyId, productionOrders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_lots_parent_fk",
      columns: [t.companyId, t.parentLotId],
      foreignColumns: [t.companyId, t.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_lots_warehouse_fk",
      columns: [t.companyId, t.warehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_lots_unit_fk",
      columns: [t.companyId, t.unitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    check(
      "product_lots_amounts",
      sql`${t.initialQuantity} > 0 and ${t.unitMaterialCost} >= 0 and ${t.initialValue} >= 0`,
    ),
    check(
      "product_lots_dates",
      sql`${t.stateChangedAt} >= ${t.producedAt} and (${t.usableUntil} is null or ${t.usableUntil} > ${t.stateChangedAt})`,
    ),
    check(
      "product_lots_shelf_life",
      sql`(${t.usableUntil} is null) = (${t.shelfLifeMinutes} is null)`,
    ),
    check(
      "product_lots_not_own_parent",
      sql`${t.parentLotId} is null or ${t.parentLotId} <> ${t.id}`,
    ),
    check(
      "product_lots_quality_reason",
      sql`${t.qualityStatus} = 'AVAILABLE' or (${t.qualityReason} is not null and length(trim(${t.qualityReason})) > 0)`,
    ),
  ],
);

/**
 * Saldo por empresa + depósito + lote: PROYECCIÓN del ledger (cantidad y valor
 * material). Custodiada por trigger igual que stock_balances: sólo cambia con un
 * movimiento nuevo de ese lote. Σ saldos de lotes = saldo agregado del producto.
 */
export const productLotBalances = pgTable(
  "product_lot_balances",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    warehouseId: uuid().notNull(),
    productLotId: uuid().notNull(),
    productId: uuid().notNull(),
    quantity: normalizedQuantity().notNull().default("0"),
    inventoryValue: costAmount().notNull().default("0"),
    lastMovementId: uuid(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("product_lot_balances_lot_uq").on(t.companyId, t.warehouseId, t.productLotId),
    index("product_lot_balances_product_idx").on(t.companyId, t.productId),
    foreignKey({
      name: "product_lot_balances_warehouse_fk",
      columns: [t.companyId, t.warehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_lot_balances_lot_fk",
      columns: [t.companyId, t.productId, t.productLotId],
      foreignColumns: [productLots.companyId, productLots.productId, productLots.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_lot_balances_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_lot_balances_last_movement_fk",
      columns: [t.companyId, t.lastMovementId],
      foreignColumns: [stockMovements.companyId, stockMovements.id],
    }).onDelete("restrict"),
    check("product_lot_balances_nonneg", sql`${t.quantity} >= 0 and ${t.inventoryValue} >= 0`),
    check("product_lot_balances_empty_value", sql`${t.quantity} > 0 or ${t.inventoryValue} = 0`),
  ],
);
