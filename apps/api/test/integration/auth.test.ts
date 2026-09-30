import { auditLogs, sessions, users } from "@bakery/database";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashSessionToken } from "../../src/modules/auth/session-token.js";
import {
  ADMIN,
  SELLER,
  WEB_ORIGIN,
  createTestContext,
  loginAs,
  type TestContext,
} from "./helpers.js";

describe("autenticación", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  const login = (payload: unknown, headers: Record<string, string> = { origin: WEB_ORIGIN }) =>
    ctx.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: payload as object });

  it("login válido: 200, cookie httpOnly y usuario sin secretos", async () => {
    const res = await login(ADMIN);
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "bakery_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    const body = res.json();
    expect(body.user).toMatchObject({
      email: ADMIN.email,
      company: { tradeName: "Panadería Test" },
    });
    expect(body.user.roles).toEqual([{ code: "ADMIN", name: "Administrador del sistema" }]);
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|argon2/);
  });

  it("guarda solo el hash del token de sesión", async () => {
    const res = await login(ADMIN);
    const token = res.cookies.find((c) => c.name === "bakery_session")!.value;
    const rows = await ctx.database.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(token)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
  });

  it("login con email en mayúsculas funciona (normalización)", async () => {
    const res = await login({ ...ADMIN, email: ADMIN.email.toUpperCase() });
    expect(res.statusCode).toBe(200);
  });

  it("login inválido: contraseña incorrecta devuelve 401 sin cookie y queda auditado", async () => {
    const res = await login({ email: ADMIN.email, password: "incorrecta" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
    expect(res.cookies.find((c) => c.name === "bakery_session")).toBeUndefined();
    const [last] = await ctx.database.db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(last).toMatchObject({ action: "AUTH_LOGIN_FAILED", actorUserId: null });
    expect(JSON.stringify(last?.metadata)).not.toContain("incorrecta");
  });

  it("login inválido: usuario inexistente devuelve el mismo error", async () => {
    const res = await login({ email: "nadie@test.local", password: "loquesea" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("login inválido: payload mal formado devuelve 400", async () => {
    const res = await login({ email: "no-es-email", password: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("usuario deshabilitado no puede ingresar", async () => {
    await ctx.database.db
      .update(users)
      .set({ status: "DISABLED" })
      .where(eq(users.email, SELLER.email));
    try {
      expect((await login(SELLER)).statusCode).toBe(401);
    } finally {
      await ctx.database.db
        .update(users)
        .set({ status: "ACTIVE" })
        .where(eq(users.email, SELLER.email));
    }
  });

  it("rechaza requests que modifican estado desde un origen no permitido (CSRF)", async () => {
    const res = await login(ADMIN, { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("rechaza cuerpos que no son JSON en requests que modifican estado", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: WEB_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      payload: `email=${encodeURIComponent(ADMIN.email)}&password=${ADMIN.password}`,
    });
    expect(res.statusCode).toBe(415);
  });
});

describe("rutas protegidas y sesión", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("GET /api/auth/me sin sesión devuelve 401", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("GET /api/auth/me con cookie inventada devuelve 401", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: "bakery_session=token-falso" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/auth/me con sesión devuelve el usuario actual", async () => {
    const cookie = await loginAs(ctx.app, ADMIN);
    const res = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(ADMIN.email);
  });

  it("logout revoca la sesión en el servidor y queda auditado", async () => {
    const cookie = await loginAs(ctx.app, ADMIN);
    const out = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, origin: WEB_ORIGIN },
    });
    expect(out.statusCode).toBe(204);
    // Reusar la cookie anterior (p.ej. robada) ya no sirve.
    const me = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(401);
    const [last] = await ctx.database.db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(last?.action).toBe("AUTH_LOGOUT");
  });

  it("una sesión expirada no autentica", async () => {
    const cookie = await loginAs(ctx.app, ADMIN);
    const token = cookie.split("=")[1]!;
    await ctx.database.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, hashSessionToken(token)));
    const me = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });
});

describe("rate limiting de login", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ LOGIN_RATE_LIMIT_PER_MINUTE: "3" });
  });
  afterAll(() => ctx.close());

  it("bloquea con 429 tras superar el límite por minuto", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: WEB_ORIGIN },
        payload: { email: ADMIN.email, password: "incorrecta" },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});
