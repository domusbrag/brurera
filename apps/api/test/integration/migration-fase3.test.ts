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
 * Gate B automatizado: una base en 0006 (Fase 3) con stock, saldos y costos se
 * migra a 0007 sin perder ni alterar nada. Usa una base propia
 * (…_migration_test) para no interferir con la base de los demás tests.
 */

const url = new URL(TEST_DATABASE_URL);
url.pathname = `${url.pathname.slice(1).replace(/_test$/, "")}_migration_test`;
const MIGRATION_DB = url.toString();
const DB_NAME = url.pathname.slice(1);

let tmp: string;
let client: pg.Client;

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

async function migrate(folder: string) {
  const handle = createDatabase(MIGRATION_DB, { max: 1 });
  try {
    await runMigrations(handle.db, folder);
  } finally {
    await handle.close();
  }
}

const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  (await client.query<T>(sql, params)).rows;

/** Agregados de inventario que la migración no debe alterar. */
async function inventorySnapshot() {
  return {
    movements: await q(
      "select id, sequence, item_type, raw_material_id, movement_type, quantity, total_value, balance_after from stock_movements order by sequence",
    ),
    balances: await q(
      "select id, item_type, raw_material_id, product_id, warehouse_id, quantity, last_movement_id from stock_balances order by id",
    ),
    costs: await q(
      "select raw_material_id, quantity, inventory_value, moving_average_cost, last_movement_id from raw_material_inventory_costs order by raw_material_id",
    ),
    history: await q(
      "select id, movement_id, quantity_after, average_after from inventory_cost_history order by id",
    ),
  };
}

/** Un movimiento aplicado como lo hace el ledger: movimiento → saldo → costo → historial. */
async function post(
  company: string,
  warehouse: string,
  material: string,
  unit: string,
  type: string,
  quantity: string,
  unitCost: string,
  reason: string | null = null,
) {
  const [balance] = await q<{ id: string; quantity: string }>(
    `insert into stock_balances (company_id, warehouse_id, item_type, raw_material_id, base_unit_id, quantity)
     values ($1, $2, 'RAW_MATERIAL', $3, $4, 0)
     on conflict do nothing returning id, quantity`,
    [company, warehouse, material, unit],
  ).then(async (rows) =>
    rows.length > 0
      ? rows
      : q<{ id: string; quantity: string }>(
          "select id, quantity from stock_balances where warehouse_id = $1 and raw_material_id = $2",
          [warehouse, material],
        ),
  );
  await q(
    `insert into raw_material_inventory_costs (company_id, raw_material_id) values ($1, $2) on conflict do nothing`,
    [company, material],
  );
  const [cost] = await q<{ quantity: string; inventory_value: string }>(
    "select quantity, inventory_value from raw_material_inventory_costs where raw_material_id = $1",
    [material],
  );
  const value = (Number(quantity) * Number(unitCost)).toFixed(6);
  const after = (Number(balance!.quantity) + Number(quantity)).toFixed(10);
  const [movement] = await q<{ id: string }>(
    `insert into stock_movements (company_id, warehouse_id, item_type, raw_material_id, movement_type,
       quantity, base_unit_id, unit_cost, total_value, balance_after, occurred_at, reason)
     values ($1, $2, 'RAW_MATERIAL', $3, $4, $5, $6, $7, $8, $9, now(), $10) returning id`,
    [company, warehouse, material, type, quantity, unit, unitCost, value, after, reason],
  );
  await q("update stock_balances set quantity = $1, last_movement_id = $2 where id = $3", [
    after,
    movement!.id,
    balance!.id,
  ]);
  const newQty = Number(cost!.quantity) + Number(quantity);
  const newValue = (Number(cost!.inventory_value) + Number(value)).toFixed(6);
  await q(
    `update raw_material_inventory_costs set quantity = $1, inventory_value = $2,
       moving_average_cost = $3, last_movement_id = $4 where raw_material_id = $5`,
    [newQty.toFixed(10), newValue, unitCost, movement!.id, material],
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bakery-migrations-"));
  await admin(`drop database if exists "${DB_NAME}" with (force)`);
  await admin(`create database "${DB_NAME}"`);
  await migrate(migrationsUpTo(6));

  // Datos de Fase 3: empresa, materias primas, dos depósitos, ingresos y una merma.
  const handle = createDatabase(MIGRATION_DB, { max: 1 });
  let companyId: string;
  try {
    companyId = (
      await handle.db.transaction((tx) =>
        provisionCompany(
          tx,
          { legalName: "Fase 3 S.A.", tradeName: "Panadería Fase 3" },
          { walkInCustomer: false },
        ),
      )
    ).id;
  } finally {
    await handle.close();
  }
  client = new pg.Client({ connectionString: MIGRATION_DB });
  await client.connect();
  const [kg] = await q<{ id: string }>(
    "select id from units_of_measure where company_id = $1 and code = 'kg'",
    [companyId],
  );
  const [main] = await q<{ id: string }>("select id from warehouses where company_id = $1", [
    companyId,
  ]);
  const [second] = await q<{ id: string }>(
    "insert into warehouses (company_id, code, name) values ($1, 'DEP-0002', 'Cámara') returning id",
    [companyId],
  );
  const [category] = await q<{ id: string }>(
    "insert into categories (company_id, type, name) values ($1, 'RAW_MATERIAL', 'Secos') returning id",
    [companyId],
  );
  const material = async (code: string, name: string) =>
    (
      await q<{ id: string }>(
        `insert into raw_materials (company_id, internal_code, name, category_id, base_unit_id)
         values ($1, $2, $3, $4, $5) returning id`,
        [companyId, code, name, category!.id, kg!.id],
      )
    )[0]!.id;
  const harina = await material("MP-0001", "Harina 000");
  const sal = await material("MP-0002", "Sal");
  await post(companyId, main!.id, harina, kg!.id, "INITIAL_STOCK", "200", "1000");
  await post(companyId, second!.id, harina, kg!.id, "INITIAL_STOCK", "50", "1000");
  await post(companyId, main!.id, sal, kg!.id, "INITIAL_STOCK", "10", "500");
  await post(companyId, main!.id, harina, kg!.id, "WASTE", "-5", "1000", "DAMAGED");
});

