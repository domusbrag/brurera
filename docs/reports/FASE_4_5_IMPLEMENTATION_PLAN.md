# Fase 4.5 — Lotes + conservación + vida útil · Plan de implementación

## Estado de partida

```
FASE_4_TECHNICAL_REVIEW = PASS
FASE_4_HUMAN_GATE       = ACCEPTED
FASE_4_STATUS           = CLOSED
NEXT_ALLOWED_PHASE      = FASE_4_5_LOTES_CONSERVACION
```

- PR #5 (Fase 4) con CI verde (`verify`, run 36895016278) mergeado a `main` → `364c1e7`.
- Rama `fase-4.5-lotes-conservacion` creada desde `main` en `364c1e7` (base commit de esta fase).
- Pedidos y Ventas quedan fuera (Fase 5A / 5B).

## Inspección (qué hay y qué se reutiliza)

| Pieza                     | Estado en Fase 4                                                                                                          | Uso en Fase 4.5                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `production_orders`       | La orden es el "lote" documental; `batch_code` `LOT-AAAAMMDD-NNN` se asigna al planificar (editable, puede quedar vacío). | Origen del `ProductLot`: un lote raíz por orden COMPLETED, con `lot_code = batch_code`.                     |
| `stock_movements`         | Append-only; producto sólo admite `PRODUCTION_OUTPUT`.                                                                    | Columna `product_lot_id` (obligatoria en PRODUCT), tipos `LOT_TRANSFORMATION_OUT/IN` y `WASTE` de producto. |
| `stock_balances`          | Saldo agregado por depósito + ítem, custodiado por trigger.                                                               | Sin cambios: sigue siendo el nivel agregado.                                                                |
| `product_inventory_costs` | Cantidad, valor y promedio móvil de costo material por producto.                                                          | Sin cambios de estructura; las salidas por lote no recalculan el promedio.                                  |
| Ledger (`ledger.ts`)      | Única puerta: `postStockMovement` / `postProductMovement`.                                                                | Se agrega `postLotMovement` (salidas e ingresos por lote) y el saldo de lote.                               |
| Dominio                   | `applyInbound` / `applyOutbound`.                                                                                         | `lots.ts`: vida útil, transiciones, elegibilidad, FEFO, disponibilidad a fecha, valor proporcional.         |
| Permisos / auditoría      | Catálogo en `@bakery/shared`.                                                                                             | 7 permisos y 7 acciones nuevas.                                                                             |

## Modelo

Migración nueva `0008_product_lots.sql` (0000–0007 sin cambios):

- **`product_conservation_settings`**: por producto, estado inicial por defecto y umbral de
  "próximo a vencer" (minutos).
- **`product_conservation_profiles`**: por producto + estado (`FRESH`, `REFRIGERATED`, `FROZEN`,
  `THAWED`): habilitado, `shelf_life_minutes` (vida útil normalizada en minutos), si es estado
  inicial permitido y observaciones. La UI muestra horas o días.
- **`product_lots`**: producto, orden de producción de origen, lote padre opcional, código, depósito,
  estado de conservación, `produced_at`, `state_changed_at`, `usable_until` (nulo = vida útil no
  configurada), cantidad inicial, unidad, costo material unitario, valor inicial, estado de calidad
  (`AVAILABLE` / `BLOCKED`), notas, operación que lo creó (idempotencia), actor y fecha. Inmutable
  salvo calidad y notas (trigger). Nunca se borra.
- **`product_lot_balances`**: proyección por empresa + depósito + lote (cantidad y valor),
  custodiada por trigger: sólo cambia con un movimiento nuevo de ese lote.
- `stock_movements.product_lot_id` con FK compuesta; CHECK: todo movimiento de producto tiene lote.

## Producción → lote

