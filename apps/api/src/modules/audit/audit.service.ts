import { auditLogs, type Database, type Transaction } from "@bakery/database";

/** Acciones auditables conocidas. Cada fase agrega las propias. */
export const AUDIT_ACTIONS = {
  AUTH_LOGIN_SUCCEEDED: "AUTH_LOGIN_SUCCEEDED",
  AUTH_LOGIN_FAILED: "AUTH_LOGIN_FAILED",
  AUTH_LOGOUT: "AUTH_LOGOUT",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  companyId: string | null;
  actorUserId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string;
  ipAddress?: string;
}

/**
 * Inserta una entrada de auditoría. Recibe la transacción de la operación de
 * negocio para que auditoría y cambio se confirmen (o reviertan) juntos.
 */
export async function recordAudit(db: Database | Transaction, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    companyId: entry.companyId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: entry.metadata ?? {},
    requestId: entry.requestId,
    ipAddress: entry.ipAddress,
  });
}
