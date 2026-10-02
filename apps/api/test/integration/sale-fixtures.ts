import { randomUUID } from "node:crypto";
import type { Database } from "@bakery/database";
import { sql } from "drizzle-orm";
import type { ApiClient } from "./helpers.js";
import { dec, ok } from "./inventory-fixtures.js";
import { produce } from "./lot-fixtures.js";
import type { OrderWorld } from "./order-fixtures.js";

/*
 * Datos de partida para ventas y cobros (Fase 5B), creados por la API.
 */

/** Dos lotes frescos de Pan francés con distinto costo material (harina a 900 y a 1.500). */
export async function twoLotsWithDifferentCost(
  api: ApiClient,
  w: OrderWorld,
  qtyA = "100",
  qtyB = "100",
) {
  const a = await produce(api, w, qtyA, { harinaCost: "900" });
  const b = await produce(api, w, qtyB, { harinaCost: "1500" });
  return { lotA: a.lot, lotB: b.lot };
}

export interface SaleLineSpec {
  productId: string;
  quantity: string;
  orderLineId?: string;
  unitPrice?: string;
  discountAmount?: string;
  priceOverrideReason?: string;
  requestedConservation?: string;
}

export const draftSale = (
  api: ApiClient,
  w: OrderWorld,
  lines: SaleLineSpec[],
  extra: Record<string, unknown> = {},
) => api.post("/api/sales", { warehouseId: w.warehouseId, lines, ...extra });

export const postSale = (api: ApiClient, saleId: string, body: Record<string, unknown> = {}) =>
  api.post(`/api/sales/${saleId}/post`, body);

/** Borrador + confirmación de entrega y venta. */
export async function postedSale(
  api: ApiClient,
  w: OrderWorld,
  lines: SaleLineSpec[],
  extra: Record<string, unknown> = {},
) {
  const sale = await ok(draftSale(api, w, lines, extra), 201);
  return (await ok(postSale(api, sale.id))).sale;
}

/** Venta desde un pedido: una línea por línea del pedido con su pendiente (o `quantities`). */
export async function saleFromOrder(
  api: ApiClient,
  w: OrderWorld,
  order: { id: string; lines: { id: string; product: { id: string }; pendingDelivery: string }[] },
  quantities?: Record<string, string>,
) {
  return draftSale(
    api,
    w,
    order.lines
      .map((l) => ({
        orderLineId: l.id,
        productId: l.product.id,
        quantity: quantities?.[l.id] ?? dec(l.pendingDelivery)!,
      }))
      .filter((l) => Number(l.quantity) > 0),
    { sourceOrderId: order.id },
  );
}

export const pay = (
  api: ApiClient,
  saleId: string,
  amount: string,
  operationId: string = randomUUID(),
  extra: Record<string, unknown> = {},
) =>
  api.post(`/api/sales/${saleId}/payments`, {
    amount,
    paymentMethod: "CASH",
    operationId,
    ...extra,
  });

export const advance = (
  api: ApiClient,
  orderId: string,
  amount: string,
  operationId: string = randomUUID(),
) =>
  api.post(`/api/orders/${orderId}/advances`, {
    amount,
    paymentMethod: "TRANSFER",
    reference: "Transferencia 123",
    operationId,
  });

/** Imputación manual de un cobro a una venta. */
export const applyTo = (
  api: ApiClient,
  paymentId: string,
  saleId: string,
  amount: string,
  operationId: string = randomUUID(),
) => api.post(`/api/payments/${paymentId}/applications`, { saleId, amount, operationId });

/** Ajuste de cuenta corriente (política B). */
export const adjust = (
  api: ApiClient,
  customerId: string,
  body: { direction: "DEBIT" | "CREDIT"; amount: string; reason: string; notes?: string },
  operationId: string = randomUUID(),
) => api.post(`/api/customers/${customerId}/account/adjustments`, { ...body, operationId });

export const accountOf = (api: ApiClient, customerId: string) =>
  ok(api.get(`/api/customers/${customerId}/account`));

