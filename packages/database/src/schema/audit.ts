import { bigserial, index, jsonb, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import { companies } from "./company.js";
import { createdAt } from "./common.js";
import { users } from "./people.js";

/**
 * Registro de auditoría de operaciones sensibles. Solo inserción: la aplicación
 * nunca actualiza ni borra filas. `metadata` no debe contener secretos.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    companyId: uuid().references(() => companies.id, { onDelete: "restrict" }),
    actorUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    action: varchar({ length: 64 }).notNull(),
    entityType: varchar({ length: 64 }).notNull(),
    entityId: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    requestId: varchar({ length: 64 }),
    ipAddress: varchar({ length: 64 }),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_actor_idx").on(t.actorUserId),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);
