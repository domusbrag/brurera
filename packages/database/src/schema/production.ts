import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  date,
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
import {
  costAmount,
  createdAt,
  id,
  normalizedQuantity,
  percentage,
  recipeQuantity,
  updatedAt,
} from "./common.js";
import { companies } from "./company.js";
import { stockMovementType, stockMovements, warehouses } from "./inventory.js";
import { costSource, products, rawMaterials } from "./items.js";
import { employees, users } from "./people.js";
import { costCompleteness, recipeIngredients, recipeVersions, recipes } from "./recipes.js";

export const productionOrderStatus = pgEnum("production_order_status", [
  "DRAFT",
  "PLANNED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
]);
export const productionLineType = pgEnum("production_line_type", ["RECIPE", "EXTRA"]);

/** Variaciones porcentuales (pueden superar 999 % con planes chicos). */
const variancePercentage = () => numeric({ precision: 20, scale: 4 });

/**
 * Orden de producción = lote del MVP (ADR-039). Documento con estados
 * DRAFT → PLANNED → IN_PROGRESS → COMPLETED (o CANCELLED antes de completar).
 *
 * - La versión de receta queda fijada al planificar (trigger, ADR-040).
 * - Las columnas planned_* de costo son el snapshot del costo ESPERADO (al
 *   planificar); actual_* el costo MATERIAL REAL (al completar). Juntas son la
 *   "estructura equivalente" a un ProductionCostSnapshot.
 * - Sólo COMPLETED genera movimientos de stock (ADR-041) y es inmutable.
 */
