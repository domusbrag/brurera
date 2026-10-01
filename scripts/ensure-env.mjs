// Verifica que las dependencias estén instaladas y crea .env a partir de .env.example si todavía
// no existe. No sobrescribe nada.
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "node_modules"))) {
  console.error("[ensure-env] Faltan las dependencias: corré `pnpm install` y después reintentá.");
  process.exit(1);
}
const target = join(root, ".env");
if (existsSync(target)) {
  console.log("[ensure-env] .env ya existe, no se modifica.");
} else {
  copyFileSync(join(root, ".env.example"), target);
  console.log("[ensure-env] .env creado desde .env.example (valores de desarrollo).");
}
