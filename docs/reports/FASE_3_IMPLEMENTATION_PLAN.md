# FASE_3_IMPLEMENTATION_PLAN — Compras + inventario

## Base

- PR #1 (Fase 1) mergeado a `main` → `ef222d6`.
- PR #2 (Fase 2) retargeteado a `main` y mergeado → `d42d745`.
- CI de `main` en `d42d745`: **verde** (run 36812767648).
- Rama `fase-3-compras-inventario` creada desde
  **`d42d745d2237d04cf9400234cf50c26697d3e915`**.

## Inspección (estado de partida)

- `raw_materials`: `base_unit_id` (unidad raíz), `minimum_stock numeric(18,4)`,
  `preferred_supplier_id`, `reference_cost numeric(18,6)` + `reference_cost_source` (enum
  `cost_source`, ya incluye `PURCHASE_MOVING_AVERAGE`) + `reference_cost_updated_at`. Sin stock.
- Costeo de recetas: `@bakery/domain/costing.ts` (puro, decimal.js). La API arma la entrada en
  `recipes.data.ts` (`loadRawMaterials` → `toCostInputs`), que hoy usa siempre `reference_cost`.
  El editor web hace el mismo cálculo en vivo con `RawMaterialDto.referenceCost`. Los snapshots
  (`recipe_cost_snapshots` + líneas) son append-only por trigger y guardan `reference_cost` +
  `cost_source` por línea.
- Unidades: raíz + derivadas de un nivel; `PACKAGING` (bolsa, caja) sin conversión global
  (ADR-025 difirió el packaging por artículo a esta fase).
- `warehouses`: maestro por empresa con `UNIQUE (company_id, id)`; cada empresa nace con
  "Depósito Principal".
- Tenancy: FKs compuestas `(company_id, id)` (ADR-016); `companyId` sólo desde la sesión.
- Auditoría: `audit_logs` append-only, se escribe en la misma transacción.
- Permisos: catálogo en `@bakery/shared`, roles de sistema como datos, matriz rol × endpoint
  probada contra la API; `docs/PERMISSIONS.md` generado.
- Códigos internos: `code_sequences` + `allocateCode` (fila bloqueada hasta el commit).
- Tests: unit (domain/shared/api), integración con Postgres real (serie), E2E Playwright
  (desktop + tablet) contra el build.
- Migraciones 0000–0005 cerradas.

## Modelo

| Tabla                          | Rol                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raw_material_presentations`   | Presentación de compra de UNA materia prima: nombre, unidad de compra (bolsa), `contained_quantity` + unidad (25 kg). La conversión es inmutable (se desactiva y se crea otra), igual que las unidades (ADR-018).                                             |
| `purchases`                    | Cabecera: proveedor, número interno `OC-0001`, nro. de documento del proveedor, fechas, estado, moneda, subtotal, descuento, impuestos informativos, total, quién creó / pidió / canceló.                                                                     |
| `purchase_lines`               | Materia prima, presentación opcional, unidad de compra, cantidad pedida, precio unitario, descuento, bruto y neto, factor a unidad base congelado, cantidad base pedida y **cantidad recibida** (materializada, `≤ pedida` por CHECK).                        |
| `purchase_receipts`            | Recepción `REC-0001`: compra, depósito, fecha de recepción, estado `DRAFT`/`POSTED`/`CANCELLED`, nro. de remito, quién la cargó / confirmó.                                                                                                                   |
| `purchase_receipt_lines`       | Línea de compra recibida: cantidad pedida (copia), cantidad recibida en unidad de compra, presentación, cantidad normalizada a unidad base, costo de adquisición por unidad base y valor de inventario de la línea. Congeladas al confirmar.                  |
| `stock_movements`              | **Ledger append-only y autoritativo.** Depósito, tipo de ítem (`RAW_MATERIAL`; `PRODUCT` preparado), tipo de movimiento, cantidad **con signo** en unidad base, costo unitario, valor total con signo, saldo del depósito después, referencia, actor, motivo. |
| `stock_balances`               | Proyección por empresa + depósito + ítem: cantidad (CHECK `≥ 0`), último movimiento. Un trigger exige que cada cambio corresponda exactamente a un movimiento.                                                                                                |
| `raw_material_inventory_costs` | Estado de costo por materia prima a nivel EMPRESA: cantidad total, valor de inventario, promedio ponderado móvil, último movimiento. Mismo trigger de coherencia.                                                                                             |
| `inventory_cost_history`       | Append-only, una fila por movimiento: cantidad/valor/promedio antes y después, origen y referencia (recepción, ajuste…).                                                                                                                                      |

Enums nuevos: `purchase_status`, `purchase_receipt_status`, `stock_item_type`,
`stock_movement_type` (sólo los de Fase 3: `INITIAL_STOCK`, `PURCHASE_RECEIPT`,
`ADJUSTMENT_POSITIVE`, `ADJUSTMENT_NEGATIVE`, `WASTE`; `PRODUCTION_CONSUMPTION`,
`PRODUCTION_OUTPUT`, `SALE`, `RETURN` se agregarán con `ALTER TYPE … ADD VALUE` cuando existan los
flujos), `inventory_adjustment_reason`, `waste_reason`.

Ajustes, mermas y stock inicial no tienen tabla propia: el movimiento ES el documento (tipo,
motivo, observación, actor, fecha). Esto evita una tabla vacía de semántica y mantiene una sola
fuente.

## Compra y recepción

```
Purchase:  DRAFT ──order──▶ ORDERED ──post receipt──▶ PARTIALLY_RECEIVED ──post receipt──▶ RECEIVED
             └──cancel──▶ CANCELLED ◀──cancel── (sólo sin recepciones POSTED)
