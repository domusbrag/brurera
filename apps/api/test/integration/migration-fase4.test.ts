import {
  MIGRATIONS_FOLDER,
  createDatabase,
  provisionCompany,
  runMigrations,
} from "@bakery/database";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "./test-env.js";

/*
 * Gate B automatizado de Fase 4.5: una base en 0007 (Fase 4) con dos órdenes
 * COMPLETED (100 kg + 50 kg de Pan francés, una sin batch code) se migra a 0008:
 * un lote raíz por orden, Σ lotes = saldo agregado, promedio y valor idénticos y
 * el ledger intacto (§51). Si hay stock de producto sin orden que lo origine, la
 * migración aborta con un BLOCKER y no aplica nada. Usa bases propias.
 */

const dbUrl = (suffix: string) => {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `${url.pathname.slice(1).replace(/_test$/, "")}_${suffix}_test`;
  return url.toString();
};
const OK_DB = dbUrl("migration4");
const BLOCKED_DB = dbUrl("migration4_blocked");
const F45_DB = dbUrl("migration45");
const nameOf = (url: string) => new URL(url).pathname.slice(1);

let tmp: string;
const clients: pg.Client[] = [];

async function admin(sql: string) {
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

/** Copia de las migraciones hasta `lastIdx` inclusive. */
function migrationsUpTo(lastIdx: number) {
  const dir = join(tmp, `upto-${lastIdx}`);
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= lastIdx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

async function migrate(url: string, folder: string) {
  const handle = createDatabase(url, { max: 1 });
  try {
    await runMigrations(handle.db, folder);
  } finally {
    await handle.close();
  }
}

type Q = <T extends pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>;

/** Base en 0007 con empresa, Pan francés y su receta (borrador alcanza para la FK). */
async function fase4Database(url: string) {
  await admin(`drop database if exists "${nameOf(url)}" with (force)`);
  await admin(`create database "${nameOf(url)}"`);
  await migrate(url, migrationsUpTo(7));
  const handle = createDatabase(url, { max: 1 });
  let companyId: string;
  try {
    companyId = (
      await handle.db.transaction((tx) =>
        provisionCompany(
          tx,
          { legalName: "Fase 4 S.A.", tradeName: "Panadería Fase 4" },
          { walkInCustomer: false },
        ),
      )
    ).id;
  } finally {
    await handle.close();
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  clients.push(client);
  const q: Q = async (sql, params = []) => (await client.query(sql, params)).rows;
  const [kg] = await q<{ id: string }>(
    "select id from units_of_measure where company_id = $1 and code = 'kg'",
    [companyId],
  );
  const [warehouse] = await q<{ id: string }>("select id from warehouses where company_id = $1", [
    companyId,
  ]);
  const [category] = await q<{ id: string }>(
    "insert into categories (company_id, type, name) values ($1, 'PRODUCT', 'Panes') returning id",
    [companyId],
  );
  const [product] = await q<{ id: string }>(
    `insert into products (company_id, internal_code, name, category_id, sale_unit_id, sale_price)
     values ($1, 'PT-0001', 'Pan francés', $2, $3, 1500) returning id`,
    [companyId, category!.id, kg!.id],
  );
  const [recipe] = await q<{ id: string }>(
    "insert into recipes (company_id, product_id, name) values ($1, $2, 'Pan francés') returning id",
    [companyId, product!.id],
  );
  const [version] = await q<{ id: string }>(
    `insert into recipe_versions (company_id, recipe_id, version_number, yield_quantity, yield_unit_id)
     values ($1, $2, 1, 100, $3) returning id`,
    [companyId, recipe!.id, kg!.id],
  );
  return {
    q,
    companyId,
    kg: kg!.id,
    warehouse: warehouse!.id,
    product: product!.id,
    recipe: recipe!.id,
    version: version!.id,
  };
}
type World = Awaited<ReturnType<typeof fase4Database>>;

/** Orden en curso, como la deja Fase 4 al iniciar. */
async function inProgressOrder(w: World, code: string, quantity: string, batchCode: string | null) {
  const [order] = await w.q<{ id: string }>(
    `insert into production_orders (company_id, internal_code, product_id, recipe_id, recipe_version_id,
       source_warehouse_id, output_warehouse_id, status, scheduled_for, planned_output_quantity,
       planned_output_unit_id, sale_unit_id, planned_output_normalized, scale_factor,
       planned_cost_status, currency_code, planned_at, started_at, batch_code)
     values ($1, $2, $3, $4, $5, $6, $6, 'IN_PROGRESS', current_date, $7, $8, $8, $7, 1,
       'INCOMPLETE', 'ARS', now(), now(), $9) returning id`,
    [w.companyId, code, w.product, w.recipe, w.version, w.warehouse, quantity, w.kg, batchCode],
  );
  return order!.id;
}

/** Ingreso del producto como lo hace el ledger de Fase 4: movimiento → saldo → costo. */
async function postOutput(w: World, orderId: string, quantity: string, unitCost: string) {
  const value = (Number(quantity) * Number(unitCost)).toFixed(6);
  await w.q(
    `insert into stock_balances (company_id, warehouse_id, item_type, product_id, base_unit_id, quantity)
     values ($1, $2, 'PRODUCT', $3, $4, 0) on conflict do nothing`,
    [w.companyId, w.warehouse, w.product, w.kg],
  );
  await w.q(
    "insert into product_inventory_costs (company_id, product_id) values ($1, $2) on conflict do nothing",
    [w.companyId, w.product],
  );
  const [balance] = await w.q<{ id: string; quantity: string }>(
    "select id, quantity from stock_balances where product_id = $1 and warehouse_id = $2",
    [w.product, w.warehouse],
  );
  const [cost] = await w.q<{ quantity: string; inventory_value: string }>(
    "select quantity, inventory_value from product_inventory_costs where product_id = $1",
    [w.product],
  );
  const after = (Number(balance!.quantity) + Number(quantity)).toFixed(10);
  const [movement] = await w.q<{ id: string }>(
    `insert into stock_movements (company_id, warehouse_id, item_type, product_id, movement_type,
       quantity, base_unit_id, unit_cost, total_value, balance_after, occurred_at,
       reference_type, reference_id, source_line_id)
     values ($1, $2, 'PRODUCT', $3, 'PRODUCTION_OUTPUT', $4, $5, $6, $7, $8, now(),
       'PRODUCTION_ORDER', $9, $9) returning id`,
    [w.companyId, w.warehouse, w.product, quantity, w.kg, unitCost, value, after, orderId],
  );
  await w.q("update stock_balances set quantity = $1, last_movement_id = $2 where id = $3", [
    after,
    movement!.id,
    balance!.id,
  ]);
  const qty = Number(cost!.quantity) + Number(quantity);
  const total = Number(cost!.inventory_value) + Number(value);
  await w.q(
    `update product_inventory_costs set quantity = $1, inventory_value = $2,
       moving_average_cost = $3, last_movement_id = $4 where product_id = $5`,
    [qty.toFixed(10), total.toFixed(6), (total / qty).toFixed(6), movement!.id, w.product],
  );
  return movement!.id;
}

async function completedOrder(
  w: World,
  code: string,
  quantity: string,
  unitCost: string,
  batchCode: string | null,
) {
  const orderId = await inProgressOrder(w, code, quantity, batchCode);
  const movementId = await postOutput(w, orderId, quantity, unitCost);
  await w.q(
    `update production_orders set status = 'COMPLETED', completed_at = now(),
       actual_output_quantity = $2, actual_output_unit_id = $3, actual_output_normalized = $2,
       actual_material_cost = $4, actual_unit_material_cost = $5, output_movement_id = $6
     where id = $1`,
    [
      orderId,
      quantity,
      w.kg,
      (Number(quantity) * Number(unitCost)).toFixed(6),
      unitCost,
      movementId,
    ],
  );
  return orderId;
}

async function snapshot(w: World) {
  return {
    movements: await w.q(
      "select id, sequence, movement_type, quantity, total_value, balance_after, reference_id from stock_movements order by sequence",
    ),
    balances: await w.q(
      "select id, product_id, warehouse_id, quantity, last_movement_id from stock_balances order by id",
    ),
    costs: await w.q(
      "select product_id, quantity, inventory_value, moving_average_cost, last_movement_id from product_inventory_costs",
    ),
    orders: await w.q(
      "select id, status, batch_code, output_movement_id from production_orders order by internal_code",
    ),
  };
}

const applied = async (w: World) =>
  (await w.q<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations"))[0]!.n;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "bakery-migrations-f4-"));
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.end()));
  await admin(`drop database if exists "${nameOf(OK_DB)}" with (force)`);
  await admin(`drop database if exists "${nameOf(BLOCKED_DB)}" with (force)`);
  await admin(`drop database if exists "${nameOf(F45_DB)}" with (force)`);
  rmSync(tmp, { recursive: true, force: true });
});

