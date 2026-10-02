import { describe, expect, it } from "vitest";
import {
  instantToZonedLocal,
  isValidLocalDateTime,
  localDateTimeSchema,
  zonedLocalToInstant,
} from "../src/timezone";

/*
 * Gate Q: la hora de un pedido se interpreta en la zona de la EMPRESA, nunca en
 * la del navegador ni la del proceso. Estas funciones no dependen de process.env.TZ.
 */

const BA = "America/Argentina/Buenos_Aires";

describe("hora de pared de la empresa", () => {
  it("§84: 10/10/2026 10:00 en Buenos Aires es 13:00 UTC y vuelve a mostrarse 10:00", () => {
    const instant = zonedLocalToInstant("2026-10-10T10:00", BA);
    expect(instant.toISOString()).toBe("2026-10-10T13:00:00.000Z");
    expect(instantToZonedLocal(instant, BA)).toBe("2026-10-10T10:00");
    expect(instantToZonedLocal(instant.toISOString(), BA)).toBe("2026-10-10T10:00");
  });

  it("la misma hora en otra zona da otro instante (no hay corrimiento silencioso)", () => {
    const tokyo = zonedLocalToInstant("2026-10-10T10:00", "Asia/Tokyo");
    expect(tokyo.toISOString()).toBe("2026-10-10T01:00:00.000Z");
    expect(instantToZonedLocal(tokyo, BA)).toBe("2026-10-09T22:00");
  });

  it("respeta el horario de verano de la zona (Madrid: +2 en octubre, +1 en diciembre)", () => {
    expect(zonedLocalToInstant("2026-10-10T10:00", "Europe/Madrid").toISOString()).toBe(
      "2026-10-10T08:00:00.000Z",
    );
    expect(zonedLocalToInstant("2026-12-10T10:00", "Europe/Madrid").toISOString()).toBe(
      "2026-12-10T09:00:00.000Z",
    );
    expect(instantToZonedLocal(new Date("2026-12-10T09:00:00Z"), "Europe/Madrid")).toBe(
      "2026-12-10T10:00",
    );
  });

  it("cruza el cambio de día y de año", () => {
    expect(zonedLocalToInstant("2026-12-31T23:30", BA).toISOString()).toBe(
      "2027-01-01T02:30:00.000Z",
    );
  });

  it("valida el formato y fechas inexistentes", () => {
    expect(isValidLocalDateTime("2026-10-10T10:00")).toBe(true);
    expect(isValidLocalDateTime("2026-02-31T10:00")).toBe(false);
    expect(isValidLocalDateTime("2026-10-10T24:00")).toBe(false);
    expect(isValidLocalDateTime("2026-10-10 10:00")).toBe(false);
    expect(isValidLocalDateTime("2026-10-10T10:00Z")).toBe(false);
    expect(localDateTimeSchema().safeParse("2026-10-10T10:00").success).toBe(true);
    expect(localDateTimeSchema().safeParse("mañana").success).toBe(false);
    expect(() => zonedLocalToInstant("2026-13-01T10:00", BA)).toThrow(RangeError);
  });
});
