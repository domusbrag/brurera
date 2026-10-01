import {
  PERMISSIONS as P,
  SYSTEM_ROLES,
  hasPermissions,
  type PermissionCode,
} from "@bakery/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clientFor,
  createMember,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";

/*
 * Matriz de autorización verificada contra la API real: para cada rol de
 * sistema y cada endpoint, la API responde 403 exactamente cuando el rol no
 * tiene el/los permisos requeridos. La autorización se evalúa antes que la
 * validación, así que un body vacío alcanza para distinguir 403 de "permitido".
 * docs/PERMISSIONS.md se genera desde la misma fuente (SYSTEM_ROLES).
 */

const ANY_ID = "00000000-0000-4000-8000-000000000000";

type Method = "GET" | "POST" | "PATCH" | "PUT";
const ENDPOINTS: [Method, string, PermissionCode[]][] = [
  ["GET", "/api/audit-logs", [P.AUDIT_READ]],
  ["GET", "/api/company", [P.COMPANY_READ]],
  ["PATCH", "/api/company", [P.COMPANY_UPDATE]],
  ["GET", "/api/roles", [P.ROLES_READ]],
];

const crud = (
  path: string,
  perms: {
    read: PermissionCode;
    create: PermissionCode;
    update: PermissionCode;
    deactivate: PermissionCode;
  },
) => {
  ENDPOINTS.push(
    ["GET", path, [perms.read]],
    ["GET", `${path}/${ANY_ID}`, [perms.read]],
    ["POST", path, [perms.create]],
    ["PATCH", `${path}/${ANY_ID}`, [perms.update]],
    ["POST", `${path}/${ANY_ID}/deactivate`, [perms.deactivate]],
    ["POST", `${path}/${ANY_ID}/activate`, [perms.deactivate]],
  );
};
crud("/api/employees", {
  read: P.EMPLOYEES_READ,
  create: P.EMPLOYEES_CREATE,
  update: P.EMPLOYEES_UPDATE,
  deactivate: P.EMPLOYEES_DEACTIVATE,
});
crud("/api/customers", {
  read: P.CUSTOMERS_READ,
  create: P.CUSTOMERS_CREATE,
  update: P.CUSTOMERS_UPDATE,
  deactivate: P.CUSTOMERS_DEACTIVATE,
});
crud("/api/suppliers", {
  read: P.SUPPLIERS_READ,
  create: P.SUPPLIERS_CREATE,
  update: P.SUPPLIERS_UPDATE,
  deactivate: P.SUPPLIERS_DEACTIVATE,
});
crud("/api/raw-materials", {
  read: P.RAW_MATERIALS_READ,
  create: P.RAW_MATERIALS_CREATE,
  update: P.RAW_MATERIALS_UPDATE,
  deactivate: P.RAW_MATERIALS_DEACTIVATE,
});
crud("/api/products", {
  read: P.PRODUCTS_READ,
  create: P.PRODUCTS_CREATE,
  update: P.PRODUCTS_UPDATE,
  deactivate: P.PRODUCTS_DEACTIVATE,
});
crud("/api/warehouses", {
  read: P.WAREHOUSES_READ,
  create: P.WAREHOUSES_MANAGE,
  update: P.WAREHOUSES_MANAGE,
  deactivate: P.WAREHOUSES_MANAGE,
});
ENDPOINTS.push(
  ["GET", "/api/users", [P.USERS_READ]],
  ["GET", `/api/users/${ANY_ID}`, [P.USERS_READ]],
  ["POST", "/api/users", [P.USERS_CREATE, P.USERS_ASSIGN_ROLES]],
  ["PATCH", `/api/users/${ANY_ID}`, [P.USERS_UPDATE]],
  ["PUT", `/api/users/${ANY_ID}/roles`, [P.USERS_ASSIGN_ROLES]],
  ["POST", `/api/users/${ANY_ID}/deactivate`, [P.USERS_DEACTIVATE]],
  ["POST", `/api/users/${ANY_ID}/activate`, [P.USERS_DEACTIVATE]],
  ["GET", "/api/units", [P.UNITS_READ]],
  ["GET", `/api/units/${ANY_ID}`, [P.UNITS_READ]],
  ["GET", `/api/units/convert?from=${ANY_ID}&to=${ANY_ID}&quantity=1`, [P.UNITS_READ]],
  ["POST", "/api/units", [P.UNITS_MANAGE]],
  ["PATCH", `/api/units/${ANY_ID}`, [P.UNITS_MANAGE]],
  ["GET", "/api/categories", [P.CATEGORIES_READ]],
  ["GET", `/api/categories/${ANY_ID}`, [P.CATEGORIES_READ]],
  ["POST", "/api/categories", [P.CATEGORIES_MANAGE]],
  ["PATCH", `/api/categories/${ANY_ID}`, [P.CATEGORIES_MANAGE]],
  ["PUT", `/api/raw-materials/${ANY_ID}/reference-cost`, [P.RAW_MATERIALS_UPDATE_COST]],
  // Recetas (Fase 2)
  ["GET", "/api/recipes", [P.RECIPES_READ]],
  ["POST", "/api/recipes", [P.RECIPES_CREATE]],
  ["GET", `/api/recipes/${ANY_ID}`, [P.RECIPES_READ]],
  ["PATCH", `/api/recipes/${ANY_ID}`, [P.RECIPES_UPDATE]],
  ["POST", `/api/recipes/${ANY_ID}/deactivate`, [P.RECIPES_ARCHIVE]],
  ["POST", `/api/recipes/${ANY_ID}/activate`, [P.RECIPES_ARCHIVE]],
  ["GET", `/api/recipes/${ANY_ID}/versions`, [P.RECIPES_READ]],
  ["POST", `/api/recipes/${ANY_ID}/versions`, [P.RECIPES_CREATE]],
  ["GET", `/api/recipes/${ANY_ID}/current-cost`, [P.RECIPES_READ]],
  ["GET", `/api/recipes/${ANY_ID}/effective-version?at=2026-01-01T00:00:00Z`, [P.RECIPES_READ]],
  ["GET", `/api/recipe-versions/${ANY_ID}`, [P.RECIPES_READ]],
  ["PATCH", `/api/recipe-versions/${ANY_ID}`, [P.RECIPES_UPDATE]],
  ["POST", `/api/recipe-versions/${ANY_ID}/publish`, [P.RECIPES_PUBLISH]],
  ["POST", `/api/recipe-versions/${ANY_ID}/duplicate`, [P.RECIPES_CREATE]],
  ["POST", `/api/recipe-versions/${ANY_ID}/discard`, [P.RECIPES_UPDATE]],
  ["POST", `/api/recipe-versions/${ANY_ID}/archive`, [P.RECIPES_ARCHIVE]],
  ["GET", `/api/recipe-versions/${ANY_ID}/cost`, [P.RECIPES_READ]],
  ["GET", `/api/recipe-versions/${ANY_ID}/diff`, [P.RECIPES_READ]],
);

