# Base de datos

PostgreSQL 16. ORM **Drizzle** con migraciones SQL versionadas generadas por `drizzle-kit`.

## Convenciones

- Nombres de tablas y columnas en `snake_case` plural (`audit_logs`, `company_id`).
- PK `uuid` con `gen_random_uuid()`. Excepción: `audit_logs.id` es `bigserial` (alto volumen,
  orden natural de inserción).
- `created_at` / `updated_at` como `timestamptz` en UTC.
- Enums de PostgreSQL para estados y tipos (`employee_status`, `user_status`, `membership_status`,
  `customer_type`, `unit_dimension`, `category_type`, `purchase_status`, `stock_movement_type`, …).
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

## Tablas (Fases 0 a 5A)

| Tabla                            | Propósito                                               | Claves / índices relevantes                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `companies`                      | Empresa                                                 | PK; `active`                                                                                                                                                                                                                                                                                                                                                           |
| `users`                          | Identidad global de acceso                              | **único `lower(email)`**                                                                                                                                                                                                                                                                                                                                               |
| `company_memberships`            | Usuario ↔ empresa (+ empleado opcional)                 | único (`company_id`, `user_id`); único `employee_id`; FK compuesta a `employees`                                                                                                                                                                                                                                                                                       |
| `membership_roles`               | Roles de una membresía                                  | PK (`membership_id`, `role_id`); FKs compuestas a membresía y rol con `company_id`                                                                                                                                                                                                                                                                                     |
| `roles`                          | Roles por empresa                                       | único (`company_id`, `code`)                                                                                                                                                                                                                                                                                                                                           |
| `permissions`                    | Catálogo global de permisos                             | único `code`                                                                                                                                                                                                                                                                                                                                                           |
| `role_permissions`               | N:M rol ↔ permiso                                       | PK (`role_id`, `permission_id`)                                                                                                                                                                                                                                                                                                                                        |
| `sessions`                       | Sesiones de servidor (una empresa cada una)             | único `token_hash`; `company_id`; índices `user_id`, `expires_at`                                                                                                                                                                                                                                                                                                      |
| `audit_logs`                     | Auditoría solo-inserción                                | índices (`entity_type`, `entity_id`), `actor_user_id`, `created_at`; trigger anti UPDATE/DELETE                                                                                                                                                                                                                                                                        |
| `employees`                      | Personas que trabajan en la empresa                     | único (`company_id`, `employee_code`); único (`company_id`, `document_number`) si no es null; check egreso ≥ ingreso                                                                                                                                                                                                                                                   |
| `code_sequences`                 | Próximo número de código por empresa/tipo               | PK (`company_id`, `entity`)                                                                                                                                                                                                                                                                                                                                            |
| `customers`                      | Clientes                                                | único (`company_id`, `internal_code`); índice (`company_id`, `active`, `legal_name`); check crédito ≥ 0                                                                                                                                                                                                                                                                |
| `suppliers`                      | Proveedores                                             | único (`company_id`, `internal_code`)                                                                                                                                                                                                                                                                                                                                  |
| `units_of_measure`               | Unidades por empresa                                    | único (`company_id`, `lower(code)`); FK compuesta a su base; checks base+factor juntos, factor > 0                                                                                                                                                                                                                                                                     |
| `categories`                     | Categorías de materias primas y productos               | único (`company_id`, `type`, `lower(name)`)                                                                                                                                                                                                                                                                                                                            |
| `raw_materials`                  | Materias primas (sin stock)                             | único (`company_id`, `internal_code`); FKs compuestas a categoría, unidad y proveedor                                                                                                                                                                                                                                                                                  |
| `products`                       | Productos terminados (sin costo)                        | único (`company_id`, `internal_code`); FKs compuestas a categoría y unidad; check precio ≥ 0                                                                                                                                                                                                                                                                           |
| `warehouses`                     | Depósitos                                               | único (`company_id`, `code`)                                                                                                                                                                                                                                                                                                                                           |
| `recipes`                        | Receta de un producto (Fase 2)                          | único (`company_id`, `id`); FK compuesta a producto; único parcial: una receta activa por producto                                                                                                                                                                                                                                                                     |
| `recipe_versions`                | Versiones de receta (Fase 2)                            | único (`recipe_id`, `version_number`); únicos parciales: un ACTIVE y un DRAFT por receta; checks; trigger de inmutabilidad                                                                                                                                                                                                                                             |
| `recipe_ingredients`             | Ingredientes de una versión (Fase 2)                    | único (`recipe_version_id`, `raw_material_id`); FKs compuestas a versión, materia prima y unidad; check cantidad > 0; trigger: sólo en DRAFT                                                                                                                                                                                                                           |
| `recipe_cost_snapshots`          | Costo congelado al publicar (Fase 2)                    | único por versión; check COMPLETE ⇔ totales presentes; trigger append-only                                                                                                                                                                                                                                                                                             |
| `recipe_cost_snapshot_lines`     | Desglose del snapshot (Fase 2)                          | FK al snapshot; trigger append-only                                                                                                                                                                                                                                                                                                                                    |
| `raw_material_presentations`     | Presentaciones de compra por materia prima (Fase 3)     | único (`company_id`, `raw_material_id`, `id`) para la FK de las líneas; único (`company_id`, `raw_material_id`, `lower(name)`); FKs compuestas a materia prima y unidades; check contenido > 0                                                                                                                                                                         |
| `purchases`                      | Compras (Fase 3)                                        | único (`company_id`, `internal_number`); FK compuesta a proveedor; índices (`company_id`, `status`, `purchase_date`), (`company_id`, `purchase_date`), proveedor; checks importes ≥ 0 y fechas coherentes con el estado; trigger: no se borra fuera de `DRAFT`                                                                                                         |
| `purchase_lines`                 | Líneas de compra (Fase 3)                               | único (`purchase_id`, `line_number`); FK compuesta a la compra y a (`company_id`, `raw_material_id`, `presentation_id`); checks pedido > 0, 0 ≤ recibido ≤ pedido, neto = bruto − descuento, descuento ≤ bruto, factor > 0; trigger: sólo cambian en `DRAFT` (después, sólo `received_quantity`)                                                                       |
| `purchase_receipts`              | Recepciones (Fase 3)                                    | único (`company_id`, `internal_number`); FKs compuestas a compra y depósito; check fechas coherentes con el estado; trigger: inmutable fuera de `DRAFT`                                                                                                                                                                                                                |
| `purchase_receipt_lines`         | Líneas recibidas (Fase 3)                               | único (`receipt_id`, `purchase_line_id`); FKs compuestas (`company_id`, `purchase_id`, …) a recepción y línea de compra (no se mezclan compras); checks recibido > 0, valores ≥ 0; trigger: inmutable fuera de `DRAFT`                                                                                                                                                 |
| `stock_movements`                | Ledger de stock (Fase 3)                                | `sequence` bigserial único; **único (`company_id`, `source_line_id`)** si no es null (idempotencia); checks de signo, motivo, ítem y referencia por tipo, saldo ≥ 0; índices por materia prima, depósito, tipo y fecha, y por referencia; trigger append-only                                                                                                          |
| `stock_balances`                 | Saldo por depósito e ítem (Fase 3)                      | únicos parciales (`company_id`, `warehouse_id`, `raw_material_id` / `product_id`); check cantidad ≥ 0; trigger `stock_balances_guard`                                                                                                                                                                                                                                  |
| `raw_material_inventory_costs`   | Costo por materia prima a nivel empresa (Fase 3)        | PK (`company_id`, `raw_material_id`); checks cantidad/valor/promedio ≥ 0 y valor 0 sin existencia; trigger `raw_material_inventory_costs_guard`                                                                                                                                                                                                                        |
| `inventory_cost_history`         | Historial de costo por movimiento (Fase 3)              | `bigserial`; único `movement_id`; índice (`company_id`, `raw_material_id`, `id`); trigger append-only                                                                                                                                                                                                                                                                  |
| `production_orders`              | Orden de producción = lote (Fase 4)                     | único (`company_id`, `internal_code`) y (`company_id`, `batch_code`) si no es null; FKs compuestas a producto, (producto, receta), (receta, versión), depósitos, unidades, responsable y movimiento de salida; índices por estado+fecha, fecha, producto, versión, responsable y `completed_at`; checks de estado/fechas/cantidades; trigger `production_orders_guard` |
| `production_material_lines`      | Plan y consumo real por materia prima (Fase 4)          | FK compuesta a la orden, materia prima, unidades y movimiento de consumo; único (`production_order_id`, `raw_material_id`) para líneas `RECIPE`; índice por materia prima; check `EXTRA` con nota; trigger `production_material_lines_guard`                                                                                                                           |
| `product_inventory_costs`        | Costo material por producto a nivel empresa (Fase 4)    | PK (`company_id`, `product_id`); checks cantidad/valor/promedio ≥ 0 y valor 0 sin existencia; trigger `product_inventory_costs_guard`                                                                                                                                                                                                                                  |
| `product_conservation_settings`  | Conservación por producto (Fase 4.5)                    | PK (`company_id`, `product_id`); estado inicial por defecto; umbral de "próximo a vencer" en minutos (check 1 a 527.040)                                                                                                                                                                                                                                               |
| `product_conservation_profiles`  | Vida útil por producto y estado (Fase 4.5)              | único (`company_id`, `product_id`, `state`); vida útil en minutos (check ≤ 10 años); check "inicial requiere habilitado"                                                                                                                                                                                                                                               |
| `product_lots`                   | Lote de producto terminado (Fase 4.5)                   | único (`company_id`, `lot_code`), (`company_id`, `operation_id`) si no es null y un lote raíz por orden; FKs compuestas a producto, orden, depósito, unidad y lote padre (mismo producto); checks de importes, fechas, vida útil coherente y motivo de bloqueo; trigger `product_lots_guard`                                                                           |
| `product_lot_balances`           | Saldo por lote y depósito (Fase 4.5)                    | único (`company_id`, `warehouse_id`, `product_lot_id`); FK (`company_id`, `product_id`, `product_lot_id`) al lote; checks ≥ 0 y valor 0 sin existencia; trigger `product_lot_balances_guard`                                                                                                                                                                           |
| `product_inventory_cost_history` | Historial de costo de producto por lote (Fase 4)        | `bigserial`; único `movement_id`; FK a la orden de producción; índice (`company_id`, `product_id`, `id`); trigger append-only                                                                                                                                                                                                                                          |
| `customer_orders`                | Pedido de cliente (Fase 5A)                             | único (`company_id`, `internal_code`); FK compuesta a cliente; índices (`company_id`, `requested_at`), (`company_id`, `status`, `requested_at`), (`company_id`, `customer_id`, `requested_at`), (`company_id`, `coverage_status`); trigger `customer_orders_guard` (no se borra, identidad fija, cancelado inmutable, `plan_revision` no retrocede)                    |
| `customer_order_lines`           | Productos del pedido (Fase 5A)                          | FKs compuestas a pedido, producto y unidades; índices por pedido y por producto; check cantidad > 0; trigger: se borran sólo en borrador, después `removed_at`                                                                                                                                                                                                         |
| `customer_order_operations`      | Idempotencia de confirmar / replan / cancelar (Fase 5A) | único (`company_id`, `operation_id`); FK al pedido; append-only                                                                                                                                                                                                                                                                                                        |
| `product_lot_reservations`       | Reserva de lote por pedido y revisión (Fase 5A)         | FKs compuestas a pedido, (pedido, línea), (producto, línea) y (producto, lote); índice parcial por lote `WHERE status = 'ACTIVE'`; índice (`company_id`, pedido, revisión); triggers `product_lot_reservations_guard` y `_capacity`                                                                                                                                    |
| `order_production_requirements`  | Lo que falta producir por línea y revisión (Fase 5A)    | FKs compuestas a pedido, línea, (producto, receta), (receta, versión) y orden de producción; índices por pedido+revisión, producto+estado y orden vinculada; trigger `order_production_requirements_guard`                                                                                                                                                             |
| `order_material_requirements`    | Materia prima proyectada por necesidad (Fase 5A)        | único (necesidad, materia prima); índices por materia prima y por pedido; append-only                                                                                                                                                                                                                                                                                  |