Receipt:   DRAFT ──post──▶ POSTED (inmutable)      DRAFT ──cancel──▶ CANCELLED
```

- Una compra se edita completa en `DRAFT`; después sólo notas, fecha esperada y nro. de documento
  del proveedor. Para pedir necesita ≥ 1 línea. Sólo `ORDERED`/`PARTIALLY_RECEIVED` reciben.
- Una compra no `DRAFT` no se borra (trigger). Las líneas sólo se agregan/cambian/quitan con la
  compra en `DRAFT`; después sólo cambia `received_quantity` (trigger).
- Una recepción `POSTED` o `CANCELLED` no admite UPDATE ni DELETE, ni sus líneas (trigger).
- Cancelar una compra con mercadería recibida → `409 PURCHASE_HAS_RECEIPTS` (devoluciones fuera de
  alcance).

## Presentaciones y conversión

`1 presentación = contained_quantity × contained_unit` de ESA materia prima; la unidad contenida
debe ser compatible con la unidad base. Conversión de una línea:

- con presentación: `base_por_unidad = convert(contained_quantity, contained_unit → base)`;
- sin presentación: la unidad de compra debe ser compatible con la base (kg, g…);
  `base_por_unidad = convert(1, unidad → base)`.

`cantidad_base = cantidad × base_por_unidad` (4 bolsas × 25 kg = 100 kg). El factor se congela en
la línea al guardarla; la recepción guarda la cantidad comercial (4 bolsas) y la normalizada
(100 kg). Una FK compuesta `(company_id, raw_material_id, presentation_id)` hace imposible usar la
presentación de otra materia prima (invariante 10).

## Estrategia de costo

- Importes: `bruto = cantidad × precio`; `neto = bruto − descuento` (descuento ≤ bruto).
  Cabecera: `subtotal = Σ bruto`, `descuento = Σ descuentos`, `total = subtotal − descuento +
