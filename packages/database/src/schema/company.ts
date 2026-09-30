import { boolean, jsonb, pgTable, text, varchar } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./common.js";

/**
 * Empresa operativa. En el MVP existe una sola, pero todas las entidades de
 * negocio llevan company_id para no bloquear una evolución multiempresa.
 */
export const companies = pgTable("companies", {
  id: id(),
  legalName: text().notNull(),
  tradeName: text().notNull(),
  taxId: varchar({ length: 32 }),
  address: text(),
  city: text(),
  province: text(),
  postalCode: varchar({ length: 16 }),
  phone: varchar({ length: 50 }),
  email: varchar({ length: 254 }),
  logoUrl: text(),
  currencyCode: varchar({ length: 3 }).notNull().default("ARS"),
  timezone: varchar({ length: 64 }).notNull().default("America/Argentina/Buenos_Aires"),
  active: boolean().notNull().default(true),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