Tipos numéricos: dinero `numeric(14,2)`, costo por unidad base `numeric(18,6)`, cantidades
`numeric(18,4)`, factores de conversión `numeric(24,10)`. Fase 2: cantidades de receta
`numeric(18,6)`, cantidades normalizadas `numeric(28,10)`, costos calculados `numeric(20,6)`,
porcentajes `numeric(7,4)`. Fase 3: cantidades de compra `numeric(18,4)`, cantidades de stock en
unidad base y factores congelados `numeric(28,10)`, precios `numeric(18,6)`, importes, costos,
valores y promedio `numeric(20,6)`. Fase 4: cantidades ingresadas `numeric(18,6)`, cantidades del plan,
normalizadas y factor de escala `numeric(28,10)`, costos `numeric(20,6)`, variación porcentual
`numeric(20,4)`, merma teórica `numeric(7,4)`.
`stock_movements` y `stock_balances` ya eran genéricos desde 0006 (`item_type` + exactamente uno de
`raw_material_id` / `product_id`): Fase 4 los usa para productos sin migrar datos; sólo agrega
índices por producto y por tipo de ítem. Fase 4.5 agrega `stock_movements.product_lot_id`
(obligatorio en todo movimiento de producto: check `stock_movements_product_lot`, FK compuesta
`(company_id, product_id, product_lot_id)`) y los tipos `LOT_TRANSFORMATION_OUT` /
`LOT_TRANSFORMATION_IN`; la merma de producto (`WASTE`) referencia el lote. Fase 5A agrega
`production_orders.source_order_requirement_id` (opcional, FK compuesta a la necesidad del pedido)
y cantidades de pedido `numeric(18,6)` (ingresadas) y `numeric(28,10)` (normalizadas, reservas y
necesidades).

