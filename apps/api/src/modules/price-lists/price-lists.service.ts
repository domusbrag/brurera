import { normalizeCode } from "@bakery/domain";
import {
  allocateCode,
  customers,
  priceListItems,
  priceLists,
  products,
  unitsOfMeasure,
  type Database,
  type Transaction,
} from "@bakery/database";
import {
  PERMISSIONS,
  hasPermissions,
  type Page,
  type PriceListDetailDto,
  type PriceListDto,
  type PriceListInput,
  type PriceListItemInput,
  type ResolvedPriceDto,
  type UpdatePriceListInput,
  type priceListQuerySchema,
} from "@bakery/shared";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { codeTaken, invalidReference, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { activeCondition, pageWindow, searchCondition, toPage } from "../../lib/listing.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";
import { money2, resolvePrices } from "./pricing.js";
import { qualified } from "../../lib/sql.js";

/*
 * Listas de precios (Fase 5B). Una lista tiene precios por producto (por unidad
 * de venta). Una sola lista default por empresa; cada cliente puede tener la
 * suya. Cambiar una lista no cambia precios ya acordados (pedidos AGREED) ni
 * ventas confirmadas: esos precios quedaron congelados.
 */

type Db = Database | Transaction;
type Row = typeof priceLists.$inferSelect;

const owned = (ctx: OperationContext, id: string) =>
  and(eq(priceLists.companyId, ctx.companyId), eq(priceLists.id, id));

const itemCount = sql<number>`(select count(*)::int from price_list_items i where i.company_id = ${qualified(priceLists.companyId)} and i.price_list_id = ${qualified(priceLists.id)} and i.active)`;
const customerCount = sql<number>`(select count(*)::int from customers c where c.company_id = ${qualified(priceLists.companyId)} and c.default_price_list_id = ${qualified(priceLists.id)})`;

function toDto(r: Row, counts: { itemCount: number; customerCount: number }): PriceListDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    active: r.active,
    isDefault: r.isDefault,
    notes: r.notes,
    itemCount: counts.itemCount,
    customerCount: counts.customerCount,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listPriceLists(
  db: Database,
  ctx: OperationContext,
  query: z.infer<typeof priceListQuerySchema>,
): Promise<Page<PriceListDto>> {
  const where = and(
    eq(priceLists.companyId, ctx.companyId),
    activeCondition(priceLists.active, query.status),
    searchCondition(query.search, [priceLists.code, priceLists.name]),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select({ list: priceLists, itemCount, customerCount })
      .from(priceLists)
      .where(where)
      .orderBy(sql`${priceLists.isDefault} desc`, asc(priceLists.name))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(priceLists).where(where),
  ]);
  return toPage(
    rows.map((r) => toDto(r.list, r)),
    total?.n ?? 0,
    query,
  );
}

export async function getPriceList(
  db: Db,
  ctx: OperationContext,
  id: string,
  permissions: Iterable<string>,
): Promise<PriceListDetailDto> {
  const [row] = await db
    .select({ list: priceLists, itemCount, customerCount })
    .from(priceLists)
    .where(owned(ctx, id));
  if (!row) throw notFound("Lista de precios");
  // Todos los productos activos (o con precio en la lista): la pantalla edita sobre esta grilla.
  const items = await db
    .select({
      product: {
        id: products.id,
        code: products.internalCode,
        name: products.name,
        active: products.active,
      },
      saleUnit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
      productPrice: products.salePrice,
      unitPrice: priceListItems.unitPrice,
      active: priceListItems.active,
      updatedAt: priceListItems.updatedAt,
    })
    .from(products)
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.saleUnitId))
    .leftJoin(
      priceListItems,
      and(
        eq(priceListItems.companyId, products.companyId),
        eq(priceListItems.productId, products.id),
        eq(priceListItems.priceListId, id),
      ),
    )
    .where(
      and(
        eq(products.companyId, ctx.companyId),
        sql`(${products.active} or ${priceListItems.id} is not null)`,
      ),
    )
    .orderBy(asc(products.name), asc(products.internalCode));
  return {
    ...toDto(row.list, row),
    items: items.map((i) => ({
      product: i.product,
      saleUnit: i.saleUnit,
      unitPrice: i.unitPrice,
      active: i.active ?? false,
      productPrice: i.productPrice,
      updatedAt: i.updatedAt?.toISOString() ?? null,
    })),
    canManage: hasPermissions(permissions, [PERMISSIONS.PRICE_LISTS_MANAGE]),
  };
}

async function isCodeTaken(tx: Transaction, ctx: OperationContext, code: string) {
  const rows = await tx
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(and(eq(priceLists.companyId, ctx.companyId), eq(priceLists.code, code)))
    .limit(1);
  return rows.length > 0;
}

/** Deja una sola lista default: la anterior deja de serlo (bloqueada). */
async function clearDefault(tx: Transaction, ctx: OperationContext, exceptId: string | null) {
  const current = await tx
    .select({ id: priceLists.id, code: priceLists.code })
    .from(priceLists)
    .where(
      and(
        eq(priceLists.companyId, ctx.companyId),
        eq(priceLists.isDefault, true),
        exceptId ? ne(priceLists.id, exceptId) : undefined,
      ),
    )
    .for("update");
  for (const c of current) {
    await tx
      .update(priceLists)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(priceLists.id, c.id));
  }
}

