# Fase 3 — Compras + inventario · Reporte

## Estado

```
FASE_3_STATUS = COMPLETE_PENDING_HUMAN_ACCEPTANCE
```

Los gates A–S pasaron en local desde una base vacía, y el CI remoto pasó en el PR de Fase 3 (ver
"Gates" y "CI"). **Fase 4 no se empezó**: espera la aceptación humana.

## Base commit

- Antes de empezar se mergearon los PR #1 (Fase 1) y #2 (Fase 2) a `main`, con CI verde en `main`.
- Rama: `fase-3-compras-inventario`, creada desde `main` en `d42d745`.
- PR: domusbrag/brurera#4, base `main`.
- El PR #3 (arranque en Windows) es independiente y **no** se mergeó.

## PR

https://github.com/domusbrag/brurera/pull/4

Commits: plan (`d2e15e9`), modelo + API (`6d7fd4b`), tests de integración (`4082222`), UI + E2E
(`d687f21`), ajustes visuales (`93374c8`), documentación (`ba00865`) y este reporte.

## Arquitectura

No hay piezas nuevas en el stack; se sigue el patrón de Fases 1 y 2:

| Capa                | Fase 3                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`   | `inventory.ts`: signos de movimiento, montos de compra, costo de adquisición, promedio ponderado (`applyInbound`/`applyOutbound`), estado de stock, costo efectivo. |
| `packages/database` | Esquemas de compras e inventario y la migración `0006_purchases_inventory.sql` (9 tablas, enums, CHECKs, triggers).                                                 |
| `packages/shared`   | Esquemas zod, DTOs, 13 permisos nuevos, etiquetas de auditoría.                                                                                                     |
| `apps/api`          | Módulos `presentations`, `purchases` e `inventory` (con `ledger.ts`, el único que escribe movimientos). Costo efectivo en `recipes.data.ts` y `raw-materials`.      |
| `apps/web`          | Compras (listado, alta/edición, detalle, recepción), Stock (existencias, movimientos, bajo mínimo, ficha, stock inicial, ajuste, merma) y presentaciones.           |

Web y API usan las mismas funciones de `@bakery/domain`: los importes y el impacto que se ven al
cargar son los que la API calcula y guarda.

## Modelo compras

- `purchases`: proveedor, fecha, depósito de destino por defecto, observación, estado
  `DRAFT → ORDERED → PARTIALLY_RECEIVED → RECEIVED`, o `CANCELLED` (sólo sin mercadería recibida,
  ADR-038). Código `OC-…` por empresa.
- `purchase_lines`: materia prima, presentación o unidad de compra, cantidad, precio, descuento,
  impuesto informativo. Al guardar se **congela** el factor a la unidad base y la cantidad base
  pedida; `received_quantity ≤ ordered_quantity` por CHECK.
- Importes: bruto = cantidad × precio; neto = bruto − descuento; total = Σ neto + impuestos. Los
  impuestos no entran al costo (ADR-032).
- Sólo `DRAFT` se edita; desde `ORDERED` la compra queda fija.

## Modelo recepción

- `purchase_receipts` (`REC-…`) y `purchase_receipt_lines`, estado `DRAFT → POSTED | CANCELLED`.
- Crear una compra o una recepción en borrador **no** mueve stock. Sólo confirmar (`POST
/purchase-receipts/:id/post`) lo hace, en una transacción: revalida lo pendiente al momento de
  confirmar, genera un `PURCHASE_RECEIPT` por línea, actualiza `received_quantity`, el estado de la
  compra, el promedio y la auditoría.
- Recepción parcial: la compra pasa a "Recibida en parte"; la segunda recepción la completa.
- Recepciones `POSTED`/`CANCELLED` y sus líneas son inmutables por trigger (ADR-033).

## Presentaciones

`raw_material_presentations` (ADR-030, resuelve ADR-025): "Bolsa 25 kg" pertenece a una materia
prima y declara unidad de compra, cantidad contenida y su unidad (compatible con la base). La
conversión es inmutable; sólo se renombra o se activa/desactiva. Sin presentación, una línea sólo
acepta unidades de la misma raíz que la base (`INCOMPATIBLE_PURCHASE_UNIT`). Una FK compuesta
impide usar la presentación de otra materia prima.

## Inventario

- Depósitos de Fase 1. El stock es por depósito; el costo y el estado frente al mínimo, por
  empresa.
- Stock inicial (exige costo, una vez por materia prima y depósito), ajustes (`PHYSICAL_COUNT`,
  `DATA_CORRECTION`, `BREAKAGE`, `OTHER`) y mermas (`EXPIRED`, `DAMAGED`, `PRODUCTION_LOSS`,
  `QUALITY`, `OTHER`). El movimiento es el documento (ADR-037).
- Sin stock negativo: `409 INSUFFICIENT_STOCK` y CHECKs en la base (ADR-035).
- Estado de stock mínimo: `OUT_OF_STOCK` (0), `LOW` (< mínimo), `OK`, medido contra el total de la
  empresa; el listado "Bajo mínimo" muestra el faltante.

## StockMovement

`stock_movements` es append-only por trigger y la única fuente de verdad (ADR-026). Cantidad y
valor **con signo** en unidad base (ADR-028): ingresos `INITIAL_STOCK`, `PURCHASE_RECEIPT`,
`ADJUSTMENT_POSITIVE`; salidas `ADJUSTMENT_NEGATIVE`, `WASTE`. Lleva `sequence`, costo unitario,
valor, saldo resultante (`balance_after ≥ 0`), motivo, referencia de origen
(tipo, id, línea) y actor. Un CHECK exige signo, valor, motivo y referencia coherentes con el tipo.

## StockBalance

`stock_balances` (empresa + depósito + materia prima) es una proyección actualizada en la misma
transacción que el movimiento. El trigger `stock_balances_guard` sólo acepta cantidad nueva =
anterior + movimiento, y sólo con un movimiento más nuevo de la misma empresa, depósito y
materia prima (ADR-027). Un `UPDATE` manual falla con SQLSTATE 23001. Los tests comparan saldos
contra `Σ movimientos`.

## Costo promedio

Promedio ponderado móvil por empresa, en `@bakery/domain` (ADR-029):

- Ingreso con existencia 0: el promedio es el costo del ingreso.
- Ingreso con existencia: `(valor anterior + cantidad × costo) ÷ cantidad nueva`.
- Salida: el promedio no cambia; sale `cantidad × promedio`; si la existencia queda en 0, el valor
  queda en 0.
- Escalas: cantidades 10 decimales, costos y valores 6, HALF_UP.

Caso exigido: 100 kg a $1.000 + 100 kg a $1.200 → 200 kg a $1.100 (test de dominio, integración
§61 y E2E). Cada cambio queda en `inventory_cost_history` (append-only) y en la auditoría
(`MOVING_AVERAGE_COST_CHANGED`).

## Cost source priority

`selectEffectiveCost` (función de dominio, ADR-031):

1. `PURCHASE_MOVING_AVERAGE`: promedio de inventario, si existe.
2. `MANUAL_REFERENCE`: costo de referencia manual de Fase 2.
3. `INCOMPLETE`: ninguno; la receta queda con costo incompleto.

## Integración con recetas

`withEffectiveCost` / `toCostInputs` (`recipes.data.ts`) aplican el costo efectivo; los DTO de
materias primas y versiones lo envían para que el editor calcule lo mismo. La UI dice "Costo
usado" y muestra su origen. Las recetas cambian solas al confirmar compras; **los snapshots
publicados no cambian** (append-only) y los nuevos guardan el origen correcto (test §62).

## Atomicidad

Confirmar una recepción, cargar stock inicial, ajustar o registrar una merma ocurre en una sola
transacción: movimiento, saldo, costo, historial de costo, estados de compra y recepción y
auditoría. El test de rollback (§65) agrega un trigger que hace fallar la auditoría
`PURCHASE_RECEIPT_POSTED`: no queda ningún movimiento, saldo, costo ni cambio de estado.

## Concurrencia

Locks de fila (`SELECT … FOR UPDATE`) en orden fijo: compra → recepción → líneas → filas de costo
ordenadas por id → saldo (ADR-034). Las filas faltantes se crean vacías con `ON CONFLICT DO
NOTHING` antes de bloquearlas. Tests: tres confirmaciones simultáneas de la misma recepción dan
`[200, 409, 409]`; cuatro recepciones y tres mermas en paralelo dejan la cadena de historial
consistente; mermas en paralelo sobre stock justo dan `[201, 201, 409, 409]`.

## Idempotencia

Dos capas (ADR-033): estado verificado con la recepción bloqueada (`409 ALREADY_POSTED`) e índice
único `(company_id, source_line_id)` en `stock_movements`. Un doble click o un reintento no duplican
stock (test §64 y concurrencia).

## Migraciones

Una sola migración nueva, `0006_purchases_inventory.sql`. **0000–0005 no se tocaron.** Tablas:
`raw_material_presentations`, `purchases`, `purchase_lines`, `purchase_receipts`,
`purchase_receipt_lines`, `stock_movements`, `stock_balances`, `raw_material_inventory_costs`,
`inventory_cost_history`. Índices para los listados paginados (por empresa + estado/fecha,
movimientos por materia prima/depósito/secuencia). `pnpm db:reset` aplica 0000–0006 desde cero.

## API

Todo bajo `/api`, con permisos, tenancy y paginación del lado del servidor.

- Presentaciones: `GET/POST /raw-materials/:id/presentations`,
  `PATCH /raw-material-presentations/:id`, `POST …/:id/deactivate`, `POST …/:id/activate`.
- Compras: `GET/POST /purchases`, `GET/PATCH /purchases/:id`, `POST /purchases/:id/order`,
  `POST /purchases/:id/cancel`, `GET/POST /purchases/:id/receipts`.
- Recepciones: `GET/PATCH /purchase-receipts/:id`, `POST /purchase-receipts/:id/post`,
  `POST /purchase-receipts/:id/cancel`.
- Inventario: `GET /inventory`, `GET /inventory/raw-materials/:id`, `GET /inventory/movements`,
  `GET /inventory/low-stock`, `GET /inventory/costs/:id`, `POST /inventory/initial-stock`,
  `POST /inventory/adjustments`, `POST /inventory/waste`.
- Materias primas y recetas exponen `movingAverageCost`, `effectiveCost` y `effectiveCostSource`.

## UI

- **Compras**: listado con filtros (estado, proveedor), alta y edición de borrador con importes en
  vivo ("Guardar borrador" / "Guardar y confirmar pedido"), detalle con acciones, líneas, totales,
  recepciones e historial; recepción con revisión previa ("Revisar recepción" → "Confirmar
  recepción").
- **Stock**: pestañas Existencias · Movimientos · Bajo mínimo; ficha con existencias por depósito,
  costos (promedio, referencia, usado, valorización), última compra, presentaciones, movimientos e
  historial de costo; formularios de stock inicial, ajuste y merma con impacto antes/después y paso
  de revisión.
- **Maestros**: la materia prima muestra "Costo usado por recetas", enlace a su stock y
  presentaciones. El aviso de proveedores enlaza a sus compras.
- **Recetas**: columnas "Costo usado" con su origen.
- Navegación: Compras y Stock habilitados según permisos.

## Permisos

Nuevos: `purchases.read`, `purchases.create`, `purchases.update`, `purchases.order`,
`purchases.receive`, `purchases.cancel`, `inventory.read`, `inventory.adjust`, `inventory.waste`,
`inventory.initial_stock`, `inventory.cost.read`, `presentations.read`, `presentations.manage`. Matriz por rol en
[PERMISSIONS](../PERMISSIONS.md) (generada). Depósito y Producción ven stock sin valorización;
Compras, Administración, Admin y Dueño, con costos (ADR-036). `authorization.test.ts` cubre los 25
endpoints nuevos rol × endpoint.

## Auditoría

En la misma transacción: `PURCHASE_CREATED/UPDATED/ORDERED/CANCELLED`,
`PURCHASE_RECEIPT_CREATED/POSTED/CANCELLED`, `INITIAL_STOCK_POSTED`, `INVENTORY_ADJUSTED`,
`INVENTORY_WASTE_RECORDED`, `MOVING_AVERAGE_COST_CHANGED`, altas y cambios de presentaciones. La UI
muestra el historial en lenguaje de negocio ("Merma · Depósito: 200 kg → 197 kg").

## Tests

| Suite                              | Tests | Qué cubre                                                                                                          |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `domain/inventory.test.ts`         | 23    | Signos, importes, conversión, promedio (100@1000 + 100@1200 → 1100), salidas, estado, costo efectivo               |
| `purchases-inventory.test.ts`      | 32    | §61 escenario principal, §62 recetas, §63 parcial, §64 idempotencia, §65 rollback, edición y cancelación, listados |
| `inventory-invariants.test.ts`     | 19    | Invariantes 1–17 con chequeos en la base y concurrencia                                                            |
| `inventory-tenancy.test.ts`        | 9     | Aislamiento entre empresas en lecturas, escrituras y FKs compuestas                                                |
| `authorization.test.ts` (ampliado) | —     | 25 endpoints nuevos                                                                                                |

Totales (`pnpm test` desde base vacía): domain 75, shared 31, web 18, database 5, api 249 → **378
tests, 0 fallos**.

Invariantes (§59): 1–17 y 21 en `inventory-invariants.test.ts`, cada uno verificado en la API y
en la base (CHECK, UNIQUE, FK o trigger); 18 (cross-company) en `inventory-tenancy.test.ts`; 19
(permisos backend) en `authorization.test.ts`; 20 (recepción atómica) en el test de rollback §65.

## E2E

`e2e/fase3-compras-inventario.spec.ts`, desktop y tablet:

- **Flujo principal (§67, 21 pasos)**: presentación "Bolsa 25 kg", compra de 8 bolsas en dos
  precios, confirmación, recepción parcial, stock y promedio, segunda recepción, compra completa,
  promedio 200 kg a $1.100, receta con "Costo usado" desde el promedio, merma con impacto y
  revisión, movimientos, historial y auditoría. Sin errores de consola.
- **Stock mínimo (§68)**: materia prima bajo mínimo con faltante, aparece en "Bajo mínimo", compra
  y recepción, pasa a OK y sale del listado.

Suite completa: **22/22** (Fases 0–3, desktop + tablet).

## Tenancy

Toda tabla nueva lleva `company_id` y FKs compuestas `(company_id, id)`; las consultas filtran por
la empresa de la sesión. `inventory-tenancy.test.ts`: otra empresa recibe 404 en lecturas y
escrituras, no puede usar proveedores, depósitos, materias primas ni presentaciones ajenas, y la
base rechaza cruces por FK.

## UX findings

Revisión manual en 1440×900, 1366×768 y 768×1024 sobre 10 pantallas: sin overflow horizontal de
página, sin UUIDs visibles, sin errores ni warnings de consola.

| Hallazgo                                                               | Resolución                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| El placeholder de unidad de compra se confundía con la opción "Bolsa". | Placeholder "Elegí la unidad de compra"; nombre sugerido "Bolsa 25 kg". |
| En la ficha de stock, "Detalles" quedaba pegado al resumen de costos.  | Separación entre bloques.                                               |
| "Origen" del costo se mostraba vacío cuando no había fuente.           | Se oculta si no hay origen.                                             |
| "Nueva compra" llevaba a una ruta inexistente.                         | Enlace corregido a `/compras/nueva`.                                    |
| El aviso de proveedores prometía la cuenta corriente "en Fase 3".      | Enlaza a las compras del proveedor y difiere la cuenta corriente.       |

## UX backlog

Se creó [UX_BACKLOG](../UX_BACKLOG.md) con hallazgos transversales (navegación, arquitectura de
información, jerarquía visual, formularios, tablas, dashboard, responsive, accesibilidad, flujo) y
la entrada **UX/DESIGN OPTIMIZATION** en el [ROADMAP](../ROADMAP.md), después de Fase 5. No se
ejecutó.

## Gates

| Gate | Qué                | Resultado | Evidencia                                                      |
| ---- | ------------------ | --------- | -------------------------------------------------------------- |
| A    | DB desde cero      | PASS      | `pnpm db:reset`: volumen borrado, 0000–0006 aplicadas, seed OK |
| B    | Unit               | PASS      | domain 75, shared 31, web 18, database 5, api unit             |
| C    | Integración        | PASS      | api 249 tests (`pnpm test`, salida 0)                          |
| D    | Invariantes        | PASS      | `inventory-invariants.test.ts` (1–17)                          |
| E    | Promedio ponderado | PASS      | dominio + §61: 200 kg a $1.100                                 |
| F    | Idempotencia       | PASS      | §64 + `[200, 409, 409]`                                        |
| G    | Rollback           | PASS      | §65: sin restos tras fallar la auditoría                       |
| H    | Concurrencia       | PASS      | Confirmaciones y mermas simultáneas                            |
| I    | Tenancy            | PASS      | `inventory-tenancy.test.ts` + `tenancy.test.ts`                |
| J    | Autorización       | PASS      | `authorization.test.ts`, 25 endpoints nuevos                   |
| K    | Recetas / costo    | PASS      | §62 + `recipes*.test.ts`: costo usado, snapshots inmutables    |
| L    | E2E compra         | PASS      | Flujo principal, desktop + tablet                              |
| M    | E2E stock mínimo   | PASS      | Flujo §68, desktop + tablet                                    |
| N    | Revisión manual UX | PASS      | 3 resoluciones, sin overflow, sin IDs, sin warnings            |
| O    | Lint               | PASS      | ESLint `--max-warnings 0` + Prettier                           |
| P    | Typecheck          | PASS      | `tsc` estricto en los 5 paquetes                               |
| Q    | Build              | PASS      | API (tsup) y web (Next.js) con las rutas nuevas                |
| R    | Worktree limpio    | PASS      | `git status` vacío tras el commit                              |
| S    | CI remoto          | PASS      | Ver "CI"                                                       |

## CI

```
CI_REMOTE_STATUS = PASS (run 36817148235 sobre ba00865)
```

El workflow `CI` (job `verify`: lint, typecheck, migraciones, seed, test, build y Playwright) pasó
en el PR #4 sobre `ba00865`, el último commit con código, tests y docs. El commit que sólo agrega
este reporte vuelve a correr el mismo CI.

## Riesgos

- **Impuestos no recuperables y fletes** no entran al costo (ADR-032). Si la empresa no recupera un
  impuesto, el costo queda subvaluado.
- **Recepciones sin reversión.** Un error en una recepción confirmada se corrige con un ajuste; no
  hay devoluciones a proveedor.
- **Triggers custodios.** Una migración que reconstruya saldos o costos debe deshabilitarlos de
  forma explícita.
- **Sin stock negativo.** Producción (Fase 4) puede necesitar consumir antes de registrar la compra;
  se revisará con un ADR.

## Deuda

- **`reference_cost` en `recipe_cost_snapshot_lines`** ahora significa "costo usado"; se renombrará
  cuando se toque la tabla (ADR-031).
- **Motivos** de ajuste y merma son `varchar` + CHECK, no enum de Postgres.
- **Stock inicial** se bloquea si ya hay cualquier movimiento en ese depósito para esa materia
  prima, aunque sea una recepción.
- **Salidas sobre materia prima inactiva** están permitidas (útil para dar de baja existencias, pero
  no está explícito en la UI).
- **`movingAverageCost` en la API de materias primas** es visible con `raw_materials.read`, igual que
  el costo usado por recetas (ADR-036); la valorización total sí exige `inventory.cost.read`.
- **Compra con faltante definitivo**: no se puede cerrar "recibida con faltante" (UX backlog).
- Filtros de fecha y referencia de movimientos existen en la API, no en la UI.

## ADR

Nuevos en [DECISIONS](../DECISIONS.md): ADR-026 ledger append-only · ADR-027 proyecciones
custodiadas por triggers · ADR-028 cantidades con signo · ADR-029 promedio ponderado por empresa y
redondeo · ADR-030 presentaciones (resuelve ADR-025) · ADR-031 costo efectivo · ADR-032 impuestos
informativos · ADR-033 recepciones e idempotencia · ADR-034 locks en orden fijo · ADR-035 sin
stock negativo · ADR-036 visibilidad de la valorización · ADR-037 operaciones manuales sin tabla
de documento · ADR-038 cancelación sólo sin recibido.

## Próximo paso

**FASE 4 — PRODUCCIÓN**: órdenes de producción, consumo de materias primas
(`PRODUCTION_CONSUMPTION`) al costo promedio y alta de producto terminado.

**No se comenzó.** Requiere la aceptación humana de Fase 3.
