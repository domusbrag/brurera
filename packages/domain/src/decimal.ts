import Decimal from "decimal.js";

/**
 * Política decimal del dominio (ver docs/ARCHITECTURE.md → "Fechas, dinero y cantidades").
 *
 * - Todo cálculo usa este constructor: 40 dígitos significativos, sin redondeos
 *   intermedios. Nunca `number` para dinero ni cantidades.
 * - Se redondea una sola vez, al persistir o al mostrar, con ROUND_HALF_UP.
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type DecimalValue = Decimal.Value;

/** Escala con que se persisten importes de costo (numeric(20,6)). */
export const COST_SCALE = 6;
/** Escala de cantidades de receta y rendimientos (numeric(18,6)). */
export const RECIPE_QUANTITY_SCALE = 6;
/** Escala de cantidades normalizadas a unidad base (numeric(28,10)). */
export const NORMALIZED_QUANTITY_SCALE = 10;
/** Escala de porcentajes calculados (variación, margen) al persistir o enviar. */
export const PERCENTAGE_SCALE = 4;
/** Decimales con que la UI muestra dinero y porcentajes. */
export const DISPLAY_MONEY_SCALE = 2;

/** Redondea a `scale` decimales (HALF_UP) y devuelve un string sin notación exponencial. */
export function toFixedString(value: Decimal.Value, scale: number): string {
  return new D(value).toFixed(scale, Decimal.ROUND_HALF_UP);
}

/** String sin ceros a la derecha ("0.750000" → "0.75"); útil para comparar y mostrar. */
export function trimDecimal(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}
