import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
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
import { companies } from "./company.js";
import { costAmount, createdAt, id, normalizedQuantity, updatedAt } from "./common.js";
import { products, rawMaterials } from "./items.js";
import { users } from "./people.js";

/** Depósito. Cada empresa nace con "Depósito Principal"; el stock vive por depósito. */
export const warehouses = pgTable(
  "warehouses",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    code: varchar({ length: 32 }).notNull(),
    name: text().notNull(),
    description: text(),
    address: text(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("warehouses_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("warehouses_company_code_uq").on(t.companyId, t.code),
    index("warehouses_company_active_idx").on(t.companyId, t.active),
  ],
);

/** Qué se mueve. Fase 3 sólo mueve materias primas; PRODUCT queda preparado para Fases 4/5. */
export const stockItemType = pgEnum("stock_item_type", ["RAW_MATERIAL", "PRODUCT"]);

/**
 * Tipos de movimiento de Fase 3. PRODUCTION_CONSUMPTION, PRODUCTION_OUTPUT, SALE y
 * RETURN están reservados: se agregan al enum cuando exista su flujo.
 */
export const stockMovementType = pgEnum("stock_movement_type", [
  "INITIAL_STOCK",
  "PURCHASE_RECEIPT",
  "ADJUSTMENT_POSITIVE",
  "ADJUSTMENT_NEGATIVE",
  "WASTE",
]);

/**
 * Ledger de inventario: FUENTE AUTORITATIVA de todo cambio de existencias.
 * Append-only (trigger). `quantity` y `total_value` llevan signo (+ ingreso,
 * − salida) en la unidad base del ítem; el CHECK de signo lo garantiza por tipo.
 * `sequence` da el orden de registro (el promedio se calcula en ese orden).
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: id(),
    sequence: bigserial({ mode: "number" }).notNull(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    warehouseId: uuid().notNull(),
    itemType: stockItemType().notNull().default("RAW_MATERIAL"),
    rawMaterialId: uuid(),
    productId: uuid(),
    movementType: stockMovementType().notNull(),
    quantity: normalizedQuantity().notNull(),
    baseUnitId: uuid().notNull(),
    /** Costo por unidad base con que se valorizó (promedio vigente en salidas). */
    unitCost: costAmount().notNull(),
    totalValue: costAmount().notNull(),
    /** Saldo del depósito después de este movimiento. */
    balanceAfter: normalizedQuantity().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    referenceType: varchar({ length: 32 }),
    referenceId: uuid(),
    /** Línea de documento que originó el movimiento (idempotencia: una sola vez). */
    sourceLineId: uuid(),
    reason: varchar({ length: 32 }),
    actorUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    notes: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("stock_movements_company_id_uq").on(t.companyId, t.id),
    unique("stock_movements_sequence_uq").on(t.sequence),
    uniqueIndex("stock_movements_source_line_uq")
      .on(t.companyId, t.sourceLineId)
      .where(sql`${t.sourceLineId} is not null`),
    index("stock_movements_company_sequence_idx").on(t.companyId, t.sequence),
    index("stock_movements_company_material_idx").on(t.companyId, t.rawMaterialId, t.sequence),
    index("stock_movements_company_material_occurred_idx").on(
      t.companyId,
      t.rawMaterialId,
      t.occurredAt,
    ),
    index("stock_movements_company_warehouse_occurred_idx").on(
      t.companyId,
      t.warehouseId,
      t.occurredAt,
    ),
    index("stock_movements_company_type_occurred_idx").on(
      t.companyId,
      t.movementType,
      t.occurredAt,
    ),
    index("stock_movements_company_occurred_idx").on(t.companyId, t.occurredAt),
    index("stock_movements_reference_idx").on(t.companyId, t.referenceType, t.referenceId),
    foreignKey({
      name: "stock_movements_warehouse_fk",
      columns: [t.companyId, t.warehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "stock_movements_raw_material_fk",
      columns: [t.companyId, t.rawMaterialId],
      foreignColumns: [rawMaterials.companyId, rawMaterials.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "stock_movements_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "stock_movements_base_unit_fk",
      columns: [t.companyId, t.baseUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    check(
      "stock_movements_item_coherent",
      sql`(${t.itemType} = 'RAW_MATERIAL' and ${t.rawMaterialId} is not null and ${t.productId} is null)
        or (${t.itemType} = 'PRODUCT' and ${t.productId} is not null and ${t.rawMaterialId} is null)`,
    ),
    check(
      "stock_movements_sign",
      sql`(${t.movementType} in ('INITIAL_STOCK', 'PURCHASE_RECEIPT', 'ADJUSTMENT_POSITIVE') and ${t.quantity} > 0 and ${t.totalValue} >= 0)
        or (${t.movementType} in ('ADJUSTMENT_NEGATIVE', 'WASTE') and ${t.quantity} < 0 and ${t.totalValue} <= 0)`,
    ),
    check("stock_movements_balance_nonneg", sql`${t.balanceAfter} >= 0`),
    check("stock_movements_unit_cost_nonneg", sql`${t.unitCost} >= 0`),
    check(
      "stock_movements_reason",
      sql`(${t.movementType} in ('ADJUSTMENT_POSITIVE', 'ADJUSTMENT_NEGATIVE') and ${t.reason} in ('PHYSICAL_COUNT', 'DATA_CORRECTION', 'BREAKAGE', 'OTHER'))
        or (${t.movementType} = 'WASTE' and ${t.reason} in ('EXPIRED', 'DAMAGED', 'PRODUCTION_LOSS', 'QUALITY', 'OTHER'))
        or (${t.movementType} in ('INITIAL_STOCK', 'PURCHASE_RECEIPT') and ${t.reason} is null)`,
    ),
    check(
      "stock_movements_receipt_reference",
      sql`${t.movementType} <> 'PURCHASE_RECEIPT' or (${t.referenceType} = 'PURCHASE_RECEIPT' and ${t.referenceId} is not null and ${t.sourceLineId} is not null)`,
    ),
  ],
);

/**
 * Saldo por empresa + depósito + ítem: PROYECCIÓN derivada del ledger, para
 * consultas rápidas. Nunca se edita a mano: un trigger exige que cada cambio
 * corresponda a un movimiento nuevo y que cantidad = anterior + movimiento.
 */
export const stockBalances = pgTable(
  "stock_balances",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    warehouseId: uuid().notNull(),
    itemType: stockItemType().notNull().default("RAW_MATERIAL"),
    rawMaterialId: uuid(),
    productId: uuid(),
    quantity: normalizedQuantity().notNull().default("0"),
    baseUnitId: uuid().notNull(),
    lastMovementId: uuid(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("stock_balances_raw_material_uq")
      .on(t.companyId, t.warehouseId, t.rawMaterialId)
      .where(sql`${t.rawMaterialId} is not null`),
    uniqueIndex("stock_balances_product_uq")
      .on(t.companyId, t.warehouseId, t.productId)
      .where(sql`${t.productId} is not null`),
    index("stock_balances_company_material_idx").on(t.companyId, t.rawMaterialId),
    foreignKey({
      name: "stock_balances_warehouse_fk",
      columns: [t.companyId, t.warehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "stock_balances_raw_material_fk",
      columns: [t.companyId, t.rawMaterialId],
      foreignColumns: [rawMaterials.companyId, rawMaterials.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "stock_balances_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "stock_balances_base_unit_fk",
      columns: [t.companyId, t.baseUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "stock_balances_last_movement_fk",
      columns: [t.companyId, t.lastMovementId],
      foreignColumns: [stockMovements.companyId, stockMovements.id],
    }).onDelete("restrict"),
    check(
      "stock_balances_item_coherent",
      sql`(${t.itemType} = 'RAW_MATERIAL' and ${t.rawMaterialId} is not null and ${t.productId} is null)
        or (${t.itemType} = 'PRODUCT' and ${t.productId} is not null and ${t.rawMaterialId} is null)`,
    ),
    // MVP: el stock nunca queda negativo (también lo valida la API: INSUFFICIENT_STOCK).
    check("stock_balances_quantity_nonneg", sql`${t.quantity} >= 0`),
  ],
);

/**
 * Costo de inventario por materia prima a nivel EMPRESA (no por depósito):
 * cantidad total, valor y promedio ponderado móvil. Proyección del ledger con
 * el mismo trigger de coherencia que stock_balances. `moving_average_cost` es
 * null hasta el primer ingreso valorizado.
 */
export const rawMaterialInventoryCosts = pgTable(
  "raw_material_inventory_costs",
  {
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    rawMaterialId: uuid().notNull(),
    quantity: normalizedQuantity().notNull().default("0"),
    inventoryValue: costAmount().notNull().default("0"),
    movingAverageCost: costAmount(),
    lastMovementId: uuid(),
    lastUpdatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.rawMaterialId] }),
    foreignKey({
      name: "raw_material_inventory_costs_material_fk",
      columns: [t.companyId, t.rawMaterialId],
      foreignColumns: [rawMaterials.companyId, rawMaterials.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "raw_material_inventory_costs_last_movement_fk",
      columns: [t.companyId, t.lastMovementId],
      foreignColumns: [stockMovements.companyId, stockMovements.id],
    }).onDelete("restrict"),
    check(
      "raw_material_inventory_costs_nonneg",
      sql`${t.quantity} >= 0 and ${t.inventoryValue} >= 0 and (${t.movingAverageCost} is null or ${t.movingAverageCost} >= 0)`,
    ),
    check(
      "raw_material_inventory_costs_empty_value",
      sql`${t.quantity} > 0 or ${t.inventoryValue} = 0`,
    ),
  ],
);

/**
 * Historial de costo (append-only): una fila por movimiento con cantidad, valor
 * y promedio antes y después, y la referencia que lo originó.
 */
export const inventoryCostHistory = pgTable(
  "inventory_cost_history",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    rawMaterialId: uuid().notNull(),
    movementId: uuid().notNull(),
    movementSequence: bigint({ mode: "number" }).notNull(),
    movementType: stockMovementType().notNull(),
    referenceType: varchar({ length: 32 }),
    referenceId: uuid(),
    quantityBefore: normalizedQuantity().notNull(),
    quantityAfter: normalizedQuantity().notNull(),
    valueBefore: costAmount().notNull(),
    valueAfter: costAmount().notNull(),
    averageBefore: costAmount(),
    averageAfter: costAmount(),
    actorUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("inventory_cost_history_movement_uq").on(t.movementId),
    index("inventory_cost_history_material_idx").on(t.companyId, t.rawMaterialId, t.id),
    foreignKey({
      name: "inventory_cost_history_material_fk",
      columns: [t.companyId, t.rawMaterialId],
      foreignColumns: [rawMaterials.companyId, rawMaterials.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_cost_history_movement_fk",
      columns: [t.companyId, t.movementId],
      foreignColumns: [stockMovements.companyId, stockMovements.id],
    }).onDelete("restrict"),
  ],
);
