import { describe, expect, it } from "vitest";
import { todayIn } from "../../src/lib/context.js";
import { likePattern } from "../../src/lib/listing.js";
import { diffChanges } from "../../src/modules/audit/audit.service.js";

describe("diffChanges (detalle de auditoría)", () => {
  it("registra solo los campos que cambiaron", () => {
    expect(
      diffChanges({ name: "A", phone: null, city: "X" }, { name: "B", phone: null, city: "X" }, [
        "name",
        "phone",
        "city",
      ]),
    ).toEqual({ name: { from: "A", to: "B" } });
  });

  it("nunca incluye secretos", () => {
    expect(diffChanges({ passwordHash: "a" }, { passwordHash: "b" }, ["passwordHash"])).toEqual({});
  });

  it("normaliza fechas y undefined", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    expect(diffChanges({ at: undefined }, { at: d }, ["at"])).toEqual({
      at: { from: null, to: "2026-01-01T00:00:00.000Z" },
    });
  });
});

describe("utilidades", () => {
  it("todayIn usa la zona horaria de la empresa", () => {
    // 02:00 UTC del 1/1 todavía es 31/12 en Buenos Aires (UTC-3).
    const instant = new Date("2026-01-01T02:00:00Z");
    expect(todayIn("America/Argentina/Buenos_Aires", instant)).toBe("2025-12-31");
    expect(todayIn("UTC", instant)).toBe("2026-01-01");
  });

  it("likePattern escapa comodines", () => {
    expect(likePattern("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
  });
});
