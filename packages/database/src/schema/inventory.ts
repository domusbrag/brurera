import {
  boolean,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { companies } from "./company.js";
import { createdAt, id, updatedAt } from "./common.js";

/**
 * Depósito. En Fase 1 solo es un maestro; el stock por depósito y las
 * transferencias llegan con los movimientos de inventario (Fase 3).
 */
export const warehouses = pgTable(
  "warehouses",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    code: varchar({ length: 32 }).notNull(),
    name: text().notNull(),
    description: text(),
    address: text(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("warehouses_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("warehouses_company_code_uq").on(t.companyId, t.code),
    index("warehouses_company_active_idx").on(t.companyId, t.active),
  ],
);
