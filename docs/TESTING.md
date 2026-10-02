# Estrategia de testing

## Niveles

| Nivel       | Herramienta                 | Dónde                                       | Base de datos                     |
| ----------- | --------------------------- | ------------------------------------------- | --------------------------------- |
| Unitario    | Vitest                      | `*/test/**/*.test.ts`, `apps/api/test/unit` | No                                |
| Integración | Vitest + `fastify.inject()` | `apps/api/test/integration`                 | PostgreSQL real `bakery_erp_test` |
| E2E / smoke | Playwright (Chromium)       | `e2e/`                                      | Base de desarrollo migrada + seed |

Principios:

- **Lógica de negocio → unit tests** (conversiones, costos, promedio ponderado, recetas, máquinas
  de estado). Funciones puras sin base.
- **Transacciones críticas → integración contra PostgreSQL real**, nunca mocks de base: compras,
  producción (incluido rollback provocado), ventas, cuentas corrientes, caja.
- **Flujos de negocio completos → E2E.**
- **Regresión:** cada bug corregido agrega un test cuando es razonable.
- No se usan mocks como comportamiento productivo.

## Cómo correr

```bash
pnpm db:up          # PostgreSQL debe estar arriba
pnpm test           # unit + integración de todos los paquetes
pnpm test:e2e       # build + Playwright (requiere `pnpm bootstrap` previo: migraciones + seed)
pnpm docs:permissions  # regenera la matriz de docs/PERMISSIONS.md si cambian roles o permisos
```

Por paquete: `pnpm --filter @bakery/api test:unit`, `pnpm --filter @bakery/api test:integration`.

