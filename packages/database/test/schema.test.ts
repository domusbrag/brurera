import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema/index.js";

const tables: PgTable[] = Object.values(schema as Record<string, unknown>).filter(
  (v): v is PgTable => is(v, PgTable),
);

describe("reglas del esquema", () => {
  it("expone las tablas de Fases 0 a 4", () => {
    expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual([
      "audit_logs",
      "categories",
      "code_sequences",
      "companies",
      "company_memberships",
      "customers",
      "employees",
      "inventory_cost_history",
      "membership_roles",
      "permissions",
      "product_inventory_cost_history",
      "product_inventory_costs",
      "production_material_lines",
      "production_orders",
      "products",
      "purchase_lines",
      "purchase_receipt_lines",
      "purchase_receipts",
      "purchases",
      "raw_material_inventory_costs",
      "raw_material_presentations",
      "raw_materials",
      "recipe_cost_snapshot_lines",
      "recipe_cost_snapshots",
      "recipe_ingredients",
      "recipe_versions",
      "recipes",
      "role_permissions",
      "roles",
      "sessions",
      "stock_balances",
      "stock_movements",
      "suppliers",
      "units_of_measure",
      "users",
      "warehouses",
    ]);
  });

  it("no usa tipos de punto flotante (dinero y cantidades van en numeric)", () => {
    for (const table of tables) {
      for (const column of getTableConfig(table).columns) {
        expect(
          ["PgReal", "PgDoublePrecision"],
          `${getTableConfig(table).name}.${column.name}`,
        ).not.toContain(column.columnType);
      }
    }
  });

  it("ninguna tabla de maestros tiene columna de stock (el stock se deriva de movimientos)", () => {
    for (const table of tables) {
      for (const column of getTableConfig(table).columns) {
        expect(column.name, getTableConfig(table).name).not.toMatch(
          /^(stock|currentStock|stockQuantity|quantityOnHand|onHand)$/i,
        );
      }
    }
  });

  it("toda tabla de negocio lleva company_id (salvo identidad global y catálogos)", () => {
    const global = new Set(["users", "permissions", "role_permissions", "audit_logs", "companies"]);
    for (const table of tables) {
      const { name, columns } = getTableConfig(table);
      if (global.has(name)) continue;
      expect(
        columns.map((c) => c.name),
        name,
      ).toContain("companyId");
    }
  });

  it("todas las marcas de tiempo son timestamptz", () => {
    for (const table of tables) {
      for (const column of getTableConfig(table).columns) {
        if (column.columnType === "PgTimestamp") {
          expect((column as unknown as { withTimezone: boolean }).withTimezone, column.name).toBe(
            true,
          );
        }
      }
    }
  });
});