`sessions` no estaba en la lista mínima de la especificación: es la tabla de sesiones que requiere
la solución de auth elegida (sesiones de servidor revocables). Ver DECISIONS (ADR-005).

## Migraciones

| Archivo                             | Contenido                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000_foundation.sql`               | Enums, las 9 tablas fundacionales, FKs e índices                                                                                                                                                                                                                                   |
| `0001_audit_logs_append_only.sql`   | Función y trigger que rechazan UPDATE/DELETE sobre `audit_logs`                                                                                                                                                                                                                    |
| `0002_company_membership.sql`       | Fase 1: `company_memberships`, `membership_roles`, `sessions.company_id`; cierra las sesiones abiertas y traslada los datos (una membresía por usuario con su empleado y roles)                                                                                                    |
| `0003_drop_single_company_user.sql` | Fase 1: elimina `users.company_id`, `users.employee_id` y `user_roles`, ya trasladados                                                                                                                                                                                             |
| `0004_masters.sql`                  | Fase 1: completa `companies` y `employees` (legajo con backfill `EMP-0001…`, estado `ON_LEAVE` → `ACTIVE`), crea `code_sequences` y los maestros                                                                                                                                   |
| `0005_recipes.sql`                  | Fase 2: renombra `raw_materials.current_cost` → `reference_cost` (+ origen y fecha), agrega `UNIQUE (company_id, id)` a productos y materias primas, crea las 5 tablas de recetas y los triggers de inmutabilidad y append-only                                                    |
| `0006_purchases_inventory.sql`      | Fase 3: enums `purchase_status`, `purchase_receipt_status`, `stock_item_type`, `stock_movement_type`; las 9 tablas de compras e inventario con FKs compuestas, checks e índices; triggers del ledger, de las proyecciones y de compras/recepciones                                 |
| `0007_production.sql`               | Fase 4: enum `production_order_status` y `production_line_type`; `PRODUCTION_CONSUMPTION` y `PRODUCTION_OUTPUT` en `stock_movement_type`; las 4 tablas de producción y costo de producto; checks del ledger para tipos productivos; triggers de producción y del costo de producto |
| `0008_product_lots.sql`             | Fase 4.5: enums `conservation_state` y `lot_quality_status`; `LOT_TRANSFORMATION_OUT/IN`; las 4 tablas de conservación y lotes; `stock_movements.product_lot_id`; triggers de lotes y saldos de lote; reconstrucción de un lote por orden completada con chequeos BLOCKER          |
| `0009_customer_orders.sql`          | Fase 5A: enums de pedidos, cobertura, prioridad, reservas y necesidades; las 6 tablas de pedidos; `production_orders.source_order_requirement_id`; triggers de guarda, capacidad de reservas (Σ activas ≤ saldo, lote bloqueado sin reservas) e índices de planificación           |

0000–0004 no se modificaron en Fase 2: todo cambio va en 0005. 0000–0005 no se modificaron en
Fase 3: todo cambio va en 0006, generada por drizzle-kit desde el esquema
(`packages/database/src/schema/purchasing.ts` e `inventory.ts`) con los triggers y funciones
agregados a mano al final del mismo archivo.

0000–0006 no se modificaron en Fase 4: todo va en 0007. El migrador de Drizzle aplica las
migraciones pendientes en **una** transacción y Postgres no deja usar un valor de enum agregado
con `ADD VALUE` en la misma transacción; por eso los checks nuevos comparan
`movement_type::text`. Probado sobre base vacía (`pnpm db:reset`) y sobre una base en 0006 con
datos de Fase 3 (`migration-fase3.test.ts`: movimientos, saldos, costos e historial idénticos y
Σ movimientos = saldo después de migrar).

0000–0007 no se modificaron en Fase 4.5: todo va en 0008. La migración reconstruye los lotes desde
los datos de Fase 4 sin inventar procedencia: antes de tocar nada verifica que todo movimiento de
producto sea un `PRODUCTION_OUTPUT` de una orden `COMPLETED` (si no, `RAISE EXCEPTION
'FASE_4_5_MIGRATION_BLOCKER: …'` y no se aplica nada); crea un lote raíz `FRESH` sin vencimiento
por orden completada (código = `batch_code` o `LOT-<código de la orden>`, nota "migrado"), completa
`product_lot_id` en esos movimientos (única escritura sobre el ledger: el trigger append-only se
suspende sólo para esa sentencia dentro de la transacción), carga los saldos de lote con el
trigger activo y vuelve a verificar Σ lotes = saldo agregado = costo de inventario (cantidad y
valor). Probado sobre base vacía, sobre datos reales de Fase 4 (antes/después idénticos) y en
`migration-fase4.test.ts` (100 kg + 50 kg → 2 lotes; caso BLOCKER).

**Triggers de Fase 2** (la base no depende sólo del servicio):

- `recipe_versions_guard`: un `DRAFT` se edita y se borra libremente; `ACTIVE` → `ARCHIVED` se
  permite sólo si no cambia nada más que estado, `archived_at` y `updated_at`; cualquier otro
  UPDATE o DELETE de una versión publicada falla con `recipe_version_immutable` (SQLSTATE 23001).
- `recipe_ingredients_guard`: rechaza INSERT/UPDATE/DELETE de ingredientes cuya versión no sea
  `DRAFT`.
- `recipe_cost_snapshots_reject_mutation`: snapshots y líneas son append-only.

**Triggers de Fase 3** (fallan con SQLSTATE 23001 `restrict_violation`):

- `stock_movements_append_only` e `inventory_cost_history_append_only`: rechazan UPDATE y DELETE.
  Las correcciones son movimientos nuevos.
- `stock_balances_guard`: un saldo nace en cero sin movimiento (para poder bloquearlo) y no se
  borra; cada UPDATE debe apuntar a un movimiento **nuevo** (secuencia mayor que la del último
  aplicado) de la misma empresa, depósito e ítem, y la cantidad nueva debe ser exactamente la
  anterior + la del movimiento (e igual a su `balance_after`). La identidad del saldo no cambia.
- `raw_material_inventory_costs_guard`: lo mismo para el costo de empresa: nace vacío, no se
  borra, y cantidad y valor cambian exactamente lo que dice un movimiento nuevo de esa materia
  prima.
- `purchases_guard`: una compra que salió de `DRAFT` no se borra.
- `purchase_lines_guard`: con la compra fuera de `DRAFT`, las líneas no se agregan, borran ni
  modifican, salvo `received_quantity`.
- `purchase_receipts_guard` y `purchase_receipt_lines_guard`: una recepción `POSTED` o
  `CANCELLED` y sus líneas son inmutables.

**Triggers de Fase 4** (SQLSTATE 23001):

- `production_orders_guard`: transiciones válidas (`DRAFT → PLANNED → IN_PROGRESS → COMPLETED`,
  cancelación antes de completar); desde `PLANNED` sólo cambian estado, responsable, lote, notas,
  tiempos y lo real; la salida real sólo en curso; el costo real sólo al completar; `COMPLETED` y
  `CANCELLED` no cambian; sólo un `DRAFT` se borra.
- `production_material_lines_guard`: el plan no cambia desde `PLANNED`; en curso sólo cambian los
  consumos reales y se agregan o quitan líneas `EXTRA`; con la orden cerrada, nada.
- `product_inventory_costs_guard` y `product_inventory_cost_history_append_only`: mismo contrato
  que el costo de materias primas (proyección exacta de un movimiento nuevo; historial append-only).

**Triggers de Fase 4.5** (SQLSTATE 23001):

- `product_lots_guard`: un lote no se borra; sólo cambian `quality_status`, `quality_reason`,
  `notes` y `updated_at` (cantidad inicial, costo, estado de conservación y vencimiento son
  históricos: una transformación crea otro lote).
- `product_lot_balances_guard`: mismo contrato que `stock_balances` (nace en cero, cambia
  exactamente lo que dice un movimiento nuevo de ese lote y depósito, cantidad y valor).

**Triggers de Fase 5A** (SQLSTATE 23001):

- `customer_orders_guard` / `customer_order_lines_guard`: un pedido no se borra (se cancela), un
  pedido cancelado no cambia, la revisión no retrocede; las líneas de un pedido confirmado no se
  borran ni cambian de producto.
- `product_lot_reservations_guard`: una reserva no se borra; sólo pasa de `ACTIVE` a `RELEASED`,
  `INVALIDATED` o `FULFILLED`; cantidad, lote y revisión fijos.
- `product_lot_reservations_capacity`: al crear una reserva activa, el lote no está bloqueado y Σ
  reservas activas ≤ saldo. `product_lot_balances_reserved`: el saldo de un lote nunca baja de lo
  reservado. `product_lots_blocked_reserved`: un lote bloqueado no conserva reservas activas. No son
  diferibles: merma y bloqueo invalidan antes (ADR-053).
- `order_production_requirements_guard`: necesidades inmutables salvo estado, orden vinculada y
  cierre; `order_material_requirements` y `customer_order_operations` append-only.

0000–0008 no se modificaron en Fase 5A: todo va en 0009 (sólo tablas nuevas y una columna
opcional, no hay datos que migrar). Probado sobre base vacía y sobre una base en 0008 con lotes de
Fase 4.5 (`migration-fase4.test.ts`): lotes, saldos, ledger y órdenes idénticos; las tablas de
pedidos nacen vacías. Empresas existentes: `pnpm db:sync-reference` agrega los permisos nuevos a
los roles de sistema.

`TRUNCATE` no dispara estos triggers: queda para los tests.

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
| 5B   | `price_lists`, `price_list_items` (+ `customers.price_list_id`), `sales`, `sale_items`, `customer_account_movements`, `payments` |
| 6    | `supplier_account_movements`, `cash_accounts`, `cash_movements`, `expenses`, `expense_categories`                                |
| 7    | `invoices`, `invoice_items`                                                                                                      |

## Operación local

- `pnpm db:up` levanta `postgres:16-alpine` (usuario/clave `bakery`/`bakery`, base `bakery_erp`,
  puerto host **5433**, volumen `pgdata`).
- `pnpm db:reset` borra el volumen y recrea todo desde cero.
- Tests de integración usan `bakery_erp_test` (se crea sola). Por seguridad, los tests se niegan a
  correr contra una base cuyo nombre no termine en `_test`.
