import { timestamp, uuid } from "drizzle-orm/pg-core";

/** Clave primaria UUID generada por PostgreSQL (gen_random_uuid, nativo desde PG13). */
export const id = () => uuid().primaryKey().defaultRandom();

/** Todas las marcas de tiempo se guardan como timestamptz (UTC). */
export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
