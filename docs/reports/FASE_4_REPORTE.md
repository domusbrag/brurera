# Fase 4 — Producción · Reporte

## Estado

```
FASE_3_TECHNICAL_REVIEW = PASS
FASE_3_HUMAN_GATE       = ACCEPTED
FASE_3_STATUS           = CLOSED
FASE_4_STATUS           = COMPLETE_PENDING_HUMAN_ACCEPTANCE
```

Los gates A–W pasaron en local desde una base vacía y el CI remoto (gate X) pasó en el PR de Fase 4
(ver "Gates" y "CI"). **Fase 5 no se empezó**: espera la aceptación humana.

## Base commit

- PR #4 (Fase 3) con CI verde, mergeado a `main` → `67e42aa`.
- Rama `fase-4-produccion` creada desde `main` en `67e42aa`.
- El PR #3 (arranque en Windows) es independiente y **no** se mergeó.

## PR

[PR #5 — Fase 4: producción](https://github.com/domusbrag/brurera/pull/5) (rama `fase-4-produccion` → `main`)

Commits: plan (`c4eb6cc`), dominio + base + API + tests (`7c85b12`), vista previa y costo estimado
(`b1e6462`), pantallas + E2E (`d2b5060`), ajustes de UX y documentación (`cafb058`) y este
reporte.

## Arquitectura

Sin piezas nuevas en el stack; mismo patrón que Fases 1–3:

| Capa                | Fase 4                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`   | `production.ts`: máquina de estados, normalización de salida y consumo, escala, plan y costo esperado, variaciones, rendimiento, costo real y unitario, requerimientos y faltantes agregados, código de lote.       |
| `packages/database` | Esquema `production.ts` y migración `0007_production.sql` (4 tablas, 2 enums, 2 tipos de movimiento, checks del ledger, 4 triggers).                                                                                |
| `packages/shared`   | Esquemas zod, DTOs (`ProductionOrderDto`, disponibilidad, costos), `withoutProductionCosts`, 9 permisos, 10 acciones de auditoría, DTOs de stock de producto.                                                       |
| `apps/api`          | Módulo `production` (`production.service.ts`, `production.data.ts`, rutas); en `inventory`, `product-stock.service.ts` y `postProductMovement` en el ledger; movimientos genéricos (materia prima o producto).      |
| `apps/web`          | Producción → Órdenes (listado, alta con vista previa, detalle por estado, revisión y confirmación); Stock → Productos terminados (listado y ficha); movimientos con artículo y enlace a la orden; filtros de fecha. |

La vista previa del alta usa la misma función que el alta real dentro de una transacción que se
revierte: lo que se ve antes de guardar es exactamente lo que se guarda.

## Production lifecycle

```
DRAFT → PLANNED → IN_PROGRESS → COMPLETED
DRAFT | PLANNED | IN_PROGRESS → CANCELLED
```

Transiciones inválidas: `409 INVALID_PRODUCTION_TRANSITION` en la API y rechazo del trigger
`production_orders_guard`. `COMPLETED` y `CANCELLED` son inmutables (`409 PRODUCTION_IMMUTABLE`,
SQLSTATE 23001 en la base). Sólo un borrador podría borrarse (no hay endpoint). Ninguno de los
estados previos a `COMPLETED` mueve stock, así que cancelar no deja nada que revertir.

## Recipe pinning

Al crear se sugiere la versión vigente para la fecha programada (`findEffectiveVersion`); en
`DRAFT` se puede elegir otra versión publicada de la misma receta (la UI ofrece "Vigente para la
fecha (sugerida)" o una versión concreta) y el detalle avisa si la elegida no es la vigente. Al
planificar, `recipe_version_id` queda fijo (API `PRODUCTION_PLAN_LOCKED` + trigger). Test §67:
publicar v2 después de planificar no cambia la orden, que completa con v1 (ADR-040).

## Planned consumption

`scaleFactor = salida planificada normalizada / rendimiento normalizado`; cada ingrediente =
cantidad de receta × factor, normalizada a la unidad base de la materia prima, con `decimal.js`.
Ejemplo §65: receta 100 kg (75 kg harina, 0,8 kg sal), orden 200 kg → 150 kg y 1,6 kg. Al
planificar se guardan las líneas `RECIPE` con cantidad, unidad, normalizada, costo unitario y su
origen (promedio de compras / referencia manual) y costo; la orden guarda costo esperado total,
por unidad y estado (`COMPLETE`/`INCOMPLETE`).

Disponibilidad por materia prima: necesario / disponible / diferencia en el depósito de origen.
Se puede planificar con faltante; iniciar no (`409 INSUFFICIENT_MATERIALS_FOR_PRODUCTION` con el
detalle). La UI muestra qué falta y un acceso "Comprar".

## Actual consumption

Al iniciar, real = planificado. En curso se carga lo real por línea en cualquier unidad compatible
(1.950 g de levadura → 1,95 kg); dimensiones incompatibles → `INCOMPATIBLE_UNITS`. Se puede cargar
0 si un ingrediente no se usó. La variación (cantidad y %) se calcula contra el plan.

## Extra consumption

`POST /extra-materials` agrega una línea `EXTRA` (materia prima de la empresa, cantidad > 0, unidad
compatible, motivo obligatorio). No toca la receta (test §69: 1 l de aceite sube el costo real a
78.400 y la versión de receta queda igual). Se puede quitar mientras la orden está en curso; las
líneas `RECIPE` no se quitan (se carga 0). Ambas acciones se auditan.

## Output

Salida real > 0 en una unidad compatible con la unidad de venta, normalizada (`ACTUAL_OUTPUT_REQUIRED`
si falta al completar). Ejemplo §66: plan 100 kg, real 96 kg.

## Yield

`variación = real − plan` (−4 kg), `rendimiento = real / plan × 100` (96 %). La merma teórica de la
versión se muestra como referencia. **No** se genera `WASTE` por rendimiento: las materias primas
ya se consumieron y el menor rendimiento sube el costo unitario (100.000 / 90 = 1.111,11/kg).

## Production costing

Cuatro conceptos, siempre con su nombre en la UI:

| Concepto                | Cuándo se fija        | Fuente                                             |
| ----------------------- | --------------------- | -------------------------------------------------- |
| Costo teórico (receta)  | Al publicar / en vivo | Costo efectivo (promedio → referencia)             |
| Costo esperado          | Al planificar         | Costo efectivo de ese momento, por línea           |
| Costo material real     | Al completar          | Σ `total_value` de los `PRODUCTION_CONSUMPTION`    |
| Costo promedio material | Con cada producción   | Promedio ponderado móvil de los lotes del producto |

En curso la UI muestra además un **costo estimado** (consumo cargado × promedio actual) que no se
guarda. Costo unitario real = costo material real / salida real. Ninguno incluye mano de obra,
energía ni indirectos; la UI lo dice junto a cada bloque de costos. Test §66: esperado 75.400
(754/kg), real 77.400, 806,25/kg.

## Product inventory

`PRODUCTION_OUTPUT` (+cantidad, depósito de producto terminado) valorizado **exactamente** con el
costo material real (no cantidad × unitario redondeado), así el valor de inventario conserva lo
consumido. Stock por depósito en `stock_balances`, costo de empresa en `product_inventory_costs` e
historial append-only en `product_inventory_cost_history` (costo anterior, lote, nuevo, cantidad,
orden, fecha, actor). Pantallas: Stock → Productos terminados y la ficha del producto (stock por
depósito, costo promedio, valor, producciones recientes, movimientos, historial de costo, receta
vigente, precio de venta y margen teórico).

## Product moving average

`applyInbound` del dominio (el mismo de compras) con el valor exacto del lote. Test §68: 100 kg @
1.000 + 100 kg @ 1.200 → 200 kg @ 1.100; con cantidades no exactas el promedio se redondea a 6
decimales y el valor conserva el total. Cambio de promedio auditado como
`PRODUCT_MOVING_AVERAGE_COST_CHANGED`.

## StockBalance evolution

`stock_balances` y `stock_movements` ya se habían generalizado en 0006 (`item_type`, exactamente uno
de `raw_material_id` / `product_id`, únicos parciales y trigger custodio que compara el ítem).
Fase 4 no migra datos: suma los tipos `PRODUCTION_CONSUMPTION` / `PRODUCTION_OUTPUT`, checks que
atan cada tipo a su ítem y referencia, e índices por producto y por tipo de ítem. Gate B lo prueba
sobre datos de Fase 3 (ver "Migrations").

## Atomicity

`completeOrder` ejecuta los 22 pasos de §37 en una transacción: bloquea la orden y sus líneas,
normaliza lo real, bloquea costos y saldos de materias primas, revalida stock, genera los consumos
(saldo y valor bajan, promedio intacto), suma el costo real, bloquea costo y saldo del producto,
genera la salida, actualiza saldo, promedio e historial del producto, congela costos reales en
líneas y orden, pasa a `COMPLETED`, audita y confirma. Cualquier error revierte todo.

## Locks

Orden fijo (ADR-042): orden → líneas → costos de materias primas (por id) → saldos de materias
primas (por id) → costo del producto → saldo del producto. Compras, ajustes y mermas usan el mismo
prefijo costo → saldo (ADR-034): no hay ciclos.

## Concurrency

- §71: dos órdenes por 70 kg con 100 kg en stock, completadas a la vez → `[200, 409]`, la segunda
  con `INSUFFICIENT_STOCK` (requerido 70, disponible 30, faltante 40); quedan 30 kg; la perdedora
  sigue en curso sin movimientos.
- Cuatro órdenes con harina, sal y aceite extra completadas a la vez → todas `200`, sin deadlocks,
  promedio 774/kg.

## Idempotency

§72: tres "Completar" simultáneos → `[200, 409, 409]` (`PRODUCTION_ALREADY_COMPLETED`), un único
`PRODUCTION_OUTPUT`, dos consumos (uno por línea) y una única fila de historial de costo. Capas:
estado verificado con la orden bloqueada + único `(company_id, source_line_id)` del ledger.

## Rollback

§73: un trigger temporal hace fallar el historial de costo del producto (después de los consumos y
la salida). Resultado: orden `IN_PROGRESS`, stocks y costos de materias primas intactos, sin
movimientos de la orden, sin stock ni costo de producto, sin auditoría de completado.

## Tenancy

Toda tabla nueva lleva `company_id` y FKs compuestas (producto, (producto, receta), (receta,
versión), depósitos, unidades, responsable, materia prima, movimientos). `production-access.test.ts`:
otra empresa recibe 422 al usar producto, depósitos, versión, responsable o unidad ajenos; 404 en
todas las rutas de una orden ajena y en la ficha de un producto ajeno; no ve movimientos ni stock
ajenos; no agrega materias primas ni líneas ajenas; la base rechaza el cruce (23503).

## Permissions

`production_orders.read|create|update|plan|start|complete|cancel|add_extra_material` y
`production.cost.read`. ADMIN/OWNER: todos. Producción: todas las operaciones, sin costos.
Administración: lectura con costos. Depósito: stock de producto sin valorizar. Compras: nada de
producción. Sin `production.cost.read` la API devuelve `null` en todo importe de producción
(`costs`, costos por línea, costo real del listado, valor de los movimientos de la orden) y
`cost-comparison` responde 403; las cantidades y diferencias se ven. La valorización del stock de
producto sigue `inventory.cost.read` (ADR-036). Matriz en [PERMISSIONS](../PERMISSIONS.md).

## Audit

Las 10 acciones de §52: `PRODUCTION_ORDER_CREATED`, `_UPDATED` (con los cambios), `_PLANNED`
(versión, lote, costo esperado, faltantes), `_STARTED`, `_CANCELLED` (estado anterior y motivo),
`_ACTUALS_UPDATED` (cambios por materia prima y salida), `PRODUCTION_EXTRA_MATERIAL_ADDED` /
`_REMOVED`, `PRODUCTION_ORDER_COMPLETED` (salida, costos, movimientos) y
`PRODUCT_MOVING_AVERAGE_COST_CHANGED`. Todas en la misma transacción; el historial de la orden las
describe en lenguaje de negocio ("Salida 96 kg · lote LOT-20261001-005 · costo material $76.800").

## Migrations

`0007_production.sql`; 0000–0006 sin cambios. Postgres no permite usar en la misma transacción un
valor de enum agregado con `ADD VALUE` y el migrador aplica todo junto: los checks nuevos comparan
`movement_type::text`.

- **Base vacía:** `pnpm db:reset` aplica 0000–0007 y el seed.
- **Base con datos de Fase 3:** `migration-fase3.test.ts` crea una base propia, migra hasta 0006,
  carga empresa, dos depósitos, dos materias primas, stock inicial y una merma, migra a 0007 y
  verifica movimientos, saldos, costos e historial idénticos, 8 migraciones, Σ movimientos = saldo
  y tablas nuevas vacías.

## API

```
GET    /api/production-orders                         listado (estado, producto, responsable, desde/hasta)
POST   /api/production-orders                         alta en borrador
POST   /api/production-orders/preview                 vista previa sin guardar
GET    /api/production-orders/:id                     detalle (plan en vivo en borrador, disponibilidad, costos)
PATCH  /api/production-orders/:id                     edición (borrador; responsable, lote y notas después)
POST   /api/production-orders/:id/plan | start | complete
POST   /api/production-orders/:id/cancel
PUT    /api/production-orders/:id/actuals
POST   /api/production-orders/:id/extra-materials
DELETE /api/production-orders/:id/extra-materials/:lineId
GET    /api/production-orders/:id/availability | cost-comparison | movements
GET    /api/production/responsibles
GET    /api/inventory/products | /api/inventory/products/:id | /api/inventory/products/:id/cost-history
GET    /api/inventory/movements?itemType=PRODUCT&productId=&from=&to=
```

Todo listado paginado en el servidor; los históricos se piden por página.

## UI

- **Menú:** Producción → Órdenes (antes de Recetas). Inventario → Stock con pestañas Materias primas ·
  Productos terminados · Movimientos · Bajo mínimo.
- **Listado** de órdenes con código, producto, fecha, estado, planificado, producido, lote,
  versión de receta, responsable y costo real (con permiso); filtros por estado, producto,
  responsable y rango de fechas.
- **Nueva orden:** producto, fecha, cantidad (con unidad compatible), receta sugerida, depósitos,
  responsable, lote y notas; resumen del plan en vivo (receta y versión, rinde, escala, avisos,
  necesario / disponible / diferencia y costo esperado con permiso).
- **Detalle por estado:** borrador y planificada con materias primas del plan y disponibilidad
  ("Volver a verificar", "Comprar" por faltante, "Iniciar producción" deshabilitado si falta); en
  curso con la tabla plan / real / unidad / diferencia editable, "Agregar consumo extra", salida
  real, "Guardar avance" y "Revisar y completar"; revisión en un diálogo con plan contra real,
  rendimiento, stock suficiente, costo estimado y "Confirmar producción"; completada con plan
  contra real, costos esperado / real / diferencia, movimientos y auditoría; cancelada con motivo.
- **Stock de productos terminados** y su ficha (ver "Product inventory").
- Movimientos de inventario con columna Artículo (materia prima o producto), filtro por tipo de
  artículo y por fecha, y enlace "Producción OP-…" a la orden.
- Sin UUIDs ni términos técnicos: "Cantidad planificada", "Producido", "Rendimiento", "Costo
  esperado", "Costo material real", "Costo promedio de inventario", "Producto terminado".

## Tests

| Suite                                | Tests | Qué cubre                                                                                  |
| ------------------------------------ | ----: | ------------------------------------------------------------------------------------------ |
| `domain/production.test.ts`          |    20 | §64–65                                                                                     |
| `shared/production.test.ts`          |     6 | Esquemas, DTOs sin costos, permisos por rol                                                |
| `api/production.test.ts`             |    29 | §66–70, §73, vista previa, estados, cancelación, edición, lote, §46–47, listados, Σ ledger |
| `api/production-concurrency.test.ts` |     3 | §71, §72, sin deadlocks                                                                    |
| `api/production-access.test.ts`      |     7 | §74 tenencia, §50–51 visibilidad de costos por rol                                         |
| `api/migration-fase3.test.ts`        |     1 | Gate B                                                                                     |
| `authorization.test.ts` (ampliado)   |     — | 19 endpoints nuevos en la matriz rol × endpoint                                            |
| `web/navigation.test.ts` (ampliado)  |     1 | Órdenes antes de Recetas, sólo con `production_orders.read`                                |

Totales (`pnpm test` desde base vacía): domain 95, shared 37, web 19, database 5, api 289 → **445
tests, 0 fallos** (Fase 3: 378).

## E2E

`e2e/fase4-produccion.spec.ts`, desktop y tablet, sin errores ni warnings de consola y sin UUIDs:

- **Flujo principal (§75):** login, materias primas con stock, Producción → Órdenes → Nueva orden,
  100 kg de pan, receta sugerida v1, necesidades y costo esperado ($75.500), planificar (lote),
  iniciar, real de harina con coma decimal (76,05 kg), consumo extra de sal con motivo, salida
  96 kg, revisión (rendimiento 96 %, costo estimado $76.800 / $800 por kg), confirmar, completada
  con plan contra real, costo real y diferencia ($1.300), 4 movimientos y auditoría; stock del pan
  96 kg a $800/kg, margen $700 (46,67 %), materias primas 123,95 kg y 8,5 kg, movimientos filtrados
  por producto con enlace a la orden, listado filtrado por estado.
- **Faltante (§76):** la vista previa muestra "faltan 15 kg" (no un error genérico); se planifica,
  "Iniciar producción" queda deshabilitado; desde "Comprar" se crea, pide y recibe la compra; de
  vuelta en la orden "Alcanza" y se inicia.

Suite completa: **26/26** (Fases 0–4, desktop + tablet).

## UX findings

Revisión manual en 1440×900, 1366×768 y 768×1024 sobre listado, alta con faltante, planificada, en
curso (con el formulario de extra abierto), revisión, completada, stock y ficha de producto
terminado y movimientos: sin overflow horizontal de página, sin UUIDs, sin errores ni warnings de
consola. Corregido en la fase:

| Hallazgo                                                                                   | Resolución                                                              |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| En el formulario de consumo extra, el campo Cantidad se superponía con Unidad.             | Campos al ancho de su columna.                                          |
| Agregar un consumo extra borraba lo tipeado en las otras líneas.                           | La tabla sólo guarda lo editado; lo nuevo se suma sin pisar.            |
| El historial de costo del producto tenía una columna "Lote" que mostraba una cantidad.     | "Lote producido".                                                       |
| La ayuda de "Controla stock" prometía que las ventas descontarían stock "desde la Fase 3". | Explica que el producto se produce con órdenes y entra al completarlas. |
| El botón decía "Planificar"; la especificación pide "Planificar producción".               | "Planificar producción".                                                |
| El listado no mostraba la versión de receta (§54).                                         | Columna "Receta" (v1, v2…).                                             |
| La revisión no decía explícitamente si alcanza el stock (§58).                             | "Stock suficiente: Sí / No" en el diálogo.                              |
| Movimientos de inventario sin filtro por fecha (deuda de Fase 3).                          | Filtros "Desde / Hasta" en movimientos y órdenes.                       |

## UX backlog

14 hallazgos `[F4]` en [UX_BACKLOG](../UX_BACKLOG.md) (pestañas de Inventario, solapamiento entre
fichas de producto, detalle largo en curso, diferencia en vivo, formulario de extra en tablet,
fechas en formato del navegador, densidad del listado, color de "Ver todos", pie fijo del diálogo
de revisión, "Comprar todo lo que falta", aviso de avance guardado, flujo de reversa). **UX/DESIGN
OPTIMIZATION** sigue en el [ROADMAP](../ROADMAP.md) después de Fase 5; no se ejecutó.

## Gates

| Gate | Qué                        | Resultado | Evidencia                                                                     |
| ---- | -------------------------- | --------- | ----------------------------------------------------------------------------- |
| A    | DB vacía + migraciones     | PASS      | `pnpm db:reset`: volumen borrado, 0000–0007 aplicadas, seed OK                |
| B    | Migración desde Fase 3     | PASS      | `migration-fase3.test.ts`: datos idénticos, Σ movimientos = saldo             |
| C    | Unit                       | PASS      | domain 95, shared 37, web 19, database 5, api unit                            |
| D    | Máquina de estados         | PASS      | dominio + API (`INVALID_PRODUCTION_TRANSITION`) + trigger                     |
| E    | Receta fijada              | PASS      | §67: v2 publicada después de planificar; la orden completa con v1             |
| F    | Cantidades planificadas    | PASS      | §65 (200 kg → 150 / 1,6) y §66 (75 / 0,8; 75.400)                             |
| G    | Cantidades reales          | PASS      | 77 kg, gramos → kg, unidades incompatibles rechazadas, variaciones            |
| H    | Consumo de materias primas | PASS      | §66: harina 123 kg, sal 9,2 kg; promedio de materia prima intacto             |
| I    | Salida de producto         | PASS      | §66: 96 kg de producto, 806,25/kg, un único `PRODUCTION_OUTPUT`               |
| J    | Promedio de producto       | PASS      | §68: 200 kg @ 1.100; historial y auditoría                                    |
| K    | Stock no negativo          | PASS      | §70 (iniciar y completar revalidan), §71 (nunca −40), CHECK en la base        |
| L    | Idempotencia               | PASS      | §72 `[200, 409, 409]`                                                         |
| M    | Concurrencia               | PASS      | §71 `[200, 409]`, cuatro órdenes sin deadlocks                                |
| N    | Rollback                   | PASS      | §73: falla forzada, nada cambió                                               |
| O    | Tenancy                    | PASS      | `production-access.test.ts` + FKs compuestas                                  |
| P    | Autorización               | PASS      | `authorization.test.ts` (19 endpoints nuevos) + visibilidad de costos por rol |
| Q    | E2E principal              | PASS      | §75, desktop + tablet                                                         |
| R    | E2E insuficiencia          | PASS      | §76, desktop + tablet                                                         |
| S    | UX manual                  | PASS      | 3 resoluciones, sin overflow, sin IDs, sin warnings                           |
| T    | Lint                       | PASS      | ESLint `--max-warnings 0` + Prettier                                          |
| U    | Typecheck                  | PASS      | `tsc` estricto en los 5 paquetes                                              |
| V    | Build                      | PASS      | API (tsup) y web (Next.js) con las rutas nuevas                               |
| W    | Worktree limpio            | PASS      | `git status` vacío tras el commit                                             |
| X    | CI remoto                  | PASS      | Ver "CI"                                                                      |

## CI

```
CI_REMOTE_STATUS = PASS
workflow  = CI (.github/workflows/ci.yml), job "verify"
run       = https://github.com/domusbrag/brurera/actions/runs/36894334292
commit    = cafb058 (último commit de código; el commit de este reporte sólo agrega docs)
resultado = success (lint, typecheck, build, tests contra Postgres, E2E)
```

## Risks

- **Sin reservas** (`INVENTORY_RESERVATIONS`): entre iniciar y completar otra operación puede
  consumir la materia prima; completar revalida y muestra qué falta, pero la producción física ya
  ocurrió y hay que reponer stock (ajuste o compra) antes de confirmar.
- **Sin reversión** (`PRODUCTION_REVERSAL`): un error en una producción completada se corrige con
  ajustes manuales de materia prima y producto, que no recalculan el costo del lote.
- **Costo sólo material:** el costo promedio del producto (que Ventas usará) no incluye mano de
  obra, energía ni indirectos; los márgenes de Fase 5 serán márgenes sobre materias primas.
- **Redondeo:** el valor del producto es exactamente lo consumido; el unitario y el promedio se
  redondean a 6 decimales (diferencias de centavos en el valor por unidad, nunca en el total).
- **Materia prima de baja en una receta vigente** bloquea planificar e iniciar; hay que publicar una
  versión nueva sin ella.

## Debt

- `PRODUCTION_REVERSAL` — reversa de una producción completada (restaurar materias primas, retirar
  producto, respetar movimientos posteriores y recalcular valorizaciones).
- `INVENTORY_RESERVATIONS` — reservar materia prima al iniciar.
- Lotes: sin stock por lote, vencimientos, FIFO ni trazabilidad sanitaria.
- La diferencia de consumo se recalcula al guardar el avance, no mientras se escribe (UX backlog).
- `cost-comparison` existe en la API pero la UI arma el plan contra real desde el detalle de la
  orden; queda para reportes (Fase 8).
- El stock inicial y los ajustes de producto terminado no tienen pantalla (sólo entra por
  producción); se definirá con Ventas.

## ADR

Nuevos en [DECISIONS](../DECISIONS.md): ADR-039 orden de producción = lote · ADR-040 receta fijada
al planificar · ADR-041 movimientos sólo al completar, valorizados al costo material real (sin
reservas ni reversión) · ADR-042 orden global de locks e idempotencia.

## Próximo paso

**FASE 5 — VENTAS + CLIENTES + COBROS**: cliente → venta → producto terminado → stock → cobro →
cuenta corriente, usando el costo promedio material del producto de Fase 4 para el margen.

**No se comenzó.** Requiere la aceptación humana de Fase 4. Después de Fase 5 sigue **UX/DESIGN
OPTIMIZATION**.
