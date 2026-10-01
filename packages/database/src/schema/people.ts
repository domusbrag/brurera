import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { companies } from "./company.js";
import { createdAt, id, updatedAt } from "./common.js";

export const employeeStatus = pgEnum("employee_status", ["ACTIVE", "INACTIVE"]);
export const documentType = pgEnum("document_type", ["DNI", "CUIL", "CUIT", "PASSPORT", "OTHER"]);
export const userStatus = pgEnum("user_status", ["ACTIVE", "DISABLED"]);

/**
 * Persona que trabaja en la empresa. Puede existir sin usuario del sistema y
 * nunca se borra: al dejar la empresa pasa a INACTIVE con fecha de egreso.
 */
export const employees = pgTable(
  "employees",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    employeeCode: varchar({ length: 32 }).notNull(),
    firstName: text().notNull(),
    lastName: text().notNull(),
    documentType: documentType(),
    documentNumber: varchar({ length: 32 }),
    phone: varchar({ length: 50 }),
    email: varchar({ length: 254 }),
    address: text(),
    city: text(),
    position: text(),
    hireDate: date({ mode: "string" }),
    terminationDate: date({ mode: "string" }),
    status: employeeStatus().notNull().default("ACTIVE"),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Destino de FKs compuestas (company_id, employee_id): impide referencias entre empresas.
    unique("employees_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("employees_company_document_uq")
      .on(t.companyId, t.documentNumber)
      .where(sql`${t.documentNumber} is not null`),
    uniqueIndex("employees_company_code_uq").on(t.companyId, t.employeeCode),
    index("employees_company_last_name_idx").on(t.companyId, t.lastName),
    index("employees_company_status_idx").on(t.companyId, t.status),
    check(
      "employees_termination_after_hire",
      sql`${t.terminationDate} is null or ${t.hireDate} is null or ${t.terminationDate} >= ${t.hireDate}`,
    ),
  ],
);

/**
 * Identidad global que puede ingresar al sistema. No pertenece a una empresa:
 * la pertenencia y la autoridad viven en `company_memberships`.
 */
export const users = pgTable(
  "users",
  {
    id: id(),
    /** Siempre almacenado en minúsculas (normalizado en la capa de aplicación). */
    email: varchar({ length: 254 }).notNull(),
    displayName: text().notNull(),
    /** Hash Argon2id (formato PHC). Nunca la contraseña en texto plano. */
    passwordHash: text().notNull(),
    /** Bloqueo global de la identidad (todas las empresas). */
    status: userStatus().notNull().default("ACTIVE"),
    lastLoginAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);
