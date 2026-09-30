import { sql } from "drizzle-orm";
import {
  date,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { companies } from "./company.js";
import { createdAt, id, updatedAt } from "./common.js";

export const employeeStatus = pgEnum("employee_status", ["ACTIVE", "ON_LEAVE", "INACTIVE"]);
export const userStatus = pgEnum("user_status", ["ACTIVE", "DISABLED"]);

/** Persona que trabaja en la empresa. Puede existir sin usuario del sistema. */
export const employees = pgTable(
  "employees",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    firstName: text().notNull(),
    lastName: text().notNull(),
    documentNumber: varchar({ length: 32 }),
    phone: varchar({ length: 50 }),
    email: varchar({ length: 254 }),
    address: text(),
    hireDate: date({ mode: "string" }),
    position: text(),
    status: employeeStatus().notNull().default("ACTIVE"),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("employees_company_document_uq")
      .on(t.companyId, t.documentNumber)
      .where(sql`${t.documentNumber} is not null`),
    index("employees_company_last_name_idx").on(t.companyId, t.lastName),
  ],
);

/** Identidad que puede ingresar al sistema. Opcionalmente vinculada a un empleado. */
export const users = pgTable(
  "users",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    employeeId: uuid().references(() => employees.id, { onDelete: "restrict" }),
    /** Siempre almacenado en minúsculas (normalizado en la capa de aplicación). */
    email: varchar({ length: 254 }).notNull(),
    displayName: text().notNull(),
    /** Hash Argon2id (formato PHC). Nunca la contraseña en texto plano. */
    passwordHash: text().notNull(),
    status: userStatus().notNull().default("ACTIVE"),
    lastLoginAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(sql`lower(${t.email})`),
    uniqueIndex("users_employee_uq")
      .on(t.employeeId)
      .where(sql`${t.employeeId} is not null`),
    index("users_company_idx").on(t.companyId),
  ],
);
