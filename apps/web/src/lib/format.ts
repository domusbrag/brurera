import { DISPLAY_MONEY_SCALE, toFixedString } from "@bakery/domain";

/*
 * Formato de datos para la UI (es-AR). Los decimales llegan como string desde
 * la API y se muestran sin pasar por aritmética de punto flotante. El redondeo
 * de presentación (HALF_UP) usa la misma política decimal que @bakery/domain.
 */

const currencyPrefix = (currency: string) => (currency === "ARS" ? "$" : `${currency} `);

/** "1234567.5" → "$1.234.567,50" (dinero, redondeado a 2 decimales). */
export function formatMoney(value: string | null | undefined, currency = "ARS"): string {
  if (value === null || value === undefined || value === "") return "—";
  const rounded = toFixedString(value, DISPLAY_MONEY_SCALE);
  // El signo va antes de la moneda: "-$7.500,00".
  const sign = rounded.startsWith("-") && !/^-0(\.0+)?$/.test(rounded) ? "-" : "";
  return `${sign}${currencyPrefix(currency)}${formatDecimal(rounded.replace(/^-/, ""), 2, 2)}`;
}

/**
 * Costo por unidad: "$850,00 / kg". Si es menor a un centavo muestra hasta 6
 * decimales ("$0,0005 / g") para no mostrar un engañoso "$0,00".
 */
export function formatUnitCost(
  value: string | null | undefined,
  currency: string,
  unitSymbol: string,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const small = value !== "0" && toFixedString(value, 2) === "0.00" && !/^0(\.0*)?$/.test(value);
  const text = small
    ? `${currencyPrefix(currency)}${formatDecimal(toFixedString(value, 6), 2, 6)}`
    : formatMoney(value, currency);
  return `${text} / ${unitSymbol}`;
}

/**
 * Costo de referencia tal como se cargó (hasta 6 decimales, sin redondear):
 * "850.125000" → "$850,125 / kg". Es un dato de entrada, no un resultado.
 */
export function formatReferenceCost(
  value: string | null | undefined,
  currency: string,
  unitSymbol: string,
): string {
  if (value === null || value === undefined || value === "") return "—";
  return `${currencyPrefix(currency)}${formatDecimal(value, 2, 6)} / ${unitSymbol}`;
}

/** Porcentaje redondeado a 2 decimales: "31.666…" → "31,67 %". */
export function formatPercent(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return `${formatDecimal(toFixedString(value, 2), 0, 2)} %`;
}

/** Cantidad con su unidad, sin ceros de más: "0.750000", "kg" → "0,75 kg". */
export function formatQuantity(value: string | null | undefined, symbol: string): string {
  if (value === null || value === undefined || value === "") return "—";
  return `${formatDecimal(value, 0, 6)} ${symbol}`;
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
