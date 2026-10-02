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
const F5A_DB = dbUrl("migration5a");
const F5B_DB = dbUrl("migration5b");
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
      // 0010 renombra moving_average_cost → average_material_cost (mismo valor).
      `select product_id, quantity, inventory_value,
        coalesce(to_jsonb(c)->>'moving_average_cost', to_jsonb(c)->>'average_material_cost') as average_cost,
        last_movement_id from product_inventory_costs c`,
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
  await admin(`drop database if exists "${nameOf(F5A_DB)}" with (force)`);
  await admin(`drop database if exists "${nameOf(F5B_DB)}" with (force)`);
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

    // Todas las migraciones hasta la actual (0011 = cierre de Fase 5B).
    expect(await applied(w)).toBe(12);
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

    expect(await applied(w)).toBe(12);
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

describe("migración 0010 (Fase 5B) sobre datos de Fase 5A", () => {
  it("pedidos sin precio (UNPRICED), Consumidor Final, promedio derivado, ledger intacto", async () => {
    const w = await fase4Database(F5A_DB);
    await completedOrder(w, "OP-0001", "100", "678.2", "LOT-20261001-001");
    await completedOrder(w, "OP-0002", "50", "726.4", null);
    await migrate(F5A_DB, migrationsUpTo(9));
    const [customer] = await w.q<{ id: string }>(
      `insert into customers (company_id, internal_code, type, legal_name)
       values ($1, 'CLI-0001', 'RETAILER', 'Hotel Central') returning id`,
      [w.companyId],
    );
    const order = async (code: string, confirmed: boolean) => {
      const [o] = await w.q<{ id: string }>(
        `insert into customer_orders (company_id, internal_code, customer_id, status, coverage_status,
           requested_at, plan_revision, confirmed_at)
         values ($1, $2, $3, $4, $5, now() + interval '1 day', $6, $7) returning id`,
        [
          w.companyId,
          code,
          customer!.id,
          confirmed ? "CONFIRMED" : "DRAFT",
          confirmed ? "PARTIALLY_COVERED" : null,
          confirmed ? 1 : 0,
          confirmed ? new Date() : null,
        ],
      );
      await w.q(
        `insert into customer_order_lines (company_id, customer_order_id, product_id, requested_quantity,
           unit_id, normalized_quantity, sale_unit_id)
         values ($1, $2, $3, 10, $4, 10, $4)`,
        [w.companyId, o!.id, w.product, w.kg],
      );
      return o!.id;
    };
    await order("PED-0001", true);
    await order("PED-0002", false);
    const before = await snapshot(w);

    await migrate(F5A_DB, MIGRATIONS_FOLDER);

    expect(await applied(w)).toBe(12);
    expect(await snapshot(w)).toEqual(before);
    const orders = await w.q<{ pricing_status: string; quoted_total: string | null }>(
      "select pricing_status, quoted_total from customer_orders order by internal_code",
    );
    expect(orders).toEqual([
      { pricing_status: "UNPRICED", quoted_total: null },
      { pricing_status: "UNPRICED", quoted_total: null },
    ]);
    const [lines] = await w.q<{ n: number }>(
      "select count(*)::int as n from customer_order_lines where quoted_unit_price is not null or price_source is not null",
    );
    expect(lines!.n).toBe(0);
    const walkIn = await w.q<{ legal_name: string; internal_code: string }>(
      "select legal_name, internal_code from customers where is_walk_in",
    );
    expect(walkIn).toEqual([{ legal_name: "Consumidor Final", internal_code: "CONS-FINAL" }]);
    const [cost] = await w.q<{ ok: boolean }>(
      "select average_material_cost = round(inventory_value / quantity, 6) as ok from product_inventory_costs",
    );
    expect(cost!.ok).toBe(true);
    for (const table of [
      "sales",
      "sale_lines",
      "sale_lot_allocations",
      "customer_payments",
      "customer_payment_applications",
      "customer_account_movements",
      "customer_account_balances",
      "price_lists",
      "price_list_items",
    ]) {
      const [row] = await w.q<{ n: number }>(`select count(*)::int as n from ${table}`);
      expect(row!.n, table).toBe(0);
    }
  });
});

