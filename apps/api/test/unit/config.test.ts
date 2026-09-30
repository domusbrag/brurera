import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("configuración", () => {
  it("rechaza configuración sin DATABASE_URL válida", () => {
    expect(() => loadConfig({ DATABASE_URL: "no-es-url" })).toThrow(/DATABASE_URL/);
  });

  it("acepta múltiples orígenes web separados por coma", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      WEB_ORIGIN: "http://localhost:3000, http://127.0.0.1:3000",
    });
    expect(config.WEB_ORIGIN).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
  });
});
