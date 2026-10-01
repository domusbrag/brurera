import {
  boolean,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { companies } from "./company.js";
import { createdAt, id, updatedAt } from "./common.js";
import { employees, users } from "./people.js";

export const membershipStatus = pgEnum("membership_status", ["ACTIVE", "DISABLED"]);

/** Rol asignable dentro de una empresa. Los roles de sistema se sincronizan desde @bakery/shared. */
export const roles = pgTable(
  "roles",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    code: varchar({ length: 64 }).notNull(),
    name: text().notNull(),
    description: text(),
    isSystem: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("roles_company_code_uq").on(t.companyId, t.code),
    unique("roles_company_id_uq").on(t.companyId, t.id),
  ],
);

/** Catálogo global de permisos (código `modulo.accion`). */
export const permissions = pgTable("permissions", {
  id: id(),
  code: varchar({ length: 100 }).notNull().unique(),
  module: varchar({ length: 64 }).notNull(),
  description: text().notNull(),
  createdAt: createdAt(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid()
      .notNull()
      .references(() => permissions.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

/**
 * Pertenencia de un usuario a una empresa. Es la fuente de su autoridad en esa
 * empresa (roles) y, opcionalmente, su vínculo con el empleado correspondiente.
 * Un mismo usuario puede tener membresías en varias empresas con roles distintos.
 */
export const companyMemberships = pgTable(
  "company_memberships",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    employeeId: uuid(),
    status: membershipStatus().notNull().default("ACTIVE"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("company_memberships_company_user_uq").on(t.companyId, t.userId),
    unique("company_memberships_company_id_uq").on(t.companyId, t.id),
    // Un empleado tiene como máximo un acceso al sistema.
    uniqueIndex("company_memberships_employee_uq").on(t.employeeId),
    index("company_memberships_user_idx").on(t.userId),
    foreignKey({
      name: "company_memberships_employee_fk",
      columns: [t.companyId, t.employeeId],
      foreignColumns: [employees.companyId, employees.id],
    }).onDelete("restrict"),
  ],
);

/** Roles de una membresía. company_id redundante para que la base impida mezclar empresas. */
export const membershipRoles = pgTable(
  "membership_roles",
  {
    membershipId: uuid().notNull(),
    roleId: uuid().notNull(),
    companyId: uuid().notNull(),
    assignedAt: createdAt(),
    assignedByUserId: uuid().references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.roleId] }),
    index("membership_roles_role_idx").on(t.roleId),
    foreignKey({
      name: "membership_roles_membership_fk",
      columns: [t.companyId, t.membershipId],
      foreignColumns: [companyMemberships.companyId, companyMemberships.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "membership_roles_role_fk",
      columns: [t.companyId, t.roleId],
      foreignColumns: [roles.companyId, roles.id],
    }).onDelete("restrict"),
  ],
);

/**
 * Sesiones de servidor. La cookie lleva un token aleatorio opaco; aquí solo se
 * guarda su hash SHA-256. Cada sesión trabaja en una empresa (company_id) y su
 * autoridad se resuelve por la membresía del usuario en esa empresa.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    tokenHash: varchar({ length: 64 }).notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
    ipAddress: varchar({ length: 64 }),
    userAgent: text(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_uq").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);
