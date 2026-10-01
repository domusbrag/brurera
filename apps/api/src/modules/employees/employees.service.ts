import {
  allocateCode,
  companyMemberships,
  employees,
  sessions,
  users,
  type Database,
  type Transaction,
} from "@bakery/database";
import type { EmployeeDto, ListQuery, Page } from "@bakery/shared";
import { type createEmployeeSchema, type updateEmployeeSchema } from "@bakery/shared";
import { and, asc, count, eq, isNull, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, todayIn, type OperationContext } from "../../lib/context.js";
import { codeTaken, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { pageWindow, searchCondition, toPage } from "../../lib/listing.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";

type CreateInput = z.infer<typeof createEmployeeSchema>;
type UpdateInput = z.infer<typeof updateEmployeeSchema>;

/** Empleado + su acceso al sistema en esta empresa (si lo tiene). */
function selectEmployees(db: Database | Transaction) {
  return db
    .select({
      e: employees,
      access: {
        userId: users.id,
        email: users.email,
        status: companyMemberships.status,
      },
    })
    .from(employees)
    .leftJoin(
      companyMemberships,
      and(
        eq(companyMemberships.employeeId, employees.id),
        eq(companyMemberships.companyId, employees.companyId),
      ),
    )
    .leftJoin(users, eq(users.id, companyMemberships.userId));
}

type SelectedRow = Awaited<ReturnType<ReturnType<typeof selectEmployees>["execute"]>>[number];

function toDto({ e, access }: SelectedRow): EmployeeDto {
  return {
    id: e.id,
    code: e.employeeCode,
    firstName: e.firstName,
    lastName: e.lastName,
    fullName: `${e.firstName} ${e.lastName}`,
    documentType: e.documentType,
    documentNumber: e.documentNumber,
    phone: e.phone,
    email: e.email,
    address: e.address,
    city: e.city,
    position: e.position,
    hireDate: e.hireDate,
    terminationDate: e.terminationDate,
    status: e.status,
    notes: e.notes,
    access:
      access?.userId && access.email && access.status ? (access as EmployeeDto["access"]) : null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

const owned = (ctx: OperationContext, id: string): SQL | undefined =>
  and(eq(employees.companyId, ctx.companyId), eq(employees.id, id));

const documentTaken = () =>
  new AppError(409, "DOCUMENT_TAKEN", "Ya existe un empleado con ese documento", [
    { path: "documentNumber", message: "Documento ya registrado" },
  ]);

export async function listEmployees(
  db: Database,
  ctx: OperationContext,
  query: ListQuery,
): Promise<Page<EmployeeDto>> {
  const where = and(
    eq(employees.companyId, ctx.companyId),
    query.status === "all"
      ? undefined
      : eq(employees.status, query.status === "active" ? "ACTIVE" : "INACTIVE"),
    searchCondition(query.search, [
      employees.employeeCode,
      employees.firstName,
      employees.lastName,
      employees.documentNumber,
    ]),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    selectEmployees(db)
      .where(where)
      .orderBy(asc(employees.lastName), asc(employees.firstName), asc(employees.employeeCode))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(employees).where(where),
  ]);
  return toPage(rows.map(toDto), total?.n ?? 0, query);
}

export async function getEmployee(db: Database | Transaction, ctx: OperationContext, id: string) {
  const [row] = await selectEmployees(db).where(owned(ctx, id));
  if (!row) throw notFound("Empleado");
  return toDto(row);
}

async function isCodeTaken(tx: Transaction, ctx: OperationContext, code: string) {
  const rows = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.companyId, ctx.companyId), eq(employees.employeeCode, code)))
    .limit(1);
  return rows.length > 0;
}

