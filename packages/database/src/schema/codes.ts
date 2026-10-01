import { integer, pgTable, primaryKey, uuid, varchar } from "drizzle-orm/pg-core";
import { companies } from "./company.js";

/**
 * Próximo número de código interno por empresa y tipo de entidad (CLI, PROV, ...).
 * Se incrementa con UPDATE ... RETURNING dentro de la transacción del alta, que
 * bloquea la fila y evita duplicados por concurrencia.
 */
export const codeSequences = pgTable(
  "code_sequences",
  {
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    entity: varchar({ length: 32 }).notNull(),
    nextValue: integer().notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.entity] })],
);
