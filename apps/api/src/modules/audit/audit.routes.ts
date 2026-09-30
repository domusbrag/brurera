import { auditLogs, users, type Database } from "@bakery/database";
import { PERMISSIONS, paginationQuerySchema, toOffset, type Page } from "@bakery/shared";
import { count, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { parseInput } from "../../lib/errors.js";
import { getAuth, requirePermission } from "../auth/auth.plugin.js";

export interface AuditLogItem {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  actor: { id: string; displayName: string } | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}

/** Consulta paginada (server-side) del registro de auditoría de la empresa. */
export async function auditRoutes(app: FastifyInstance, opts: { db: Database }) {
  app.get(
    "/audit-logs",
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => {
      const query = parseInput(paginationQuerySchema, request.query);
      const companyId = getAuth(request).user.company.id;

      const [rows, totals] = await Promise.all([
        opts.db
          .select({
            id: auditLogs.id,
            action: auditLogs.action,
            entityType: auditLogs.entityType,
            entityId: auditLogs.entityId,
            metadata: auditLogs.metadata,
            requestId: auditLogs.requestId,
            createdAt: auditLogs.createdAt,
            actorId: users.id,
            actorName: users.displayName,
          })
          .from(auditLogs)
          .leftJoin(users, eq(users.id, auditLogs.actorUserId))
          .where(eq(auditLogs.companyId, companyId))
          .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
          .limit(query.pageSize)
          .offset(toOffset(query)),
        opts.db
          .select({ total: count() })
          .from(auditLogs)
          .where(eq(auditLogs.companyId, companyId)),
      ]);

      const page: Page<AuditLogItem> = {
        page: query.page,
        pageSize: query.pageSize,
        total: totals[0]?.total ?? 0,
        items: rows.map((r) => ({
          id: r.id,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          actor: r.actorId && r.actorName ? { id: r.actorId, displayName: r.actorName } : null,
          metadata: r.metadata,
          requestId: r.requestId,
          createdAt: r.createdAt.toISOString(),
        })),
      };
      return page;
    },
  );
}
