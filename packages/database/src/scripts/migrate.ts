import { createDatabase } from "../client.js";
import { loadRootEnv, requireDatabaseUrl } from "../env.js";
import { MIGRATIONS_FOLDER, runMigrations } from "../migrate.js";

loadRootEnv();
const handle = createDatabase(requireDatabaseUrl(), { max: 1 });
try {
  await runMigrations(handle.db);
  console.log(
    JSON.stringify({ level: "info", msg: "migraciones aplicadas", folder: MIGRATIONS_FOLDER }),
  );
} finally {
  await handle.close();
}