describe("migración 0008 sobre datos de Fase 4 (Gate B, §51)", () => {
  it("100 kg + 50 kg COMPLETED → dos lotes raíz; Σ lotes = saldo; promedio y valor idénticos", async () => {
    const w = await fase4Database(OK_DB);
    const o1 = await completedOrder(w, "OP-0001", "100", "678.2", "LOT-20261001-001");
    const o2 = await completedOrder(w, "OP-0002", "50", "726.4", null);
    const before = await snapshot(w);
    expect(before.costs).toEqual([
      expect.objectContaining({ quantity: "150.0000000000", inventory_value: "104140.000000" }),
    ]);

    await migrate(OK_DB, MIGRATIONS_FOLDER);

    // Todas las migraciones hasta la actual (0009 = Fase 5A).
    expect(await applied(w)).toBe(10);
    // Ledger, saldos, costos y órdenes: nada cambia (salvo la columna nueva del movimiento).
    expect(await snapshot(w)).toEqual(before);

    const lots = await w.q<{
      production_order_id: string;
      lot_code: string;
      conservation_state: string;
      usable_until: Date | null;
      initial_quantity: string;
      initial_value: string;
      unit_material_cost: string;
      parent_lot_id: string | null;
      notes: string;
    }>("select * from product_lots order by lot_code");
    expect(lots).toHaveLength(2);
    expect(lots.map((l) => [l.lot_code, l.production_order_id])).toEqual([
      ["LOT-20261001-001", o1],
      ["LOT-OP-0002", o2],
    ]);
    for (const l of lots) {
      expect(l.conservation_state).toBe("FRESH");
      expect(l.usable_until).toBeNull();
      expect(l.parent_lot_id).toBeNull();
      expect(l.notes).toMatch(/migrado/i);
    }
    expect(lots.map((l) => [l.initial_quantity, l.initial_value])).toEqual([
      ["100.0000000000", "67820.000000"],
      ["50.0000000000", "36320.000000"],
    ]);

    const [sum] = await w.q<{ quantity: string; value: string }>(
      "select sum(quantity)::text as quantity, sum(inventory_value)::text as value from product_lot_balances",
    );
    expect(Number(sum!.quantity)).toBe(150);
    expect(Number(sum!.value)).toBe(104140);
    const [unlinked] = await w.q<{ n: number }>(
      "select count(*)::int as n from stock_movements where item_type = 'PRODUCT' and product_lot_id is null",
    );
    expect(unlinked!.n).toBe(0);
    // La migración no registra auditoría inventada ni movimientos nuevos.
    expect((await snapshot(w)).movements).toHaveLength(2);
  });

  it("stock de producto sin orden COMPLETED que lo origine → BLOCKER y no se aplica nada", async () => {
    const w = await fase4Database(BLOCKED_DB);
    await completedOrder(w, "OP-0001", "100", "678.2", "LOT-X");
    // Ingreso huérfano: la orden sigue en curso (dato inconsistente heredado).
    const orphan = await inProgressOrder(w, "OP-0002", "20", null);
    await postOutput(w, orphan, "20", "700");
    const before = await snapshot(w);

    const err = await migrate(BLOCKED_DB, MIGRATIONS_FOLDER).then(
      () => "",
      (e: { cause?: { message?: string }; message?: string }) =>
        e.cause?.message ?? e.message ?? "",
    );
    expect(err).toMatch(/FASE_4_5_MIGRATION_BLOCKER/);
    expect(await applied(w)).toBe(8);
    const [table] = await w.q<{ t: string | null }>(
      "select to_regclass('product_lots')::text as t",
    );
    expect(table!.t).toBeNull();
    expect(await snapshot(w)).toEqual(before);
  });
});

