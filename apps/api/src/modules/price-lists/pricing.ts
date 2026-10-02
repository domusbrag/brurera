import {
  D,
  SaleError,
  isPriceOverride,
  lineAmounts,
  resolveUnitPrice,
  roundMoney,
  type PriceSource,
} from "@bakery/domain";
import {
  customers,
  priceListItems,
  priceLists,
  products,
  type Database,
  type Transaction,
} from "@bakery/database";
import { PERMISSIONS, hasPermissions } from "@bakery/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { OperationContext } from "../../lib/context.js";
import { AppError } from "../../lib/errors.js";

/*
 * Precios de venta (Fase 5B, ADR-060). Prioridad: precio acordado del pedido →
 * lista asignada al cliente → lista default de la empresa → precio del
 * producto. Nunca se inventa un precio: si un producto no tiene ninguno, vale
 * su precio de producto (que es obligatorio, puede ser 0).
 *
 * Cualquier desvío del precio vigente / acordado (o un descuento) es un
 * OVERRIDE: exige sales.price_override y motivo, queda con origen MANUAL y se
 * audita (SALE_PRICE_OVERRIDDEN).
 */

type Db = Database | Transaction;

export interface ResolvedPrice {
  unitPrice: string;
  source: PriceSource;
  priceList: { id: string; code: string; name: string } | null;
}

export const money2 = (v: InstanceType<typeof D> | string) => roundMoney(v).toFixed(2);

/** Lista vigente para un cliente: la suya (si está activa) o la default de la empresa. */
export async function priceListsFor(db: Db, ctx: OperationContext, customerId: string | null) {
  const lists = await db
    .select({
      id: priceLists.id,
      code: priceLists.code,
      name: priceLists.name,
      isDefault: priceLists.isDefault,
    })
    .from(priceLists)
    .where(and(eq(priceLists.companyId, ctx.companyId), eq(priceLists.active, true)));
  const companyDefault = lists.find((l) => l.isDefault) ?? null;
  let customerList: (typeof lists)[number] | null = null;
  if (customerId) {
    const [c] = await db
      .select({ listId: customers.defaultPriceListId })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)));
    customerList = lists.find((l) => l.id === c?.listId) ?? null;
  }
  return { customerList, companyDefault };
}

/** Precio vigente (sin acuerdo previo) de cada producto para un cliente. */
export async function resolvePrices(
  db: Db,
  ctx: OperationContext,
  customerId: string | null,
  productIds: readonly string[],
): Promise<Map<string, ResolvedPrice>> {
  const ids = [...new Set(productIds)];
  const result = new Map<string, ResolvedPrice>();
  if (ids.length === 0) return result;
  const { customerList, companyDefault } = await priceListsFor(db, ctx, customerId);
  const listIds = [customerList?.id, companyDefault?.id].filter((x): x is string => !!x);
  const items = listIds.length
    ? await db
        .select({
          listId: priceListItems.priceListId,
          productId: priceListItems.productId,
          unitPrice: priceListItems.unitPrice,
        })
        .from(priceListItems)
        .where(
          and(
            eq(priceListItems.companyId, ctx.companyId),
            eq(priceListItems.active, true),
            inArray(priceListItems.priceListId, listIds),
            inArray(priceListItems.productId, ids),
          ),
        )
    : [];
  const rows = await db
    .select({ id: products.id, salePrice: products.salePrice })
    .from(products)
    .where(and(eq(products.companyId, ctx.companyId), inArray(products.id, ids)));
  for (const p of rows) {
    const fromList = (listId: string | undefined) =>
      listId
        ? (items.find((i) => i.listId === listId && i.productId === p.id)?.unitPrice ?? null)
        : null;
    const resolved = resolveUnitPrice({
      customerList: fromList(customerList?.id),
      defaultList: fromList(companyDefault?.id),
      productPrice: p.salePrice,
    });
    const list =
      resolved.source === "CUSTOMER_PRICE_LIST"
        ? customerList
        : resolved.source === "DEFAULT_PRICE_LIST"
          ? companyDefault
          : null;
    result.set(p.id, {
      unitPrice: resolved.unitPrice.toFixed(2),
      source: resolved.source,
      priceList: list ? { id: list.id, code: list.code, name: list.name } : null,
    });
  }
  return result;
}

