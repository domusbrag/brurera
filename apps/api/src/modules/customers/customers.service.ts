import {
  allocateCode,
  customers,
  priceLists,
  type Database,
  type Transaction,
} from "@bakery/database";
import type { CustomerDto, ListQuery, Page } from "@bakery/shared";
import { type createCustomerSchema, type updateCustomerSchema } from "@bakery/shared";
import { and, asc, count, eq } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { codeTaken, invalidReference, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { activeCondition, pageWindow, searchCondition, toPage } from "../../lib/listing.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";

type Row = typeof customers.$inferSelect;
type ListRef = { id: string; code: string; name: string } | null;
type CreateInput = z.infer<typeof createCustomerSchema>;
type UpdateInput = z.infer<typeof updateCustomerSchema>;

function toDto(r: Row, priceList: ListRef = null): CustomerDto {
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
    defaultPriceList: priceList,
    walkIn: r.isWalkIn,
    active: r.active,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const listRef = { id: priceLists.id, code: priceLists.code, name: priceLists.name };
const listJoin = and(
  eq(priceLists.companyId, customers.companyId),
  eq(priceLists.id, customers.defaultPriceListId),
);

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
      .select({ c: customers, list: listRef })
      .from(customers)
      .leftJoin(priceLists, listJoin)
      .where(where)
      .orderBy(asc(customers.legalName), asc(customers.internalCode))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(customers).where(where),
  ]);
  return toPage(
    rows.map((r) => toDto(r.c, r.list)),
    total?.n ?? 0,
    query,
  );
}

export async function getCustomer(db: Database | Transaction, ctx: OperationContext, id: string) {
  const [row] = await db
    .select({ c: customers, list: listRef })
    .from(customers)
    .leftJoin(priceLists, listJoin)
    .where(owned(ctx, id));
  if (!row) throw notFound("Cliente");
  return toDto(row.c, row.list);
}

/** La lista asignada tiene que ser de la empresa y estar activa. */
async function checkPriceList(
  tx: Transaction,
  ctx: OperationContext,
  id: string | null | undefined,
) {
  if (!id) return;
  const [list] = await tx
    .select({ active: priceLists.active })
    .from(priceLists)
    .where(and(eq(priceLists.companyId, ctx.companyId), eq(priceLists.id, id)));
  if (!list?.active) {
    throw invalidReference("defaultPriceListId", "La lista de precios no existe o está inactiva");
  }
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
    await checkPriceList(tx, ctx, fields.defaultPriceListId);
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
    return getCustomer(tx, ctx, row.id);
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
    await checkPriceList(tx, ctx, input.defaultPriceListId);
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
    return getCustomer(tx, ctx, id);
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
    if (before.isWalkIn && !active) {
      throw new AppError(
        409,
        "WALK_IN_CUSTOMER",
        "Consumidor Final no se puede desactivar: es el cliente de las ventas de mostrador",
      );
    }
    if (before.active === active) return getCustomer(tx, ctx, id);
    const [after] = await tx.update(customers).set({ active }).where(owned(ctx, id)).returning();
    if (!after) throw notFound("Cliente");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: active ? "CUSTOMER_REACTIVATED" : "CUSTOMER_DEACTIVATED",
      entityType: "customer",
      entityId: id,
      metadata: { code: after.internalCode },
    });
    return getCustomer(tx, ctx, id);
  });
}
