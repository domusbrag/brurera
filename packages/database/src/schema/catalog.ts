import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { companies } from "./company.js";
import { conversionFactor, createdAt, id, updatedAt } from "./common.js";

export const unitDimension = pgEnum("unit_dimension", [
  "MASS",
  "VOLUME",
  "COUNT",
  "PACKAGING",
  "OTHER",
]);
export const categoryType = pgEnum("category_type", ["RAW_MATERIAL", "PRODUCT"]);

/**
 * Unidad de medida (por empresa). Una unidad raíz no tiene base; una derivada
 * declara `1 unidad = conversion_factor × base`. Solo se convierte entre
 * unidades con la misma raíz (misma dimensión): masa nunca se convierte a volumen.
 */
export const unitsOfMeasure = pgTable(
  "units_of_measure",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    code: varchar({ length: 16 }).notNull(),
    name: text().notNull(),
    symbol: varchar({ length: 16 }).notNull(),
    dimension: unitDimension().notNull(),
    baseUnitId: uuid(),
    conversionFactor: conversionFactor(),
    /** Decimales con que se expresan cantidades en esta unidad. */
    decimals: smallint().notNull().default(2),
    isSystem: boolean().notNull().default(false),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("units_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("units_company_code_uq").on(t.companyId, sql`lower(${t.code})`),
    foreignKey({
      name: "units_base_unit_fk",
      columns: [t.companyId, t.baseUnitId],
      foreignColumns: [t.companyId, t.id],
    }).onDelete("restrict"),
    check(
      "units_base_and_factor_together",
      sql`(${t.baseUnitId} is null) = (${t.conversionFactor} is null)`,
    ),
    check("units_factor_positive", sql`${t.conversionFactor} is null or ${t.conversionFactor} > 0`),
    check("units_decimals_range", sql`${t.decimals} between 0 and 6`),
    check("units_not_own_base", sql`${t.baseUnitId} is null or ${t.baseUnitId} <> ${t.id}`),
  ],
);

/** Categoría de materias primas o de productos (una tabla, discriminada por tipo). */
export const categories = pgTable(
  "categories",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    type: categoryType().notNull(),
    name: text().notNull(),
    description: text(),
    sortOrder: integer().notNull().default(0),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("categories_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("categories_company_type_name_uq").on(t.companyId, t.type, sql`lower(${t.name})`),
    index("categories_company_type_idx").on(t.companyId, t.type, t.sortOrder),
  ],
);
