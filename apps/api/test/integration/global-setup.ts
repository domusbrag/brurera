import { createDatabase, runMigrations } from "@bakery/database";
import pg from "pg";
import { TEST_DATABASE_URL } from "./test-env.js";

/** Crea la base de test si no existe y aplica las migraciones versionadas. */
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = "/postgres";

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
    if (exists.rowCount === 0) await admin.query(`create database "${dbName.replace(/"/g, "")}"`);
  } finally {
    await admin.end();
  }

  const handle = createDatabase(TEST_DATABASE_URL, { max: 1 });
  try {
    await runMigrations(handle.db);
  } finally {
    await handle.close();
  }
}
