import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { companies } from "./company.js";
import { createdAt, id, money, updatedAt } from "./common.js";

export const customerType = pgEnum("customer_type", [
  "CONSUMER",
  "RETAILER",
  "WHOLESALER",
  "DISTRIBUTOR",
  "OTHER",
]);
export const commercialCondition = pgEnum("commercial_condition", ["CASH", "CURRENT_ACCOUNT"]);

/**
 * Cliente. Preparado para ventas y cuenta corriente (fases 5 y 6), que se
 * vincularán por FK a esta tabla. La lista de precios se agregará en Fase 5.
 */
export const customers = pgTable(
  "customers",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    internalCode: varchar({ length: 32 }).notNull(),
    type: customerType().notNull(),
    legalName: text().notNull(),
    tradeName: text(),
    taxId: varchar({ length: 32 }),
    phone: varchar({ length: 50 }),
    email: varchar({ length: 254 }),
    address: text(),
    city: text(),
    province: text(),
    postalCode: varchar({ length: 16 }),
    commercialCondition: commercialCondition().notNull().default("CASH"),
    creditLimit: money(),
    active: boolean().notNull().default(true),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("customers_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("customers_company_code_uq").on(t.companyId, t.internalCode),
    index("customers_company_active_name_idx").on(t.companyId, t.active, t.legalName),
    check("customers_credit_limit_nonneg", sql`${t.creditLimit} is null or ${t.creditLimit} >= 0`),
  ],
);

/** Proveedor. Compras y cuentas a pagar se agregan en fases 3 y 6. */
export const suppliers = pgTable(
  "suppliers",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    internalCode: varchar({ length: 32 }).notNull(),
    legalName: text().notNull(),
    tradeName: text(),
    taxId: varchar({ length: 32 }),
    contactName: text(),
    phone: varchar({ length: 50 }),
    email: varchar({ length: 254 }),
    address: text(),
    city: text(),
    province: text(),
    paymentTerms: text(),
    active: boolean().notNull().default(true),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("suppliers_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("suppliers_company_code_uq").on(t.companyId, t.internalCode),
    index("suppliers_company_active_name_idx").on(t.companyId, t.active, t.legalName),
  ],
);
