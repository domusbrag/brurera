import {
  companyMemberships,
  createDatabase,
  findRoleIdsByCode,
  membershipRoles,
  provisionCompany,
  users,
  type DatabaseHandle,
} from "@bakery/database";
import type { SystemRoleCode } from "@bakery/shared";
import { sql } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import { TEST_DATABASE_URL } from "./test-env.js";

export const ADMIN = { email: "admin@test.local", password: "admin-password-123" };
export const SELLER = { email: "ventas@test.local", password: "ventas-password-123" };
/** Administrador de una segunda empresa (pruebas de aislamiento). */
export const ADMIN_B = { email: "admin-b@test.local", password: "admin-b-password-123" };
export const WEB_ORIGIN = "http://localhost:3000";

export interface Credentials {
  email: string;
  password: string;
}

export interface TestContext {
  app: FastifyInstance;
  database: DatabaseHandle;
  /** Empresa A: ADMIN y SELLER. */
  companyId: string;
  /** Empresa B: ADMIN_B. */
  companyBId: string;
  close: () => Promise<void>;
}

const ALL_TABLES = [
  "audit_logs",
  "product_lot_balances",
  "product_lots",
  "product_conservation_profiles",
  "product_conservation_settings",
  "product_inventory_cost_history",
  "product_inventory_costs",
  "production_material_lines",
  "production_orders",
  "inventory_cost_history",
  "raw_material_inventory_costs",
  "stock_balances",
  "stock_movements",
  "purchase_receipt_lines",
  "purchase_receipts",
  "purchase_lines",
  "purchases",
  "raw_material_presentations",
  "sessions",
  "membership_roles",
  "company_memberships",
  "role_permissions",
  "permissions",
  "roles",
  "recipe_cost_snapshot_lines",
  "recipe_cost_snapshots",
  "recipe_ingredients",
  "recipe_versions",
  "recipes",
  "products",
  "raw_materials",
  "categories",
  "units_of_measure",
  "customers",
  "suppliers",
  "warehouses",
  "code_sequences",
  "users",
  "employees",
  "companies",
];

/** Deja la base de test vacía (sin tocar la tabla de migraciones de drizzle). */
export async function resetDatabase(database: DatabaseHandle): Promise<void> {
  await database.db.execute(
    sql.raw(`truncate table ${ALL_TABLES.join(", ")} restart identity cascade`),
  );
}

/** Crea un usuario con membresía y roles en una empresa existente. */
export async function createMember(
  database: DatabaseHandle,
  companyId: string,
  who: Credentials & { displayName: string; roles: SystemRoleCode[] },
): Promise<{ userId: string; membershipId: string }> {
  const { db } = database;
  const [user] = await db
    .insert(users)
    .values({
      email: who.email,
      displayName: who.displayName,
      passwordHash: await hashPassword(who.password),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("fixture: usuario");
  const [membership] = await db
    .insert(companyMemberships)
    .values({ companyId, userId: user.id })
    .returning({ id: companyMemberships.id });
  if (!membership) throw new Error("fixture: membresía");
  const roleIds = await findRoleIdsByCode(db, companyId, who.roles);
  for (const code of who.roles) {
    const roleId = roleIds.get(code);
    if (!roleId) throw new Error(`fixture: rol ${code}`);
    await db.insert(membershipRoles).values({ membershipId: membership.id, roleId, companyId });
  }
  return { userId: user.id, membershipId: membership.id };
}

/**
 * Fixture: Empresa A ("Panadería Test") con un ADMIN y un usuario de VENTAS, y
 * Empresa B ("Panadería Otra") con su propio ADMIN.
 */
export async function seedFixture(
  database: DatabaseHandle,
): Promise<{ companyId: string; companyBId: string }> {
  const { db } = database;
  const companyA = await db.transaction((tx) =>
    provisionCompany(tx, { legalName: "Test S.A.", tradeName: "Panadería Test" }),
  );
  const companyB = await db.transaction((tx) =>
    provisionCompany(tx, { legalName: "Otra S.A.", tradeName: "Panadería Otra" }),
  );
  await createMember(database, companyA.id, {
    ...ADMIN,
    displayName: "Admin Test",
    roles: ["ADMIN"],
  });
  await createMember(database, companyA.id, {
    ...SELLER,
    displayName: "Vendedor Test",
    roles: ["SALES"],
  });
  await createMember(database, companyB.id, {
    ...ADMIN_B,
    displayName: "Admin Otra",
    roles: ["ADMIN"],
  });
  return { companyId: companyA.id, companyBId: companyB.id };
}

export async function createTestContext(
  overrides: Record<string, string> = {},
): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    LOG_LEVEL: "silent",
    WEB_ORIGIN,
    LOGIN_RATE_LIMIT_PER_MINUTE: "1000",
    ...overrides,
  });
  const database = createDatabase(TEST_DATABASE_URL, { max: 5 });
  await resetDatabase(database);
  const { companyId, companyBId } = await seedFixture(database);
  const app = await buildApp({ config, db: database.db });
  await app.ready();
  return {
    app,
    database,
    companyId,
    companyBId,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}

/** Hace login y devuelve el valor de la cookie de sesión ("nombre=valor"). */
export async function loginAs(app: FastifyInstance, who: Credentials): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: WEB_ORIGIN },
    payload: who,
  });
  if (res.statusCode !== 200) throw new Error(`login falló: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === "bakery_session");
  if (!cookie) throw new Error("login sin cookie");
  return `${cookie.name}=${cookie.value}`;
}

/** Cliente HTTP autenticado sobre app.inject (con Origin permitido y JSON). */
export function apiClient(app: FastifyInstance, cookie: string) {
  const call = (method: InjectOptions["method"], url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { cookie, origin: WEB_ORIGIN },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return {
    get: (url: string) => call("GET", url),
    post: (url: string, payload: unknown = {}) => call("POST", url, payload),
    patch: (url: string, payload: unknown) => call("PATCH", url, payload),
    put: (url: string, payload: unknown) => call("PUT", url, payload),
    delete: (url: string) => call("DELETE", url),
  };
}

export type ApiClient = ReturnType<typeof apiClient>;

/** Login + cliente en un paso. */
export async function clientFor(app: FastifyInstance, who: Credentials): Promise<ApiClient> {
  return apiClient(app, await loginAs(app, who));
}