describe("migración 0009 (Fase 5A) sobre datos de Fase 4.5", () => {
  it("lotes, saldos, ledger y órdenes quedan idénticos; las tablas de pedidos nacen vacías", async () => {
    const w = await fase4Database(F45_DB);
    await completedOrder(w, "OP-0001", "100", "678.2", "LOT-20261001-001");
    await completedOrder(w, "OP-0002", "50", "726.4", null);
    await migrate(F45_DB, migrationsUpTo(8));
    const lotsSnapshot = async () => ({
      ...(await snapshot(w)),
      lots: await w.q(
        "select id, lot_code, conservation_state, usable_until, quality_status, initial_quantity from product_lots order by lot_code",
      ),
      lotBalances: await w.q(
        "select product_lot_id, quantity, inventory_value from product_lot_balances order by product_lot_id",
      ),
    });
    const before = await lotsSnapshot();
    expect(before.lots).toHaveLength(2);

    await migrate(F45_DB, MIGRATIONS_FOLDER);

    expect(await applied(w)).toBe(10);
    expect(await lotsSnapshot()).toEqual(before);
    for (const table of [
      "customer_orders",
      "customer_order_lines",
      "product_lot_reservations",
      "order_production_requirements",
      "order_material_requirements",
      "customer_order_operations",
    ]) {
      const [row] = await w.q<{ n: number }>(`select count(*)::int as n from ${table}`);
      expect(row!.n, table).toBe(0);
    }
    const [linked] = await w.q<{ n: number }>(
      "select count(*)::int as n from production_orders where source_order_requirement_id is not null",
    );
    expect(linked!.n).toBe(0);
    const triggers = await w.q<{ tgname: string }>(
      "select tgname from pg_trigger where not tgisinternal and tgname like any (array['product_lot%reserv%', 'customer_order%', 'order_%'])",
    );
    expect(triggers.map((t) => t.tgname)).toEqual(
      expect.arrayContaining([
        "product_lot_reservations_capacity",
        "product_lot_balances_reserved",
        "product_lots_blocked_reserved",
      ]),
    );
  });
});