export interface PricedLine {
  unitPrice: string;
  discountAmount: string;
  netAmount: string;
  grossAmount: string;
  priceSource: PriceSource;
  agreedUnitPrice: string;
  agreedDiscountAmount: string;
  priceOverrideReason: string | null;
  overridden: boolean;
}

/**
 * Precio final de una línea: el acordado/vigente salvo que se cargue otro. Un
 * desvío exige permiso y motivo (si no, 403 / 422 con el campo).
 */
export function priceLine(args: {
  quantity: string | InstanceType<typeof D>;
  base: {
    unitPrice: string;
    discountAmount?: string | null;
    source: PriceSource;
    /** Motivo de un precio MANUAL ya acordado que se conserva. */
    reason?: string | null;
  };
  input: { unitPrice?: string; discountAmount?: string; priceOverrideReason?: string | null };
  /** Override previo que se conserva (borrador ya modificado). */
  keep?: { unitPrice: string; discountAmount: string; reason: string } | null;
  permissions: Iterable<string>;
  path: string;
}): PricedLine {
  const agreedUnitPrice = money2(args.base.unitPrice);
  const agreedDiscountAmount = money2(args.base.discountAmount ?? "0");
  const unitPrice =
    args.input.unitPrice !== undefined
      ? money2(args.input.unitPrice)
      : (args.keep?.unitPrice ?? agreedUnitPrice);
  const discountAmount =
    args.input.discountAmount !== undefined
      ? money2(args.input.discountAmount)
      : (args.keep?.discountAmount ?? agreedDiscountAmount);
  const overridden = isPriceOverride({
    unitPrice,
    discountAmount,
    agreedUnitPrice,
    agreedDiscountAmount,
  });
  let reason: string | null = overridden ? null : (args.base.reason ?? null);
  if (overridden) {
    const explicit = args.input.unitPrice !== undefined || args.input.discountAmount !== undefined;
    if (explicit && !hasPermissions(args.permissions, [PERMISSIONS.SALES_PRICE_OVERRIDE])) {
      throw new AppError(
        403,
        "PRICE_OVERRIDE_FORBIDDEN",
        "No tenés permiso para cambiar precios ni aplicar descuentos.",
        [{ path: `${args.path}.unitPrice`, message: "Sin permiso para modificar el precio" }],
      );
    }
    reason = args.input.priceOverrideReason ?? args.keep?.reason ?? null;
    if (!reason) {
      throw new AppError(
        422,
        "PRICE_OVERRIDE_REASON_REQUIRED",
        "Indicá el motivo del cambio de precio.",
        [{ path: `${args.path}.priceOverrideReason`, message: "Motivo obligatorio" }],
      );
    }
  }
  let amounts;
  try {
    amounts = lineAmounts({ quantity: args.quantity, unitPrice, discountAmount });
  } catch (err) {
    if (err instanceof SaleError) {
      throw new AppError(422, err.code, err.message, [
        { path: `${args.path}.discountAmount`, message: err.message },
      ]);
    }
    throw err;
  }
  return {
    unitPrice,
    discountAmount: amounts.discount.toFixed(2),
    netAmount: amounts.net.toFixed(2),
    grossAmount: amounts.gross.toFixed(2),
    priceSource: overridden ? "MANUAL" : args.base.source,
    agreedUnitPrice,
    agreedDiscountAmount,
    priceOverrideReason: reason,
    overridden,
  };
}

/** Totales de un conjunto de líneas con precio. */
export function pricedTotals(lines: readonly { grossAmount: string; discountAmount: string }[]) {
  const subtotal = lines.reduce((s, l) => s.plus(l.grossAmount), new D(0));
  const discount = lines.reduce((s, l) => s.plus(l.discountAmount), new D(0));
  return {
    subtotal: subtotal.toFixed(2),
    discountTotal: discount.toFixed(2),
    total: subtotal.minus(discount).toFixed(2),
  };
}
