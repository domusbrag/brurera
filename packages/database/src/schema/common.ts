import { numeric, timestamp, uuid } from "drizzle-orm/pg-core";

/** Clave primaria UUID generada por PostgreSQL (gen_random_uuid, nativo desde PG13). */
export const id = () => uuid().primaryKey().defaultRandom();

/** Todas las marcas de tiempo se guardan como timestamptz (UTC). */
export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/*
 * Tipos decimales del dominio. Nunca float. Drizzle los devuelve como string;
 * la aritmética se hace con decimal.js en @bakery/domain.
 */
/** Importes de dinero (precios, límites de crédito). */
export const money = () => numeric({ precision: 14, scale: 2 });
/** Costo unitario por unidad base (puede ser muy chico, p. ej. por gramo). */
export const unitCost = () => numeric({ precision: 18, scale: 6 });
/** Cantidades físicas (stock mínimo, cantidades de receta en fases futuras). */
export const quantity = () => numeric({ precision: 18, scale: 4 });
/** Factores de conversión entre unidades. */
export const conversionFactor = () => numeric({ precision: 24, scale: 10 });