impuestos`. Impuestos: informativos, NO entran al costo (simplificación documentada).
- Costo de adquisición por unidad base de una línea = `neto / cantidad_base_pedida`
  (4 × $20.000 / 100 kg = $800/kg). Una recepción parcial se valoriza al mismo costo unitario.
- Promedio ponderado móvil por materia prima a nivel EMPRESA, con decimal.js:
  - ingreso: `si OldQty = 0 → NewAvg = costo del ingreso`; si no,
    `NewAvg = (OldValue + Qty × Cost) / (OldQty + Qty)`; `NewValue = OldValue + Qty × Cost`;
  - salida (merma, ajuste negativo): el promedio NO cambia; `NewValue = OldValue − Qty × Avg`;
    si la cantidad queda en 0, el valor queda en 0 (el residuo de redondeo lo absorbe la salida);
  - ajuste positivo: sin costo indicado usa el promedio vigente (no cambia el promedio); si no hay
    promedio, exige costo (`422 VALUATION_COST_REQUIRED`); stock inicial exige siempre costo.
  - escalas: promedio 6 decimales (HALF_UP), valores 6, cantidades base 10.
- Stock negativo prohibido: `409 INSUFFICIENT_STOCK` en la API y `CHECK (quantity >= 0)` en
  `stock_balances` y en el costo de empresa.

## Costo efectivo para recetas

Función de dominio explícita `selectEffectiveCost({ movingAverageCost, referenceCost })`:

1. promedio ponderado existente → `PURCHASE_MOVING_AVERAGE`;
2. si no, costo de referencia manual → `MANUAL_REFERENCE`;
3. si no, `null` → costo `INCOMPLETE`.

`recipes.data.ts` carga el promedio junto con la materia prima y llama a esa función: el costo
teórico actual pasa a usar el promedio automáticamente; los snapshots ya publicados no se tocan
(append-only por trigger) y los nuevos guardan `cost_source = PURCHASE_MOVING_AVERAGE`. El costo
de referencia manual se conserva y sigue editable. El editor de recetas usa el mismo costo
efectivo (viene en `RawMaterialDto`).

## Transacciones, concurrencia e idempotencia

Confirmar una recepción es UNA transacción:

1. `SELECT … FOR UPDATE` de la recepción y de la compra (orden fijo: compra → recepción);
2. validar estado de la compra y de la recepción (`409 ALREADY_POSTED` si ya está confirmada);
3. validar cantidades pendientes con las líneas de compra bloqueadas (`409 RECEIPT_EXCEEDS_PENDING`);
4. convertir y calcular costo de adquisición;
5. por cada materia prima, en orden de id (evita deadlocks): bloquear la fila de costo de empresa
   y el saldo del depósito (`INSERT … ON CONFLICT DO NOTHING` + `SELECT … FOR UPDATE`);
6. insertar `stock_movements`, actualizar `stock_balances`, actualizar costo de empresa e
   insertar `inventory_cost_history`;
7. actualizar `received_quantity` y el estado de la compra;
8. marcar la recepción `POSTED`;
9. auditar (`PURCHASE_RECEIPT_POSTED`, `MOVING_AVERAGE_COST_CHANGED` por cada cambio de
   promedio);
10. commit. Cualquier error → rollback total.

Ajustes, mermas y stock inicial siguen el mismo camino (`postStockMovement`), con el mismo lock de
costo por materia prima, así que toda operación que toque una materia prima se serializa sobre esa
fila y nunca calcula sobre un estado viejo. Idempotencia doble: lock + chequeo de estado en la API
y un índice único `(company_id, source_line_id)` en `stock_movements` para movimientos de
recepción (una línea de recepción no puede generar dos movimientos).

## Invariantes en la base

- `stock_movements`: append-only (trigger), signo coherente con el tipo (CHECK), ítem coherente
  con el tipo de ítem (CHECK).
- `stock_balances` y `raw_material_inventory_costs`: trigger que exige que toda inserción o cambio
  de cantidad referencie un movimiento nuevo de la misma empresa/ítem (y depósito) y que la
  cantidad nueva sea exactamente la anterior + la del movimiento. No se borran. Editar un saldo
  "a mano" falla.
- `inventory_cost_history`: append-only.
- `purchase_lines.received_quantity ≤ ordered_quantity` (CHECK).
- Recepciones confirmadas y sus líneas: inmutables (trigger).
- FKs compuestas para proveedor, materia prima, presentación (por materia prima), depósito,
  unidades, compra ↔ líneas ↔ recepciones.

## API

Compras (`purchases.*`): `GET/POST /api/purchases`, `GET/PATCH /api/purchases/:id`,
`POST /api/purchases/:id/order`, `POST /api/purchases/:id/cancel`,
`GET/POST /api/purchases/:id/receipts`, `GET/PATCH /api/purchase-receipts/:id`,
`POST /api/purchase-receipts/:id/post`, `POST /api/purchase-receipts/:id/cancel`.

Inventario (`inventory.*`): `GET /api/inventory`, `GET /api/inventory/raw-materials/:id`,
`GET /api/inventory/movements`, `POST /api/inventory/initial-stock`,
`POST /api/inventory/adjustments`, `POST /api/inventory/waste`, `GET /api/inventory/low-stock`,
`GET /api/inventory/costs/:rawMaterialId`. Valorización (promedio, valor) sólo con
`inventory.cost.read`; sin ese permiso los campos de valor vienen en `null`.

Presentaciones (`presentations.*`): `GET/POST /api/raw-materials/:id/presentations`,
`PATCH /api/raw-material-presentations/:id`, `POST …/:id/deactivate`, `POST …/:id/activate`.

Todos los listados paginan en el servidor. Errores estables: `INSUFFICIENT_STOCK`,
`ALREADY_POSTED`, `RECEIPT_EXCEEDS_PENDING`, `PURCHASE_NOT_RECEIVABLE`, `PURCHASE_HAS_RECEIPTS`,
`PURCHASE_NOT_EDITABLE`, `VALUATION_COST_REQUIRED`, `INITIAL_STOCK_ALREADY_LOADED`,
`INCOMPATIBLE_PRESENTATION_UNIT`, `INVALID_REFERENCE`.

## Permisos

Nuevos: `purchases.read/create/update/order/receive/cancel`, `inventory.read/adjust/waste/
initial_stock`, `inventory.cost.read`, `presentations.read/manage`.

| Rol            | Asignación                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| ADMIN, OWNER   | todos                                                                                                    |
| PURCHASING     | compras completas (incl. recibir), presentaciones (leer/gestionar), inventario y costos (lectura)        |
| WAREHOUSE      | inventario (leer, ajustar, merma), recibir compras (+ leerlas), presentaciones (lectura)                 |
| ADMINISTRATION | lectura de compras, inventario, costos y presentaciones; stock inicial (es una decisión de valorización) |
| PRODUCTION     | lectura de stock                                                                                         |
| SALES          | —                                                                                                        |

## Auditoría

`PURCHASE_CREATED`, `PURCHASE_UPDATED`, `PURCHASE_ORDERED`, `PURCHASE_CANCELLED`,
`PURCHASE_RECEIPT_CREATED`, `PURCHASE_RECEIPT_UPDATED`, `PURCHASE_RECEIPT_POSTED`,
`PURCHASE_RECEIPT_CANCELLED`, `RAW_MATERIAL_PRESENTATION_CREATED`,
`RAW_MATERIAL_PRESENTATION_UPDATED`, `INITIAL_STOCK_POSTED`, `INVENTORY_ADJUSTED`,
`INVENTORY_WASTE_RECORDED`, `MOVING_AVERAGE_COST_CHANGED`. Siempre en la misma transacción.

## UI

- **Compras → Compras**: listado (número, proveedor, fecha, estado, total, recibido, pendiente);
  alta/edición de borrador con líneas (materia prima → presentación → cantidad → precio →
  descuento, subtotal/total en vivo y "Equivale a 100 kg" secundario); detalle con cabecera,
  líneas, recepciones, acciones por estado e historial.
- **Registrar recepción**: pedido / recibido antes / pendiente / recibido ahora, depósito, resumen
  antes de confirmar (4 bolsas = 100 kg, costo neto, costo de adquisición $/kg).
- **Inventario → Stock**: tabla (materia prima, depósito, stock, unidad, mínimo, estado, costo
  promedio, valor) con búsqueda, depósito, bajo mínimo, sin stock; acciones "Cargar stock
  inicial", "Ajustar stock", "Registrar merma" (formularios propios con resumen antes/después).
  **Movimientos de stock**: ledger paginado con filtros. **Stock bajo mínimo**: faltante y
  proveedor preferido.
- **Detalle de stock por materia prima**: total, por depósito, los tres costos claramente
  separados (promedio de inventario, referencia manual, costo usado por recetas + origen), última
  compra, movimientos, historial de costo, presentaciones.
- **Materia prima**: panel de presentaciones de compra; el aviso "stock en Fase 3" se reemplaza
  por el resumen real.
- **Recetas**: la columna pasa a "Costo usado" con su origen.
- `docs/UX_BACKLOG.md` para mejoras transversales; los bugs se corrigen en la fase.

## Migraciones

Una nueva: `0006_purchases_inventory` (tablas, enums, FKs, índices, triggers). 0000–0005 no se
tocan. Índices del ledger: `(company_id, raw_material_id, occurred_at)`,
`(company_id, warehouse_id, occurred_at)`, `(company_id, movement_type, occurred_at)`,
`(company_id, occurred_at)`, `(reference_type, reference_id)`.

## Testing

- **Unit (domain)**: 4 bolsas × 25 kg = 100 kg; promedio 100×1000 + 100×1200 → 200 @ 1100; salida
  100 @ 1000 − 10 → 90 @ 1000 / $90.000; stock en cero; adquisición 4 × $20.000 / 100 kg =
  $800/kg; descuento; estado de stock mínimo; selección de costo efectivo; signo por tipo.
- **Integración**: escenario principal (ref $900, inicial 100 @ $1.000, compra 4 × 25 kg a
  $30.000/bolsa → 200 kg, $1.100/kg, ref intacta, receta a $1.100); receta + snapshot; recepción
  parcial 6 + 4 + rechazo; idempotencia; rollback (falla inyectada con un trigger temporal en la
  auditoría); concurrencia (recepciones simultáneas de la misma materia prima); tenancy A/B;
  invariantes 1–21; matriz de autorización ampliada.
- **E2E**: flujo principal de 21 pasos y stock mínimo (LOW → OK), sin errores de consola, en
  desktop y tablet.

## Riesgos

- Rendimiento del ledger → índices + paginación server-side; saldos materializados.
- Deadlocks entre operaciones concurrentes → orden fijo de locks (compra, recepción, materias
  primas por id).
- Redondeo del promedio → valor de inventario como acumulado exacto; promedio redondeado a 6.
- Compras que nunca se completan (el proveedor no entrega el resto): sin "cerrar con faltante"
  en esta fase (deuda).
- Devoluciones y correcciones de una recepción confirmada: fuera de alcance; se corrigen con
  ajustes explícitos.
