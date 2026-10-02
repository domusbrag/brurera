import { z } from "zod";

/*
 * Fecha y hora "de pared" en la zona horaria de la EMPRESA (Fase 5A, ADR-054).
 *
 * Un pedido para "el sábado a las 10:00" significa las 10:00 en la zona de la
 * empresa, no en la del navegador de quien lo carga. La UI envía la hora tal
 * como se ve ("2026-10-10T10:00") y la API la interpreta con Company.timezone;
 * se persiste como timestamptz (UTC). Nunca se usa `new Date("…T10:00")`, que
 * interpretaría la hora en la zona del navegador o del servidor.
 */

/** "AAAA-MM-DDTHH:mm" sin zona: hora de pared. */
export const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function parts(local: string) {
  const m = LOCAL_DATE_TIME_PATTERN.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  // Rechaza fechas inexistentes (31/02): el día debe sobrevivir al ida y vuelta.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, mo, d, h, mi };
}

export function isValidLocalDateTime(local: string): boolean {
  return parts(local) !== null;
}

/** Desfasaje (ms) de la zona respecto de UTC en un instante dado. */
function offsetAt(instant: number, timeZone: string): number {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(fields.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Hora de pared en `timeZone` → instante UTC. "2026-10-10T10:00" en
 * America/Argentina/Buenos_Aires → 2026-10-10T13:00:00Z, sea cual sea la zona
 * del proceso que lo calcula.
 */
export function zonedLocalToInstant(local: string, timeZone: string): Date {
  const p = parts(local);
  if (!p) throw new RangeError(`Fecha y hora inválidas: ${local}`);
  const guess = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  const first = offsetAt(guess - offsetAt(guess, timeZone), timeZone);
  return new Date(guess - first);
}

/** Instante → hora de pared en `timeZone` ("AAAA-MM-DDTHH:mm"). */
export function instantToZonedLocal(instant: Date | string, timeZone: string): string {
  const time = typeof instant === "string" ? Date.parse(instant) : instant.getTime();
  const local = new Date(time + offsetAt(time, timeZone));
  return local.toISOString().slice(0, 16);
}

/** Hora de pared de la empresa, validada ("AAAA-MM-DDTHH:mm"). */
export const localDateTimeSchema = () =>
  z
    .string({ error: "Indicá fecha y hora" })
    .trim()
    .refine(isValidLocalDateTime, "Fecha y hora inválidas (AAAA-MM-DD y HH:MM)");

/** Nombre corto de la zona para mostrar junto a la hora ("Buenos Aires"). */
export function timeZoneLabel(timeZone: string): string {
  const last = timeZone.split("/").pop() ?? timeZone;
  return last.replace(/_/g, " ");
}

/** "2026-10-10T10:00" → "10/10/2026 10:00" (para mensajes y explicaciones). */
export function formatLocalDateTime(local: string): string {
  const p = parts(local);
  if (!p) return local;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(p.d)}/${two(p.mo)}/${p.y} ${two(p.h)}:${two(p.mi)}`;
}
