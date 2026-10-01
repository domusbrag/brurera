# Fase 4 — Producción · Plan de implementación

## Estado de partida

```
FASE_3_TECHNICAL_REVIEW = PASS
FASE_3_HUMAN_GATE       = ACCEPTED
FASE_3_STATUS           = CLOSED
NEXT_ALLOWED_PHASE      = FASE_4_PRODUCCION
```

- PR #4 (Fase 3) con CI verde (`verify`, run 36817493394) mergeado a `main` → `67e42aa`.
- Rama `fase-4-produccion` creada desde `main` en `67e42aa` (base commit de esta fase).

## Inspección (qué hay y qué se reutiliza)

| Pieza                      | Estado en Fase 3                                                                                                                                                    | Uso en Fase 4                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Recipe` / `RecipeVersion` | Versiones `DRAFT → ACTIVE → ARCHIVED`; publicadas inmutables por trigger; `effective_from` / `archived_at`.                                                         | La orden fija `recipe_version_id` (sólo versiones publicadas).                                 |
| `effective-version?at=`    | `findEffectiveVersion` (dominio) + endpoint.                                                                                                                        | Sugerencia de versión según la fecha programada.                                               |
| Costeo                     | `calculateRecipeCost`, `normalizeRecipeYield`, `selectEffectiveCost` (promedio → referencia → incompleto).                                                          | Escalado y costo esperado reutilizan conversión y prioridad de costo.                          |
| `StockMovement`            | Ledger append-only con `item_type`, `raw_material_id`, `product_id`, CHECK "exactamente uno", FKs compuestas; enum sin tipos productivos.                           | Se agregan `PRODUCTION_CONSUMPTION` y `PRODUCTION_OUTPUT`.                                     |
| `StockBalance`             | **Ya generalizado** en 0006: `item_type`, `raw_material_id?`, `product_id?`, CHECK de coherencia, únicos parciales por ítem y trigger custodio que compara el ítem. | Se usa tal cual para productos; sólo se agrega un índice por producto. Sin migración de datos. |
| Promedio móvil             | `applyInbound` / `applyOutbound` (dominio) + `raw_material_inventory_costs` custodiada por trigger.                                                                 | `applyInbound` se reutiliza para el producto (con valor de lote exacto).                       |
| Ledger (`ledger.ts`)       | Única puerta de escritura; locks costo → saldo.                                                                                                                     | Se generaliza a productos (`postProductMovement`).                                             |
| Depósitos, productos       | `controls_stock`, `sale_unit_id`, `active`.                                                                                                                         | Validaciones de producto producible.                                                           |
| Permisos / auditoría       | Catálogo en `@bakery/shared`, roles de sistema, `recordAudit` en la misma transacción.                                                                              | 9 permisos nuevos y 10 acciones de auditoría.                                                  |
| Locks / idempotencia       | `SELECT … FOR UPDATE` en orden fijo (ADR-034); único `(company_id, source_line_id)` (ADR-033).                                                                      | Mismo patrón; la línea de material y la orden son `source_line_id`.                            |
| Tests Fase 3               | Integración real contra Postgres, concurrencia con `Promise.all`, rollback por trigger de prueba.                                                                   | Mismo estilo.                                                                                  |
| UX backlog                 | `docs/UX_BACKLOG.md`.                                                                                                                                               | Se agregan hallazgos `[F4]`; no se ejecuta el rediseño.                                        |

Problema técnico detectado: el migrador de Drizzle aplica todas las migraciones pendientes en **una
transacción**, y Postgres no permite usar un valor de enum agregado con `ALTER TYPE … ADD VALUE` en
la misma transacción. Las restricciones nuevas comparan `movement_type::text`, así ninguna sentencia
de la migración usa el valor nuevo como literal del enum.

## Modelo de producción

La orden de producción es también el lote (ADR-039). Tablas nuevas (migración `0007_production`):

- **`production_orders`**: código `OP-0001` por empresa; producto, receta, versión, depósito de
  materias primas y de producto terminado, estado, fecha programada, cantidad planificada (tal como
  se ingresó + unidad + normalizada a la unidad de venta), factor de escala, merma teórica de la
  versión (referencia), cantidad real obtenida (ídem), lote opcional (`LOT-AAAAMMDD-NNN`),
  responsable (empleado) opcional, actores y fechas de cada transición, motivo de cancelación,
  notas. Además, el **snapshot de costo** (estructura equivalente a `ProductionCostSnapshot`):
  moneda, costo esperado total y por unidad + estado (`COMPLETE`/`INCOMPLETE`) congelados al
  planificar; costo material real total y por unidad + movimiento de salida congelados al completar.
- **`production_material_lines`**: `RECIPE` (derivadas de la receta al planificar) o `EXTRA`
  (consumo adicional durante la producción, con nota obligatoria). Cantidad planificada y su
  normalización a la unidad base, costo esperado por unidad/origen/total, cantidad real (unidad
  compatible) y su normalización, costo real unitario/total, variación, movimiento de consumo.
- **`product_inventory_costs`**: cantidad, valor y promedio móvil de **costo material** por
  producto a nivel empresa (proyección custodiada por trigger, igual que materias primas).
- **`product_inventory_cost_history`**: append-only; costo anterior, costo del lote, costo nuevo,
  cantidad, orden de producción, fecha, actor.

## Estados

```
DRAFT → PLANNED → IN_PROGRESS → COMPLETED
DRAFT | PLANNED | IN_PROGRESS → CANCELLED
```

Transiciones inválidas (`COMPLETED → *`, `CANCELLED → *`, saltos) → `409 INVALID_PRODUCTION_TRANSITION`
en la API y rechazo del trigger `production_orders_guard` en la base. COMPLETED y CANCELLED son
inmutables (`409 PRODUCTION_IMMUTABLE`; SQLSTATE 23001 en la base). Ninguna orden se borra.

- **DRAFT**: se editan producto, versión, fecha, cantidad, depósitos, responsable, lote y notas.
  No mueve stock. El detalle muestra el plan calculado en vivo (no persistido).
- **PLANNED**: valida versión, producto, materias primas activas y unidades; calcula cantidades y
  costo esperado; persiste las líneas y el snapshot; audita. Campos estructurales bloqueados por
  trigger. No mueve stock.
- **IN_PROGRESS**: revalida stock en el depósito de materias primas (`409
INSUFFICIENT_MATERIALS_FOR_PRODUCTION` con faltantes). Propone real = planificado. Se cargan
  consumos reales, extras y la salida real. No mueve stock.
- **COMPLETED**: único momento con movimientos (ADR-041).
- **CANCELLED**: desde cualquier estado previo a COMPLETED, sin inventario que revertir.

## Versión de receta

- Al crear: versión vigente en la fecha programada (`findEffectiveVersion`: fecha futura u hoy →
  versión vigente; fecha pasada → la vigente al final de ese día). Se puede elegir otra versión
  publicada de la misma receta mientras la orden está en DRAFT.
- Al planificar, `recipe_version_id` queda inmutable (trigger). Publicar una versión nueva no
  cambia órdenes existentes (ADR-040).

## Cálculo de cantidades

Todo con `decimal.js` en `@bakery/domain` (`production.ts`):

```
plannedOutputNormalized = cantidad × factor(unidad → unidad de venta)
recipeYieldNormalized   = rendimiento × factor(unidad rendimiento → unidad de venta)
scaleFactor             = plannedOutputNormalized / recipeYieldNormalized
plannedIngredient       = cantidad de receta × scaleFactor   (en la unidad de la receta)
plannedNormalized       = plannedIngredient → unidad base de la materia prima
```

Ejemplo §65: receta 100 kg → 75 kg harina / 0,8 kg sal; orden 200 kg → 150 kg / 1,6 kg.

## Planned vs actual

- Variación de consumo = real − planificado (cantidad y %); las líneas EXTRA no tienen plan (variación
  = real, % sin definir).
- Salida: `outputVariance = real − planificado`, `yieldPerformance = real / planificado × 100`. La
  merma teórica de la versión se muestra como referencia; **no** se genera un `WASTE` por diferencia
  de rendimiento: el menor rendimiento sube el costo unitario del lote.

## Costos (cuatro conceptos distintos)

| Concepto                | Dónde                        | Cuándo                     | Fuente                                                      |
| ----------------------- | ---------------------------- | -------------------------- | ----------------------------------------------------------- |
| Costo teórico           | Receta / snapshot de versión | Al publicar o en vivo      | Costo efectivo (promedio → referencia)                      |
| Costo esperado          | Orden PLANNED (congelado)    | DRAFT → PLANNED            | Costo efectivo de ese momento, por línea con su origen      |
| Costo material real     | Orden COMPLETED (congelado)  | Al completar               | Σ `total_value` de los movimientos `PRODUCTION_CONSUMPTION` |
| Costo promedio material | Inventario del producto      | Cada producción completada | Promedio ponderado móvil de los lotes                       |

`ACTUAL_UNIT_MATERIAL_COST = costo material real / cantidad real normalizada`. En la UI se llama
"Costo material real" / "Costo por unidad"; nunca "costo total" (no incluye mano de obra, energía ni
indirectos).

## Producto terminado e inventario

- `PRODUCTION_OUTPUT` (+ cantidad, depósito de salida) valorizado con el costo material real del
  lote: el valor del movimiento es **exactamente** el costo real (no `cantidad × unitario
