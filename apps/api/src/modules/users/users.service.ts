import {
  companyMemberships,
  employees,
  membershipRoles,
  permissions,
  rolePermissions,
  roles,
  users,
  type Database,
  type Transaction,
} from "@bakery/database";
import type { ListQuery, Page, RoleSummary, UserDetailDto, UserDto } from "@bakery/shared";
import { type createUserSchema, type updateUserSchema } from "@bakery/shared";
import { and, asc, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { pageWindow, searchCondition, toPage } from "../../lib/listing.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";
import { hashPassword } from "../auth/password.js";
import { revokeSessions } from "../employees/employees.service.js";

/*
 * "Usuario" en la UI = acceso de una identidad a ESTA empresa (membresía).
 * El id expuesto es el del usuario; la empresa sale siempre de la sesión.
 */

function selectMembers(db: Database | Transaction) {
  return db
    .select({
      membershipId: companyMemberships.id,
      status: companyMemberships.status,
      user: {
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      },
      employee: {
        id: employees.id,
        code: employees.employeeCode,
        firstName: employees.firstName,
        lastName: employees.lastName,
      },
    })
    .from(companyMemberships)
    .innerJoin(users, eq(users.id, companyMemberships.userId))
    .leftJoin(
      employees,
      and(
        eq(employees.id, companyMemberships.employeeId),
        eq(employees.companyId, companyMemberships.companyId),
      ),
    );
}

type MemberRow = Awaited<ReturnType<ReturnType<typeof selectMembers>["execute"]>>[number];

/** Roles de varias membresías en una sola consulta (sin N+1). */
async function rolesByMembership(db: Database | Transaction, membershipIds: string[]) {
  const map = new Map<string, RoleSummary[]>();
  if (membershipIds.length === 0) return map;
  const rows = await db
    .select({
      membershipId: membershipRoles.membershipId,
      id: roles.id,
      code: roles.code,
      name: roles.name,
    })
    .from(membershipRoles)
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .where(inArray(membershipRoles.membershipId, membershipIds))
    .orderBy(asc(roles.code));
  for (const r of rows) {
    const list = map.get(r.membershipId) ?? [];
    list.push({ id: r.id, code: r.code, name: r.name });
    map.set(r.membershipId, list);
  }
  return map;
}

function toDto(row: MemberRow, roleList: RoleSummary[]): UserDto {
  return {
    id: row.user.id,
    email: row.user.email,
    displayName: row.user.displayName,
    status: row.status,
    employee: row.employee?.id
      ? {
          id: row.employee.id,
          code: row.employee.code,
          fullName: `${row.employee.firstName} ${row.employee.lastName}`,
        }
      : null,
    roles: roleList,
    lastLoginAt: row.user.lastLoginAt?.toISOString() ?? null,
    createdAt: row.user.createdAt.toISOString(),
  };
}

const memberOf = (ctx: OperationContext, userId: string): SQL | undefined =>
  and(eq(companyMemberships.companyId, ctx.companyId), eq(companyMemberships.userId, userId));

export async function listUsers(
  db: Database,
  ctx: OperationContext,
  query: ListQuery,
): Promise<Page<UserDto>> {
  const where = and(
    eq(companyMemberships.companyId, ctx.companyId),
    query.status === "all"
      ? undefined
      : eq(companyMemberships.status, query.status === "active" ? "ACTIVE" : "DISABLED"),
    searchCondition(query.search, [
      users.email,
      users.displayName,
      employees.firstName,
      employees.lastName,
    ]),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    selectMembers(db)
      .where(where)
      .orderBy(asc(users.displayName), asc(users.email))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: count() })
      .from(companyMemberships)
      .innerJoin(users, eq(users.id, companyMemberships.userId))
      .leftJoin(employees, eq(employees.id, companyMemberships.employeeId))
      .where(where),
  ]);
  const roleMap = await rolesByMembership(
    db,
    rows.map((r) => r.membershipId),
  );
  return toPage(
    rows.map((r) => toDto(r, roleMap.get(r.membershipId) ?? [])),
    total?.n ?? 0,
    query,
  );
}

