import { allocateCode, customers, type Database, type Transaction } from "@bakery/database";
import type { CustomerDto, ListQuery, Page } from "@bakery/shared";
import { type createCustomerSchema, type updateCustomerSchema } from "@bakery/shared";
import { and, asc, count, eq } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { codeTaken, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { activeCondition, pageWindow, searchCondition, toPage } from "../../lib/listing.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";

type Row = typeof customers.$inferSelect;
type CreateInput = z.infer<typeof createCustomerSchema>;
type UpdateInput = z.infer<typeof updateCustomerSchema>;

function toDto(r: Row): CustomerDto {
  return {
    id: r.id,
    code: r.internalCode,
    type: r.type,
    legalName: r.legalName,
    tradeName: r.tradeName,
    taxId: r.taxId,
    phone: r.phone,
    email: r.email,
    address: r.address,
    city: r.city,
    province: r.province,
    postalCode: r.postalCode,
    commercialCondition: r.commercialCondition,
    creditLimit: r.creditLimit,
    active: r.active,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Todas las consultas se restringen a la empresa de la sesión. */
const owned = (ctx: OperationContext, id: string) =>
  and(eq(customers.companyId, ctx.companyId), eq(customers.id, id));

export async function listCustomers(
  db: Database,
  ctx: OperationContext,
  query: ListQuery,
): Promise<Page<CustomerDto>> {
  const where = and(
    eq(customers.companyId, ctx.companyId),
    activeCondition(customers.active, query.status),
    searchCondition(query.search, [
      customers.internalCode,
      customers.legalName,
      customers.tradeName,
      customers.taxId,
    ]),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(customers)
      .where(where)
      .orderBy(asc(customers.legalName), asc(customers.internalCode))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(customers).where(where),
  ]);
  return toPage(rows.map(toDto), total?.n ?? 0, query);
}

export async function getCustomer(db: Database, ctx: OperationContext, id: string) {
  const [row] = await db.select().from(customers).where(owned(ctx, id));
  if (!row) throw notFound("Cliente");
  return toDto(row);
}

async function isCodeTaken(tx: Transaction, ctx: OperationContext, code: string) {
  const rows = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.internalCode, code)))
    .limit(1);
  return rows.length > 0;
}

export async function createCustomer(db: Database, ctx: OperationContext, input: CreateInput) {
  return db.transaction(async (tx) => {
    const { code: manualCode, ...fields } = input;
    const code =
      manualCode ??
      (await allocateCode(tx, ctx.companyId, "CUSTOMER", (c) => isCodeTaken(tx, ctx, c)));
    const [row] = await mapUniqueViolations(
      tx
        .insert(customers)
        .values({ ...fields, companyId: ctx.companyId, internalCode: code })
        .returning(),
      { customers_company_code_uq: () => codeTaken(code) },
    );
    if (!row) throw new Error("Alta de cliente sin fila");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "CUSTOMER_CREATED",
      entityType: "customer",
      entityId: row.id,
      metadata: { code: row.internalCode, legalName: row.legalName },
    });
    return toDto(row);
  });
}

export async function updateCustomer(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: UpdateInput,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(customers).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Cliente");
    const [after] = await tx.update(customers).set(input).where(owned(ctx, id)).returning();
    if (!after) throw notFound("Cliente");
    const changes = diffChanges(before, after, Object.keys(input));
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "CUSTOMER_UPDATED",
        entityType: "customer",
        entityId: id,
        metadata: { code: after.internalCode, changes },
      });
    }
    return toDto(after);
  });
}

/** Desactiva o reactiva. Nunca borra: el cliente conserva su historia y referencias. */
export async function setCustomerActive(
  db: Database,
  ctx: OperationContext,
  id: string,
  active: boolean,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(customers).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Cliente");
    if (before.active === active) return toDto(before);
    const [after] = await tx.update(customers).set({ active }).where(owned(ctx, id)).returning();
    if (!after) throw notFound("Cliente");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: active ? "CUSTOMER_REACTIVATED" : "CUSTOMER_DEACTIVATED",
      entityType: "customer",
      entityId: id,
      metadata: { code: after.internalCode },
    });
    return toDto(after);
  });
}
