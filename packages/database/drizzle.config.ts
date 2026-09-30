import { defineConfig } from "drizzle-kit";
import { loadRootEnv } from "./src/env.js";

loadRootEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://bakery:bakery@localhost:5433/bakery_erp",
  },
});
