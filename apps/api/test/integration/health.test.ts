import { createDatabase } from "@bakery/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createTestContext, type TestContext } from "./helpers.js";

describe("GET /api/health", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("responde 200 con API y base de datos OK", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", checks: { api: "ok", database: "ok" } });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("propaga un x-request-id válido como correlation id", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/health",
      headers: { "x-request-id": "test-correlation-1234" },
    });
    expect(res.headers["x-request-id"]).toBe("test-correlation-1234");
  });

  it("responde 503 si la base no es accesible", async () => {
    // Puerto cerrado: la base no es alcanzable.
    const unreachable = "postgres://bakery:bakery@127.0.0.1:1/bakery_erp_test";
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: unreachable, LOG_LEVEL: "silent" });
    const database = createDatabase(unreachable, { max: 1 });
    const app = await buildApp({ config, db: database.db });
    try {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        status: "error",
        checks: { api: "ok", database: "error" },
      });
    } finally {
      await app.close();
      await database.close();
    }
  });
});