export async function getUser(
  db: Database | Transaction,
  ctx: OperationContext,
  userId: string,
): Promise<UserDetailDto> {
  const [row] = await selectMembers(db).where(memberOf(ctx, userId));
  if (!row) throw notFound("Usuario");
  const roleList = (await rolesByMembership(db, [row.membershipId])).get(row.membershipId) ?? [];
  const perms = roleList.length
    ? await db
        .selectDistinct({ code: permissions.code })
        .from(rolePermissions)
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(
          inArray(
            rolePermissions.roleId,
            roleList.map((r) => r.id),
          ),
        )
        .orderBy(asc(permissions.code))
    : [];
  return { ...toDto(row, roleList), permissions: perms.map((p) => p.code) };
}

/** Verifica que todos los roles pertenezcan a la empresa; devuelve sus códigos. */
async function assertRoles(tx: Transaction, ctx: OperationContext, roleIds: string[]) {
  const unique = [...new Set(roleIds)];
  const found = await tx
    .select({ id: roles.id, code: roles.code })
    .from(roles)
    .where(and(eq(roles.companyId, ctx.companyId), inArray(roles.id, unique)));
  if (found.length !== unique.length) throw invalidReference("roleIds", "Rol inexistente");
  return { ids: unique, codes: found.map((r) => r.code).sort() };
}

/** El empleado debe ser de la empresa, estar activo y no tener otro acceso. */
async function assertLinkableEmployee(tx: Transaction, ctx: OperationContext, employeeId: string) {
  const [employee] = await tx
    .select({ id: employees.id, status: employees.status, code: employees.employeeCode })
    .from(employees)
    .where(and(eq(employees.companyId, ctx.companyId), eq(employees.id, employeeId)));
  if (!employee) throw invalidReference("employeeId", "Empleado inexistente");
  if (employee.status !== "ACTIVE")
    throw invalidReference("employeeId", "El empleado está dado de baja");
  return employee;
}

const employeeAlreadyLinked = () =>
  new AppError(409, "EMPLOYEE_ALREADY_LINKED", "El empleado ya tiene acceso al sistema", [
    { path: "employeeId", message: "Ya tiene acceso" },
  ]);