const listUniques = (code: string) => ({
  price_lists_company_code_uq: () => codeTaken(code),
});

export async function createPriceList(
  db: Database,
  ctx: OperationContext,
  input: PriceListInput,
  permissions: Iterable<string>,
) {
  const id = await db.transaction(async (tx) => {
    const code = input.code
      ? normalizeCode(input.code)
      : await allocateCode(tx, ctx.companyId, "PRICE_LIST", (c) => isCodeTaken(tx, ctx, c));
    if (input.isDefault && !input.active) {
      throw invalidReference("active", "La lista general tiene que estar activa");
    }
    if (input.isDefault) await clearDefault(tx, ctx, null);
    const [row] = await mapUniqueViolations(
      tx
        .insert(priceLists)
        .values({
          companyId: ctx.companyId,
          code,
          name: input.name,
          isDefault: input.isDefault,
          active: input.active,
          notes: input.notes,
        })
        .returning(),
      listUniques(code),
    );
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRICE_LIST_CREATED",
      entityType: "price_list",
      entityId: row!.id,
      metadata: { code, name: input.name, isDefault: input.isDefault },
    });
    return row!.id;
  });
  return getPriceList(db, ctx, id, permissions);
}

export async function updatePriceList(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: UpdatePriceListInput,
  permissions: Iterable<string>,
) {
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(priceLists).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Lista de precios");
    const next = {
      ...(input.code !== undefined && input.code !== null ? { code: normalizeCode(input.code) } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
    };
    const isDefault = next.isDefault ?? before.isDefault;
    const active = next.active ?? before.active;
    if (isDefault && !active) {
      throw invalidReference("active", "La lista general tiene que estar activa");
    }
    if (next.isDefault && !before.isDefault) await clearDefault(tx, ctx, id);
    const [after] = await mapUniqueViolations(
      tx
        .update(priceLists)
        .set({ ...next, updatedAt: new Date() })
        .where(owned(ctx, id))
        .returning(),
      listUniques(next.code ?? before.code),
    );
    const changes = diffChanges(before, after!, Object.keys(next));
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "PRICE_LIST_UPDATED",
        entityType: "price_list",
        entityId: id,
        metadata: { code: after!.code, changes },
      });
    }
  });
  return getPriceList(db, ctx, id, permissions);
}

/** Fija (o quita, active=false) el precio de un producto en la lista. */
export async function setPriceListItem(
  db: Database,
  ctx: OperationContext,
  id: string,
  productId: string,
  input: PriceListItemInput,
  permissions: Iterable<string>,
) {
  await db.transaction(async (tx) => {
    const [list] = await tx.select().from(priceLists).where(owned(ctx, id)).for("update");
    if (!list) throw notFound("Lista de precios");
    const [product] = await tx
      .select({ id: products.id, name: products.name, code: products.internalCode })
      .from(products)
      .where(and(eq(products.companyId, ctx.companyId), eq(products.id, productId)));
    if (!product) throw invalidReference("productId", "Producto inexistente");
    const [before] = await tx
      .select()
      .from(priceListItems)
      .where(
        and(
          eq(priceListItems.companyId, ctx.companyId),
          eq(priceListItems.priceListId, id),
          eq(priceListItems.productId, productId),
        ),
      )
      .for("update");
    const unitPrice = money2(input.unitPrice);
    if (before && before.unitPrice === unitPrice && before.active === input.active) return;
    if (before) {
      await tx
        .update(priceListItems)
        .set({ unitPrice, active: input.active, updatedByUserId: ctx.userId, updatedAt: new Date() })
        .where(eq(priceListItems.id, before.id));
    } else {
      await tx.insert(priceListItems).values({
        companyId: ctx.companyId,
        priceListId: id,
        productId,
        unitPrice,
        active: input.active,
        updatedByUserId: ctx.userId,
      });
    }
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRICE_LIST_ITEM_CHANGED",
      entityType: "price_list",
      entityId: id,
      metadata: {
        code: list.code,
        product: product.name,
        productCode: product.code,
        changes: {
          unitPrice: { from: before?.unitPrice ?? null, to: unitPrice },
          ...(before?.active !== input.active
            ? { active: { from: before?.active ?? null, to: input.active } }
            : {}),
        },
      },
    });
  });
  return getPriceList(db, ctx, id, permissions);
}

/** Precio vigente de productos para un cliente (formularios de pedido y venta). */
export async function resolveForCustomer(
  db: Database,
  ctx: OperationContext,
  customerId: string | null,
  productIds: readonly string[],
): Promise<ResolvedPriceDto[]> {
  if (customerId) {
    const [c] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)));
    if (!c) throw invalidReference("customerId", "Cliente inexistente");
  }
  const prices = await resolvePrices(db, ctx, customerId, productIds);
  return [...prices.entries()].map(([productId, p]) => ({ productId, ...p }));
}
