import { SYSTEM_ROLES } from "@bakery/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, SELLER, createTestContext, loginAs, type TestContext } from "./helpers.js";

describe("permisos básicos (autorización en servidor)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("sin sesión: 401", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/audit-logs" });
    expect(res.statusCode).toBe(401);
  });

  it("VENTAS no tiene audit.read: 403", async () => {
    const cookie = await loginAs(ctx.app, SELLER);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/audit-logs",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("VENTAS recibe solo sus permisos efectivos", async () => {
    const cookie = await loginAs(ctx.app, SELLER);
    const res = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    const sales = SYSTEM_ROLES.find((r) => r.code === "SALES")!;
    expect([...res.json().user.permissions].sort()).toEqual([...sales.permissions].sort());
  });

  it("ADMIN puede leer auditoría paginada y ve su propio login con actor", async () => {
    const cookie = await loginAs(ctx.app, ADMIN);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/audit-logs?page=1&pageSize=5",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ page: 1, pageSize: 5 });
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items[0]).toMatchObject({
      action: "AUTH_LOGIN_SUCCEEDED",
      actor: { displayName: "Admin Test" },
    });
  });

  it("valida la paginación (pageSize máximo 100)", async () => {
    const cookie = await loginAs(ctx.app, ADMIN);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/audit-logs?pageSize=1000",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});