export async function createUser(
  db: Database,
  ctx: OperationContext,
  input: z.infer<typeof createUserSchema>,
) {
  // El hash se calcula fuera de la transacción (es CPU intensivo).
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const roleSet = await assertRoles(tx, ctx, input.roleIds);
    const employee = input.employeeId
      ? await assertLinkableEmployee(tx, ctx, input.employeeId)
      : null;
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email}`);
    if (existing) {
      throw new AppError(409, "EMAIL_TAKEN", "Ya existe un usuario con ese email", [
        { path: "email", message: "Email en uso" },
      ]);
    }
    let displayName = input.displayName;
    if (!displayName && employee) {
      const [e] = await tx
        .select({ firstName: employees.firstName, lastName: employees.lastName })
        .from(employees)
        .where(eq(employees.id, employee.id));
      displayName = e ? `${e.firstName} ${e.lastName}` : null;
    }
    const [user] = await mapUniqueViolations(
      tx
        .insert(users)
        .values({ email: input.email, displayName: displayName ?? input.email, passwordHash })
        .returning({ id: users.id }),
      {
        users_email_uq: () =>
          new AppError(409, "EMAIL_TAKEN", "Ya existe un usuario con ese email"),
      },
    );
    if (!user) throw new Error("Alta de usuario sin fila");
    const [membership] = await mapUniqueViolations(
      tx
        .insert(companyMemberships)
        .values({ companyId: ctx.companyId, userId: user.id, employeeId: employee?.id ?? null })
        .returning({ id: companyMemberships.id }),
      { company_memberships_employee_uq: employeeAlreadyLinked },
    );
    if (!membership) throw new Error("Alta de membresía sin fila");
    await tx.insert(membershipRoles).values(
      roleSet.ids.map((roleId) => ({
        membershipId: membership.id,
        roleId,
        companyId: ctx.companyId,
        assignedByUserId: ctx.userId,
      })),
    );
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "USER_CREATED",
      entityType: "user",
      entityId: user.id,
      metadata: { email: input.email, roles: roleSet.codes, employeeCode: employee?.code ?? null },
    });
    return getUser(tx, ctx, user.id);
  });
}

export async function updateUser(
  db: Database,
  ctx: OperationContext,
  userId: string,
  input: z.infer<typeof updateUserSchema>,
) {
  return db.transaction(async (tx) => {
    const [membership] = await tx
      .select()
      .from(companyMemberships)
      .where(memberOf(ctx, userId))
      .for("update");
    if (!membership) throw notFound("Usuario");
    const [userBefore] = await tx.select().from(users).where(eq(users.id, userId));
    if (!userBefore) throw notFound("Usuario");

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (input.displayName !== undefined && input.displayName !== userBefore.displayName) {
      await tx.update(users).set({ displayName: input.displayName }).where(eq(users.id, userId));
      Object.assign(
        changes,
        diffChanges(userBefore, { displayName: input.displayName }, ["displayName"]),
      );
    }
    if (input.employeeId !== undefined && input.employeeId !== membership.employeeId) {
      if (input.employeeId) await assertLinkableEmployee(tx, ctx, input.employeeId);
      await mapUniqueViolations(
        tx
          .update(companyMemberships)
          .set({ employeeId: input.employeeId })
          .where(eq(companyMemberships.id, membership.id)),
        { company_memberships_employee_uq: employeeAlreadyLinked },
      );
      changes.employeeId = { from: membership.employeeId, to: input.employeeId };
    }
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "USER_UPDATED",
        entityType: "user",
        entityId: userId,
        metadata: { email: userBefore.email, changes },
      });
    }
    return getUser(tx, ctx, userId);
  });
}

const cannotModifySelf = (what: string) =>
  new AppError(409, "CANNOT_MODIFY_SELF", `No puede ${what} su propio usuario`);

/** Reemplaza los roles del usuario en esta empresa. Los permisos rigen desde el próximo request. */
export async function setUserRoles(
  db: Database,
  ctx: OperationContext,
  userId: string,
  roleIds: string[],
) {
  if (userId === ctx.userId) throw cannotModifySelf("cambiar los roles de");
  return db.transaction(async (tx) => {
    const [membership] = await tx
      .select()
      .from(companyMemberships)
      .where(memberOf(ctx, userId))
      .for("update");
    if (!membership) throw notFound("Usuario");
    const roleSet = await assertRoles(tx, ctx, roleIds);
    const before = await tx
      .select({ code: roles.code })
      .from(membershipRoles)
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .where(eq(membershipRoles.membershipId, membership.id));
    const fromCodes = before.map((r) => r.code).sort();
    if (JSON.stringify(fromCodes) !== JSON.stringify(roleSet.codes)) {
      await tx.delete(membershipRoles).where(eq(membershipRoles.membershipId, membership.id));
      await tx.insert(membershipRoles).values(
        roleSet.ids.map((roleId) => ({
          membershipId: membership.id,
          roleId,
          companyId: ctx.companyId,
          assignedByUserId: ctx.userId,
        })),
      );
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "USER_ROLE_CHANGED",
        entityType: "user",
        entityId: userId,
        metadata: { from: fromCodes, to: roleSet.codes },
      });
    }
    return getUser(tx, ctx, userId);
  });
}

/** Activa o desactiva el acceso a esta empresa. Desactivar cierra sus sesiones. */
export async function setUserActive(
  db: Database,
  ctx: OperationContext,
  userId: string,
  active: boolean,
) {
  if (userId === ctx.userId) throw cannotModifySelf(active ? "reactivar" : "desactivar");
  return db.transaction(async (tx) => {
    const [membership] = await tx
      .select()
      .from(companyMemberships)
      .where(memberOf(ctx, userId))
      .for("update");
    if (!membership) throw notFound("Usuario");
    const status = active ? "ACTIVE" : "DISABLED";
    if (membership.status !== status) {
      if (active && membership.employeeId) {
        const [e] = await tx
          .select({ status: employees.status })
          .from(employees)
          .where(eq(employees.id, membership.employeeId));
        if (e?.status !== "ACTIVE") {
          throw new AppError(409, "EMPLOYEE_INACTIVE", "El empleado vinculado está dado de baja");
        }
      }
      await tx
        .update(companyMemberships)
        .set({ status })
        .where(eq(companyMemberships.id, membership.id));
      if (!active) await revokeSessions(tx, userId, ctx.companyId);
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: active ? "USER_REACTIVATED" : "USER_DEACTIVATED",
        entityType: "user",
        entityId: userId,
        metadata: {},
      });
    }
    return getUser(tx, ctx, userId);
  });
}