redondeado`), así el valor del inventario conserva lo consumido.
- Promedio del producto con `applyInbound` (100 kg @ $1.000 + 100 kg @ $1.200 → 200 kg @ $1.100).
- `stock_balances` ya es genérico: el saldo del producto por depósito usa las mismas filas y el
  mismo trigger custodio. Migración de saldos existentes: no hace falta (todos son
  `RAW_MATERIAL` desde 0006); se verifica `Σ movimientos = saldo` antes y después de aplicar 0007.

## Atomicidad, locks e idempotencia

`completeProduction()` en una transacción:

```
1  lock production_orders (FOR UPDATE)            ← serializa dobles clicks
2  estado = IN_PROGRESS (si COMPLETED → 409 PRODUCTION_ALREADY_COMPLETED)
3  lock líneas
4  normaliza consumos reales y salida
5  lock raw_material_inventory_costs (orden por id)
6  lock stock_balances de materias primas (orden por id)
7  revalida stock agregado por materia prima → 409 INSUFFICIENT_STOCK (detalle)
8-11 PRODUCTION_CONSUMPTION por línea (orden por materia prima, línea): saldo, valor, promedio intacto
12 costo material real = Σ |total_value|
13-15 lock product_inventory_costs y stock_balances del producto
16-18 PRODUCTION_OUTPUT, saldo y promedio del producto, historial de costo de producto
19 congela costos reales en líneas y orden
20 estado COMPLETED
21 auditoría (+ PRODUCT_MOVING_AVERAGE_COST_CHANGED)
22 commit — cualquier error revierte todo
```

Orden global de locks (ADR-042): orden de producción → costos de materias primas (por id) → saldos
de materias primas (por id) → costo de producto → saldo de producto. Compras, ajustes y mermas toman
el mismo prefijo (costo → saldo), sin ciclos.

Idempotencia en dos capas: estado verificado con la orden bloqueada y único `(company_id,
source_line_id)` (línea de material para consumos; la orden para la salida).

## Sin reservas, sin reversión

- Iniciar no reserva stock (deuda `INVENTORY_RESERVATIONS`); completar revalida todo.
- No se revierte una producción completada (deuda `PRODUCTION_REVERSAL`).
- Lotes: sólo trazabilidad del documento; sin stock por lote, vencimientos ni FIFO.

## API

```
GET    /api/production-orders                       listado paginado (estado, producto, fecha, responsable)
POST   /api/production-orders                       alta en DRAFT
GET    /api/production-orders/:id                   detalle (+ plan en vivo en DRAFT, disponibilidad)
PATCH  /api/production-orders/:id                   edición (DRAFT; notas/responsable/lote después)
POST   /api/production-orders/:id/plan
POST   /api/production-orders/:id/start
POST   /api/production-orders/:id/cancel
PUT    /api/production-orders/:id/actuals           consumos reales y salida real (IN_PROGRESS)
POST   /api/production-orders/:id/extra-materials
DELETE /api/production-orders/:id/extra-materials/:lineId
POST   /api/production-orders/:id/complete
GET    /api/production-orders/:id/availability
GET    /api/production-orders/:id/cost-comparison  (production.cost.read)
GET    /api/production-orders/:id/movements
GET    /api/production/responsibles                 empleados activos para elegir responsable
GET    /api/inventory/products
GET    /api/inventory/products/:id
GET    /api/inventory/products/:id/cost-history     (inventory.cost.read)
GET    /api/inventory/movements?itemType=PRODUCT
```

## Permisos

`production_orders.read|create|update|plan|start|complete|cancel|add_extra_material`,
`production.cost.read`. ADMIN/OWNER: todos. PRODUCCIÓN: todos menos costos. ADMINISTRACIÓN: lectura

- costos. DEPÓSITO: sólo `inventory.read` (sin cambios). COMPRAS: nada de producción. Sin
  `production.cost.read` la API devuelve `null` en todo campo monetario de producción (cantidades
  intactas); la valorización del inventario de producto sigue `inventory.cost.read` (ADR-036).

## UI

- Menú Producción: **Órdenes de producción** y Recetas. Inventario → Stock con pestañas
  Materias primas · Productos terminados · Movimientos · Bajo mínimo.
- Listado con filtros (estado, producto, fecha, responsable) y paginación.
- Alta en orden de negocio: producto, fecha, cantidad, depósitos, responsable, receta sugerida y
  resumen del plan.
- Detalle según estado: planificación (necesario / disponible / faltante, costo esperado con
  permiso, "Planificar producción"), en curso (plan / real / diferencia editable, consumo extra,
  salida real, "Revisar y completar"), revisión (resumen y "Confirmar producción"), completada
  (resumen, plan vs real, rendimiento, costos con permiso, movimientos, historial).
- Stock → Productos terminados y ficha del producto terminado (stock por depósito, costo promedio
  material, valor, últimas producciones, movimientos, historial de costo, receta vigente, precio y
  margen teórico).

## Tests

- Unit (`domain/production.test.ts`): escala, cantidades, costo esperado, variaciones, rendimiento,
  costo real y unitario, promedio de producto, unidades compatibles, extras, faltantes.
- Shared: DTOs de visibilidad de costos (función `redactProductionCosts`).
- Integración: flujo §66, inmutabilidad de receta §67, promedio §68, extra §69, faltante §70,
  concurrencia §71, idempotencia §72, rollback §73 (dos puntos de falla), tenancy §74, máquina de
  estados, inmutabilidad en la base, autorización rol × endpoint, migración desde datos de Fase 3.
- E2E (desktop + tablet): flujo principal §75 y faltante §76.

## Riesgos

- Enum ampliado dentro de la transacción del migrador (mitigado con comparaciones `::text`).
- Sin reservas: una orden iniciada puede quedarse sin stock al completar (revalidación + mensaje
  con faltantes).
- Redondeo: el valor del producto es exactamente el costo consumido; el unitario se redondea a 6
  decimales sólo para mostrar y para el promedio.
- Cantidades muy chicas escaladas (p. ej. levadura × 1/3) se guardan con 10 decimales.
