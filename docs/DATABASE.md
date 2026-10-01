# Base de datos

PostgreSQL 16. ORM **Drizzle** con migraciones SQL versionadas generadas por `drizzle-kit`.

## Convenciones

- Nombres de tablas y columnas en `snake_case` plural (`audit_logs`, `company_id`).
- PK `uuid` con `gen_random_uuid()`. Excepción: `audit_logs.id` es `bigserial` (alto volumen,
  orden natural de inserción).
- `created_at` / `updated_at` como `timestamptz` en UTC.
- Enums de PostgreSQL para estados y tipos (`employee_status`, `user_status`, `membership_status`,
  `customer_type`, `unit_dimension`, `category_type`, …).
- Dinero y cantidades: `numeric(p, s)`. **Prohibido** `real` / `double precision` (hay un test que
  lo verifica en todo el esquema).
- Claves foráneas `ON DELETE RESTRICT` por defecto: no se borran entidades con historia. Solo
  tablas puente o dependientes puras usan `CASCADE` (`role_permissions`, `membership_roles`,
  `sessions`).
- **Tenancy en la base:** cada tabla de negocio tiene `UNIQUE (company_id, id)` y las referencias
  entre maestros son FKs compuestas `(company_id, x_id)`. Una materia prima no puede apuntar a una
  categoría, unidad o proveedor de otra empresa aunque la aplicación fallara (hay un test que lo
  prueba insertando directo en la base).
- Códigos internos en mayúsculas con `UNIQUE (company_id, código)`; nombres y CUIT no son únicos.
- Índices en claves de búsqueda y foráneas usadas en consultas.

## Tablas (Fases 0, 1 y 2)

| Tabla                        | Propósito                                   | Claves / índices relevantes                                                                                                                  |
| ---------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `companies`                  | Empresa                                     | PK; `active`                                                                                                                                 |
| `users`                      | Identidad global de acceso                  | **único `lower(email)`**                                                                                                                     |
| `company_memberships`        | Usuario ↔ empresa (+ empleado opcional)     | único (`company_id`, `user_id`); único `employee_id`; FK compuesta a `employees`                                                             |
| `membership_roles`           | Roles de una membresía                      | PK (`membership_id`, `role_id`); FKs compuestas a membresía y rol con `company_id`                                                           |
| `roles`                      | Roles por empresa                           | único (`company_id`, `code`)                                                                                                                 |
| `permissions`                | Catálogo global de permisos                 | único `code`                                                                                                                                 |
| `role_permissions`           | N:M rol ↔ permiso                           | PK (`role_id`, `permission_id`)                                                                                                              |
| `sessions`                   | Sesiones de servidor (una empresa cada una) | único `token_hash`; `company_id`; índices `user_id`, `expires_at`                                                                            |
| `audit_logs`                 | Auditoría solo-inserción                    | índices (`entity_type`, `entity_id`), `actor_user_id`, `created_at`; trigger anti UPDATE/DELETE                                              |
| `employees`                  | Personas que trabajan en la empresa         | único (`company_id`, `employee_code`); único (`company_id`, `document_number`) si no es null; check egreso ≥ ingreso                         |
| `code_sequences`             | Próximo número de código por empresa/tipo   | PK (`company_id`, `entity`)                                                                                                                  |
| `customers`                  | Clientes                                    | único (`company_id`, `internal_code`); índice (`company_id`, `active`, `legal_name`); check crédito ≥ 0                                      |
| `suppliers`                  | Proveedores                                 | único (`company_id`, `internal_code`)                                                                                                        |
| `units_of_measure`           | Unidades por empresa                        | único (`company_id`, `lower(code)`); FK compuesta a su base; checks base+factor juntos, factor > 0                                           |
| `categories`                 | Categorías de materias primas y productos   | único (`company_id`, `type`, `lower(name)`)                                                                                                  |
| `raw_materials`              | Materias primas (sin stock)                 | único (`company_id`, `internal_code`); FKs compuestas a categoría, unidad y proveedor                                                        |
| `products`                   | Productos terminados (sin costo)            | único (`company_id`, `internal_code`); FKs compuestas a categoría y unidad; check precio ≥ 0                                                 |
| `warehouses`                 | Depósitos                                   | único (`company_id`, `code`)                                                                                                                 |
| `recipes`                    | Receta de un producto (Fase 2)              | único (`company_id`, `id`); FK compuesta a producto; único parcial: una receta activa por producto                                           |
| `recipe_versions`            | Versiones de receta (Fase 2)                | único (`recipe_id`, `version_number`); únicos parciales: un ACTIVE y un DRAFT por receta; checks; trigger de inmutabilidad                   |
| `recipe_ingredients`         | Ingredientes de una versión (Fase 2)        | único (`recipe_version_id`, `raw_material_id`); FKs compuestas a versión, materia prima y unidad; check cantidad > 0; trigger: sólo en DRAFT |
| `recipe_cost_snapshots`      | Costo congelado al publicar (Fase 2)        | único por versión; check COMPLETE ⇔ totales presentes; trigger append-only                                                                   |
| `recipe_cost_snapshot_lines` | Desglose del snapshot (Fase 2)              | FK al snapshot; trigger append-only                                                                                                          |

