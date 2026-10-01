import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { categories, unitsOfMeasure } from "./catalog.js";
import { suppliers } from "./commercial.js";
import { companies } from "./company.js";
import { createdAt, id, money, quantity, unitCost, updatedAt } from "./common.js";

/**
 * Materia prima. NO tiene stock: el stock se derivará de movimientos de
 * inventario (Fase 3). `current_cost` es un costo de referencia por unidad base,
 * cargado a mano hasta que las compras lo recalculen por promedio ponderado.
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
    currentCost: unitCost(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
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
    check("raw_materials_cost_nonneg", sql`${t.currentCost} is null or ${t.currentCost} >= 0`),
  ],
);

/**
 * Producto terminado. El costo NO se guarda aquí: se calculará desde la receta
 * vigente (Fase 2). `controls_stock` indica si las ventas descontarán stock.
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
