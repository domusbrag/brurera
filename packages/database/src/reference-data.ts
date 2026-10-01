import { STANDARD_UNITS } from "@bakery/domain";
import { PERMISSION_CATALOG, SYSTEM_ROLES } from "@bakery/shared";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Database, Transaction } from "./client.js";
import { permissions, rolePermissions, roles, unitsOfMeasure } from "./schema/index.js";

/**
 * Sincroniza datos de referencia necesarios en CUALQUIER entorno (no son datos
 * de prueba): catálogo de permisos y roles de sistema de una empresa.
 * Idempotente: se puede ejecutar tantas veces como se quiera.
 */
export async function syncPermissionCatalog(db: Database | Transaction): Promise<void> {
  for (const p of PERMISSION_CATALOG) {
    await db
      .insert(permissions)
      .values({ code: p.code, module: p.module, description: p.description })
      .onConflictDoUpdate({
        target: permissions.code,
        set: { module: p.module, description: p.description },
      });
  }
}

export async function syncSystemRoles(
  db: Database | Transaction,
  companyId: string,
): Promise<void> {
  const allPermissions = await db.select().from(permissions);
  const idByCode = new Map(allPermissions.map((p) => [p.code, p.id]));

  for (const def of SYSTEM_ROLES) {
    const [role] = await db
      .insert(roles)
      .values({
        companyId,
        code: def.code,
        name: def.name,
        description: def.description,
        isSystem: true,
      })
      .onConflictDoUpdate({
        target: [roles.companyId, roles.code],
        set: { name: def.name, description: def.description, isSystem: true },
      })
      .returning({ id: roles.id });
    if (!role) throw new Error(`No se pudo sincronizar el rol ${def.code}`);

    const wanted = def.permissions.map((code) => {
      const permissionId = idByCode.get(code);
      if (!permissionId)
        throw new Error(
          `Permiso ${code} no existe en la base; ejecutar syncPermissionCatalog primero`,
        );
      return permissionId;
    });

    if (wanted.length > 0) {
      await db
        .insert(rolePermissions)
        .values(wanted.map((permissionId) => ({ roleId: role.id, permissionId })))
        .onConflictDoNothing();
      await db
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, role.id),
            notInArray(rolePermissions.permissionId, wanted),
          ),
        );
    } else {
      await db.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));
    }
  }
}

export async function findRoleIdsByCode(
  db: Database | Transaction,
  companyId: string,
  codes: readonly string[],
): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const rows = await db
    .select({ id: roles.id, code: roles.code })
    .from(roles)
    .where(and(eq(roles.companyId, companyId), inArray(roles.code, [...codes])));
  return new Map(rows.map((r) => [r.code, r.id]));
}

/**
 * Crea las unidades estándar de la empresa que falten (kg, g, l, ml, unidad,
 * docena, bolsa, caja). No modifica unidades existentes. Idempotente.
 */
export async function syncStandardUnits(
  db: Database | Transaction,
  companyId: string,
): Promise<void> {
  const existing = await db
    .select({ id: unitsOfMeasure.id, code: unitsOfMeasure.code })
    .from(unitsOfMeasure)
    .where(eq(unitsOfMeasure.companyId, companyId));
  const idByCode = new Map(existing.map((u) => [u.code.toLowerCase(), u.id]));

  // Primero las raíces, después las derivadas (que referencian a su raíz).
  const ordered = [...STANDARD_UNITS].sort((a, b) => Number(!!a.base) - Number(!!b.base));
  for (const unit of ordered) {
    if (idByCode.has(unit.code)) continue;
    const baseUnitId = unit.base ? idByCode.get(unit.base.code) : undefined;
    if (unit.base && !baseUnitId) {
      throw new Error(`Unidad base ${unit.base.code} inexistente para ${unit.code}`);
    }
    const [created] = await db
      .insert(unitsOfMeasure)
      .values({
        companyId,
        code: unit.code,
        name: unit.name,
        symbol: unit.symbol,
        dimension: unit.dimension,
        decimals: unit.decimals,
        baseUnitId: baseUnitId ?? null,
        conversionFactor: unit.base?.factor ?? null,
        isSystem: true,
      })
      .returning({ id: unitsOfMeasure.id });
    if (created) idByCode.set(unit.code, created.id);
  }
}
