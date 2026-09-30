import { allocateCode, suppliers, type Database, type Transaction } from "@bakery/database";
import type { SupplierDto, ListQuery, Page } from "@bakery/shared";
import { type createSupplierSchema, type updateSupplierSchema } from "@bakery/shared";
import { and, asc, count, eq } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { codeTaken, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { activeCondition, pageWindow, searchCondition, toPage } from "../../lib/listing.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";

type Row = typeof suppliers.$inferSelect;
type CreateInput = z.infer<typeof createSupplierSchema>;
type UpdateInput = z.infer<typeof updateSupplierSchema>;

function toDto(r: Row): SupplierDto {
  return {
    id: r.id,
    code: r.internalCode,
    legalName: r.legalName,
    tradeName: r.tradeName,
    taxId: r.taxId,
    contactName: r.contactName,
    phone: r.phone,
    email: r.email,
    address: r.address,
    city: r.city,
    province: r.province,
    paymentTerms: r.paymentTerms,
    active: r.active,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Todas las consultas se restringen a la empresa de la sesión. */
const owned = (ctx: OperationContext, id: string) =>
  and(eq(suppliers.companyId, ctx.companyId), eq(suppliers.id, id));

export async function listSuppliers(
  db: Database,
  ctx: OperationContext,
  query: ListQuery,
): Promise<Page<SupplierDto>> {
  const where = and(
    eq(suppliers.companyId, ctx.companyId),
    activeCondition(suppliers.active, query.status),
    searchCondition(query.search, [
      suppliers.internalCode,
      suppliers.legalName,
      suppliers.tradeName,
      suppliers.taxId,
      suppliers.contactName,
    ]),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(suppliers)
      .where(where)
      .orderBy(asc(suppliers.legalName), asc(suppliers.internalCode))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(suppliers).where(where),
  ]);
  return toPage(rows.map(toDto), total?.n ?? 0, query);
}

export async function getSupplier(db: Database, ctx: OperationContext, id: string) {
  const [row] = await db.select().from(suppliers).where(owned(ctx, id));
  if (!row) throw notFound("Proveedor");
  return toDto(row);
}

async function isCodeTaken(tx: Transaction, ctx: OperationContext, code: string) {
  const rows = await tx
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(and(eq(suppliers.companyId, ctx.companyId), eq(suppliers.internalCode, code)))
    .limit(1);
  return rows.length > 0;
}

export async function createSupplier(db: Database, ctx: OperationContext, input: CreateInput) {
  return db.transaction(async (tx) => {
    const { code: manualCode, ...fields } = input;
    const code =
      manualCode ??
      (await allocateCode(tx, ctx.companyId, "SUPPLIER", (c) => isCodeTaken(tx, ctx, c)));
    const [row] = await mapUniqueViolations(
      tx
        .insert(suppliers)
        .values({ ...fields, companyId: ctx.companyId, internalCode: code })
        .returning(),
      { suppliers_company_code_uq: () => codeTaken(code) },
    );
    if (!row) throw new Error("Alta de proveedor sin fila");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "SUPPLIER_CREATED",
      entityType: "supplier",
      entityId: row.id,
      metadata: { code: row.internalCode, legalName: row.legalName },
    });
    return toDto(row);
  });
}

export async function updateSupplier(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: UpdateInput,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(suppliers).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Proveedor");
    const [after] = await tx.update(suppliers).set(input).where(owned(ctx, id)).returning();
    if (!after) throw notFound("Proveedor");
    const changes = diffChanges(before, after, Object.keys(input));
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "SUPPLIER_UPDATED",
        entityType: "supplier",
        entityId: id,
        metadata: { code: after.internalCode, changes },
      });
    }
    return toDto(after);
  });
}

/** Desactiva o reactiva. Nunca borra: el proveedor conserva su historia y referencias. */
export async function setSupplierActive(
  db: Database,
  ctx: OperationContext,
  id: string,
  active: boolean,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(suppliers).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Proveedor");
    if (before.active === active) return toDto(before);
    const [after] = await tx.update(suppliers).set({ active }).where(owned(ctx, id)).returning();
    if (!after) throw notFound("Proveedor");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: active ? "SUPPLIER_REACTIVATED" : "SUPPLIER_DEACTIVATED",
      entityType: "supplier",
      entityId: id,
      metadata: { code: after.internalCode },
    });
    return toDto(after);
  });
}
