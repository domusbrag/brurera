import type { ApiError } from "./api-client";
import { formatDecimal, formatMoney } from "./format";

/*
 * Errores en lenguaje de negocio. La API ya responde en castellano; acá se
 * cubren los casos que llegaban con números crudos ("faltan 2.5 kg",
 * "$ 1500.00") o con mensajes genéricos, y nunca se muestra un código interno
 * (INSUFFICIENT_FREE_PRODUCT_STOCK, LOT_QUANTITY_COMMITTED…) como texto principal.
 */

/** Mensajes propios por código, cuando el texto de la API no alcanza. */
const MESSAGES: Record<string, string> = {
  NETWORK: "No hay conexión con el servidor. Revisá la conexión y reintentá.",
  FORBIDDEN: "No tenés permiso para esta operación.",
  UNKNOWN: "Ocurrió un error inesperado. Reintentá en unos segundos.",
  HTTP_ERROR: "Ocurrió un error inesperado. Reintentá en unos segundos.",
};

/**
 * Montos ("$ 1500.00", "$1500.5") y decimales sueltos ("2.5 kg") del texto de
 * la API pasan a formato es-AR. No toca códigos (LOT-20261005-004.1) ni fechas.
 */
export function localizeNumbers(text: string): string {
  return text
    .replace(/\$ ?(-?\d+(?:\.\d+)?)(?![\d.,])/g, (_, n: string) => formatMoney(n))
    .replace(/(?<![\w\-./,$])(\d{1,12})\.(\d{1,6})(?![\d\w-]|\.\d)/g, (_, i: string, f: string) =>
      formatDecimal(`${i}.${f}`, 0, 6),
    );
}

export function describeError(error: Pick<ApiError, "code" | "message" | "status">): string {
  const own = MESSAGES[error.code];
  if (own && (error.code !== "HTTP_ERROR" || !error.message)) return own;
  const text = error.message?.trim();
  if (!text || /^[A-Z][A-Z0-9_]+$/.test(text)) return MESSAGES.UNKNOWN!;
  return localizeNumbers(text);
}
