import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import {
  costAmount,
  createdAt,
  id,
  normalizedQuantity,
  percentage,
  recipeQuantity,
  unitCost,
  updatedAt,
} from "./common.js";
import { companies } from "./company.js";
import { costSource, products, rawMaterials } from "./items.js";
import { users } from "./people.js";

export const recipeVersionStatus = pgEnum("recipe_version_status", ["DRAFT", "ACTIVE", "ARCHIVED"]);
export const costCompleteness = pgEnum("cost_completeness", ["COMPLETE", "INCOMPLETE"]);

/**
 * Identidad de la receta de un producto. MVP: como máximo una receta activa por
 * producto (índice parcial). Se desactiva, no se borra. La composición vive en
 * sus versiones.
 */
export const recipes = pgTable(
  "recipes",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    productId: uuid().notNull(),
    name: text().notNull(),
    description: text(),
    active: boolean().notNull().default(true),
    /** Último número de versión asignado: un borrador descartado no libera su número. */
    lastVersionNumber: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("recipes_company_id_uq").on(t.companyId, t.id),
    // Destino de la FK compuesta de production_orders (producto ↔ receta coherentes).
    unique("recipes_company_product_id_uq").on(t.companyId, t.productId, t.id),
    uniqueIndex("recipes_one_active_per_product_uq")
      .on(t.companyId, t.productId)
      .where(sql`${t.active}`),
    index("recipes_product_idx").on(t.productId),
    foreignKey({
      name: "recipes_product_fk",
      columns: [t.companyId, t.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
  ],
);

/**
 * Formulación concreta. DRAFT se edita; ACTIVE y ARCHIVED son inmutables (la
 * base lo garantiza con triggers, ver migración 0005). Una sola ACTIVE y un solo
 * DRAFT por receta. `effective_from` = momento de publicación; la versión deja de
 * estar vigente en `archived_at`.
 */
export const recipeVersions = pgTable(
  "recipe_versions",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    recipeId: uuid().notNull(),
    versionNumber: integer().notNull(),
    status: recipeVersionStatus().notNull().default("DRAFT"),
    /** Producción útil final esperada, en `yield_unit_id`. */
    yieldQuantity: recipeQuantity().notNull(),
    yieldUnitId: uuid().notNull(),
    /** Merma teórica informativa (no se aplica al costo). */
    wastePercentage: percentage(),
    instructions: text(),
    effectiveFrom: timestamp({ withTimezone: true }),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    publishedAt: timestamp({ withTimezone: true }),
    publishedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique("recipe_versions_company_id_uq").on(t.companyId, t.id),
    // Destino de la FK compuesta de production_orders (receta ↔ versión coherentes).
    unique("recipe_versions_company_recipe_id_uq").on(t.companyId, t.recipeId, t.id),
    unique("recipe_versions_recipe_number_uq").on(t.recipeId, t.versionNumber),
    uniqueIndex("recipe_versions_one_active_uq")
      .on(t.recipeId)
      .where(sql`${t.status} = 'ACTIVE'`),
    uniqueIndex("recipe_versions_one_draft_uq")
      .on(t.recipeId)
      .where(sql`${t.status} = 'DRAFT'`),
    index("recipe_versions_company_status_idx").on(t.companyId, t.status),
    foreignKey({
      name: "recipe_versions_recipe_fk",
      columns: [t.companyId, t.recipeId],
      foreignColumns: [recipes.companyId, recipes.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "recipe_versions_yield_unit_fk",
      columns: [t.companyId, t.yieldUnitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    check("recipe_versions_number_positive", sql`${t.versionNumber} > 0`),
    check("recipe_versions_yield_positive", sql`${t.yieldQuantity} > 0`),
    check(
      "recipe_versions_waste_range",
      sql`${t.wastePercentage} is null or (${t.wastePercentage} >= 0 and ${t.wastePercentage} < 100)`,
    ),
    check(
      "recipe_versions_status_dates",
      sql`(${t.status} = 'DRAFT' and ${t.publishedAt} is null and ${t.effectiveFrom} is null and ${t.archivedAt} is null)
        or (${t.status} = 'ACTIVE' and ${t.publishedAt} is not null and ${t.effectiveFrom} is not null and ${t.archivedAt} is null)
        or (${t.status} = 'ARCHIVED' and ${t.archivedAt} is not null)`,
    ),
  ],
);

/** Ingrediente de una versión. Sólo se agrega, cambia o quita mientras la versión es DRAFT. */
export const recipeIngredients = pgTable(
  "recipe_ingredients",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    recipeVersionId: uuid().notNull(),
    rawMaterialId: uuid().notNull(),
    quantity: recipeQuantity().notNull(),
    unitId: uuid().notNull(),
    sortOrder: integer().notNull().default(0),
    notes: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("recipe_ingredients_version_material_uq").on(t.recipeVersionId, t.rawMaterialId),
    index("recipe_ingredients_version_idx").on(t.recipeVersionId, t.sortOrder),
    index("recipe_ingredients_raw_material_idx").on(t.rawMaterialId),
    foreignKey({
      name: "recipe_ingredients_version_fk",
      columns: [t.companyId, t.recipeVersionId],
      foreignColumns: [recipeVersions.companyId, recipeVersions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "recipe_ingredients_raw_material_fk",
      columns: [t.companyId, t.rawMaterialId],
      foreignColumns: [rawMaterials.companyId, rawMaterials.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "recipe_ingredients_unit_fk",
      columns: [t.companyId, t.unitId],
      foreignColumns: [unitsOfMeasure.companyId, unitsOfMeasure.id],
    }).onDelete("restrict"),
    check("recipe_ingredients_quantity_positive", sql`${t.quantity} > 0`),
  ],
);

/**
 * Costo calculado al publicar una versión. Inmutable (append-only por trigger):
 * si mañana cambia el costo de la harina, este registro conserva con qué valores
 * se calculó. `total_cost` y `unit_cost` son null si el costeo está incompleto.
 */
export const recipeCostSnapshots = pgTable(
  "recipe_cost_snapshots",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    recipeVersionId: uuid().notNull(),
    calculatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    currencyCode: varchar({ length: 3 }).notNull(),
    completenessStatus: costCompleteness().notNull(),
    totalCost: costAmount(),
    yieldQuantity: recipeQuantity().notNull(),
    yieldUnitCode: varchar({ length: 16 }).notNull(),
    yieldUnitSymbol: varchar({ length: 16 }).notNull(),
    /** Rendimiento expresado en la unidad de venta del producto. */
    normalizedYield: normalizedQuantity().notNull(),
    saleUnitCode: varchar({ length: 16 }).notNull(),
    saleUnitSymbol: varchar({ length: 16 }).notNull(),
    unitCost: costAmount(),
    /** Precio de venta vigente al publicar (referencia para el margen histórico). */
    salePrice: costAmount(),
  },
  (t) => [
    unique("recipe_cost_snapshots_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("recipe_cost_snapshots_version_uq").on(t.recipeVersionId),
    foreignKey({
      name: "recipe_cost_snapshots_version_fk",
      columns: [t.companyId, t.recipeVersionId],
      foreignColumns: [recipeVersions.companyId, recipeVersions.id],
    }).onDelete("restrict"),
    check(
      "recipe_cost_snapshots_complete_has_totals",
      sql`(${t.completenessStatus} = 'COMPLETE') = (${t.totalCost} is not null and ${t.unitCost} is not null)`,
    ),
  ],
);

/** Desglose congelado por ingrediente de un snapshot (append-only). */
export const recipeCostSnapshotLines = pgTable(
  "recipe_cost_snapshot_lines",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    snapshotId: uuid().notNull(),
    sortOrder: integer().notNull(),
    rawMaterialId: uuid().notNull(),
    rawMaterialCode: varchar({ length: 32 }).notNull(),
    rawMaterialName: text().notNull(),
    quantity: recipeQuantity().notNull(),
    unitCode: varchar({ length: 16 }).notNull(),
    unitSymbol: varchar({ length: 16 }).notNull(),
    normalizedQuantity: normalizedQuantity().notNull(),
    baseUnitCode: varchar({ length: 16 }).notNull(),
    baseUnitSymbol: varchar({ length: 16 }).notNull(),
    /** Costo por unidad base usado; null = faltaba (nunca 0 implícito). */
    referenceCost: unitCost(),
    costSource: costSource(),
    ingredientCost: costAmount(),
  },
  (t) => [
    index("recipe_cost_snapshot_lines_snapshot_idx").on(t.snapshotId, t.sortOrder),
    foreignKey({
      name: "recipe_cost_snapshot_lines_snapshot_fk",
      columns: [t.companyId, t.snapshotId],
      foreignColumns: [recipeCostSnapshots.companyId, recipeCostSnapshots.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "recipe_cost_snapshot_lines_raw_material_fk",
      columns: [t.companyId, t.rawMaterialId],
      foreignColumns: [rawMaterials.companyId, rawMaterials.id],
    }).onDelete("restrict"),
    check(
      "recipe_cost_snapshot_lines_cost_coherent",
      sql`(${t.referenceCost} is null) = (${t.ingredientCost} is null)`,
    ),
  ],
);