`completeOrder` (misma transacción): consumos → crea `ProductLot` raíz (código = `batch_code`,
generado si estaba vacío; estado inicial = el elegido o el por defecto del producto; vida útil
según el perfil) → `PRODUCTION_OUTPUT` con `product_lot_id` → saldo agregado, costo promedio y
saldo del lote.

## Transformaciones (congelar / descongelar)

Transiciones (`canTransform`): `FRESH → FROZEN`, `REFRIGERATED → FROZEN`, `FROZEN → THAWED`.
Nada más (sin recongelar). El estado destino debe estar habilitado en el perfil.

Una transformación (parcial o total) en una transacción: bloquea el lote origen, revalida cantidad
(`409 INSUFFICIENT_LOT_QUANTITY`), crea el lote hijo (`parent_lot_id`, mismo producto, orden,
`produced_at` y costo unitario), `LOT_TRANSFORMATION_OUT` (−q) del padre y
`LOT_TRANSFORMATION_IN` (+q) del hijo con el mismo valor, saldos, auditoría. Stock y valor
agregados netos 0; promedio sin cambio. `usable_until` del hijo = momento de la transformación +
vida útil del estado destino. Sin costo de congelado (fuera del MVP).

## Merma de producto terminado

Sobre un lote concreto, motivos `EXPIRED`, `DAMAGED`, `QUALITY`, `OTHER`. `WASTE` negativo
valorizado al costo del lote; baja saldo de lote, saldo agregado y valor; no cambia el promedio.

## Elegibilidad, FEFO y disponibilidad a fecha

- Lote elegible en `at` si: saldo > 0, calidad `AVAILABLE` y (`usable_until` nulo o
  `at ≤ usable_until`). Razones: `DEPLETED`, `BLOCKED`, `EXPIRED`.
- FEFO: `usable_until ASC` (nulos al final), luego `produced_at ASC`, luego código.
- `calculateProductAvailabilityAt(productId, warehouse?, requestedAt)` (dominio + servicio):
  físico, elegible, no elegible, razones, desglose por conservación y lotes en orden FEFO.
- `GET /api/inventory/products/:id/availability?at=&warehouseId=`.
- Sin reservas ni stock comprometido (Fase 5A).

## Migración desde Fase 4

Toda orden COMPLETED tiene exactamente un `PRODUCTION_OUTPUT`. Por cada una: lote raíz
(código = `batch_code` o `LOT-<código de orden>` si estaba vacío), estado `FRESH`,
`usable_until` nulo (no se inventa vida útil), saldo inicializado vía el trigger con ese
movimiento, y backfill de `product_lot_id` en el movimiento (única escritura sobre el ledger,
documentada en ADR). Verificación dentro de la migración: si Σ lotes ≠ saldo agregado por
producto/depósito, o hay producto sin orden de origen, la migración aborta (BLOCKER) en lugar de
inventar procedencia.

## Permisos

`product_lots.read|transform|waste|quality`, `product_conservation.read|manage`,
`inventory.expiry.read`. ADMIN/OWNER todo; PRODUCCIÓN lectura + transformar; DEPÓSITO lectura,
transformar, merma y calidad; ADMINISTRACIÓN lectura. Costos de lote con `inventory.cost.read`.

## UI

Producto → Conservación (ver y configurar); Stock → Productos terminados (físico, fresco,
refrigerado, congelado, utilizable ahora, próximo a vencer, costo promedio); ficha con Lotes y
"Disponibilidad a una fecha"; ficha de lote (padre/hijos, movimientos, auditoría); Congelar,
Descongelar (advierte que no se recongela) y Merma con resumen; vista "Próximos a vencer".

## Tests y gates

Unit de dominio, integración (producción → lote, perfiles, congelar, descongelar, expiración,
FEFO, merma, reconciliación de cantidad y valor, idempotencia, concurrencia, rollback, tenancy,
autorización), migración con datos de Fase 4 (automática y manual sobre una base real), E2E
principal / no congelable / elegibilidad futura en escritorio y tablet.