afterAll(async () => {
  await client?.end();
  await admin(`drop database if exists "${DB_NAME}" with (force)`);
  rmSync(tmp, { recursive: true, force: true });
});

describe("migración 0007 sobre datos de Fase 3 (Gate B)", () => {
  it("conserva movimientos, saldos, costos e historial; Σ movimientos = saldo", async () => {
    const before = await inventorySnapshot();
    expect(before.movements).toHaveLength(4);
    expect(before.balances).toHaveLength(3);

    await migrate(MIGRATIONS_FOLDER);

    const applied = await q<{ n: number }>(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    // Todas las migraciones hasta la actual (0010 = Fase 5B).
    expect(applied[0]!.n).toBe(12);
    expect(await inventorySnapshot()).toEqual(before);
    const [mismatch] = await q<{ n: number }>(`
      select count(*)::int as n from stock_balances b
      where b.quantity <> coalesce((select sum(m.quantity) from stock_movements m
        where m.warehouse_id = b.warehouse_id and m.raw_material_id = b.raw_material_id), 0)`);
    expect(mismatch!.n).toBe(0);
    const types = await q<{ item_type: string }>("select distinct item_type from stock_balances");
    expect(types).toEqual([{ item_type: "RAW_MATERIAL" }]);
    // Las tablas nuevas existen vacías y los tipos productivos ya son válidos.
    for (const table of [
      "production_orders",
      "production_material_lines",
      "product_inventory_costs",
      "product_inventory_cost_history",
    ]) {
      const [row] = await q<{ n: number }>(`select count(*)::int as n from ${table}`);
      expect(row!.n, table).toBe(0);
    }
    const enumValues = await q<{ v: string }>(
      "select unnest(enum_range(null::stock_movement_type))::text as v",
    );
    expect(enumValues.map((r) => r.v)).toEqual(
      expect.arrayContaining(["PRODUCTION_CONSUMPTION", "PRODUCTION_OUTPUT"]),
    );
  });
});