La base de test se crea y migra automáticamente (`apps/api/test/integration/global-setup.ts`).
Cada archivo de integración trunca las tablas y carga una fixture propia: Empresa A ("Panadería
Test", aprovisionada con roles, unidades y depósito) con un ADMIN y un usuario de VENTAS, y
Empresa B ("Panadería Otra") con su ADMIN para las pruebas de aislamiento. Los archivos corren en serie. Protección: los tests se
niegan a correr si `DATABASE_URL_TEST` no apunta a una base terminada en `_test`.

Playwright usa el Chromium del sistema si `PLAYWRIGHT_CHROMIUM_EXECUTABLE` está definido; si no,
el de `playwright install chromium`. Corre en dos viewports: desktop y tablet (820×1180).

## Cobertura de Fase 5B

Para iterar sólo sobre ventas: `pnpm --filter @bakery/domain exec vitest run test/sales.test.ts`,
`pnpm --filter @bakery/api exec vitest run test/integration/sales.test.ts
test/integration/sales-concurrency.test.ts` y `pnpm exec playwright test e2e/fase5b-ventas.spec.ts`.

| Suite             | Archivo(s)                                                                                                           | Tests | Qué cubre                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain (unit)     | `packages/domain/test/sales.test.ts`                                                                                 |    21 | Prioridad de precios, importes y descuentos con redondeo, override, margen sobre materiales (negativo y sin costo), costo por lote y promedio derivado, FEFO de venta sin tocar lo comprometido, entregable vs pendiente, estado de entrega del pedido, estado de cobro, aplicación de señas por antigüedad y tope de imputación                                                                                                                                                                                                                                                                                                        |
| api (integración) | `sales.test.ts`                                                                                                      |    26 | Venta directa FEFO de dos lotes (costo 90.384, stock y promedio después), idempotencia del posteo, stock insuficiente, borrador descartado; listas de precios (prioridad, una sola general, override 403/422/MANUAL, margen negativo); pedido con precio congelado, seña, entrega parcial con seña aplicada sola, resto y pedido entregado; cobro a cuenta e imputación manual; ajuste; pedidos `UNPRICED` y "Acordar precio"; cancelar con seña avisa crédito; `ORDER_CLOSED`; límite de crédito sólo avisa y audita; cobro inicial (sobrepago 422); visibilidad de costo y margen por rol; tenencia; Consumidor Final no se desactiva |
| api (integración) | `sales-concurrency.test.ts`                                                                                          |     8 | 70 + 70 sobre 100, reserva y venta directa a la vez, confirmar pedido y vender a la vez, cobros paralelos `[201, 422]`, mismo `operationId` ×3, operaciones mezcladas de un cliente (saldo exacto), posteo ×5 `[200, 409×4]`, rollback con falla inyectada en el débito                                                                                                                                                                                                                                                                                                                                                                 |
| api (integración) | `migration-fase4.test.ts`, `migration-fase3.test.ts`, `authorization.test.ts`, `database.test.ts`, `masters.test.ts` |       | 0010 sobre datos de 5A: pedidos `UNPRICED`, un Consumidor Final por empresa, promedio = valor / cantidad, tablas nuevas vacías; endpoints 5B en la matriz rol × endpoint (cobro inicial exige `payments.create` + `payments.post`); 9 tablas nuevas; 11 migraciones                                                                                                                                                                                                                                                                                                                                                                     |
| web (unit)        | `apps/web/test/navigation.test.ts`, `apps/web/test/format.test.ts`                                                   |       | Comercial → Ventas y Listas de precios, Finanzas → Cuentas a cobrar según permiso; signo antes de la moneda                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| E2E               | `e2e/fase5b-ventas.spec.ts`                                                                                          |     3 | Pedido con seña → entrega parcial (vista previa y «Confirmar entrega y venta») → cobro → resto → cuenta corriente con cobro a cuenta e imputación; mostrador con Consumidor Final, lotes FEFO, precio cambiado con motivo, margen negativo y cobro en el momento; lista de precios asignada al cliente y ajuste de saldo. Desktop y tablet. `smoke`, `fase1-maestros` y `fase5a-pedidos` se actualizaron a las pantallas reales                                                                                                                                                                                                         |

Totales: ver [reports/FASE_5B_REPORTE.md](reports/FASE_5B_REPORTE.md).

## Cobertura de Fase 5A

Para iterar sólo sobre pedidos: `pnpm --filter @bakery/domain exec vitest run test/orders.test.ts`,
`pnpm --filter @bakery/api exec vitest run test/integration/orders.test.ts
test/integration/orders-access.test.ts` y `pnpm exec playwright test e2e/fase5a-pedidos.spec.ts`.

| Suite             | Archivo(s)                                                                                        | Tests | Qué cubre                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain (unit)     | `packages/domain/test/orders.test.ts`                                                             |    24 | Máquina de estados (gate D) y qué estados son demanda, código `PED-0001`, §4/§5/§72 físico 700 → elegible 400 → comprometido 100 → disponible 300 → reserva 300 / producir 200, AVAILABLE = ELIGIBLE − COMMITTED con varios lotes, lotes bloqueados o vencidos, vida útil desconocida, conservación pedida, FEFO (vencimiento, producción, código; nunca más que lo libre), cobertura y READY, §73 materias primas desde la receta, §74 demanda global 7 + 5 contra 10, §82 merma que invalida y §83 transformable = saldo − comprometido                                                                                                                                                                                                                                                                                                                                                                                  |
| shared (unit)     | `packages/shared/test/timezone.test.ts`                                                           |     5 | §84 10/10/2026 10:00 en Buenos Aires ↔ 13:00 UTC, otra zona da otro instante, horario de verano, cambio de día y de año, formato y fechas inexistentes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| api (integración) | `orders.test.ts`                                                                                  |    23 | Borrador sin reservas y con la hora de la empresa; vista previa que explica y no escribe; confirmar reserva FEFO por lote sin movimientos y con receta fijada; §73 segundo pedido sobre lo comprometido; materia prima sólo proyectada; disponibilidad y resumen de stock con comprometido; idempotencia; GET sin escrituras; conservación pedida; sin receta (sin cubrir, sin ingredientes inventados); demanda global con horizonte; replan por cantidad y §78 por fecha (lote fresco liberado, congelado reservado, historia por revisión); cancelación y stock liberado que sólo avisa; LISTO con cobertura completa y cancelación con advertencia; edición sólo informativa; congelar lo comprometido (`LOT_QUANTITY_COMMITTED`), merma parcial y bloqueo que invalidan; orden de producción desde la necesidad (prellenado, vínculo, sin duplicar, completar / cancelar); guardas de base; ningún pedido mueve stock |
| api (integración) | `orders-access.test.ts`                                                                           |    11 | Concurrencia 70 + 70 sobre 100 (nunca 140), cancelar y replanificar a la vez, reintentos simultáneos con el mismo `operationId`, merma y confirmación a la vez; rollback con falla inyectada en la auditoría; tenencia empresa B; permisos por rol (Ventas, Producción sin datos de contacto, Depósito, Administración, lote sin cliente sin `customers.read`); hora en una empresa en Tokio (Gate Q)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| api (integración) | `migration-fase4.test.ts`, `authorization.test.ts`, `database.test.ts`, `migration-fase3.test.ts` |       | Gate B: base en 0008 con lotes de Fase 4.5 → 0009 deja lotes, saldos, ledger y órdenes idénticos; endpoints de pedidos y planificación en la matriz rol × endpoint (crear producción desde una necesidad exige ambos permisos); 6 tablas nuevas; 10 migraciones aplicadas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| web (unit)        | `apps/web/test/navigation.test.ts`                                                                |       | Comercial → Pedidos y Planificación → Necesidades según permiso                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| E2E               | `e2e/fase5a-pedidos.spec.ts`                                                                      |     3 | Navegador en Tokio y empresa en Buenos Aires. Principal (alta con vista previa explicada, borrador, confirmar, lotes reservados, producción y materias primas, segundo pedido que no reutiliza lo comprometido, orden de producción prellenada y vinculada, auditoría, comprometido / libre en el lote y en el stock, Necesidades), replan (cancelar un pedido libera, el otro avisa, cambio de fecha con antes/después y revisión 2, listo, cancelar listo con advertencia) y calidad (congelar sólo lo libre, bloquear invalida, "Necesita recalcular", actualizar cobertura); desktop y tablet, sin errores de consola ni UUIDs. `fase4-5-lotes.spec.ts` carga la disponibilidad a una fecha con el selector nuevo                                                                                                                                                                                                      |

Totales: ver [reports/FASE_5A_REPORTE.md](reports/FASE_5A_REPORTE.md).

## Cobertura de Fase 4.5

Para iterar sólo sobre lotes: `pnpm --filter @bakery/domain exec vitest run test/lots.test.ts`,
`pnpm --filter @bakery/api exec vitest run test/integration/product-lots.test.ts
test/integration/migration-fase4.test.ts` y `pnpm exec playwright test e2e/fase4-5-lotes.spec.ts`.

| Suite             | Archivo(s)                                                             | Tests | Qué cubre                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain (unit)     | `packages/domain/test/lots.test.ts`                                    |    30 | Transiciones (no recongelar), vida útil en minutos (horas/días, límites), estado inicial (perfil, por defecto, no permitido), `lotOutflow` (costo del lote, agotamiento exacto), `applyLotMovement` (promedio intacto), elegibilidad (agotado > bloqueado > vencido, borde `at = usable_until`), próximo a vencer, FEFO (nulos al final), §18/§54 disponibilidad 700 → 400 el sábado, códigos de lote hijo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| api (integración) | `product-lots.test.ts`                                                 |    25 | Lote al completar (código, estado, vencimiento, movimiento con lote, auditoría), estado inicial elegido / no permitido / sin perfil, perfil (alta, cambio, auditoría sólo con cambios, validación, lotes existentes intactos), §52 congelar 300 de 500 (hijo, valores, promedio), §53 descongelar y no recongelar, cantidades inválidas, agotado, §54 disponibilidad y FEFO, próximos a vencer, resumen por estado, §55 merma al costo del lote, bloqueo / desbloqueo, idempotencia (replay 200, `OPERATION_ID_REUSED`), concurrencia 300 + 300 sobre 500 (una 409) y mismo `operationId` en paralelo, rollback (falla inyectada en auditoría), tenencia empresa B, Depósito sin importes, Producción sin merma, Ventas sin lotes, guardas de base (borrar / cambiar lote, saldo directo, movimiento de producto sin lote). Reconciliación Σ lotes = agregado = costo después de cada operación |
| api (integración) | `migration-fase4.test.ts`                                              |     2 | §51 Gate B: base en 0007 con 100 kg + 50 kg completados (uno sin lote) → 2 lotes raíz, Σ = 150, valor y promedio idénticos, ledger intacto; stock de producto sin orden completada → `FASE_4_5_MIGRATION_BLOCKER` y nada aplicado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| api (integración) | `authorization.test.ts`, `database.test.ts`, `migration-fase3.test.ts` |       | 10 endpoints nuevos en la matriz rol × endpoint; 4 tablas nuevas; 9 migraciones aplicadas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| E2E               | `e2e/fase4-5-lotes.spec.ts`                                            |     3 | Principal (configurar conservación, producir con el diálogo, lote enlazado, congelar 30, descongelar 10 con advertencia y sin recongelar, merma 5, ficha con stock por estado, lotes FEFO y disponibilidad a 3 días: 20 utilizables de 95), producto no congelable (sin "Congelar", acceso directo explicado) y vencimiento (lote de 2 h en Próximos a vencer, fuera de la disponibilidad a 2 días); desktop y tablet, sin errores de consola ni UUIDs                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Totales: ver [reports/FASE_4_5_REPORTE.md](reports/FASE_4_5_REPORTE.md).

## Cobertura de Fase 4

Mismos comandos (`pnpm test`, `pnpm test:e2e`). Para iterar sólo sobre producción:
`pnpm --filter @bakery/domain test`, `pnpm --filter @bakery/api exec vitest run
test/integration/production` y `pnpm exec playwright test e2e/fase4-produccion.spec.ts`.

| Suite             | Archivo(s)                                  | Tests | Qué cubre                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain (unit)     | `packages/domain/test/production.test.ts`   |    20 | §64–65: máquina de estados, escala (200 kg → 150 kg harina / 1,6 kg sal), plan y costo esperado (completo e incompleto), unidades compatibles (1.950 g), variación de consumo (+2,5 kg / +3,33 %), rendimiento (96 kg → −4 %), costo real y unitario (100.000 / 90 = 1.111,11), promedio de producto (100 @ 1.000 + 100 @ 1.200 = 1.100), extras, faltantes agregados, lote                                                                                      |
| shared (unit)     | `packages/shared/test/production.test.ts`   |     6 | Esquemas (cantidad > 0, extra con motivo, salida con unidad), DTOs sin costos (`withoutProductionCosts`) y permisos por rol                                                                                                                                                                                                                                                                                                                                      |
| database (unit)   | `packages/database/test/schema.test.ts`     |       | Las 4 tablas nuevas, sin float                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| web (unit)        | `apps/web/test/navigation.test.ts`          |       | Producción → Órdenes (con `production_orders.read`) antes de Recetas                                                                                                                                                                                                                                                                                                                                                                                             |
| api (integración) | `production.test.ts`                        |    29 | Flujo principal §66 (75.400 esperado; 77.400 real; 806,25/kg; harina 123 kg, sal 9,2 kg; producto 96 kg; idempotencia e inmutabilidad en API y base), §67 receta fijada, §68 promedio de producto, unidades (g → kg), §69 extra de aceite, §70 faltante (planificar sí, iniciar no, completar revalida), §73 rollback, vista previa, máquina de estados, cancelación, edición por estado, lote, §46–47 producto/materia prima inactivos, listados, Σ movimientos |
| api (integración) | `production-concurrency.test.ts`            |     3 | §71 dos órdenes por 70 kg con 100 kg (una 409, quedan 30), §72 `[200, 409, 409]` con un único juego de movimientos, cuatro órdenes con las mismas materias primas sin deadlocks                                                                                                                                                                                                                                                                                  |
| api (integración) | `production-access.test.ts`                 |     7 | §74 tenencia (producto, depósitos, versión, responsable, unidad, extras y líneas de otra empresa; 404; FKs compuestas) y §50–51 visibilidad de costos por rol                                                                                                                                                                                                                                                                                                    |
| api (integración) | `migration-fase3.test.ts`                   |     1 | Gate B: base en 0006 con datos de Fase 3 → 0007 sin cambios en movimientos, saldos, costos e historial; Σ movimientos = saldo                                                                                                                                                                                                                                                                                                                                    |
| api (integración) | `authorization.test.ts`, `database.test.ts` |       | Endpoints de producción y de stock de producto en la matriz rol × endpoint; tablas de Fases 0 a 4                                                                                                                                                                                                                                                                                                                                                                |
| E2E               | `e2e/fase4-produccion.spec.ts`              |     2 | §75 flujo principal (crear con vista previa, planificar, iniciar, real con coma decimal y extra, revisar, completar, plan vs real, movimientos, auditoría, stock y costo del producto, margen, movimientos filtrados) y §76 faltante → compra recibida → iniciar; desktop y tablet, sin errores de consola ni UUIDs                                                                                                                                              |

Totales (`pnpm test` desde base vacía): domain 95, shared 37, web 19, database 5, api 289 →
**445 tests, 0 fallos**. E2E: **26/26** (Fases 0–4, desktop + tablet).

## Cobertura de Fase 3

Se corren con los mismos comandos: `pnpm test` (unit + integración) y `pnpm test:e2e`. Para
iterar sólo sobre esta fase: `pnpm --filter @bakery/domain test`,
`pnpm --filter @bakery/api test:integration` y
`pnpm exec playwright test e2e/fase3-compras-inventario.spec.ts` (con el build y la base de
desarrollo migrada + seed, como el resto de los E2E).

| Suite             | Archivo(s)                                  | Tests | Qué cubre                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| domain (unit)     | `packages/domain/test/inventory.test.ts`    |    23 | Presentaciones (4 bolsas × 25 kg = 100 kg; Paquete 500 g → 0,5 kg; bolsa sin presentación rechazada), importes y adquisición (4 × $20.000 / 100 kg = $800/kg, descuento, impuestos fuera del costo), promedio (100 @ $1.000 + 100 @ $1.200 = 200 @ $1.100; stock en cero; redondeo a 6), salidas (90 kg @ $1.000), sin stock negativo, stock inicial y ajuste positivo, signo, OK/LOW/OUT_OF_STOCK, costo efectivo |
| shared (unit)     | `packages/shared/test/permissions.test.ts`  |       | Formato `modulo.accion` o `modulo.recurso.accion` (`inventory.cost.read`); `PERMISSIONS.md` al día con los permisos nuevos                                                                                                                                                                                                                                                                                         |
| database (unit)   | `packages/database/test/schema.test.ts`     |       | Las 9 tablas nuevas en el esquema, sin float                                                                                                                                                                                                                                                                                                                                                                       |
| web (unit)        | `apps/web/test/navigation.test.ts`          |       | Compras y Stock en el menú sólo con `purchases.read` / `inventory.read`                                                                                                                                                                                                                                                                                                                                            |
| api (integración) | `purchases-inventory.test.ts`               |    32 | Escenario principal (§61), salidas/ajustes/stock negativo, descuentos e impuestos, receta + inventario (§62), recepción parcial (§63), idempotencia (§64), rollback (§65), cancelación y edición por estado, listados paginados                                                                                                                                                                                    |
| api (integración) | `inventory-invariants.test.ts`              |    19 | Invariantes 1–17 en la API y en la base (escritura directa rechazada por trigger, CHECK, UNIQUE o FK) y concurrencia (21)                                                                                                                                                                                                                                                                                          |
| api (integración) | `inventory-tenancy.test.ts`                 |     9 | Empresa A/B en compras, recepciones, presentaciones, stock, movimientos, costos y operaciones manuales (422/404), FKs compuestas en la base                                                                                                                                                                                                                                                                        |
| api (integración) | `authorization.test.ts`, `database.test.ts` |       | 25 endpoints nuevos (presentaciones, compras, recepciones, inventario) en la matriz rol × endpoint; tablas de Fases 0 a 3                                                                                                                                                                                                                                                                                          |
| E2E               | `e2e/fase3-compras-inventario.spec.ts`      |     2 | Flujo de 21 pasos y stock mínimo, sin errores de consola, en desktop y tablet                                                                                                                                                                                                                                                                                                                                      |

**Escenarios de integración principales** (`purchases-inventory.test.ts`):

- **Principal (§61):** harina con referencia manual $900/kg; stock inicial 100 kg @ $1.000 (una
  sola vez por depósito); compra de 4 bolsas × 25 kg a $30.000 la bolsa → 100 kg a $1.200/kg; al
  confirmar: 200 kg, $220.000, promedio $1.100; la referencia sigue en $900 y las recetas usan
  $1.100; historial de costo con dos cambios; movimientos con signo y saldo posterior.
- **Receta + inventario (§62):** el snapshot publicado con la referencia queda intacto, el costo
  actual pasa al promedio y una versión nueva guarda `PURCHASE_MOVING_AVERAGE` como origen.
- **Recepción parcial (§63):** 6 de 10 → `PARTIALLY_RECEIVED` con 4 pendientes; recibir 5 se
  rechaza; los 4 restantes → `RECEIVED`; otra recepción se rechaza; un borrador que excede lo
  pendiente al momento de confirmar se rechaza (lo pendiente se revalida al confirmar).
- **Idempotencia (§64):** confirmar dos veces → `409 ALREADY_POSTED`, sin segundo movimiento ni
  auditoría.
- **Rollback (§65):** un trigger temporal sobre `audit_logs` hace fallar la auditoría
  `PURCHASE_RECEIPT_POSTED`, el último paso de la confirmación (500); se verifica que no quedaron
  movimientos, que saldo, valor y promedio siguen como antes, que la compra sigue `ORDERED` y la
  recepción `DRAFT`, y que no hay auditoría de promedio ni de la recepción. Sin la falla, la misma
  recepción se confirma normalmente.
- **Concurrencia (`inventory-invariants.test.ts`, 21):** tres confirmaciones simultáneas de la
  misma recepción (una aplica, las otras 409); cuatro recepciones y tres mermas simultáneas de la
  misma materia prima en dos depósitos (el historial de costo encadena "antes" con "después", sin
  actualizaciones perdidas); mermas simultáneas que juntas superan el stock (sólo pasan las que
  alcanzan, nunca queda negativo).

**E2E** (`e2e/fase3-compras-inventario.spec.ts`): (1) login → proveedor → harina con referencia
$900 → presentación "Bolsa 25 kg" (y receta publicada con la referencia) → stock inicial 100 kg @
$1.000 → compra de 4 bolsas a $30.000 → pedido → recepción parcial de 2 bolsas → "recibida en
parte" → completar → 200 kg → promedio $1.100 con la referencia en $900 → receta: costo actual
$825/kg y snapshot en $675/kg → merma de 3 kg → 197 kg con el mismo promedio → movimientos con
signo y saldo → auditoría; sin UUIDs visibles. (2) Stock mínimo: azúcar con mínimo 50 kg y stock
inicial 40 kg → "Bajo mínimo" con faltante 10 kg y en la vista de bajo mínimo → compra recibida →
OK. Ambos sin errores de consola, en los proyectos desktop y tablet.

### Invariantes de Fase 3 → tests

| #     | Invariante                                                      | Dónde                                                                            |
| ----- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1     | Todo cambio de stock tiene su movimiento (saldos = suma ledger) | `inventory-invariants.test.ts` › 1                                               |
| 2     | `stock_movements` es append-only                                | ídem › 2 (UPDATE y DELETE rechazados por trigger)                                |
| 3     | El saldo no cambia sin un movimiento nuevo                      | ídem › 3 (`stock_balances_guard`, `raw_material_inventory_costs_guard`)          |
| 4     | Una recepción no se aplica dos veces                            | ídem › 4 (409 y UNIQUE por línea de origen); `purchases-inventory.test.ts` › §64 |
| 5     | Una recepción confirmada es inmutable                           | ídem › 5 (cabecera y líneas)                                                     |
| 6     | No se recibe más de lo pendiente                                | ídem › 6 (409 y CHECK recibido ≤ pedido); §63                                    |
| 7     | El stock nunca queda negativo                                   | ídem › 7 (`INSUFFICIENT_STOCK` y CHECK ≥ 0); `inventory.test.ts`                 |
| 8     | Una compra cancelada no recibe                                  | ídem › 8; cancelación (§45)                                                      |
| 9     | Una compra con recepción confirmada no se cancela               | ídem › 9; cancelación (§45)                                                      |
| 10    | Una presentación es de una sola materia prima                   | ídem › 10 (422 y FK compuesta)                                                   |
| 11    | El packaging no tiene conversión universal                      | ídem › 11; `inventory.test.ts` › presentaciones                                  |
| 12    | La cantidad recibida se normaliza a la unidad base              | ídem › 12; `inventory.test.ts`                                                   |
| 13    | Promedio ponderado correcto                                     | ídem › 13; `inventory.test.ts`; §61                                              |
| 14    | Una salida no cambia el promedio                                | ídem › 14; `inventory.test.ts`; salidas y ajustes                                |
| 15    | Los snapshots de recetas son inmutables                         | ídem › 15; §62; E2E pasos 16–17                                                  |
| 16–17 | El costo efectivo usa el promedio y conserva la referencia      | ídem › 16–17; `inventory.test.ts` › costo efectivo; §61                          |
| 18    | Aislamiento por empresa                                         | `inventory-tenancy.test.ts`                                                      |
| 19    | Autorización por permiso                                        | `authorization.test.ts`                                                          |
| 20    | Confirmar una recepción es atómico                              | `purchases-inventory.test.ts` › rollback (§65)                                   |
| 21    | Concurrencia: costo y stock consistentes                        | `inventory-invariants.test.ts` › 21                                              |

## Cobertura de Fase 2

| Suite             | Archivo(s)                                  | Tests | Qué cubre                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain (unit)     | `packages/domain/test/costing.test.ts`      |    36 | Ejemplos de la especificación (750 g → 0,750 kg; $8.200 / 10 kg = $820/kg; margen $380 = 31,666…%), costo incompleto sin cero implícito, merma no aplicada dos veces, sin redondeo por ingrediente, PACKAGING no convertible, validación, diff, vigencia, escalas |
| shared (unit)     | `packages/shared/test/recipes.test.ts`      |     7 | Esquemas zod: cantidad > 0 con hasta 6 decimales, rendimiento > 0, merma 0 ≤ x < 100, confirmación de costo incompleto, costo de referencia                                                                                                                       |
| shared (unit)     | `packages/shared/test/permissions.test.ts`  |    11 | Incluye la matriz de Fase 2 (quién publica, quién cambia costos)                                                                                                                                                                                                  |
| web (unit)        | `apps/web/test/{format,navigation}.test.ts` |    17 | Formato de dinero HALF_UP, costo por unidad, costo de referencia sin redondear, porcentajes, cantidades; Producción → Recetas en el menú                                                                                                                          |
| api (integración) | `recipes.test.ts`                           |    41 | Publicación con snapshot, cambio de costo sin tocar el snapshot, versionado (duplicar, un borrador, diff, archivar), rollback de la publicación, inmutabilidad por API y por triggers, unidades, costo incompleto, borradores, permisos de Producción             |
| api (integración) | `recipes-invariants.test.ts`                |    10 | Cantidad > 0, rendimiento > 0 y merma válida, en la API (400) y en la base (CHECK)                                                                                                                                                                                |
| api (integración) | `recipes-tenancy.test.ts`                   |     7 | Empresa A/B: materia prima, unidad o producto ajenos (422), lectura y modificación ajenas (404), copia de versión ajena, FKs compuestas en la base                                                                                                                |
| api (integración) | `authorization.test.ts`, `masters.test.ts`  |       | Endpoints de recetas y `PUT /raw-materials/:id/reference-cost` en la matriz rol × endpoint; costo de referencia auditado                                                                                                                                          |
| E2E               | `e2e/fase2-recetas.spec.ts`                 |     2 | Flujo de 23 pasos (materias primas y costos → producto → receta → costo → borrador → publicar → cambiar costo → snapshot intacto y costo actual → v2 → v1 archivada → auditoría) y costo incompleto (sin $0, sin margen, publicación con confirmación explícita)  |

### Invariantes de Fase 2 → tests

| #   | Invariante                                              | Dónde                                                                                 |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | ACTIVE es inmutable                                     | `recipes.test.ts` › inmutabilidad por API y en la base (triggers)                     |
| 2   | ARCHIVED es inmutable                                   | ídem                                                                                  |
| 3   | Una sola versión ACTIVE por receta                      | `recipes.test.ts` › publicar v2 archiva v1; la base impide dos ACTIVE                 |
| 4–6 | Ingrediente, materia prima y unidad de la misma empresa | `recipes-tenancy.test.ts` (API 422 y FKs compuestas en la base)                       |
| 7   | Unidad compatible con la unidad base                    | `costing.test.ts`, `recipes.test.ts` › unidades y rendimiento                         |
| 8   | Rendimiento compatible con unidad de venta              | ídem                                                                                  |
| 9   | Cantidad > 0                                            | `recipes-invariants.test.ts`, `costing.test.ts`, `shared/recipes.test.ts`             |
| 10  | Rendimiento > 0                                         | ídem                                                                                  |
| 11  | Merma válida                                            | ídem                                                                                  |
| 12  | El snapshot no cambia con el costo                      | `recipes.test.ts` › cambiar la harina a $1.000/kg; E2E pasos 15–17                    |
| 13  | Publicar es transaccional                               | `recipes.test.ts` › rollback de la publicación                                        |
| 14  | Costo incompleto sin cero implícito                     | `costing.test.ts`, `recipes.test.ts` › costo incompleto, E2E de costo incompleto      |
| 15  | Dinero y cantidades sin float                           | `database/schema.test.ts` (sin `real`/`double`), `costing.test.ts` › política decimal |
| 16  | Aislamiento por empresa                                 | `recipes-tenancy.test.ts`                                                             |

## Cobertura de Fase 1

| Suite             | Archivo(s)                                     | Qué cubre                                                                                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| domain (unit)     | `packages/domain/test/{units,codes}.test.ts`   | Conversión exacta con decimal.js, masa↔volumen rechazado, definición de unidades derivadas, formato y normalización de códigos                                                                                                                                                                                     |
| shared (unit)     | `packages/shared/test/masters.test.ts`         | Validaciones zod (decimales, códigos, fechas, zona horaria, contraseña, edición sin cambios), permisos efectivos                                                                                                                                                                                                   |
| shared (doc)      | `packages/shared/test/permissions-doc.test.ts` | `docs/PERMISSIONS.md` coincide con `SYSTEM_ROLES`                                                                                                                                                                                                                                                                  |
| database (unit)   | `packages/database/test/schema.test.ts`        | Tablas esperadas, sin float, sin columna de stock, `company_id` en toda tabla de negocio, `timestamptz`                                                                                                                                                                                                            |
| api (unit)        | `apps/api/test/unit/audit-diff.test.ts`        | Diff de auditoría sin secretos, "hoy" en la zona de la empresa, escape de LIKE                                                                                                                                                                                                                                     |
| api (integración) | `masters.test.ts`                              | Clientes, proveedores, depósitos, categorías, materias primas y productos: códigos automáticos/manuales, duplicados, búsqueda, paginación, edición, desactivación sin borrado, referencias inválidas, auditoría                                                                                                    |
| api (integración) | `people.test.ts`                               | Empresa; empleados (legajo, documento único, baja con fecha); usuarios (alta con empleado, roles, permisos efectivos, login rechazado tras desactivar, baja de empleado desactiva su acceso, no auto-modificación); roles                                                                                          |
| api (integración) | `units.test.ts`                                | Unidades estándar, conversiones válidas e incompatibles, unidades derivadas, inmutabilidad de la conversión                                                                                                                                                                                                        |
| api (integración) | `tenancy.test.ts`                              | Empresa A/B: leer, modificar, desactivar, inferir por búsqueda y referenciar datos ajenos (9 entidades), `companyId` enviado se ignora, auditoría separada, FK compuesta en la base                                                                                                                                |
| api (integración) | `authorization.test.ts`                        | Matriz rol × endpoint contra la API real (7 roles × 51 endpoints) y ausencia de chequeos por código de rol                                                                                                                                                                                                         |
| E2E               | `e2e/fase1-maestros.spec.ts`                   | Flujo de 19 pasos (login → empresa → empleado → acceso → rol → cliente → proveedor → unidad → categorías → materia prima → producto → depósito → buscar → editar → desactivar → auditoría → logout), login del usuario creado con menú según sus roles, sin errores de consola; ningún UUID visible en la interfaz |

## Cobertura de Fase 0

### packages/shared (unit)

- Catálogo de permisos sin duplicados y con formato `modulo.accion`.
- `hasPermissions` exige todos los requeridos.
- Roles de sistema: exactamente los 7 iniciales, solo referencian permisos existentes; ADMIN/DUEÑO
  tienen todos; VENTAS no tiene `audit.read`.

### packages/database (unit)

- El esquema expone exactamente las 9 tablas fundacionales.
- Ninguna columna usa `real`/`double precision`.
- Todas las marcas de tiempo son `timestamptz`.

### apps/api (unit)

- Tokens de sesión: 256 bits, únicos; hash SHA-256 determinístico.
- Contraseñas: Argon2id, salt distinto por hash, verificación correcta/incorrecta.
- Configuración: rechaza `DATABASE_URL` inválida; múltiples orígenes web.

### apps/api (integración)

- **Health:** 200 con API y DB ok; propagación de `x-request-id`; 503 si la DB no es accesible.
- **DB:** existen exactamente las tablas fundacionales; migraciones registradas; email único sin
  distinguir mayúsculas; empleado sin usuario; FK restrict impide borrar empresa con usuarios;
  `audit_logs` rechaza UPDATE/DELETE.
- **Login válido:** 200, cookie `HttpOnly` + `SameSite=Lax`, respuesta sin secretos, solo el hash
  del token en base, normalización de email.
- **Login inválido:** contraseña incorrecta (401 + auditoría sin la contraseña), usuario
  inexistente (mismo error), payload inválido (400), usuario deshabilitado (401).
- **CSRF:** origen no permitido (403), cuerpo no JSON (415).
- **Rate limit:** 429 al superar el límite.
- **Ruta protegida:** `/api/auth/me` sin sesión (401), cookie inventada (401), con sesión (200),
  logout revoca en servidor y audita, sesión expirada (401).
- **Permisos básicos:** `/api/audit-logs` sin sesión (401), VENTAS (403), ADMIN (200 paginado con
  actor), validación de `pageSize`.

### apps/web (unit)

- Slugs de menú únicos; `findNavItem`; `safeNextPath` contra open redirect.

### E2E smoke (desktop y tablet)

- Health a través del proxy web.
- Ruta protegida sin sesión → `/login`.
- Login inválido muestra error.
- Admin ingresa, ve shell con usuario y roles, actividad reciente real, navega a una sección futura
  ("Disponible en próxima etapa"), sale, y la ruta protegida vuelve a exigir login. **Sin errores de
  consola.**
- Sección inexistente → 404.
