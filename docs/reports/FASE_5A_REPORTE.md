# Fase 5A — Pedidos + demanda comprometida + necesidades · Reporte

## Estado

**FASE_5A_STATUS = COMPLETE_PENDING_HUMAN_ACCEPTANCE.** No se comenzó Fase 5B (ventas, entrega,
cobros, cuenta corriente, margen): espera la aceptación humana de esta fase.

Registrado al iniciar: `FASE_4_5_TECHNICAL_REVIEW = PASS`, `FASE_4_5_HUMAN_GATE = ACCEPTED`,
`FASE_4_5_STATUS = CLOSED`, `NEXT_ALLOWED_PHASE = FASE_5A_PEDIDOS`.

## Base commit y PR

- PR #6 (Fase 4.5) con CI verde, mergeado a `main` en **`f9c0157`**; CI de `main` verde (run
  36940779544).
- Rama `fase-5a-pedidos` desde `main` en **`f9c0157`**.
- PR: [#7](https://github.com/domusbrag/brurera/pull/7). PR #3 (Windows) no se tocó.

## Order model

| Tabla                           | Qué guarda                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer_orders`               | Código `PED-0001` por empresa, cliente, `requested_at`, retiro/entrega y dirección, contacto, evento, prioridad, notas, estado, cobertura, `plan_revision`, quién/cuándo en cada paso |
| `customer_order_lines`          | Producto, cantidad y unidad (compatible con la de venta), cantidad normalizada, conservación pedida (`ANY` o un estado), notas, orden, `removed_at`                                   |
| `product_lot_reservations`      | Pedido, línea, lote, cantidad, revisión, estado (`ACTIVE` / `RELEASED` / `INVALIDATED` / `FULFILLED`), motivo, fechas y usuarios                                                      |
| `order_production_requirements` | Línea, producto, cantidad a producir, receta y versión fijadas, problema (`NO_RECIPE_FOR_PRODUCTION` / `RECIPE_NOT_USABLE`), revisión, estado, orden de producción vinculada          |
| `order_material_requirements`   | Por necesidad: materia prima, cantidad en unidad base, versión de receta y revisión (snapshot)                                                                                        |
| `customer_order_operations`     | `operationId` de confirmar / replan / cancelar (idempotencia)                                                                                                                         |

Más `production_orders.source_order_requirement_id`. Ver DOMAIN_MODEL y DATABASE.

## Order lifecycle

`DRAFT → CONFIRMED → IN_PREPARATION → READY`, `READY → IN_PREPARATION`, cualquiera → `CANCELLED`
(terminal). Sin `DELIVERED` (Fase 5B). Borrador: se edita libremente, no reserva, no es demanda.
Confirmado: sólo se editan datos informativos (`409 ORDER_PLAN_LOCKED` para fecha o productos;
eso es replan). `READY` exige cobertura completa (`409 ORDER_NOT_FULLY_COVERED`). Sólo
`CONFIRMED`, `IN_PREPARATION` y `READY` son demanda.

## Coverage status

Separado del estado: `FULLY_COVERED`, `PARTIALLY_COVERED`, `NOT_COVERED` y `NEEDS_REPLAN`.
`NEEDS_REPLAN` se deriva al consultar de las reservas invalidadas de la revisión vigente (así merma
y bloqueo no escriben el pedido, ADR-053). Un producto sin receta deja el pedido sin cobertura
completa aunque se confirme.

## Requested datetime / timezone

`requested_at` es `timestamptz`; la UI y la API intercambian la hora de pared de la empresa
(`"2026-10-10T10:00"`) y la API la convierte con `Company.timezone` (ADR-055). La UI usa
`WallClockInput` (fecha + hora, rotulado "hora de Buenos Aires"), nunca `datetime-local`. Se
corrigió la deuda de 4.5: la disponibilidad a una fecha y el "hoy" del formulario de producción
usan la zona de la empresa. Probado: unit (§84 10:00 BA = 13:00 UTC), integración con una empresa
en Tokio y E2E con el navegador en Tokio y la empresa en Buenos Aires (alta, detalle, listado,
replan a otra fecha: siempre 10:00 hora de la empresa).

## Reservations

Reserva **dura por lote** (ADR-050): "LOT-A 150 + LOT-B 250", nunca un total suelto. No crea
`StockMovement`: el stock físico no cambia (test "ningún pedido movió stock"). Las reservas no se
borran; se liberan (cancelación, replan) o invalidan (calidad, merma).

## FEFO allocation

Entre lotes elegibles para `requested_at` (no agotados, no bloqueados, no vencidos en esa fecha,
con la conservación pedida) y sólo sobre su parte libre: `usable_until`, luego `produced_at`,
luego código. Reutiliza la elegibilidad y el orden de Fase 4.5 (`allocateFefo` en el dominio).

## Committed stock

`PHYSICAL`, `ELIGIBLE`, `COMMITTED` (reservas activas de otros pedidos sobre lotes elegibles) y
`AVAILABLE = ELIGIBLE − COMMITTED`. §4: 700 físicos, 400 elegibles el sábado, reserva 400,
producir 100. §5: segundo pedido de 200 → reservable 0, producir 200. La disponibilidad a una
fecha, Stock → Productos terminados (Comprometido, Disponible ahora) y el detalle de lote
(comprometido, libre, pedidos) lo muestran.

## Production requirements

Por línea: pedido − reservado = a producir. Sin receta usable: queda "sin cubrir" con el problema
explícito ("Faltan 80 kg y no existe una receta activa…"), sin ingredientes inventados.

## Recipe pinning

La necesidad guarda receta y versión vigentes al confirmar o replanificar. Una versión nueva no
cambia nada solo: el pedido avisa "receta nueva publicada" y entra con un replan.

## Material requirements

Snapshot por necesidad con el escalado de Producción. §73: faltan 200 kg, receta 100 kg = 75 kg
harina + 0,8 kg sal → 150 kg harina y 1,6 kg sal. No reserva materia prima (ADR-051).

## Global demand

`calculateMaterialDemand` (`GET /api/planning/material-demand`): por materia prima `currentStock`,
`openOrderDemand`, `availableAfterDemand`, `shortage`, proveedor preferido, primera entrega y
pedidos; horizonte `until` en hora de la empresa; filtro sólo faltantes; agregado y paginado en el
servidor. §74 / §77: 7 + 5 contra 10 → demanda 12, faltante 2.

## Order → ProductionOrder

"Crear orden de producción" desde la necesidad: producto, cantidad, receta, fecha requerida,
depósitos sugeridos y nota prellenados; la orden queda vinculada (`Creada para PED-0001`) y la
necesidad pasa a `PRODUCTION_CREATED` (no se duplica: `409 REQUIREMENT_NOT_OPEN`). Cancelar la
orden la reabre; completarla la cumple y el pedido avisa stock nuevo. Requiere
`order_production.create` y `production_orders.create`. Deuda `PRODUCTION_CONSOLIDATION`
documentada (ADR-056, UX_BACKLOG).

## Replan / plan revision

Acción explícita con vista previa antes/después (cobertura actual y nueva, reservas que se
mantienen, liberan y toman, producción y materias primas). Atómico: libera la revisión anterior,
cierra necesidades (cumplidas → `SATISFIED`; con orden en curso en una línea que sigue → se
conservan y descuentan; resto → `CANCELLED`), incrementa `plan_revision`, aplica cambios y vuelve a
planificar. "Actualizar cobertura" es el replan sin cambios. §78 (cambio de fecha: el fresco se
libera, se reserva congelado) y §79 (cambio de cantidad) probados; historial por revisión
conservado. Ningún GET escribe.

## Cancellation

Borrador: simple. Confirmado / en preparación: libera reservas y cancela necesidades abiertas, sin
mover stock. Listo: sólo con `confirmReady` (`409 ORDER_READY_CANCEL_CONFIRMATION` si no). §77: el
otro pedido no cambia solo; muestra "Hay nuevo stock disponible — recalcular cobertura".

## Lot quality interaction

Bloquear un lote reservado se permite siempre: invalida sus reservas (`LOT_BLOCKED`) y el pedido
queda "Necesita recalcular" (§81). El diálogo de bloqueo avisa cuánto estaba reservado.

## Waste interaction

La merma se registra; si deja el saldo debajo de lo comprometido, invalida reservas (menor
prioridad y entrega más lejana primero) y re-reserva lo que queda del lote para la reserva
afectada (`LOT_WASTE`, §82: nunca saldo 50 con 80 activos).

## Transformation protection

Congelar / descongelar sólo toma `saldo − comprometido`; si no, `409 LOT_QUANTITY_COMMITTED`
("se pueden transformar hasta 20 kg", §83). La pantalla muestra "Libre: 20 kg (80 kg reservados
para pedidos, no se pueden congelar)".

## Atomicity

Confirmar, replanificar y cancelar son una transacción cada uno. Fallar al crear necesidades o al
auditar deja el pedido en borrador sin reservas (test de rollback con trigger inyectado).

## Locks

Pedido → líneas → necesidades → lotes (`FOR UPDATE`, ordenados por id) → saldos → reservas. Las
operaciones de lote (transformar, merma, bloqueo) toman lote → saldo → reservas y nunca el pedido.
Marcar listo: reservas `FOR SHARE`. Crear producción desde necesidad: pedido `FOR SHARE` → necesidad
`FOR UPDATE`. ADR-053.

## Concurrency

§69: dos confirmaciones simultáneas de 70 sobre 100 → 100 reservados (70 + 30) y 40 a producir,
nunca 140. También cancelar y replanificar a la vez, merma y confirmación a la vez (§70: nunca una
reserva activa sobre cantidad inexistente) y reintentos simultáneos con el mismo id.

## Idempotency

`operationId` por intento en confirmar, replan y cancelar (`customer_order_operations`): reintento →
mismo resultado con `replayed: true`; el mismo id en otra acción u otro pedido → `409
OPERATION_ID_REUSED`. Confirmar dos veces no duplica reservas ni necesidades.

## Rollback

Falla inyectada en la auditoría de la confirmación: sin reservas, necesidades ni estado a medias.

## Tenancy

Empresa B no ve ni opera pedidos, necesidades, planificación ni productos de la A (FKs compuestas y
`companyId` de la sesión).

## Permissions

`orders.read/create/update/confirm/replan/cancel/prepare/ready`, `order_planning.read`,
`order_production.create`. Ventas: cargar, editar, confirmar, replanificar, cancelar.
Administración: ver, replanificar, Necesidades. Producción: ver, preparación, Necesidades, crear
producción desde una necesidad, sin datos de contacto del cliente. Depósito: ver y marcar listo.
Admin / Dueño: todo. Nada financiero. Empresas existentes: `pnpm db:sync-reference`. Ver
PERMISSIONS.

## Audit

`ORDER_CREATED`, `ORDER_UPDATED`, `ORDER_CONFIRMED`, `ORDER_REPLANNED`, `ORDER_CANCELLED`,
`ORDER_PREPARATION_STARTED`, `ORDER_MARKED_READY`, `LOT_RESERVED`, `LOT_RESERVATION_RELEASED`,
`LOT_RESERVATION_INVALIDATED`, `ORDER_PRODUCTION_REQUIREMENT_CREATED`,
`PRODUCTION_ORDER_CREATED_FROM_ORDER`, con `planRevision`. El detalle del pedido muestra el
historial.

## Migrations

`0009_customer_orders.sql` (0000–0008 intactas): sólo tablas nuevas, enums, índices, triggers y una
columna opcional. Probado sobre base vacía (suite completa) y sobre una base en 0008 con lotes de
Fase 4.5 (`migration-fase4.test.ts`): lotes, saldos, ledger y órdenes idénticos, tablas de pedidos
vacías. Base de desarrollo migrada y sincronizada con `pnpm db:sync-reference`.

## API

`GET/POST /api/orders`, `POST /api/orders/coverage-preview`, `GET/PATCH /api/orders/:id`,
`GET /api/orders/:id/coverage-preview`, `POST /api/orders/:id/{confirm, replan-preview, replan,
cancel, start-preparation, mark-ready}`, `GET /api/planning/{production-needs, material-demand,
orders-at-risk, requirements/:id}`. Cambios: disponibilidad y resumen de stock con comprometido,
detalle de lote con `commitment`, transformar con `LOT_QUANTITY_COMMITTED`, orden de producción con
`sourceOrderRequirementId` y `sourceOrder`.

## UI

Comercial → Pedidos (listado con filtros de estado, cobertura, prioridad, cliente, próximas
entregas, con faltante y fechas; alta con vista previa explicada; detalle con avisos, productos y
cobertura, lotes reservados con historial, producción necesaria, materias primas necesarias e
historial; editar; modificar con antes/después). Planificación → Necesidades (Producción, Materias
primas, Pedidos en riesgo, con horizonte). Stock con Comprometido / Disponible ahora; lote con
comprometido, libre y pedidos; congelar muestra lo libre; bloquear avisa reservas. Términos de
negocio (Stock válido para la fecha, Ya comprometido, Reservado para este pedido, Falta producir,
Falta comprar, Actualizar cobertura); sin UUIDs.

## Tests

| Paquete                | Tests | Nuevos en 5A                                                                            |
| ---------------------- | ----: | --------------------------------------------------------------------------------------- |
| domain (unit)          |   149 | `orders.test.ts` 24                                                                     |
| shared (unit)          |    42 | `timezone.test.ts` 5                                                                    |
| database (unit)        |     5 | lista de tablas                                                                         |
| api (unit+integración) |   351 | `orders.test.ts` 23, `orders-access.test.ts` 11, migración 0009, matriz de autorización |
| web (unit)             |    20 | navegación de Pedidos y Necesidades                                                     |

Todos verdes (`pnpm test`). Detalle por invariante en TESTING.

## E2E

`e2e/fase5a-pedidos.spec.ts` (3 escenarios × desktop y tablet, navegador en Asia/Tokyo): principal
§85, replan §86 (cambio de fecha, revisión 2, reservas liberadas y nuevas, producción actualizada)
y calidad §87. Suite completa: **38 pruebas verdes** (incluye las de Fases 1 a 4.5; la de 4.5 usa
el selector de fecha nuevo). Sin errores de consola (salvo el 409 esperado al cancelar un pedido
listo sin confirmar) ni UUIDs.

## UX findings

Revisión en 1440×900, 1366×768 y 768×1024 de listado, alta, detalle, modificar, Necesidades (tres
pestañas), lote y productos terminados: sin overflow horizontal. Corregido en la fase: el
formulario de pedido ensanchaba la página en 768 px (tabla dentro de `.form`), el menú móvil se
reabría al volver a la página donde se abrió, la comparación de replan mostraba el mismo lote como
liberado y nuevo (ahora "se mantienen"), y la terminología se alineó con §89.

## UX backlog

Agregados [F5A] en NAVIGATION, INFORMATION_ARCHITECTURE, VISUAL_HIERARCHY, FORMS, TABLES,
DASHBOARD, RESPONSIVE y WORKFLOW (detalle largo del pedido, tarjetas de cobertura, campos
`datetime-local` restantes, consolidación de producción, recálculo por lote, señas). No se inició
UX/DESIGN OPTIMIZATION.

## Gates

| Gate                          | Resultado | Evidencia                                           |
| ----------------------------- | --------- | --------------------------------------------------- |
| A — DB limpia                 | PASS      | suite de integración migra desde cero               |
| B — migración desde 4.5       | PASS      | `migration-fase4.test.ts` (0008 con lotes → 0009)   |
| C — unit                      | PASS      | domain 149, shared 42, database 5, web 20           |
| D — order state machine       | PASS      | domain `orders.test.ts`                             |
| E — future eligibility        | PASS      | §4/§72, conservación pedida, fecha                  |
| F — lot reservations          | PASS      | reserva por lote, sin movimientos                   |
| G — FEFO allocation           | PASS      | unit + integración                                  |
| H — committed stock           | PASS      | §5/§73, stock y lote                                |
| I — production requirements   | PASS      | confirmación, sin receta                            |
| J — material requirements     | PASS      | §73                                                 |
| K — global material demand    | PASS      | §74/§77 con horizonte                               |
| L — cancellation release      | PASS      | integración + E2E                                   |
| M — replan/revision           | PASS      | §78 fecha, §79 cantidad, E2E                        |
| N — quality invalidation      | PASS      | §81 + E2E                                           |
| O — waste invalidation        | PASS      | §82                                                 |
| P — transformation protection | PASS      | §83 + E2E                                           |
| Q — timezone                  | PASS      | §84 unit, Tokio integración, E2E navegador en Tokio |
| R — idempotency               | PASS      | replay y `OPERATION_ID_REUSED`                      |
| S — concurrency               | PASS      | 70 + 70 sobre 100 y otros tres casos                |
| T — rollback                  | PASS      | falla inyectada                                     |
| U — tenancy                   | PASS      | empresa B                                           |
| V — authorization             | PASS      | matriz rol × endpoint y permisos por rol            |
| W — E2E principal             | PASS      | desktop + tablet                                    |
| X — E2E replan                | PASS      | desktop + tablet                                    |
| Y — E2E quality risk          | PASS      | desktop + tablet                                    |
| Z — UX manual                 | PASS      | tres viewports, sin overflow                        |
| AA — lint                     | PASS      | `pnpm lint`                                         |
| AB — typecheck                | PASS      | `pnpm typecheck`                                    |
| AC — build                    | PASS      | `pnpm build`                                        |
| AD — worktree clean           | PASS      | todo commiteado                                     |
| AE — remote CI                | ver PR #7 | se confirma en el PR antes de pedir la revisión     |

## CI

GitHub Actions `ci.yml` en el PR #7. Un run intermedio falló por la lista de tablas del test de
esquema de `packages/database` (corregido en `8bcb4b1`).

## Risks

- Cada necesidad crea su propia orden de producción: con muchos pedidos del mismo producto hay
  muchas órdenes (deuda `PRODUCTION_CONSOLIDATION`).
- Stock nuevo no reasigna pedidos solo (por diseño): si nadie actualiza la cobertura, el pedido
  sigue mostrando "falta producir" aunque haya stock; el aviso lo hace visible.
- La materia prima no se reserva: dos órdenes de producción pueden competir por la misma harina
  hasta iniciarse (la demanda proyectada lo anticipa).
- Empresas existentes necesitan `pnpm db:sync-reference` para ver Pedidos.

## Debt

`PRODUCTION_CONSOLIDATION`; `ORDER_ADVANCE_PAYMENT` (señas, 5B); reserva física de materia prima;
campos `datetime-local` de recepción de compras y operaciones de stock; selector de fecha propio en
es-AR; recálculo explícito de los pedidos afectados por un lote nuevo; `FULFILLED` y consumo de
reservas al vender (5B).

## ADR

ADR-050 (reserva dura por lote), ADR-051 (materia prima proyectada), ADR-052 (REPLAN y
`planRevision`, sin writes desde GET), ADR-053 (orden de locks), ADR-054 (calidad y merma sobre
reservas; transformación protegida), ADR-055 (hora de la empresa), ADR-056 (necesidad → orden de
producción, idempotencia).

## Próximo paso

**FASE 5B — VENTAS + ENTREGA + COBROS + CUENTA CORRIENTE + MARGEN. NO comenzar** sin aceptación
humana de esta fase.
