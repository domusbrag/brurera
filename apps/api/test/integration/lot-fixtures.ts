import { randomUUID } from "node:crypto";
import { D } from "@bakery/domain";
import type { Database } from "@bakery/database";
import { sql } from "drizzle-orm";
import type { ApiClient } from "./helpers.js";
import { ok } from "./inventory-fixtures.js";
import { recordActuals, startedOrder, stock, type ProductionWorld } from "./production-fixtures.js";

/*
 * Datos de partida para lotes (Fase 4.5), creados por la API: conservación del
 * producto y producciones completadas con su lote.
 */

export const HOUR = 60;
export const DAY = 1440;

type StateConfig = [shelfLifeMinutes: number, allowedAsInitial?: boolean];

/** Configura la conservación (estados no indicados quedan deshabilitados). */
export function configureConservation(
  api: ApiClient,
  productId: string,
  states: Partial<Record<"FRESH" | "REFRIGERATED" | "FROZEN" | "THAWED", StateConfig>>,
  opts: { defaultInitialState?: string; nearExpiryMinutes?: number } = {},
) {
  return api.put(`/api/products/${productId}/conservation`, {
    defaultInitialState: opts.defaultInitialState ?? "FRESH",
    nearExpiryMinutes: opts.nearExpiryMinutes ?? DAY,
    states: Object.entries(states).map(([state, [shelfLifeMinutes, initial]]) => ({
      state,
      enabled: true,
      shelfLifeMinutes,
      allowedAsInitial: initial ?? state === (opts.defaultInitialState ?? "FRESH"),
      notes: null,
    })),
  });
}

/** Medialuna conceptual: fresca 2 días, congelada 30 días, descongelada 12 horas. */
export const MEDIALUNA = {
  FRESH: [2 * DAY, true],
  FROZEN: [30 * DAY],
  THAWED: [12 * HOUR],
} satisfies Partial<Record<string, StateConfig>>;

/**
 * Produce `quantity` kg de Pan francés (receta 100 kg → 75 kg harina + 0,8 kg sal)
 * y devuelve la orden completada y su lote raíz. Carga la harina necesaria.
 */
export async function produce(
  api: ApiClient,
  w: ProductionWorld,
  quantity: string,
  opts: {
    warehouseId?: string;
    conservationState?: string;
    productId?: string;
    /** Costo de la harina que se carga para esta producción (por defecto 900/kg). */
    harinaCost?: string;
  } = {},
) {
  const harina = new D(quantity).times("0.75").toString();
  const sal = new D(quantity).times("0.008").toString();
  await stock(api, w, w.harina, harina, opts.harinaCost ?? "900");
  await stock(api, w, w.sal, sal, "400");
  const order = await startedOrder(api, w, {
    plannedOutputQuantity: quantity,
    outputWarehouseId: opts.warehouseId ?? w.warehouseId,
    ...(opts.productId ? { productId: opts.productId } : {}),
  });
  await recordActuals(api, w, order, { [w.harina]: harina, [w.sal]: sal }, quantity);
  const done = await ok(
    api.post(
      `/api/production-orders/${order.id}/complete`,
      opts.conservationState ? { conservationState: opts.conservationState } : {},
    ),
  );
  const lot = await ok(api.get(`/api/product-lots/${done.productLot.id}`));
  return { order: done, lot };
}

export const freeze = (
  api: ApiClient,
  lotId: string,
  quantity: string,
  operationId = randomUUID(),
) =>
  api.post(`/api/product-lots/${lotId}/transform`, {
    targetState: "FROZEN",
    quantity,
    operationId,
  });

export const thaw = (api: ApiClient, lotId: string, quantity: string, operationId = randomUUID()) =>
  api.post(`/api/product-lots/${lotId}/transform`, {
    targetState: "THAWED",
    quantity,
    operationId,
  });

export const waste = (
  api: ApiClient,
  lotId: string,
  quantity: string,
  reason = "DAMAGED",
  operationId = randomUUID(),
) => api.post(`/api/product-lots/${lotId}/waste`, { quantity, reason, operationId });

/**
 * Invariantes de reconciliación (gates L y M) para toda la base:
 * - Σ saldos de lote = saldo agregado por producto + depósito;
 * - Σ saldos de lote (cantidad y valor) = costo de inventario del producto;
 * - cada saldo de lote = Σ movimientos del lote; ningún saldo negativo;
 * - todo movimiento de producto tiene lote.
 */
export async function reconciliationProblems(db: Database): Promise<string[]> {
  const problems: string[] = [];
  const check = async (label: string, query: ReturnType<typeof sql>) => {
    const { rows } = await db.execute<{ n: number }>(query);
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) problems.push(`${label}: ${n}`);
  };
  await check(
    "saldo agregado ≠ Σ lotes",
    sql`select count(*)::int as n from stock_balances sb where sb.item_type = 'PRODUCT'
      and sb.quantity <> coalesce((select sum(lb.quantity) from product_lot_balances lb
        where lb.company_id = sb.company_id and lb.product_id = sb.product_id and lb.warehouse_id = sb.warehouse_id), 0)`,
  );
  await check(
    "costo de producto ≠ Σ lotes",
    sql`select count(*)::int as n from product_inventory_costs c
      where c.quantity <> coalesce((select sum(lb.quantity) from product_lot_balances lb
              where lb.company_id = c.company_id and lb.product_id = c.product_id), 0)
         or c.inventory_value <> coalesce((select sum(lb.inventory_value) from product_lot_balances lb
              where lb.company_id = c.company_id and lb.product_id = c.product_id), 0)`,
  );
  await check(
    "saldo de lote ≠ Σ movimientos",
    sql`select count(*)::int as n from product_lot_balances lb
      where lb.quantity <> coalesce((select sum(m.quantity) from stock_movements m where m.product_lot_id = lb.product_lot_id), 0)
         or lb.inventory_value <> coalesce((select sum(m.total_value) from stock_movements m where m.product_lot_id = lb.product_lot_id), 0)`,
  );
  await check(
    "saldo agregado ≠ Σ movimientos",
    sql`select count(*)::int as n from stock_balances sb where sb.item_type = 'PRODUCT'
      and sb.quantity <> coalesce((select sum(m.quantity) from stock_movements m
        where m.product_id = sb.product_id and m.warehouse_id = sb.warehouse_id), 0)`,
  );
  await check(
    "saldo de lote negativo",
    sql`select count(*)::int as n from product_lot_balances where quantity < 0 or inventory_value < 0`,
  );
  await check(
    "movimiento de producto sin lote",
    sql`select count(*)::int as n from stock_movements where item_type = 'PRODUCT' and product_lot_id is null`,
  );
  return problems;
}