Tipos numéricos: dinero `numeric(14,2)`, costo por unidad base `numeric(18,6)`, cantidades
`numeric(18,4)`, factores de conversión `numeric(24,10)`. Fase 2: cantidades de receta
`numeric(18,6)`, cantidades normalizadas `numeric(28,10)`, costos calculados `numeric(20,6)`,
porcentajes `numeric(7,4)`.

`sessions` no estaba en la lista mínima de la especificación: es la tabla de sesiones que requiere
la solución de auth elegida (sesiones de servidor revocables). Ver DECISIONS (ADR-005).

## Migraciones

| Archivo                             | Contenido                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000_foundation.sql`               | Enums, las 9 tablas fundacionales, FKs e índices                                                                                                                                                                                |
| `0001_audit_logs_append_only.sql`   | Función y trigger que rechazan UPDATE/DELETE sobre `audit_logs`                                                                                                                                                                 |
| `0002_company_membership.sql`       | Fase 1: `company_memberships`, `membership_roles`, `sessions.company_id`; cierra las sesiones abiertas y traslada los datos (una membresía por usuario con su empleado y roles)                                                 |
| `0003_drop_single_company_user.sql` | Fase 1: elimina `users.company_id`, `users.employee_id` y `user_roles`, ya trasladados                                                                                                                                          |
| `0004_masters.sql`                  | Fase 1: completa `companies` y `employees` (legajo con backfill `EMP-0001…`, estado `ON_LEAVE` → `ACTIVE`), crea `code_sequences` y los maestros                                                                                |
| `0005_recipes.sql`                  | Fase 2: renombra `raw_materials.current_cost` → `reference_cost` (+ origen y fecha), agrega `UNIQUE (company_id, id)` a productos y materias primas, crea las 5 tablas de recetas y los triggers de inmutabilidad y append-only |

0000–0004 no se modificaron en Fase 2: todo cambio va en 0005.

**Triggers de Fase 2** (la base no depende sólo del servicio):

- `recipe_versions_guard`: un `DRAFT` se edita y se borra libremente; `ACTIVE` → `ARCHIVED` se
  permite sólo si no cambia nada más que estado, `archived_at` y `updated_at`; cualquier otro
  UPDATE o DELETE de una versión publicada falla con `recipe_version_immutable` (SQLSTATE 23001).
- `recipe_ingredients_guard`: rechaza INSERT/UPDATE/DELETE de ingredientes cuya versión no sea
  `DRAFT`.
- `recipe_cost_snapshots_reject_mutation`: snapshots y líneas son append-only.

0000 y 0001 no se modificaron en Fase 1. 0002 y 0003 están separadas porque drizzle-kit pide confirmación
interactiva cuando un mismo paso agrega y quita columnas; además así el traslado de datos corre
antes del borrado.

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

| Comando                                    | Qué hace                                                                                                                       | Entornos            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `pnpm db:sync-reference`                   | Upsert del catálogo de permisos y de los roles de sistema de cada empresa                                                      | Todos (idempotente) |
| `pnpm db:seed`                             | Empresa demo aprovisionada + admin + maestros de ejemplo (Supermercado Demo, Molino Demo, Harina 000, Pan francés, categorías) | Solo desarrollo     |
| `pnpm --filter @bakery/api company:create` | Alta de una empresa real y su primer administrador (datos por variables de entorno)                                            | Todos               |

Toda empresa se crea con `provisionCompany` (roles de sistema, unidades estándar y Depósito
Principal), la misma función que usan el seed, el alta y los tests.

Ningún código productivo depende de los datos del seed.

## Tablas previstas por fase

No se crean hasta su fase (cada una con su migración):

| Fase | Tablas                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| 3    | `purchases`, `purchase_items`, `stock_movements` (+ saldo cacheado opcional con reconciliación)                                  |
| 4    | `production_orders`, `production_cost_snapshots`                                                                                 |
| 5    | `price_lists`, `price_list_items` (+ `customers.price_list_id`), `sales`, `sale_items`, `customer_account_movements`, `payments` |
| 6    | `supplier_account_movements`, `cash_accounts`, `cash_movements`, `expenses`, `expense_categories`                                |
| 7    | `invoices`, `invoice_items`                                                                                                      |

## Operación local

- `pnpm db:up` levanta `postgres:16-alpine` (usuario/clave `bakery`/`bakery`, base `bakery_erp`,
  puerto host **5433**, volumen `pgdata`).
- `pnpm db:reset` borra el volumen y recrea todo desde cero.
- Tests de integración usan `bakery_erp_test` (se crea sola). Por seguridad, los tests se niegan a
  correr contra una base cuyo nombre no termine en `_test`.
