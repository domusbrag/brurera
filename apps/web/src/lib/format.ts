/*
 * Formato de datos para la UI (es-AR). Los decimales llegan como string desde
 * la API y se muestran sin pasar por aritmética de punto flotante.
 */

/** "1234567.5" → "1.234.567,50" (dinero, 2 decimales). */
export function formatMoney(value: string | null | undefined, currency = "ARS"): string {
  if (value === null || value === undefined || value === "") return "—";
  return `${currency === "ARS" ? "$" : `${currency} `}${formatDecimal(value, 2, 2)}`;
}

/** Formatea un decimal-string con separador de miles y coma decimal, sin float. */
export function formatDecimal(
  value: string | null | undefined,
  minScale = 0,
  maxScale = 6,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const negative = value.startsWith("-");
  const [intPartRaw = "0", fracRaw = ""] = value.replace("-", "").split(".");
  let frac = fracRaw.slice(0, maxScale).replace(/0+$/, "");
  while (frac.length < minScale) frac += "0";
  const intPart = intPartRaw.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${intPart}${frac ? `,${frac}` : ""}`;
}

/** "2026-01-15" → "15/01/2026" (fecha de calendario, sin zona horaria). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const [y, m, d] = value.split("-");
  return `${d}/${m}/${y}`;
}

/** Instante ISO en la zona de la empresa. */
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone,
  }).format(new Date(iso));
}

export function orDash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}
