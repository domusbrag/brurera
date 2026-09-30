import {
  companies,
  createDatabase,
  findRoleIdsByCode,
  syncPermissionCatalog,
  syncSystemRoles,
  userRoles,
  users,
  type DatabaseHandle,
} from "@bakery/database";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import { TEST_DATABASE_URL } from "./test-env.js";

export const ADMIN = { email: "admin@test.local", password: "admin-password-123" };
export const SELLER = { email: "ventas@test.local", password: "ventas-password-123" };
export const WEB_ORIGIN = "http://localhost:3000";

export interface TestContext {
  app: FastifyInstance;
  database: DatabaseHandle;
  companyId: string;
  close: () => Promise<void>;
}

/** Deja la base de test vacía (sin tocar la tabla de migraciones de drizzle). */
export async function resetDatabase(database: DatabaseHandle): Promise<void> {
  await database.db.execute(sql`
    truncate table audit_logs, sessions, user_roles, role_permissions, permissions,
      roles, users, employees, companies restart identity cascade
  `);
}

/** Fixture mínima: empresa, permisos, roles de sistema, un ADMIN y un usuario de VENTAS. */
export async function seedFixture(database: DatabaseHandle): Promise<{ companyId: string }> {
  const { db } = database;
  await syncPermissionCatalog(db);
  const [company] = await db
    .insert(companies)
    .values({ legalName: "Test S.A.", tradeName: "Panadería Test" })
    .returning({ id: companies.id });
  if (!company) throw new Error("fixture: empresa");
  await syncSystemRoles(db, company.id);
  const roleIds = await findRoleIdsByCode(db, company.id, ["ADMIN", "SALES"]);

  for (const [who, role, name] of [
    [ADMIN, "ADMIN", "Admin Test"],
    [SELLER, "SALES", "Vendedor Test"],
  ] as const) {
    const [user] = await db
      .insert(users)
      .values({
        companyId: company.id,
        email: who.email,
        displayName: name,
        passwordHash: await hashPassword(who.password),
      })
      .returning({ id: users.id });
    const roleId = roleIds.get(role);
    if (!user || !roleId) throw new Error("fixture: usuario/rol");
    await db.insert(userRoles).values({ userId: user.id, roleId });
  }
  return { companyId: company.id };
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
  const { companyId } = await seedFixture(database);
  const app = await buildApp({ config, db: database.db });
  await app.ready();
  return {
    app,
    database,
    companyId,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}

/** Hace login y devuelve el valor de la cookie de sesión ("nombre=valor"). */
export async function loginAs(
  app: FastifyInstance,
  who: { email: string; password: string },
): Promise<string> {
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