/** Fija un precio en una lista (crea la lista si no se pasa). */
export async function priceList(
  api: ApiClient,
  name: string,
  prices: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  const list = await ok(api.post("/api/price-lists", { name, ...extra }), 201);
  for (const [productId, unitPrice] of Object.entries(prices)) {
    await ok(api.put(`/api/price-lists/${list.id}/items/${productId}`, { unitPrice }));
  }
  return list;
}

/**
 * Invariantes de la cuenta corriente y las ventas para toda la base:
 * - saldo = Σ movimientos = balance_after del último;
 * - lo cobrado de cada venta = Σ aplicaciones; ninguna aplicación supera venta o pago;
 * - cada venta confirmada: costo = Σ asignaciones = Σ |movimientos SALE|, una
 *   deuda SALE_DEBIT por su total (si > 0);
 * - cada movimiento SALE tiene su asignación.
 */
export async function salesProblems(db: Database): Promise<string[]> {
  const problems: string[] = [];
  const check = async (label: string, query: ReturnType<typeof sql>) => {
    const { rows } = await db.execute<{ n: number }>(query);
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) problems.push(`${label}: ${n}`);
  };
  await check(
    "saldo de cuenta ≠ Σ movimientos",
    sql`select count(*)::int as n from customer_account_balances b
      where b.balance <> coalesce((select sum(m.signed_amount) from customer_account_movements m
        where m.company_id = b.company_id and m.customer_id = b.customer_id), 0)`,
  );
  await check(
    "cobrado ≠ Σ aplicaciones",
    sql`select count(*)::int as n from sales s
      where s.paid_amount <> coalesce((select sum(a.amount) from customer_payment_applications a where a.sale_id = s.id), 0)`,
  );
  await check(
    "aplicado > monto del cobro",
    sql`select count(*)::int as n from customer_payments p
      where p.amount < coalesce((select sum(a.amount) from customer_payment_applications a where a.payment_id = p.id), 0)`,
  );
  await check(
    "costo de venta ≠ Σ lotes",
    sql`select count(*)::int as n from sales s where s.status = 'POSTED'
      and s.material_cost_total <> coalesce((select sum(a.material_cost) from sale_lot_allocations a where a.sale_id = s.id), 0)`,
  );
  await check(
    "costo de venta ≠ Σ movimientos SALE",
    sql`select count(*)::int as n from sales s where s.status = 'POSTED'
      and s.material_cost_total <> coalesce((select -sum(m.total_value) from stock_movements m
        where m.movement_type = 'SALE' and m.reference_id = s.id), 0)`,
  );
  await check(
    "venta sin su deuda",
    sql`select count(*)::int as n from sales s where s.status = 'POSTED' and s.total > 0
      and not exists (select 1 from customer_account_movements m where m.sale_id = s.id and m.movement_type = 'SALE_DEBIT' and m.signed_amount = s.total)`,
  );
  await check(
    "movimiento SALE sin asignación",
    sql`select count(*)::int as n from stock_movements m where m.movement_type = 'SALE'
      and not exists (select 1 from sale_lot_allocations a where a.stock_movement_id = m.id)`,
  );
  await check(
    "línea de venta: costo ≠ Σ lotes",
    sql`select count(*)::int as n from sale_lines l join sales s on s.id = l.sale_id where s.status = 'POSTED'
      and l.material_cost <> coalesce((select sum(a.material_cost) from sale_lot_allocations a where a.sale_line_id = l.id), 0)`,
  );
  await check(
    "promedio de producto ≠ valor / cantidad",
    sql`select count(*)::int as n from product_inventory_costs c
      where (c.quantity = 0 and c.average_material_cost is not null)
         or (c.quantity > 0 and c.average_material_cost <> round(c.inventory_value / c.quantity, 6))`,
  );
  await check(
    "reserva: entregado fuera de rango",
    sql`select count(*)::int as n from product_lot_reservations where fulfilled_quantity < 0 or fulfilled_quantity > quantity`,
  );
  return problems;
}
