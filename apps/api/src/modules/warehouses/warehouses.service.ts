import { allocateCode, warehouses, type Database, type Transaction } from "@bakery/database";
import type { ListQuery, Page, WarehouseDto } from "@bakery/shared";
import { type createWarehouseSchema, type updateWarehouseSchema } from "@bakery/shared";
import { and, asc, count, eq } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { codeTaken, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { activeCondition, pageWindow, searchCondition, toPage } from "../../lib/listing.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";

type Row = typeof warehouses.$inferSelect;

function toDto(r: Row): WarehouseDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    address: r.address,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const owned = (ctx: OperationContext, id: string) =>
  and(eq(warehouses.companyId, ctx.companyId), eq(warehouses.id, id));

export async function listWarehouses(
  db: Database,
  ctx: OperationContext,
  query: ListQuery,
): Promise<Page<WarehouseDto>> {
  const where = and(
    eq(warehouses.companyId, ctx.companyId),
    activeCondition(warehouses.active, query.status),
    searchCondition(query.search, [warehouses.code, warehouses.name]),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(warehouses)
      .where(where)
      .orderBy(asc(warehouses.code))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(warehouses).where(where),
  ]);
  return toPage(rows.map(toDto), total?.n ?? 0, query);
}

export async function getWarehouse(db: Database, ctx: OperationContext, id: string) {
  const [row] = await db.select().from(warehouses).where(owned(ctx, id));
  if (!row) throw notFound("Depósito");
  return toDto(row);
}

async function isCodeTaken(tx: Transaction, ctx: OperationContext, code: string) {
  const rows = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.companyId, ctx.companyId), eq(warehouses.code, code)))
    .limit(1);
  return rows.length > 0;
}

export async function createWarehouse(
  db: Database,
  ctx: OperationContext,
  input: z.infer<typeof createWarehouseSchema>,
) {
  return db.transaction(async (tx) => {
    const { code: manualCode, ...fields } = input;
    const code =
      manualCode ??
      (await allocateCode(tx, ctx.companyId, "WAREHOUSE", (c) => isCodeTaken(tx, ctx, c)));
    const [row] = await mapUniqueViolations(
      tx
        .insert(warehouses)
        .values({ ...fields, companyId: ctx.companyId, code })
        .returning(),
      { warehouses_company_code_uq: () => codeTaken(code) },
    );
    if (!row) throw new Error("Alta de depósito sin fila");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "WAREHOUSE_CREATED",
      entityType: "warehouse",
      entityId: row.id,
      metadata: { code: row.code, name: row.name },
    });
    return toDto(row);
  });
}

export async function updateWarehouse(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: z.infer<typeof updateWarehouseSchema>,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(warehouses).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Depósito");
    const [after] = await tx.update(warehouses).set(input).where(owned(ctx, id)).returning();
    if (!after) throw notFound("Depósito");
    const changes = diffChanges(before, after, Object.keys(input));
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "WAREHOUSE_UPDATED",
        entityType: "warehouse",
        entityId: id,
        metadata: { code: after.code, changes },
      });
    }
    return toDto(after);
  });
}

export async function setWarehouseActive(
  db: Database,
  ctx: OperationContext,
  id: string,
  active: boolean,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(warehouses).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Depósito");
    if (before.active === active) return toDto(before);
    const [after] = await tx.update(warehouses).set({ active }).where(owned(ctx, id)).returning();
    if (!after) throw notFound("Depósito");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: active ? "WAREHOUSE_REACTIVATED" : "WAREHOUSE_DEACTIVATED",
      entityType: "warehouse",
      entityId: id,
      metadata: { code: after.code },
    });
    return toDto(after);
  });
}
