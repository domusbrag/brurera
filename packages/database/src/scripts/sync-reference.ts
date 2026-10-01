import { createDatabase } from "../client.js";
import { loadRootEnv, requireDatabaseUrl } from "../env.js";
import { syncPermissionCatalog, syncStandardUnits, syncSystemRoles } from "../reference-data.js";
import { companies } from "../schema/index.js";

loadRootEnv();
const handle = createDatabase(requireDatabaseUrl(), { max: 1 });
try {
  await handle.db.transaction(async (tx) => {
    await syncPermissionCatalog(tx);
    const all = await tx.select({ id: companies.id }).from(companies);
    for (const c of all) {
      await syncSystemRoles(tx, c.id);
      await syncStandardUnits(tx, c.id);
    }
    console.log(
      JSON.stringify({
        level: "info",
        msg: "datos de referencia sincronizados",
        companies: all.length,
      }),
    );
  });
} finally {
  await handle.close();
}
