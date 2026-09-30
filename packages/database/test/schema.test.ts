import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema/index.js";

const tables: PgTable[] = Object.values(schema as Record<string, unknown>).filter(
  (v): v is PgTable => is(v, PgTable),
);

describe("reglas del esquema", () => {
  it("expone las tablas fundacionales de Fase 0", () => {
    expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual([
      "audit_logs",
      "companies",
      "employees",
      "permissions",
      "role_permissions",
      "roles",
      "sessions",
      "user_roles",
      "users",
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
