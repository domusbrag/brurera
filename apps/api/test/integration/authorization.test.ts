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

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
/** Cuarto elemento opcional: body (cuando el permiso depende de lo que se envía). */
const ENDPOINTS: [Method, string, PermissionCode[], unknown?][] = [
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
  // Presentaciones de compra (Fase 3)
  ["GET", `/api/raw-materials/${ANY_ID}/presentations`, [P.PRESENTATIONS_READ]],
  ["POST", `/api/raw-materials/${ANY_ID}/presentations`, [P.PRESENTATIONS_MANAGE]],
  ["PATCH", `/api/raw-material-presentations/${ANY_ID}`, [P.PRESENTATIONS_MANAGE]],
  ["POST", `/api/raw-material-presentations/${ANY_ID}/deactivate`, [P.PRESENTATIONS_MANAGE]],
  ["POST", `/api/raw-material-presentations/${ANY_ID}/activate`, [P.PRESENTATIONS_MANAGE]],
  // Compras y recepciones (Fase 3)
  ["GET", "/api/purchases", [P.PURCHASES_READ]],
  ["POST", "/api/purchases", [P.PURCHASES_CREATE]],
  ["GET", `/api/purchases/${ANY_ID}`, [P.PURCHASES_READ]],
  ["PATCH", `/api/purchases/${ANY_ID}`, [P.PURCHASES_UPDATE]],
  ["POST", `/api/purchases/${ANY_ID}/order`, [P.PURCHASES_ORDER]],
  ["POST", `/api/purchases/${ANY_ID}/cancel`, [P.PURCHASES_CANCEL]],
  ["GET", `/api/purchases/${ANY_ID}/receipts`, [P.PURCHASES_READ]],
  ["POST", `/api/purchases/${ANY_ID}/receipts`, [P.PURCHASES_RECEIVE]],
  ["GET", `/api/purchase-receipts/${ANY_ID}`, [P.PURCHASES_READ]],
  ["PATCH", `/api/purchase-receipts/${ANY_ID}`, [P.PURCHASES_RECEIVE]],
  ["POST", `/api/purchase-receipts/${ANY_ID}/post`, [P.PURCHASES_RECEIVE]],
  ["POST", `/api/purchase-receipts/${ANY_ID}/cancel`, [P.PURCHASES_RECEIVE]],
  // Inventario (Fase 3)
  ["GET", "/api/inventory", [P.INVENTORY_READ]],
  ["GET", `/api/inventory/raw-materials/${ANY_ID}`, [P.INVENTORY_READ]],
  ["GET", "/api/inventory/movements", [P.INVENTORY_READ]],
  ["GET", "/api/inventory/low-stock", [P.INVENTORY_READ]],
  ["GET", `/api/inventory/costs/${ANY_ID}`, [P.INVENTORY_READ, P.INVENTORY_COST_READ]],
  ["POST", "/api/inventory/initial-stock", [P.INVENTORY_INITIAL_STOCK]],
  ["POST", "/api/inventory/adjustments", [P.INVENTORY_ADJUST]],
  ["POST", "/api/inventory/waste", [P.INVENTORY_WASTE]],
  // Producto terminado (Fase 4)
  ["GET", "/api/inventory/products", [P.INVENTORY_READ]],
  ["GET", `/api/inventory/products/${ANY_ID}`, [P.INVENTORY_READ]],
  [
    "GET",
    `/api/inventory/products/${ANY_ID}/cost-history`,
    [P.INVENTORY_READ, P.INVENTORY_COST_READ],
  ],
  // Producción (Fase 4)
  ["GET", "/api/production-orders", [P.PRODUCTION_ORDERS_READ]],
  ["POST", "/api/production-orders", [P.PRODUCTION_ORDERS_CREATE]],
  ["POST", "/api/production-orders/preview", [P.PRODUCTION_ORDERS_CREATE]],
  ["GET", `/api/production-orders/${ANY_ID}`, [P.PRODUCTION_ORDERS_READ]],
  ["PATCH", `/api/production-orders/${ANY_ID}`, [P.PRODUCTION_ORDERS_UPDATE]],
  ["POST", `/api/production-orders/${ANY_ID}/plan`, [P.PRODUCTION_ORDERS_PLAN]],
  ["POST", `/api/production-orders/${ANY_ID}/start`, [P.PRODUCTION_ORDERS_START]],
  ["POST", `/api/production-orders/${ANY_ID}/cancel`, [P.PRODUCTION_ORDERS_CANCEL]],
  ["PUT", `/api/production-orders/${ANY_ID}/actuals`, [P.PRODUCTION_ORDERS_UPDATE]],
  [
    "POST",
    `/api/production-orders/${ANY_ID}/extra-materials`,
    [P.PRODUCTION_ORDERS_ADD_EXTRA_MATERIAL],
  ],
  [
    "DELETE",
    `/api/production-orders/${ANY_ID}/extra-materials/${ANY_ID}`,
    [P.PRODUCTION_ORDERS_ADD_EXTRA_MATERIAL],
  ],
  ["POST", `/api/production-orders/${ANY_ID}/complete`, [P.PRODUCTION_ORDERS_COMPLETE]],
  ["GET", `/api/production-orders/${ANY_ID}/availability`, [P.PRODUCTION_ORDERS_READ]],
  [
    "GET",
    `/api/production-orders/${ANY_ID}/cost-comparison`,
    [P.PRODUCTION_ORDERS_READ, P.PRODUCTION_COST_READ],
  ],
  ["GET", `/api/production-orders/${ANY_ID}/movements`, [P.PRODUCTION_ORDERS_READ]],
  ["GET", "/api/production/responsibles", [P.PRODUCTION_ORDERS_READ]],
  // Lotes, conservación y vencimientos (Fase 4.5)
  ["GET", `/api/products/${ANY_ID}/conservation`, [P.PRODUCT_CONSERVATION_READ]],
  ["PUT", `/api/products/${ANY_ID}/conservation`, [P.PRODUCT_CONSERVATION_MANAGE]],
  ["GET", `/api/inventory/products/${ANY_ID}/lots`, [P.PRODUCT_LOTS_READ]],
  ["GET", `/api/inventory/products/${ANY_ID}/availability`, [P.PRODUCT_LOTS_READ]],
  ["GET", "/api/inventory/expiring", [P.INVENTORY_EXPIRY_READ]],
  ["GET", `/api/product-lots/${ANY_ID}`, [P.PRODUCT_LOTS_READ]],
  ["POST", `/api/product-lots/${ANY_ID}/transform`, [P.PRODUCT_LOTS_TRANSFORM]],
  ["POST", `/api/product-lots/${ANY_ID}/waste`, [P.PRODUCT_LOTS_WASTE]],
  ["POST", `/api/product-lots/${ANY_ID}/block`, [P.PRODUCT_LOTS_QUALITY]],
  ["POST", `/api/product-lots/${ANY_ID}/unblock`, [P.PRODUCT_LOTS_QUALITY]],
  // Fase 5A: pedidos y planificación.
  ["GET", "/api/orders", [P.ORDERS_READ]],
  ["POST", "/api/orders", [P.ORDERS_CREATE]],
  ["POST", "/api/orders/coverage-preview", [P.ORDERS_CREATE]],
  ["GET", `/api/orders/${ANY_ID}`, [P.ORDERS_READ]],
  ["PATCH", `/api/orders/${ANY_ID}`, [P.ORDERS_UPDATE]],
  ["GET", `/api/orders/${ANY_ID}/coverage-preview`, [P.ORDERS_READ]],
  ["POST", `/api/orders/${ANY_ID}/confirm`, [P.ORDERS_CONFIRM]],
  ["POST", `/api/orders/${ANY_ID}/replan-preview`, [P.ORDERS_REPLAN]],
  ["POST", `/api/orders/${ANY_ID}/replan`, [P.ORDERS_REPLAN]],
  ["POST", `/api/orders/${ANY_ID}/cancel`, [P.ORDERS_CANCEL]],
  ["POST", `/api/orders/${ANY_ID}/start-preparation`, [P.ORDERS_PREPARE]],
  ["POST", `/api/orders/${ANY_ID}/mark-ready`, [P.ORDERS_READY]],
  ["GET", "/api/planning/production-needs", [P.ORDER_PLANNING_READ]],
  ["GET", "/api/planning/material-demand", [P.ORDER_PLANNING_READ]],
  ["GET", "/api/planning/orders-at-risk", [P.ORDER_PLANNING_READ]],
  ["GET", `/api/planning/requirements/${ANY_ID}`, [P.ORDER_PLANNING_READ]],
  [
    "POST",
    "/api/production-orders",
    [P.PRODUCTION_ORDERS_CREATE, P.ORDER_PRODUCTION_CREATE],
    {
      productId: ANY_ID,
      scheduledFor: "2030-01-01",
      plannedOutputQuantity: "1",
      sourceWarehouseId: ANY_ID,
      outputWarehouseId: ANY_ID,
      sourceOrderRequirementId: ANY_ID,
    },
  ],
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
      for (const [method, url, required, body = {}] of ENDPOINTS) {
        const res =
          method === "GET"
            ? await api.get(url)
            : method === "POST"
              ? await api.post(url, body)
              : method === "PATCH"
                ? await api.patch(url, {})
                : method === "PUT"
                  ? await api.put(url, {})
                  : await api.delete(url);
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
