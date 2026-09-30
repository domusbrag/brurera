import { permissions, rolePermissions, roles, type Database } from "@bakery/database";
import { PERMISSIONS, type RoleDto } from "@bakery/shared";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { operationContext } from "../../lib/context.js";
import { requirePermission } from "../auth/auth.plugin.js";

/** Roles de la empresa con sus permisos (solo lectura en Fase 1). */
export async function roleRoutes(app: FastifyInstance, { db }: { db: Database }) {
  app.get(
    "/roles",
    { preHandler: requirePermission(PERMISSIONS.ROLES_READ) },
    async (req): Promise<RoleDto[]> => {
      const { companyId } = operationContext(req);
      const rows = await db
        .select({ role: roles, permission: permissions.code })
        .from(roles)
        .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(eq(roles.companyId, companyId))
        .orderBy(asc(roles.createdAt), asc(roles.code), asc(permissions.code));
      const byId = new Map<string, RoleDto>();
      for (const { role, permission } of rows) {
        const dto = byId.get(role.id) ?? {
          id: role.id,
          code: role.code,
          name: role.name,
          description: role.description,
          isSystem: role.isSystem,
          permissions: [],
        };
        if (permission) dto.permissions.push(permission);
        byId.set(role.id, dto);
      }
      return [...byId.values()];
    },
  );
}
