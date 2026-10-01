import { auditLogs, companies, employees, users } from "@bakery/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "./helpers.js";

describe("base de datos (migraciones)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("crea exactamente las tablas de Fases 0 a 4.5", async () => {
    const result = await ctx.database.db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name
    `);
    expect(result.rows.map((r) => r.table_name)).toEqual([
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
      "product_conservation_profiles",
      "product_conservation_settings",
      "product_inventory_cost_history",
      "product_inventory_costs",
      "product_lot_balances",
      "product_lots",
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

  it("registra las migraciones aplicadas en el esquema drizzle", async () => {
    const result = await ctx.database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    expect(result.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("impide dos usuarios con el mismo email sin importar mayúsculas", async () => {
    await expect(
      ctx.database.db.insert(users).values({
        email: "ADMIN@test.local",
        displayName: "Duplicado",
        passwordHash: "x",
      }),
    ).rejects.toThrow();
  });

  it("permite empleados sin usuario", async () => {
    const [company] = await ctx.database.db.select().from(companies).limit(1);
    const [employee] = await ctx.database.db
      .insert(employees)
      .values({
        companyId: company!.id,
        employeeCode: "EMP-9001",
        firstName: "Ana",
        lastName: "Panadera",
      })
      .returning();
    expect(employee?.status).toBe("ACTIVE");
  });

  it("no permite borrar una empresa con usuarios (restricción de integridad)", async () => {
    await expect(ctx.database.db.delete(companies)).rejects.toThrow();
  });

  it("audit_logs es solo-inserción: la base rechaza UPDATE y DELETE", async () => {
    await ctx.database.db
      .insert(auditLogs)
      .values({ action: "AUTH_LOGOUT", entityType: "session", entityId: "x" });
    await expect(ctx.database.db.update(auditLogs).set({ action: "ALTERADO" })).rejects.toThrow();
    await expect(ctx.database.db.delete(auditLogs)).rejects.toThrow();
  });
});
