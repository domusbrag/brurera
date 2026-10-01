# Fase 4.5 — Lotes + conservación + vida útil · Reporte

## Estado

**FASE_4_5_STATUS = COMPLETE_PENDING_HUMAN_ACCEPTANCE.** No se comenzó Fase 5A (pedidos) ni
ventas: esperan la aceptación humana de esta fase.

## Base commit y PR

- Fase 4 mergeada a `main` (PR #5, CI verde, run 36895016278); CI de `main` verde (run
  36910953506).
- Rama `fase-4.5-lotes-conservacion` desde `main` en **`364c1e7`**.
- PR: [#6](https://github.com/domusbrag/brurera/pull/6). PR #3 (Windows) no se tocó.

## Modelo de lotes

| Tabla                           | Qué guarda                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_conservation_settings` | Por producto: estado inicial por defecto y umbral de "próximo a vencer" (minutos).                                                                                                                             |
| `product_conservation_profiles` | Por producto y estado (`FRESH`, `REFRIGERATED`, `FROZEN`, `THAWED`): habilitado, vida útil en minutos, puede ser inicial, notas.                                                                               |
| `product_lots`                  | El lote: producto, orden de origen, lote padre, código, depósito, conservación, producido, cambio de estado, utilizable hasta, vida útil, cantidad y valor iniciales, costo unitario, calidad, `operation_id`. |
| `product_lot_balances`          | Proyección cantidad + valor por (empresa, depósito, lote), sólo desde movimientos.                                                                                                                             |

`stock_movements.product_lot_id` es obligatorio en todo movimiento de producto (check + FK
compuesta). El estado operativo (utilizable, próximo a vencer, vencido, bloqueado, agotado) se
deriva al consultar. Ver DOMAIN_MODEL, ADR-043.

## Migración desde Fase 4

`0008_product_lots.sql` (0000–0007 intactas). Verifica que todo movimiento de producto sea la
salida de una orden `COMPLETED` (si no, `FASE_4_5_MIGRATION_BLOCKER` y nada se aplica), crea un
lote raíz `FRESH` sin vencimiento por orden (código = `batch_code` o `LOT-<OP>`), completa
`product_lot_id` (única escritura sobre el ledger, trigger append-only suspendido sólo para esa
sentencia), carga saldos con el trigger activo, re-verifica Σ lotes = agregado = costo (cantidad y
valor) y recién al final agrega el check. Probado:

- **Base vacía**: `migration-fase4.test.ts` y la suite de integración migran desde cero.
- **Datos reales de Fase 4** (dump con 3 órdenes, 100 + 50 + 78 kg en dos depósitos): antes /
  después idénticos en movimientos, saldos, promedio y valor; lotes `LOT-20261001-001/002/003` =
  100 / 50 / 78 kg por $67.820 / $36.320 / $56.120.
- **Base de desarrollo con datos de los E2E de Fase 4**: 3 lotes, 0 movimientos sin lote.
- **§51 automatizado**: 100 kg + 50 kg (uno sin batch code → `LOT-OP-0002`) → 2 lotes, Σ = 150,
  valor 104.140 y promedio idénticos; y el caso BLOCKER (ingreso huérfano) aborta sin aplicar nada.

## Conservation profiles y shelf life

Configurables por producto y estado: nada fijo en el código (ADR-046). Vida útil en minutos
enteros (máx. 10 años); la UI la carga y muestra en días u horas (`describeShelfLife`). Sin perfil:
lote `FRESH` sin vencimiento, contado como utilizable y marcado "vida útil sin configurar".
Cambiar el perfil no recalcula lotes existentes. Auditoría `PRODUCT_CONSERVATION_PROFILE_CREATED`
/ `UPDATED` sólo si algo cambió.

## Integración con producción

Completar crea el lote en la misma transacción, antes del `PRODUCTION_OUTPUT` que lo referencia.
Si la orden no tenía `batch_code` se genera al completar. Estado inicial: el pedido (si el perfil
lo permite como inicial; si no, `409 INITIAL_STATE_NOT_ALLOWED` y la orden sigue en curso) o el
por defecto. La orden completada muestra y enlaza su lote; el diálogo de completar anuncia el
estado y la vida útil y deja elegir si hay varios estados iniciales.

## Lot balances

Todo movimiento de producto actualiza saldo del lote, saldo agregado y costo del producto en el
mismo paso; los tres custodiados por triggers. `reconciliationProblems` verifica después de cada
operación de los tests: Σ lotes = agregado, = costo (cantidad y valor), saldo = Σ movimientos,
nada negativo, nada sin lote (gates L y M).

## Freeze / Thaw / Traceability

Transiciones `FRESH → FROZEN`, `REFRIGERATED → FROZEN`, `FROZEN → THAWED` si el destino está
habilitado; nunca `THAWED → FROZEN` (ADR-045). Parcial: el origen baja, nace un hijo
`<padre>.<n>` con la misma orden de origen y el vencimiento del destino desde ahora;
`LOT_TRANSFORMATION_OUT` / `IN` al costo del lote, neto cero, sin costo agregado ni cambio de
promedio. §52: 500 → 200 FRESH + 300 FROZEN (valor 203.460), agregado, valor y promedio iguales.
§53: 300 FROZEN → 200 + 100 THAWED con 12 h; recongelar → `409 TRANSFORMATION_NOT_ALLOWED`. El
detalle del lote muestra padre, hijos, movimientos y auditoría.

## Expiry, FEFO y disponibilidad futura

Vencido = `at > usable_until`, derivado (sin jobs). FEFO: `usable_until` asc (sin vencimiento al
final), luego `produced_at`; ordena lotes, disponibilidad y `recommendFefo` (sólo recomendación).
`calculateProductAvailabilityAt(productId, warehouse?, at)` y `GET
/api/inventory/products/:id/availability?at=` devuelven físico, elegible, no elegible por motivo,
desglose por conservación, cantidad sin vida útil y lotes con rango FEFO. §18/§54: 700 físicos
(300 frescos que vencen antes, 400 congelados) → 400 elegibles el sábado, razón "300 kg vencen
antes de la fecha". Vista **Próximos a vencer** con umbral por producto o ventana elegida.

## Waste

`WASTE` sobre un lote (`EXPIRED`, `DAMAGED`, `QUALITY`, `OTHER`) al costo del lote (agotar = valor
restante exacto); baja lote, agregado y valor sin cambiar el promedio; registra historial de
costo. §55: 100 → merma 20 → 80, valor −13.564, promedio igual. Admite lotes vencidos o bloqueados.

## Preservación de costo y valor

ADR-044: el promedio sólo cambia con producciones; Σ valores de lote = valor de inventario.

## Atomicidad, concurrencia, idempotencia y rollback

- Transformar y merma: una transacción; locks lote → saldo del lote → costo → saldo agregado →
  saldo del hijo (orden global compatible con ADR-034/042).
- Concurrencia: 300 + 300 sobre 500 en paralelo → `[201, 409 INSUFFICIENT_LOT_QUANTITY]`, quedan
  200, nunca negativo.
- Idempotencia (ADR-049): `operationId` por intento; reintento → `200 replayed: true` sin
  duplicar; mismo id en paralelo → un solo hijo; mismo id en otra operación → `409
OPERATION_ID_REUSED`.
- Rollback: falla inyectada al auditar la transformación → 500 y nada cambia (sin hijo,
  movimientos, saldos); sin la falla, la misma operación funciona.

## Tenancy

FKs compuestas en todas las tablas nuevas (producto, orden, depósito, unidad, lote padre, saldo →
lote con producto). Empresa B recibe 404 al leer, congelar, descartar, bloquear un lote, leer o
configurar la conservación o consultar disponibilidad de A; su "Próximos a vencer" no ve lotes de A.

## Permisos

| Permiso                        | Owner/Admin | Administración | Producción | Depósito |
| ------------------------------ | :---------: | :------------: | :--------: | :------: |
| `product_lots.read`            |      ✓      |       ✓        |     ✓      |    ✓     |
| `product_lots.transform`       |      ✓      |                |     ✓      |    ✓     |
| `product_lots.waste`           |      ✓      |                |            |    ✓     |
| `product_lots.quality` (extra) |      ✓      |                |            |    ✓     |
| `product_conservation.read`    |      ✓      |       ✓        |     ✓      |    ✓     |
| `product_conservation.manage`  |      ✓      |                |            |          |
| `inventory.expiry.read`        |      ✓      |       ✓        |     ✓      |    ✓     |

Importes por `inventory.cost.read` como hasta ahora (Depósito ve lotes sin valores). Ventas no ve
lotes. `docs/PERMISSIONS.md` regenerado.

## Auditoría

`PRODUCT_CONSERVATION_PROFILE_CREATED`, `_UPDATED`, `PRODUCT_LOT_CREATED`, `PRODUCT_LOT_TRANSFORMED`
(en origen e hijo), `PRODUCT_LOT_WASTE_RECORDED`, `PRODUCT_LOT_BLOCKED`, `PRODUCT_LOT_UNBLOCKED`,
con etiquetas en lenguaje de negocio.

## API

- `GET` / `PUT /api/products/:id/conservation`
- `GET /api/inventory/products/:id/lots?scope=active|all`
- `GET /api/inventory/products/:id/availability?at=&warehouseId=`
- `GET /api/inventory/expiring?withinHours=&status=&warehouseId=&productId=&search=`
- `GET /api/product-lots/:id`
- `POST /api/product-lots/:id/transform` · `/waste` (201, o 200 en reintento) · `/block` · `/unblock`
- `POST /api/production-orders/:id/complete` acepta `{ conservationState? }`; la orden expone
  `productLot`; productos terminados exponen el resumen por lote.

## UI

Producto → Conservación (resumen y configuración). Stock → Productos terminados: físico, fresco,
refrigerado, congelado, utilizable ahora, próximo a vencer, costo. Ficha de stock del producto:
existencias por conservación, LOTES (FEFO, con producción, producido, estado y acciones) y
disponibilidad a una fecha. Detalle de lote (padre, hijos, movimientos, historial, bloquear).
Congelar / Descongelar (advierte que no se recongela) / Merma con resumen previo. Próximos a vencer
(pestaña de Stock, con acciones). Movimientos con su lote. Sin UUIDs en pantalla.

## Tests

| Paquete  | Tests | Nuevos de 4.5                                                                                      |
| -------- | ----: | -------------------------------------------------------------------------------------------------- |
| domain   |   125 | `lots.test.ts` (30)                                                                                |
| shared   |    37 | —                                                                                                  |
| web      |    19 | —                                                                                                  |
| database |     5 | tablas nuevas                                                                                      |
| api      |   316 | `product-lots.test.ts` (25), `migration-fase4.test.ts` (2), matriz de autorización (+10 endpoints) |

**502 tests, 0 fallos.** Detalle en TESTING.md.

## E2E

`e2e/fase4-5-lotes.spec.ts`, desktop + tablet: principal (configurar, producir, lote, congelar,
descongelar, merma, movimientos, auditoría, stock por estado, disponibilidad a 3 días: 20 de 95),
no congelable (sin acción; acceso directo explicado) y vencimiento (Próximos a vencer; físico pero
no elegible en el futuro). Suite completa **32/32** (Fases 0–4.5). `fase4-produccion.spec.ts` sólo
cambió el rótulo "Stock total" → "Stock físico".

## UX findings

Corregido en la fase: rótulos con estado + vencimiento en palabras ("vence en 1 día y 23 h"), vida
útil en días u horas, acciones según reglas (no se ofrece lo que no se puede). Registrado en
UX_BACKLOG [F4.5]: pestañas de Inventario, ficha de stock larga, badges dobles, vida útil en tabla,
zona horaria del selector de fecha, columnas en tablet, alerta de vencimientos en el inicio,
congelado masivo, merma directa desde Próximos a vencer.

## Gates

| Gate                           | Resultado                                                        |
| ------------------------------ | ---------------------------------------------------------------- |
| A — DB vacía                   | ✓ migración desde cero (integración y `migration-fase4.test.ts`) |
| B — migración Fase 4 con datos | ✓ dump real + base de desarrollo + test automatizado             |
| C — unit                       | ✓                                                                |
| D — lot invariants             | ✓                                                                |
| E — production → lot           | ✓                                                                |
| F — conservation profiles      | ✓                                                                |
| G — freeze                     | ✓ §52                                                            |
| H — thaw                       | ✓ §53                                                            |
| I — expiry eligibility         | ✓                                                                |
| J — FEFO ordering              | ✓                                                                |
| K — waste                      | ✓ §55                                                            |
| L — aggregate reconciliation   | ✓                                                                |
| M — value reconciliation       | ✓                                                                |
| N — idempotency                | ✓                                                                |
| O — concurrency                | ✓                                                                |
| P — rollback                   | ✓                                                                |
| Q — tenancy                    | ✓                                                                |
| R — authorization              | ✓                                                                |
| S — E2E principal              | ✓ desktop + tablet                                               |
| T — E2E non-freezable          | ✓                                                                |
| U — E2E future eligibility     | ✓                                                                |
| V — UX manual                  | ✓ recorrido en desktop y tablet vía E2E; hallazgos en UX_BACKLOG |
| W — lint                       | ✓                                                                |
| X — typecheck                  | ✓                                                                |
| Y — build                      | ✓                                                                |
| Z — worktree                   | ✓ limpio                                                         |
| AA — remote CI                 | ver PR #6                                                        |

## CI

Ver el estado de los checks en el PR #6.

## Riesgos

- Los lotes migrados de Fase 4 no tienen vencimiento: cuentan como utilizables hasta agotarse o
  registrarse como merma. Conviene revisarlos al aceptar la fase.
- "Disponibilidad a una fecha" toma la hora del navegador; si la PC está en otra zona que la
  empresa, la hora elegida difiere (UX_BACKLOG).
- Las salidas por lote dejan el promedio intacto pero el costo del lote puede diferir del promedio:
  Fase 5B debe decidir si la venta sale al costo del lote o al promedio.

## Deuda

`INVENTORY_RESERVATIONS` (Fase 5A), consumo de lotes por ventas (5B), transferencias de lotes
entre depósitos, fresco ↔ refrigerado, costo de congelado, `PRODUCTION_REVERSAL` (sigue), estado
`DISCARDED` explícito (hoy: merma total → agotado).

## ADR

ADR-043 (lote propio desde la orden, hijos por transformación), ADR-044 (valorización por lote sin
tocar el promedio), ADR-045 (transiciones), ADR-046 (vencimiento derivado; vida útil desconocida
utilizable), ADR-047 (migración con BLOCKER y backfill del ledger), ADR-048 (calidad separada,
permiso `product_lots.quality`), ADR-049 (idempotencia por `operationId`). ADR-039 anotado.

## Próximo paso

FASE 5A — Pedidos + demanda comprometida + necesidades. **No se comienza sin aceptación humana.**
