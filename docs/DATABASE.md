# Base de datos

PostgreSQL 16. ORM **Drizzle** con migraciones SQL versionadas generadas por `drizzle-kit`.

## Convenciones

- Nombres de tablas y columnas en `snake_case` plural (`audit_logs`, `company_id`).
- PK `uuid` con `gen_random_uuid()`. Excepción: `audit_logs.id` es `bigserial` (alto volumen,
  orden natural de inserción).
- `created_at` / `updated_at` como `timestamptz` en UTC.
- Enums de PostgreSQL para estados (`employee_status`, `user_status`).
- Dinero y cantidades: `numeric(p, s)`. **Prohibido** `real` / `double precision` (hay un test que
  lo verifica en todo el esquema).
- Claves foráneas `ON DELETE RESTRICT` por defecto: no se borran entidades con historia. Solo
  tablas puente o dependientes puras usan `CASCADE` (`role_permissions`, `user_roles`, `sessions`).
- Índices en claves de búsqueda y foráneas usadas en consultas.

## Tablas creadas en Fase 0

| Tabla              | Propósito                           | Claves / índices relevantes                                                                           |
| ------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `companies`        | Empresa operativa                   | PK                                                                                                    |
| `employees`        | Personas que trabajan en la empresa | FK company; único (`company_id`, `document_number`) si no es null; índice (`company_id`, `last_name`) |
| `users`            | Identidades de acceso               | FK company, FK employee (único si no es null); **único `lower(email)`**                               |
| `roles`            | Roles por empresa                   | único (`company_id`, `code`)                                                                          |
| `permissions`      | Catálogo global de permisos         | único `code`                                                                                          |
| `role_permissions` | N:M rol ↔ permiso                   | PK (`role_id`, `permission_id`)                                                                       |
| `user_roles`       | N:M usuario ↔ rol                   | PK (`user_id`, `role_id`); índice `role_id`; `assigned_by_user_id`                                    |
| `sessions`         | Sesiones de servidor                | único `token_hash`; índices `user_id`, `expires_at`                                                   |
| `audit_logs`       | Auditoría solo-inserción            | índices (`entity_type`, `entity_id`), `actor_user_id`, `created_at`; trigger anti UPDATE/DELETE       |

`sessions` no estaba en la lista mínima de la especificación: es la tabla de sesiones que requiere
la solución de auth elegida (sesiones de servidor revocables). Ver DECISIONS (ADR-005).

## Migraciones

| Archivo                           | Contenido                                                       |
| --------------------------------- | --------------------------------------------------------------- |
| `0000_foundation.sql`             | Enums, las 9 tablas fundacionales, FKs e índices                |
| `0001_audit_logs_append_only.sql` | Función y trigger que rechazan UPDATE/DELETE sobre `audit_logs` |

Ubicación: `packages/database/migrations/` (SQL + `meta/` con snapshots de drizzle-kit). Drizzle
registra lo aplicado en `drizzle.__drizzle_migrations`.

### Flujo de trabajo

1. Modificar el esquema en `packages/database/src/schema/`.
2. `pnpm db:generate` → genera `NNNN_nombre.sql`. Revisar el SQL a mano.
3. Para SQL que Drizzle no modela (triggers, funciones, checks complejos):
   `pnpm --filter @bakery/database exec drizzle-kit generate --custom --name <nombre>` y escribir el SQL.
4. `pnpm db:migrate` localmente; `pnpm test` (los tests migran la base de test automáticamente).
5. Versionar SQL y `meta/` en el mismo commit que el cambio de esquema.

**Regla:** nunca modificar una migración que ya fue aplicada en una etapa cerrada; crear una nueva.

## Seeds y datos de referencia

Separados de las migraciones:

| Comando                  | Qué hace                                                                  | Entornos            |
| ------------------------ | ------------------------------------------------------------------------- | ------------------- |
| `pnpm db:sync-reference` | Upsert del catálogo de permisos y de los roles de sistema de cada empresa | Todos (idempotente) |
| `pnpm db:seed`           | Referencia + empresa demo + empleado y usuario admin de desarrollo        | Solo desarrollo     |

Ningún código productivo depende de los datos del seed.

## Tablas previstas por fase

No se crean hasta su fase (cada una con su migración):

| Fase | Tablas                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `customers`, `suppliers`, `units`, `unit_conversions`, `categories`, `raw_materials`, `products`, `warehouses`, `price_lists` (lista principal) |
| 2    | `recipes`, `recipe_versions`, `recipe_ingredients`                                                                                              |
| 3    | `purchases`, `purchase_items`, `stock_movements` (+ saldo cacheado opcional con reconciliación)                                                 |
| 4    | `production_orders`, `production_cost_snapshots`                                                                                                |
| 5    | `sales`, `sale_items`, `price_list_items`, `customer_account_movements`, `payments`                                                             |
| 6    | `supplier_account_movements`, `cash_accounts`, `cash_movements`, `expenses`, `expense_categories`                                               |
| 7    | `invoices`, `invoice_items`                                                                                                                     |

## Operación local

- `pnpm db:up` levanta `postgres:16-alpine` (usuario/clave `bakery`/`bakery`, base `bakery_erp`,
  puerto host **5433**, volumen `pgdata`).
- `pnpm db:reset` borra el volumen y recrea todo desde cero.
- Tests de integración usan `bakery_erp_test` (se crea sola). Por seguridad, los tests se niegan a
  correr contra una base cuyo nombre no termine en `_test`.
