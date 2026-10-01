import { D } from "@bakery/domain";

/*
 * Números escritos por el usuario: se acepta coma o punto decimal ("12,5") y se
 * envían a la API como decimal-string con punto. Nunca pasan por float.
 */

const DECIMAL = /^\d{1,14}([.,]\d{1,6})?$/;

export const toDecimal = (value: string) => value.trim().replace(",", ".");

/** ¿Es un decimal válido y no negativo? */
export const isDecimal = (value: string) => DECIMAL.test(value.trim());

export const isPositive = (value: string) => isDecimal(value) && new D(toDecimal(value)).gt(0);

/** Decimal del input, o null si está vacío o es inválido. */
export function parseDecimal(value: string): InstanceType<typeof D> | null {
  return isDecimal(value) ? new D(toDecimal(value)) : null;
}
