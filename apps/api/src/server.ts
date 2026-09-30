import { createDatabase } from "@bakery/database";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);
const app = await buildApp({ config, db: database.db });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "cerrando API");
  await app.close();
  await database.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.API_PORT, host: config.API_HOST });
