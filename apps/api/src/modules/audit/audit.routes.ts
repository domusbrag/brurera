import { auditLogs, users, type Database } from "@bakery/database";
import {
  PERMISSIONS,
  paginationQuerySchema,
  type AuditLogItemDto,
  type Page,
} from "@bakery/shared";
import { and, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { pageWindow, toPage } from "../../lib/listing.js";
import { requirePermission } from "../auth/auth.plugin.js";

const auditQuerySchema = paginationQuerySchema.extend({
  entityType: z.string().trim().max(64).optional(),
  entityId: z.string().trim().max(100).optional(),
});

/** Consulta paginada (server-side) del registro de auditoría de la empresa de la sesión. */
export async function auditRoutes(app: FastifyInstance, opts: { db: Database }) {
  app.get(
    "/audit-logs",
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request): Promise<Page<AuditLogItemDto>> => {
      const query = parseInput(auditQuerySchema, request.query);
      const { companyId } = operationContext(request);
      const where = and(
        eq(auditLogs.companyId, companyId),
        query.entityType ? eq(auditLogs.entityType, query.entityType) : undefined,
        query.entityId ? eq(auditLogs.entityId, query.entityId) : undefined,
      );

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
          .where(where)
          .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
          .limit(pageWindow(query).limit)
          .offset(pageWindow(query).offset),
        opts.db.select({ total: count() }).from(auditLogs).where(where),
      ]);

      return toPage(
        rows.map((r) => ({
          id: r.id,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          actor: r.actorId && r.actorName ? { id: r.actorId, displayName: r.actorName } : null,
          metadata: r.metadata,
          requestId: r.requestId,
          createdAt: r.createdAt.toISOString(),
        })),
        totals[0]?.total ?? 0,
        query,
      );
    },
  );
}