export async function createEmployee(db: Database, ctx: OperationContext, input: CreateInput) {
  return db.transaction(async (tx) => {
    const { code: manualCode, ...fields } = input;
    const code =
      manualCode ??
      (await allocateCode(tx, ctx.companyId, "EMPLOYEE", (c) => isCodeTaken(tx, ctx, c)));
    const [row] = await mapUniqueViolations(
      tx
        .insert(employees)
        .values({ ...fields, companyId: ctx.companyId, employeeCode: code })
        .returning(),
      {
        employees_company_code_uq: () => codeTaken(code),
        employees_company_document_uq: documentTaken,
      },
    );
    if (!row) throw new Error("Alta de empleado sin fila");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "EMPLOYEE_CREATED",
      entityType: "employee",
      entityId: row.id,
      metadata: { code: row.employeeCode, name: `${row.firstName} ${row.lastName}` },
    });
    return getEmployee(tx, ctx, row.id);
  });
}

export async function updateEmployee(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: UpdateInput,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(employees).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Empleado");
    const [after] = await mapUniqueViolations(
      tx.update(employees).set(input).where(owned(ctx, id)).returning(),
      { employees_company_document_uq: documentTaken },
    );
    if (!after) throw notFound("Empleado");
    const changes = diffChanges(before, after, Object.keys(input));
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "EMPLOYEE_UPDATED",
        entityType: "employee",
        entityId: id,
        metadata: { code: after.employeeCode, changes },
      });
    }
    return getEmployee(tx, ctx, id);
  });
}

/** Revoca las sesiones abiertas de un usuario en una empresa. */
export async function revokeSessions(tx: Transaction, userId: string, companyId: string) {
  await tx
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.companyId, companyId),
        isNull(sessions.revokedAt),
      ),
    );
}

/**
 * Baja de un empleado: pasa a INACTIVE con fecha de egreso (hoy en la zona de la
 * empresa si no se indica). Si tenía acceso al sistema, el acceso se desactiva y
 * sus sesiones se cierran en la misma transacción. No se borra nada.
 */
export async function deactivateEmployee(
  db: Database,
  ctx: OperationContext,
  id: string,
  terminationDate: string | null,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(employees).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Empleado");
    if (before.status === "INACTIVE") return getEmployee(tx, ctx, id);

    const date = terminationDate ?? todayIn(ctx.timezone);
    if (before.hireDate && date < before.hireDate) {
      throw new AppError(400, "VALIDATION_ERROR", "La fecha de egreso es anterior al ingreso", [
        { path: "terminationDate", message: "Anterior a la fecha de ingreso" },
      ]);
    }
    await tx
      .update(employees)
      .set({ status: "INACTIVE", terminationDate: date })
      .where(owned(ctx, id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "EMPLOYEE_DEACTIVATED",
      entityType: "employee",
      entityId: id,
      metadata: { code: before.employeeCode, terminationDate: date },
    });

    const [membership] = await tx
      .select({
        id: companyMemberships.id,
        userId: companyMemberships.userId,
        status: companyMemberships.status,
      })
      .from(companyMemberships)
      .where(
        and(eq(companyMemberships.companyId, ctx.companyId), eq(companyMemberships.employeeId, id)),
      )
      .for("update");
    if (membership?.status === "ACTIVE") {
      await tx
        .update(companyMemberships)
        .set({ status: "DISABLED" })
        .where(eq(companyMemberships.id, membership.id));
      await revokeSessions(tx, membership.userId, ctx.companyId);
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "USER_DEACTIVATED",
        entityType: "user",
        entityId: membership.userId,
        metadata: { reason: "EMPLOYEE_DEACTIVATED", employeeCode: before.employeeCode },
      });
    }
    return getEmployee(tx, ctx, id);
  });
}

/** Reingreso: vuelve a ACTIVE. El acceso al sistema NO se reactiva solo. */
export async function reactivateEmployee(db: Database, ctx: OperationContext, id: string) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(employees).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Empleado");
    if (before.status === "ACTIVE") return getEmployee(tx, ctx, id);
    await tx
      .update(employees)
      .set({ status: "ACTIVE", terminationDate: null })
      .where(owned(ctx, id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "EMPLOYEE_REACTIVATED",
      entityType: "employee",
      entityId: id,
      metadata: { code: before.employeeCode, previousTerminationDate: before.terminationDate },
    });
    return getEmployee(tx, ctx, id);
  });
}
