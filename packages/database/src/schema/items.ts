import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { categories, unitsOfMeasure } from "./catalog.js";
import { suppliers } from "./commercial.js";
import { companies } from "./company.js";
import { createdAt, id, money, quantity, unitCost, updatedAt } from "./common.js";

/**
 * Procedencia de un costo. En Fase 2 sólo existe MANUAL_REFERENCE; las compras
 * (Fase 3) agregarán PURCHASE_MOVING_AVERAGE. Los valores coinciden con
 * COST_SOURCES de @bakery/domain.
 */
export const costSource = pgEnum("cost_source", [
  "MANUAL_REFERENCE",
  "PURCHASE_MOVING_AVERAGE",
  "SUPPLIER_QUOTE",
  "OTHER",
]);

/**
 * Materia prima. NO tiene stock: el stock se derivará de movimientos de
 * inventario (Fase 3). `reference_cost` es dinero (moneda de la empresa) por
 * UNIDAD BASE ($850/kg), cargado a mano: no es el precio de una bolsa, ni la
 * última factura, ni un promedio ponderado. Es el insumo del costo teórico.
 */
export const rawMaterials = pgTable(
  "raw_materials",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    internalCode: varchar({ length: 32 }).notNull(),
    name: text().notNull(),
    description: text(),
    categoryId: uuid().notNull(),
    baseUnitId: uuid().notNull(),
    minimumStock: quantity().notNull().default("0"),
    preferredSupplierId: uuid(),
    referenceCost: unitCost(),
    referenceCostSource: costSource().notNull().default("MANUAL_REFERENCE"),
    referenceCostUpdatedAt: timestamp({ withTimezone: true }),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("raw_materials_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("raw_materials_company_code_uq").on(t.companyId, t.internalCode),
    index("raw_materials_company_active_name_idx").on(t.companyId, t.active, t.name),
    index("raw_materials_category_idx").on(t.categoryId),
    index("raw_materials_supplier_idx").on(t.preferredSupplierId),
    foreignKey({
      name: "raw_materials_category_fk",
      columns: [t.companyId, t.categoryId],
      foreignColumns: [categories.companyId, categories.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "raw_materials_base_unit_fk",
      columns: [t.companyId, t.baseUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "raw_materials_supplier_fk",
      columns: [t.companyId, t.preferredSupplierId],
      foreignColumns: [suppliers.companyId, suppliers.id],
    }).onDelete("restrict"),
    check("raw_materials_minimum_stock_nonneg", sql`${t.minimumStock} >= 0`),
    check("raw_materials_cost_nonneg", sql`${t.referenceCost} is null or ${t.referenceCost} >= 0`),
  ],
);

/**
 * Producto terminado. El costo NO se guarda aquí: se deriva de la receta activa
 * (recipes → recipe_versions → recipe_cost_snapshots). `controls_stock` indica si las ventas descontarán stock.
 */
export const products = pgTable(
  "products",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    internalCode: varchar({ length: 32 }).notNull(),
    name: text().notNull(),
    description: text(),
    categoryId: uuid().notNull(),
    saleUnitId: uuid().notNull(),
    salePrice: money().notNull(),
    controlsStock: boolean().notNull().default(true),
    imageUrl: text(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("products_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("products_company_code_uq").on(t.companyId, t.internalCode),
    index("products_company_active_name_idx").on(t.companyId, t.active, t.name),
    index("products_category_idx").on(t.categoryId),
    foreignKey({
      name: "products_category_fk",
      columns: [t.companyId, t.categoryId],
      foreignColumns: [categories.companyId, categories.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "products_sale_unit_fk",
      columns: [t.companyId, t.saleUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    check("products_sale_price_nonneg", sql`${t.salePrice} >= 0`),
  ],
);
