import { loadRootEnv } from "@bakery/database";

loadRootEnv();

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? "postgres://bakery:bakery@localhost:5433/bakery_erp_test";

if (!new URL(TEST_DATABASE_URL).pathname.endsWith("_test")) {
  // Protección: los tests truncan tablas; nunca deben apuntar a una base que no sea de test.
  throw new Error(
    `DATABASE_URL_TEST debe apuntar a una base cuyo nombre termine en _test: ${TEST_DATABASE_URL}`,
  );
}