let ctx: TestContext;
const clients = new Map<string, ApiClient>();

beforeAll(async () => {
  ctx = await createTestContext();
  for (const role of SYSTEM_ROLES) {
    const who = {
      email: `rol-${role.code.toLowerCase()}@test.local`,
      password: "rol-password-123",
    };
    await createMember(ctx.database, ctx.companyId, {
      ...who,
      displayName: `Rol ${role.code}`,
      roles: [role.code],
    });
    clients.set(role.code, await clientFor(ctx.app, who));
  }
});
afterAll(() => ctx.close());

describe("matriz de autorización (rol × endpoint)", () => {
  for (const role of SYSTEM_ROLES) {
    it(`${role.code}: 403 exactamente donde el rol no tiene permiso`, async () => {
      const api = clients.get(role.code)!;
      const mismatches: string[] = [];
      for (const [method, url, required] of ENDPOINTS) {
        const res =
          method === "GET"
            ? await api.get(url)
            : method === "POST"
              ? await api.post(url, {})
              : method === "PATCH"
                ? await api.patch(url, {})
                : await api.put(url, {});
        const allowed = hasPermissions(role.permissions, required);
        const denied = res.statusCode === 403;
        if (allowed === denied || res.statusCode === 401 || res.statusCode >= 500) {
          mismatches.push(
            `${method} ${url} → ${res.statusCode} (esperado ${allowed ? "permitido" : "403"})`,
          );
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it("cubre todos los permisos del catálogo excepto dashboard.view", () => {
    const covered = new Set(ENDPOINTS.flatMap(([, , perms]) => perms));
    const missing = Object.values(P).filter((p) => !covered.has(p) && p !== P.DASHBOARD_VIEW);
    expect(missing).toEqual([]);
  });

  it("la autorización nunca compara el código de rol (se decide solo por permisos)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "../../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.ts$/.test(entry.name) && !path.includes("scripts")) {
          if (
            /role\w*\s*===?\s*["'](ADMIN|OWNER)["']|["'](ADMIN|OWNER)["']\s*===/.test(
              readFileSync(path, "utf8"),
            )
          ) {
            offenders.push(path);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