export const productionOrders = pgTable(
  "production_orders",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    internalCode: varchar({ length: 32 }).notNull(),
    productId: uuid().notNull(),
    recipeId: uuid().notNull(),
    recipeVersionId: uuid().notNull(),
    sourceWarehouseId: uuid().notNull(),
    outputWarehouseId: uuid().notNull(),
    status: productionOrderStatus().notNull().default("DRAFT"),
    scheduledFor: date({ mode: "string" }).notNull(),
    /** Cantidad a producir tal como se ingresó. */
    plannedOutputQuantity: recipeQuantity().notNull(),
    plannedOutputUnitId: uuid().notNull(),
    /** Unidad de venta del producto (unidad del stock del producto). */
    saleUnitId: uuid().notNull(),
    /** Cantidad planificada en la unidad de venta. */
    plannedOutputNormalized: normalizedQuantity().notNull(),
    /** salida planificada / rendimiento de la receta (al planificar). */
    scaleFactor: normalizedQuantity(),
    /** Merma teórica de la versión de receta: sólo referencia, no se aplica. */
    theoreticalWastePercentage: percentage(),
    actualOutputQuantity: recipeQuantity(),
    actualOutputUnitId: uuid(),
    actualOutputNormalized: normalizedQuantity(),
    batchCode: varchar({ length: 40 }),
    responsibleEmployeeId: uuid(),
    notes: text(),
    currencyCode: varchar({ length: 3 }),
    plannedCostStatus: costCompleteness(),
    plannedMaterialCost: costAmount(),
    plannedUnitMaterialCost: costAmount(),
    actualMaterialCost: costAmount(),
    actualUnitMaterialCost: costAmount(),
    outputMovementId: uuid(),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    plannedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    startedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    completedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    cancelledByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    plannedAt: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelReason: text(),
    /**
     * Necesidad de un pedido que originó la orden (Fase 5A); null = producción normal.
     * FK compuesta a order_production_requirements declarada en la migración 0009
     * (evita el ciclo de tipos entre schema/production y schema/orders).
     */
    sourceOrderRequirementId: uuid(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("production_orders_company_id_uq").on(t.companyId, t.id),
    index("production_orders_source_requirement_idx")
      .on(t.companyId, t.sourceOrderRequirementId)
      .where(sql`${t.sourceOrderRequirementId} is not null`),

    uniqueIndex("production_orders_company_code_uq").on(t.companyId, t.internalCode),
    uniqueIndex("production_orders_company_batch_uq")
      .on(t.companyId, t.batchCode)
      .where(sql`${t.batchCode} is not null`),
    index("production_orders_company_status_date_idx").on(t.companyId, t.status, t.scheduledFor),
    index("production_orders_company_date_idx").on(t.companyId, t.scheduledFor),
    index("production_orders_company_product_idx").on(t.companyId, t.productId, t.scheduledFor),
    index("production_orders_company_version_idx").on(t.companyId, t.recipeVersionId),
    index("production_orders_company_responsible_idx").on(t.companyId, t.responsibleEmployeeId),
    index("production_orders_company_completed_idx").on(t.companyId, t.completedAt),
    // Producto → receta → versión coherentes y de la misma empresa (FKs compuestas).
    foreignKey({
      name: "production_orders_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_orders_recipe_fk",
      columns: [t.companyId, t.productId, t.recipeId],
      foreignColumns: [recipes.companyId, recipes.productId, recipes.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_orders_version_fk",
      columns: [t.companyId, t.recipeId, t.recipeVersionId],
      foreignColumns: [recipeVersions.companyId, recipeVersions.recipeId, recipeVersions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_orders_source_warehouse_fk",
      columns: [t.companyId, t.sourceWarehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_orders_output_warehouse_fk",
      columns: [t.companyId, t.outputWarehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_orders_planned_unit_fk",
      columns: [t.companyId, t.plannedOutputUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_orders_sale_unit_fk",
      columns: [t.companyId, t.saleUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_orders_actual_unit_fk",
      columns: [t.companyId, t.actualOutputUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_orders_responsible_fk",
      columns: [t.companyId, t.responsibleEmployeeId],
      foreignColumns: [employees.companyId, employees.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_orders_output_movement_fk",
      columns: [t.companyId, t.outputMovementId],
      foreignColumns: [stockMovements.companyId, stockMovements.id],
    }).onDelete("restrict"),
    check(
      "production_orders_quantities",
      sql`${t.plannedOutputQuantity} > 0 and ${t.plannedOutputNormalized} > 0
        and (${t.scaleFactor} is null or ${t.scaleFactor} > 0)
        and ((${t.actualOutputQuantity} is null and ${t.actualOutputUnitId} is null and ${t.actualOutputNormalized} is null)
          or (${t.actualOutputQuantity} > 0 and ${t.actualOutputUnitId} is not null and ${t.actualOutputNormalized} > 0))`,
    ),
    check(
      "production_orders_planned_cost",
      sql`(${t.plannedCostStatus} is null and ${t.plannedMaterialCost} is null and ${t.plannedUnitMaterialCost} is null)
        or (${t.plannedCostStatus} = 'COMPLETE' and ${t.plannedMaterialCost} >= 0 and ${t.plannedUnitMaterialCost} >= 0)
        or (${t.plannedCostStatus} = 'INCOMPLETE' and ${t.plannedMaterialCost} is null and ${t.plannedUnitMaterialCost} is null)`,
    ),
    check(
      "production_orders_status_data",
      sql`(${t.status} = 'DRAFT' and ${t.plannedAt} is null and ${t.startedAt} is null and ${t.completedAt} is null and ${t.cancelledAt} is null)
        or (${t.status} = 'PLANNED' and ${t.plannedAt} is not null and ${t.scaleFactor} is not null and ${t.plannedCostStatus} is not null and ${t.currencyCode} is not null
            and ${t.startedAt} is null and ${t.completedAt} is null and ${t.cancelledAt} is null)
        or (${t.status} = 'IN_PROGRESS' and ${t.plannedAt} is not null and ${t.startedAt} is not null and ${t.completedAt} is null and ${t.cancelledAt} is null)
        or (${t.status} = 'COMPLETED' and ${t.plannedAt} is not null and ${t.startedAt} is not null and ${t.completedAt} is not null and ${t.cancelledAt} is null
            and ${t.actualOutputNormalized} is not null and ${t.actualMaterialCost} >= 0 and ${t.actualUnitMaterialCost} >= 0 and ${t.outputMovementId} is not null)
        or (${t.status} = 'CANCELLED' and ${t.cancelledAt} is not null and ${t.completedAt} is null)`,
    ),
  ],
);

/**
 * Línea de consumo de una orden. RECIPE: derivada de la versión de receta al
 * planificar (cantidad escalada y costo esperado congelados). EXTRA: consumo
 * adicional cargado durante la producción, con motivo; NO modifica la receta.
 * Las cantidades reales se cargan en IN_PROGRESS; al completar se congelan el
 * costo real (desde el movimiento de consumo) y la variación.
 */
export const productionMaterialLines = pgTable(
  "production_material_lines",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    productionOrderId: uuid().notNull(),
    lineNumber: integer().notNull(),
    lineType: productionLineType().notNull(),
    recipeIngredientId: uuid().references(() => recipeIngredients.id, { onDelete: "restrict" }),
    rawMaterialId: uuid().notNull(),
    /** Unidad base de la materia prima (unidad del stock). */
    baseUnitId: uuid().notNull(),
    plannedQuantity: normalizedQuantity(),
    plannedUnitId: uuid(),
    plannedNormalizedQuantity: normalizedQuantity(),
    plannedUnitCost: costAmount(),
    plannedCostSource: costSource(),
    plannedCost: costAmount(),
    actualQuantity: normalizedQuantity(),
    actualUnitId: uuid(),
    actualNormalizedQuantity: normalizedQuantity(),
    actualUnitCost: costAmount(),
    actualCost: costAmount(),
    varianceQuantity: normalizedQuantity(),
    variancePercentage: variancePercentage(),
    consumptionMovementId: uuid(),
    notes: text(),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("production_material_lines_company_id_uq").on(t.companyId, t.id),
    unique("production_material_lines_order_number_uq").on(t.productionOrderId, t.lineNumber),
    uniqueIndex("production_material_lines_recipe_material_uq")
      .on(t.productionOrderId, t.rawMaterialId)
      .where(sql`${t.lineType} = 'RECIPE'`),
    index("production_material_lines_material_idx").on(t.companyId, t.rawMaterialId),
    foreignKey({
      name: "production_material_lines_order_fk",
      columns: [t.companyId, t.productionOrderId],
      foreignColumns: [productionOrders.companyId, productionOrders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_material_lines_raw_material_fk",
      columns: [t.companyId, t.rawMaterialId],
      foreignColumns: [rawMaterials.companyId, rawMaterials.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_material_lines_base_unit_fk",
      columns: [t.companyId, t.baseUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_material_lines_planned_unit_fk",
      columns: [t.companyId, t.plannedUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_material_lines_actual_unit_fk",
      columns: [t.companyId, t.actualUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "production_material_lines_movement_fk",
      columns: [t.companyId, t.consumptionMovementId],
      foreignColumns: [stockMovements.companyId, stockMovements.id],
    }).onDelete("restrict"),
    check(
      "production_material_lines_type",
      sql`(${t.lineType} = 'RECIPE' and ${t.plannedQuantity} > 0 and ${t.plannedUnitId} is not null and ${t.plannedNormalizedQuantity} > 0)
        or (${t.lineType} = 'EXTRA' and ${t.plannedQuantity} is null and ${t.plannedUnitId} is null and ${t.plannedNormalizedQuantity} is null
            and ${t.recipeIngredientId} is null and ${t.actualQuantity} is not null
            and ${t.notes} is not null and length(trim(${t.notes})) > 0)`,
    ),
    check(
      "production_material_lines_actual",
      sql`(${t.actualQuantity} is null and ${t.actualUnitId} is null and ${t.actualNormalizedQuantity} is null)
        or (${t.actualQuantity} >= 0 and ${t.actualUnitId} is not null and ${t.actualNormalizedQuantity} >= 0)`,
    ),
    check(
      "production_material_lines_costs",
      sql`((${t.plannedUnitCost} is null) = (${t.plannedCost} is null))
        and (${t.plannedUnitCost} is null or (${t.plannedUnitCost} >= 0 and ${t.plannedCostSource} is not null))
        and ((${t.actualUnitCost} is null) = (${t.actualCost} is null))
        and (${t.actualCost} is null or ${t.actualCost} >= 0)`,
    ),
  ],
);

/**
 * Costo de inventario por producto terminado a nivel EMPRESA: cantidad y valor
 * de COSTO MATERIAL (sin mano de obra ni indirectos), proyección del ledger con
 * el mismo trigger de coherencia que las materias primas. Desde Fase 5B el
 * producto se valoriza por LOTE ESPECÍFICO (ADR-057): inventory_value = Σ valores
 * de sus lotes y `average_material_cost` = valor / cantidad es una métrica
 * DERIVADA (6 decimales, redondeo half-up; null sin stock), nunca el costo de una
 * venta. Reemplaza a `moving_average_cost` (Fases 4–5A).
 */
export const productInventoryCosts = pgTable(
  "product_inventory_costs",
  {
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    productId: uuid().notNull(),
    quantity: normalizedQuantity().notNull().default("0"),
    inventoryValue: costAmount().notNull().default("0"),
    averageMaterialCost: costAmount(),
    lastMovementId: uuid(),
    lastUpdatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.productId] }),
    foreignKey({
      name: "product_inventory_costs_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_inventory_costs_last_movement_fk",
      columns: [t.companyId, t.lastMovementId],
      foreignColumns: [stockMovements.companyId, stockMovements.id],
    }).onDelete("restrict"),
    check(
      "product_inventory_costs_nonneg",
      sql`${t.quantity} >= 0 and ${t.inventoryValue} >= 0 and (${t.averageMaterialCost} is null or ${t.averageMaterialCost} >= 0)`,
    ),
    check("product_inventory_costs_empty_value", sql`${t.quantity} > 0 or ${t.inventoryValue} = 0`),
  ],
);

/**
 * Historial de costo del producto (append-only): costo anterior, costo del lote
 * y costo nuevo, con la orden de producción que lo originó. Base del costo de
 * venta de Fase 5.
 */
export const productInventoryCostHistory = pgTable(
  "product_inventory_cost_history",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    productId: uuid().notNull(),
    movementId: uuid().notNull(),
    movementSequence: bigint({ mode: "number" }).notNull(),
    movementType: stockMovementType().notNull(),
    productionOrderId: uuid(),
    quantityBefore: normalizedQuantity().notNull(),
    quantityAfter: normalizedQuantity().notNull(),
    valueBefore: costAmount().notNull(),
    valueAfter: costAmount().notNull(),
    averageBefore: costAmount(),
    averageAfter: costAmount(),
    /** Cantidad del lote y su costo material por unidad y total. */
    batchQuantity: normalizedQuantity().notNull(),
    batchUnitCost: costAmount().notNull(),
    batchValue: costAmount().notNull(),
    actorUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("product_inventory_cost_history_movement_uq").on(t.movementId),
    index("product_inventory_cost_history_product_idx").on(t.companyId, t.productId, t.id),
    foreignKey({
      name: "product_inventory_cost_history_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_inventory_cost_history_movement_fk",
      columns: [t.companyId, t.movementId],
      foreignColumns: [stockMovements.companyId, stockMovements.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "product_inventory_cost_history_order_fk",
      columns: [t.companyId, t.productionOrderId],
      foreignColumns: [productionOrders.companyId, productionOrders.id],
    }).onDelete("restrict"),
  ],
);
