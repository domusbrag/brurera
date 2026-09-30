import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

/** Carga el .env de la raíz del monorepo si existe. Las variables ya definidas tienen prioridad. */
export function loadRootEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const rootEnv = join(here, "..", "..", "..", ".env");
  if (existsSync(rootEnv)) config({ path: rootEnv, quiet: true });
}

export function requireDatabaseUrl(name = "DATABASE_URL"): string {
  const url = process.env[name];
  if (!url) throw new Error(`Falta la variable de entorno ${name}. Ver .env.example.`);
  return url;
}
