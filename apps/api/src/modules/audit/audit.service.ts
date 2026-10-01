import { auditLogs, type Database, type Transaction } from "@bakery/database";
import type { AuditAction } from "@bakery/shared";

export type { AuditAction };

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

/** Campos que nunca se copian a la auditoría. */
const SECRET_FIELDS = new Set(["password", "passwordHash", "tokenHash"]);

/**
 * Diferencias entre dos versiones de una entidad, solo para los campos
 * indicados: { campo: { from, to } }. Omite secretos y campos sin cambio.
 */
export function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of fields) {
    if (SECRET_FIELDS.has(field)) continue;
    const from = normalize(before[field]);
    const to = normalize(after[field]);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from, to };
  }
  return changes;
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}