describe("migración 0011 (cierre de Fase 5B) sobre datos de Fase 5B", () => {
  it("agrega operation_id sin tocar cobros, movimientos ni saldos; la base impide duplicar un intento", async () => {
    const w = await fase4Database(F5B_DB);
    await migrate(F5B_DB, migrationsUpTo(10));
    const [customer] = await w.q<{ id: string }>(
      `insert into customers (company_id, internal_code, type, legal_name)
       values ($1, 'CLI-0001', 'RETAILER', 'Hotel Central') returning id`,
      [w.companyId],
    );
    const customerId = customer!.id;
    await w.q("insert into customer_account_balances (company_id, customer_id) values ($1, $2)", [
      w.companyId,
      customerId,
    ]);
    const [payment] = await w.q<{ id: string }>(
      `insert into customer_payments (company_id, internal_code, customer_id, kind, payment_date, amount,
         payment_method, operation_id, posted_at)
       values ($1, 'COB-0001', $2, 'ON_ACCOUNT', now(), 5000, 'CASH', gen_random_uuid(), now()) returning id`,
      [w.companyId, customerId],
    );
    const move = async (type: string, signed: string, after: string, paymentId: string | null) => {
      const [m] = await w.q<{ id: string }>(
        `insert into customer_account_movements (company_id, customer_id, movement_type, signed_amount,
           balance_after, occurred_at, payment_id, reason)
         values ($1, $2, $3, $4, $5, now(), $6, $7) returning id`,
        [w.companyId, customerId, type, signed, after, paymentId, paymentId ? null : "Corrección"],
      );
      await w.q(
        "update customer_account_balances set balance = $3, last_movement_id = $4 where company_id = $1 and customer_id = $2",
        [w.companyId, customerId, after, m!.id],
      );
    };
    await move("PAYMENT_CREDIT", "-5000", "-5000", payment!.id);
    await move("ADJUSTMENT_DEBIT", "1000", "-4000", null);
    const state = () =>
      w.q(
        `select (select json_agg(m order by sequence) from (select id, sequence, movement_type, signed_amount,
           balance_after, payment_id, reason from customer_account_movements) m) as movements,
         (select json_agg(b) from (select balance, last_movement_id from customer_account_balances) b) as balances,
         (select json_agg(p) from (select id, amount, operation_id from customer_payments) p) as payments`,
      );
    const before = await state();

    await migrate(F5B_DB, MIGRATIONS_FOLDER);

    expect(await applied(w)).toBe(12);
    expect(await state()).toEqual(before);
    const [nulls] = await w.q<{ n: number }>(
      "select count(*)::int as n from customer_account_movements where operation_id is not null",
    );
    expect(nulls!.n).toBe(0);
    // El mismo intento no puede producir dos ajustes (índice único por empresa)…
    const op = "00000000-0000-4000-8000-000000000001";
    const adjustment = (after: string) =>
      w.q(
        `insert into customer_account_movements (company_id, customer_id, movement_type, signed_amount,
           balance_after, occurred_at, reason, operation_id)
         values ($1, $2, 'ADJUSTMENT_CREDIT', -100, $3, now(), 'Bonificación', $4)`,
        [w.companyId, customerId, after, op],
      );
    await adjustment("-4100");
    await expect(adjustment("-4200")).rejects.toThrow(/customer_account_movements_operation_uq/);
    // …y sólo los ajustes llevan operation_id (el cobro ya tiene el suyo).
    await expect(
      w.q(
        `insert into customer_account_movements (company_id, customer_id, movement_type, signed_amount,
           balance_after, occurred_at, payment_id, operation_id)
         values ($1, $2, 'PAYMENT_CREDIT', -1, -1, now(), $3, gen_random_uuid())`,
        [w.companyId, customerId, payment!.id],
      ),
    ).rejects.toThrow(/customer_account_movements_operation_adjustment/);
  });
});
