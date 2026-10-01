import { categories, type Database } from "@bakery/database";
import type { CategoryDto, ListQuery, Page } from "@bakery/shared";
import {
  type CATEGORY_TYPES,
  type createCategorySchema,
  type updateCategorySchema,
} from "@bakery/shared";
import { and, asc, count, eq } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { activeCondition, pageWindow, searchCondition, toPage } from "../../lib/listing.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";

type Row = typeof categories.$inferSelect;
type CategoryType = (typeof CATEGORY_TYPES)[number];

function toDto(r: Row): CategoryDto {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    description: r.description,
    sortOrder: r.sortOrder,
    active: r.active,
  };
}

const owned = (ctx: OperationContext, id: string) =>
  and(eq(categories.companyId, ctx.companyId), eq(categories.id, id));

const nameTaken = () =>
  new AppError(409, "NAME_TAKEN", "Ya existe una categoría con ese nombre", [
    { path: "name", message: "Nombre en uso" },
  ]);

export async function listCategories(
  db: Database,
  ctx: OperationContext,
  query: ListQuery & { type?: CategoryType },
): Promise<Page<CategoryDto>> {
  const where = and(
    eq(categories.companyId, ctx.companyId),
    query.type ? eq(categories.type, query.type) : undefined,
    activeCondition(categories.active, query.status),
    searchCondition(query.search, [categories.name]),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(categories)
      .where(where)
      .orderBy(asc(categories.type), asc(categories.sortOrder), asc(categories.name))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(categories).where(where),
  ]);
  return toPage(rows.map(toDto), total?.n ?? 0, query);
}

export async function getCategory(db: Database, ctx: OperationContext, id: string) {
  const [row] = await db.select().from(categories).where(owned(ctx, id));
  if (!row) throw notFound("Categoría");
  return toDto(row);
}

export async function createCategory(
  db: Database,
  ctx: OperationContext,
  input: z.infer<typeof createCategorySchema>,
) {
  return db.transaction(async (tx) => {
    const [row] = await mapUniqueViolations(
      tx
        .insert(categories)
        .values({ ...input, companyId: ctx.companyId })
        .returning(),
      { categories_company_type_name_uq: nameTaken },
    );
    if (!row) throw new Error("Alta de categoría sin fila");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "CATEGORY_CREATED",
      entityType: "category",
      entityId: row.id,
      metadata: { type: row.type, name: row.name },
    });
    return toDto(row);
  });
}

/** El tipo no se edita: una categoría de materias primas no se vuelve de productos. */
export async function updateCategory(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: z.infer<typeof updateCategorySchema>,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(categories).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Categoría");
    const [after] = await mapUniqueViolations(
      tx.update(categories).set(input).where(owned(ctx, id)).returning(),
      { categories_company_type_name_uq: nameTaken },
    );
    if (!after) throw notFound("Categoría");
    const changes = diffChanges(before, after, Object.keys(input));
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "CATEGORY_UPDATED",
        entityType: "category",
        entityId: id,
        metadata: { name: after.name, changes },
      });
    }
    return toDto(after);
  });
}
