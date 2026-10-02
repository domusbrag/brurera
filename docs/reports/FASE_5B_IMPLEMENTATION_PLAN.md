# Fase 5B — Ventas + entrega + cobros + cuenta corriente + margen · Plan de implementación

Base: `main` en `4c95051` (PR #7 de Fase 5A mergeado con CI verde, run del head `629179c`).
Rama `fase-5b-ventas-cobros`. Registrado: `FASE_5A_TECHNICAL_REVIEW = PASS`,
`FASE_5A_HUMAN_GATE = ACCEPTED`, `FASE_5A_STATUS = CLOSED`,
`NEXT_ALLOWED_PHASE = FASE_5B_VENTAS_ENTREGA_COBROS`. No se inicia Fase 6; después de 5B sigue
UX/DESIGN OPTIMIZATION.

## 0. Inspección (lo que condiciona el diseño)

- **Reservas (5A)**: `product_lot_reservations.quantity` es inmutable (trigger) y "comprometido" =
  Σ `quantity` de las `ACTIVE` en SQL (`committedByLot`, triggers de capacidad y de saldo), en el
  detalle del pedido, en marcar listo y en la invalidación por merma. `FULFILLED` existe en el enum
  pero nada lo usa.
- **Lotes y valor**: `product_lot_balances` (cantidad + valor) y `product_inventory_costs`
  (cantidad + valor + `moving_average_cost`) son proyecciones custodiadas por triggers; las salidas
  de lote (`postLotMovement`, `lotOutflow`) ya valorizan al costo del lote, pero **no** recalculan el
  promedio: después de una merma o transformación `moving_average_cost ≠ valor / cantidad`.
- **Stock**: `stock_movements_product_types` sólo admite `PRODUCTION_OUTPUT`, transformaciones y
  `WASTE` para producto; `SALE` está "reservado". Enums nuevos se comparan con `::text` en checks
  (el migrador aplica todo en una transacción).
- **Locks**: ADR-034/042 (costo → saldo), ADR-053 (pedido → líneas → necesidades → lotes por id →
  saldos → reservas; operaciones de lote: lote → saldo de lote → reservas → costo de producto →
  saldo del producto).
- **Precio**: sólo `products.sale_price` (money 14,2). El pedido muestra un "precio informativo"
  sin congelar. `customers.credit_limit` existe sin uso. Sin listas de precios.
- **Idempotencia**: `operationId` del cliente (4.5/5A) y estado verificado con la fila bloqueada
  (producción: `[200, 409, 409]`).
- **Zona horaria**: `Company.timezone`; filtros de fecha con `zonedLocalToInstant`.
- **Decimal**: `decimal.js` (`D`, ROUND_HALF_UP), dinero `numeric(14,2)`, costos `numeric(20,6)`.

## 1. Modelo y migración `0010_sales_payments`

Migración nueva (0000–0009 intactas). Tablas nuevas con `company_id` y FKs compuestas:

| Tabla                           | Contenido                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `price_lists`                   | código, nombre, activa, `is_default` (única por empresa, parcial)                                                                                                                                                                                                                                                                  |
| `price_list_items`              | lista, producto, `unit_price` (por unidad de venta), activo; único (lista, producto)                                                                                                                                                                                                                                               |
| `sales`                         | `VTA-0001`, cliente, `source_order_id` opcional, depósito, `status` (DRAFT/POSTED/CANCELLED), `payment_status` (UNPAID/PARTIALLY_PAID/PAID), `sale_date`, lista de precios, subtotal, descuentos, total, `paid_amount`, `material_cost_total`, margen bruto y %, moneda, notas, quién/cuándo en cada paso, `credit_limit_exceeded` |
| `sale_lines`                    | línea de pedido origen opcional, producto, cantidad + unidad + normalizada, `unit_price`, `discount_amount`, `net_amount`, `price_source`, precio acordado (si viene de pedido) y motivo de override, `material_cost`, costo unitario promedio de lotes (informativo), margen y %                                                  |
| `sale_lot_allocations`          | venta, línea, lote, reserva opcional, cantidad + unidad, `unit_material_cost`, `material_cost`, movimiento `SALE`                                                                                                                                                                                                                  |
| `customer_payments`             | `COB-0001`, cliente, pedido opcional (seña), `kind` (ORDER_ADVANCE / SALE_PAYMENT / ON_ACCOUNT), `status` POSTED, fecha, monto, medio, referencia, notas, `operation_id` (idempotencia), quién/cuándo                                                                                                                              |
| `customer_payment_applications` | pago, venta, monto, quién/cuándo                                                                                                                                                                                                                                                                                                   |
| `customer_account_movements`    | ledger append-only: tipo (SALE_DEBIT, PAYMENT_CREDIT, ADJUSTMENT_DEBIT, ADJUSTMENT_CREDIT), `signed_amount` (+ debe / − crédito), referencia (venta / pago / ajuste), motivo, `balance_after`, actor                                                                                                                               |
| `customer_account_balances`     | proyección: `balance`, `last_movement_id`                                                                                                                                                                                                                                                                                          |

Columnas nuevas:

- `customers.default_price_list_id`, `customers.is_walk_in` (Consumidor Final, uno por empresa).
- `customer_orders`: `pricing_status` (UNPRICED / QUOTED / AGREED), `price_list_id`,
  `quoted_subtotal`, `quoted_discount_total`, `quoted_total`, `first_delivered_at`, `delivered_at`,
  `delivered_by_user_id`; estados nuevos `PARTIALLY_DELIVERED` y `DELIVERED`.
- `customer_order_lines`: `quoted_unit_price`, `quoted_discount_amount`, `quoted_net_amount`,
  `price_source`.
- `product_lot_reservations.fulfilled_quantity` (0 ≤ cumplido ≤ reservado).
- `product_inventory_costs.moving_average_cost` → **`average_material_cost`** (ver §4).
- `stock_movement_type` + `SALE` (cantidad negativa, lote + línea de venta obligatorios).

Triggers (red de la base, el servicio ya lo garantiza con locks):

- Venta `POSTED`, sus líneas y asignaciones: inmutables; ventas, líneas y asignaciones no se
  borran (borrador: líneas sí). `paid_amount` = Σ aplicaciones y `payment_status` coherente.
- Aplicaciones: Σ por venta ≤ total; Σ por pago ≤ monto; append-only.
- Ledger de cuenta corriente append-only; saldo custodiado como `stock_balances` (sólo cambia con
  un movimiento nuevo y saldo = anterior + movimiento).
- Pagos `POSTED` inmutables.
- Reservas: comprometido = Σ (`quantity − fulfilled_quantity`) de las `ACTIVE` (se redefinen las
  funciones de capacidad y saldo); `fulfilled_quantity` sólo crece; `FULFILLED` exige cumplido =
  reservado.
- `product_inventory_costs`: el guard exige `average_material_cost = round(valor / cantidad, 6)`
  (null con cantidad 0).
- Pedido `DELIVERED`: inmutable.

Migración de datos:

- Pedidos existentes: `pricing_status = UNPRICED`, sin precios (no se inventan con
  `Product.salePrice`). Reservas, revisiones, estados y cobertura intactos.
- `average_material_cost` = `round(inventory_value / quantity, 6)` en cada producto (trigger
  suspendido sólo para esa sentencia, como en 0008), con reconciliación obligatoria lotes ↔ costo
  (BLOCKER si no cierra).
- Un cliente "Consumidor Final" por empresa existente (código `CONS-FINAL`); las empresas nuevas lo
  reciben al aprovisionarse. No se hardcodea ningún UUID.

## 2. Valorización (ADR-057)

- **Producto terminado = identificación específica por lote.** El costo de una venta es
  Σ valor retirado de los lotes (`lotOutflow`: cantidad × costo del lote, o el remanente exacto si
  se vacía). Nunca receta, costo esperado ni promedio.
- `inventoryValue = Σ valor de lotes`, `quantity = Σ cantidades`;
  `averageMaterialCost = inventoryValue / quantity` (6 decimales, ROUND_HALF_UP) es una **métrica
  derivada** que se recalcula después de toda entrada o salida de producto (producción,
  transformación, merma, venta). Se reemplaza `moving_average_cost` (opción A del §7): no quedan dos
  valores con semánticas distintas. El historial de costo de producto conserva sus columnas
  (`average_before/after` registran desde ahora el promedio derivado).
- Materias primas siguen con promedio ponderado móvil (sin cambios).
- Invariantes probados después de producción, transformación, merma, venta y entrega parcial:
  Σ lotes = saldo agregado, Σ valores = `inventoryValue`, promedio = valor / cantidad.

## 3. Venta (ADR-058)

- `Sale` = operación comercial concretada; `SaleStatus` (DRAFT / POSTED / CANCELLED) separado de
  `PaymentStatus` (UNPAID / PARTIALLY_PAID / PAID, derivado de Σ aplicaciones).
- **DRAFT**: editable, sin stock, sin reservas consumidas, sin cuenta corriente, sin costos
  congelados; tiene vista previa.
- **POSTED** = la entrega ocurrió: sale el producto (movimiento `SALE` por lote), se congelan
  costos (`sale_lot_allocations`), margen, `SALE_DEBIT`, señas aplicadas, cobro inicial opcional,
  estado de entrega del pedido. Inmutable.
- **CANCELLED**: sólo desde borrador. Devoluciones, reversión y notas de crédito quedan como deuda
  explícita (`SALE_RETURN`, `SALE_REVERSAL`, `CREDIT_NOTE`); no hay `SALE_REVERSAL` funcional.
- Depósito de la venta: lotes libres de ese depósito (venta directa y faltante); las reservas del
  pedido se consumen en el depósito de cada lote.

## 4. Pedido → venta, entregas parciales (ADR-059)

- `Sale.source_order_id`; un pedido puede tener varias ventas. Entregable en `READY` o
  `PARTIALLY_DELIVERED`. Pendiente por línea = pedido − Σ líneas de ventas POSTED (derivado con el
  pedido bloqueado). No se puede superar el pendiente (`409 DELIVERY_EXCEEDS_PENDING`).
- Al postear: primero se consumen las **reservas activas de esa línea** (FEFO entre los lotes
  reservados; no se rehace FEFO global); sólo si la reserva no alcanza (p. ej. un lote se bloqueó
  después) se completa con stock libre FEFO del depósito con la conservación pedida.
- Reserva: `fulfilled_quantity += retirado`; `FULFILLED` cuando cumplido = reservado; nada se borra.
- Pedido: `PARTIALLY_DELIVERED` mientras quede pendiente, `DELIVERED` al completar (terminal: no se
  edita, replanifica ni cancela; necesidades abiertas → `SATISFIED`).
- `PARTIALLY_DELIVERED`: no se replanifica (`409 ORDER_PARTIALLY_DELIVERED`); se puede cancelar el
  remanente (libera reservas restantes; las ventas quedan).
- Venta directa (sin pedido): FEFO sobre lotes no agotados, `AVAILABLE`, válidos ahora y con la
  conservación pedida, sólo sobre **físico − reservas activas de todos los pedidos**; si no
  alcanza, `409 INSUFFICIENT_FREE_PRODUCT_STOCK` con lo disponible. Nunca vende lo comprometido.
  Override manual de lote: fuera de fase.

## 5. Precios (ADR-060)

- `PriceList` / `PriceListItem`, `Customer.defaultPriceListId`. Función de dominio
  `resolveUnitPrice`: 1. precio acordado/congelado (cotización del pedido); 2. lista del cliente; 3. lista default de la empresa; 4. `Product.salePrice`. Guarda `price_source`.
- Pedido nuevo (después de 5B): el borrador se cotiza al guardarlo (`QUOTED`, precio vigente
  visible); **confirmar congela** precio unitario, descuento y total (`AGREED`). Cambios de lista no
  tocan el pedido.
- Replan: fecha, prioridad, entrega y cobertura no cambian precios; una línea existente conserva
  su precio aunque cambie la cantidad (el neto se recalcula); una línea nueva toma el precio
  vigente y se muestra en la vista previa. Cambiar un precio acordado exige `sales.price_override`,
  motivo y auditoría.
- Pedidos de 5A: `UNPRICED`; antes de la primera venta exigen "Cotizar pedido" explícito
  (`409 ORDER_UNPRICED`). La pantalla propone la lista vigente pero el usuario confirma.
- Venta desde pedido: copia precio y descuento acordados (no consulta listas). Venta directa:
  precio vigente, editable según permisos, congelado al postear.
- Override (precio distinto del acordado / resuelto): `sales.price_override`, "Precio acordado $X →
  Nuevo $Y (diferencia $Z)", motivo obligatorio, `SALE_PRICE_OVERRIDDEN`.
- Redondeo: neto de línea = round2(cantidad × precio) − descuento; totales = Σ netos.

## 6. Margen

Por línea `margen = neto − costo material`, `% = margen / neto × 100` (null si neto = 0; se guarda
con 4 decimales, se muestra con 2). Venta = Σ líneas. Rótulo "Margen sobre materiales" (nunca
ganancia ni rentabilidad neta). Margen negativo: se permite con advertencia "Precio inferior al
costo material de los lotes seleccionados".

## 7. Cobros, señas y cuenta corriente (ADR-061)

- Ledger `customer_account_movements` (append-only, signo: + debe, − crédito a favor) y proyección
  `customer_account_balances` (mismo patrón `StockMovement` / `StockBalance`).
- `CustomerPayment` (`COB-0001`) siempre `POSTED` al registrarse → `PAYMENT_CREDIT`. Medios: CASH,
  TRANSFER, DEBIT_CARD, CREDIT_CARD, OTHER (sólo registro).
- `CustomerPaymentApplication` separa recibir dinero de aplicarlo: **no** genera movimiento.
  `PAYMENT_EXCEEDS_SALE_BALANCE` si supera el pendiente. `paymentStatus` = f(Σ aplicaciones).
- **Seña** (`ORDER_ADVANCE_PAYMENT`): pago vinculado al pedido; al postear una venta del pedido se
  aplican automáticamente las señas no aplicadas hasta min(disponible, total); el excedente queda
  como crédito a favor. Cancelar un pedido con seña: la seña queda como crédito (advertencia).
- Cobro desde la venta (crea pago + crédito + aplicación + estado, atómico), cobro inicial al
  postear, pago general a cuenta (sin asignación automática) y aplicación manual posterior.
- **Error en un cobro: política B** — el pago POSTED es inmutable; se corrige con
  `ADJUSTMENT_DEBIT/CREDIT` (permiso `customer_accounts.adjust`, motivo obligatorio, auditado). Sin
  void de pagos ni reembolsos (deuda `PAYMENT_REFUND`).
- Límite de crédito: antes de postear se calcula el saldo proyectado; si supera, advertencia fuerte,
  no bloquea; se guarda `credit_limit_exceeded` y se audita.
- Consumidor Final por empresa para el mostrador.

## 8. Transacciones, locks, concurrencia, idempotencia y rollback (ADR-062)

Orden global (extiende ADR-034/042/053 sin ciclos):
**pedido → líneas del pedido → venta → líneas de venta → lotes (por id) → saldos de lote (por id)
→ reservas → costos de producto (por id) → saldos de producto (por id) → saldo de cuenta del
cliente → pagos (por id)**. Venta directa = el mismo orden sin el pedido. Cobro de una venta:
venta → saldo de cuenta. Seña: pedido (`FOR SHARE`) → saldo de cuenta. Aplicación manual: venta →
pago. Merma, bloqueo y transformación (lote → saldo de lote → reservas → costo → saldo) y
producción (… → costo del producto → saldo) son prefijos compatibles.

- Postear desde pedido = una transacción con los 28 pasos del §55; venta directa los del §56.
  Cualquier falla → rollback total (prueba con trigger inyectado después de los movimientos `SALE` y
  antes del ledger).
- Idempotencia de postear: estado verificado con la venta bloqueada → `[200, 409, 409]`
  (`SALE_ALREADY_POSTED`), más el único `(company_id, source_line_id)` del ledger por asignación.
- Idempotencia de cobros: `operationId` único por empresa; un reintento devuelve el mismo cobro
  (`replayed: true`); el mismo id en otra operación → `409 OPERATION_ID_REUSED`.
- Concurrencia probada: dos ventas 70 + 70 sobre 100 libres (una falla con
  `INSUFFICIENT_FREE_PRODUCT_STOCK`), venta directa vs confirmación/merma de reservas, dos cobros de
  70.000 sobre 100.000 pendientes (uno `PAYMENT_EXCEEDS_SALE_BALANCE`), venta vs merma del mismo
  lote, entregas simultáneas del mismo pedido.

## 9. API

- `GET/POST /api/price-lists`, `GET/PATCH /api/price-lists/:id`,
  `PUT/DELETE /api/price-lists/:id/items/:productId`, `GET /api/price-lists/resolve` (precio
  vigente para cliente + productos).
- `GET/POST /api/sales`, `GET/PATCH /api/sales/:id`, `GET /api/sales/:id/preview`,
  `POST /api/sales/:id/post`, `POST /api/sales/:id/cancel`, `POST /api/sales/:id/payments`.
- `POST /api/orders/:id/quote` (cotizar pedido sin precio), `POST /api/orders/:id/advances`
  (seña), `GET /api/orders/:id/delivery` (pendiente, reservas, precios para "Registrar entrega").
- `GET /api/customers/:id/account` (saldo, movimientos paginados, ventas, cobros),
  `POST /api/customers/:id/payments` (cobro a cuenta), `POST /api/customers/:id/adjustments`,
  `POST /api/payments/:id/applications`, `GET /api/payments`, `GET /api/customer-accounts`
  (cuentas a cobrar).
- Sin `sales.cost.read` la API no expone costos de lotes ni de venta; sin `sales.margin.read`, no
  expone márgenes (se omiten del JSON, no sólo de la UI).

## 10. Permisos y auditoría

Permisos nuevos (§76): `sales.read/create/update/post/price_override`, `sales.cost.read`,
`sales.margin.read`, `price_lists.read/manage`, `payments.read/create/post`,
`customer_accounts.read/adjust`, `order_advances.create`. Roles: Admin/Dueño todo; Ventas: ventas,
precios comerciales, cobros y señas, sin costo ni margen; Administración: ventas, cobros, cuenta
corriente, ajustes, costos y márgenes; Producción: nada financiero; Depósito: lectura de ventas
para salidas físicas, sin precios ni costos (los importes comerciales de una venta se exponen sólo
con `price_lists.read`). Empresas existentes: `pnpm db:sync-reference`.
Auditoría §78 completa (`SALE_*`, `ORDER_PARTIALLY_DELIVERED`, `ORDER_DELIVERED`, `PRICE_LIST_*`,
`CUSTOMER_PAYMENT_*`, `PAYMENT_APPLIED`, `ORDER_ADVANCE_PAYMENT_POSTED`,
`CUSTOMER_ACCOUNT_ADJUSTED`, `ORDER_QUOTED`, `SALE_CREDIT_LIMIT_EXCEEDED`).

## 11. UI

- Comercial → Pedidos, **Ventas**, **Listas de precios**, Clientes, Proveedores; Finanzas →
  **Cuentas a cobrar** (clientes con saldo).
- Ventas: listado (venta, fecha, cliente, origen, estado, cobro, total, pendiente, margen con
  permiso; filtros de fecha, cliente, cobro, con/sin pedido, pendiente; paginado), venta directa
  rápida (Consumidor Final por defecto, FEFO automático "Se utilizarán los lotes más próximos a
  vencer", detalle inspeccionable), revisión antes de postear ("Confirmar entrega y venta"),
  detalle por secciones (venta, entrega, costo y margen con permiso, cobros, cuenta corriente,
  auditoría), registrar cobro.
- Pedido: cotización y total acordado, anticipos, entregado / pendiente, ventas asociadas;
  acciones "Registrar entrega / venta", "Registrar seña", "Cotizar pedido".
- Listas de precios: listado y detalle con alta / cambio de precio / desactivar.
- Cliente: resumen comercial, saldo ("Debe $X" / "Sin saldo" / "Crédito a favor $X"), pedidos,
  ventas, cobros y cuenta corriente con Debe / Haber / Saldo (sin `signedAmount` crudo); cobro a
  cuenta, aplicar a ventas abiertas, ajuste.
- Terminología §109; sin UUIDs; revisión en 1440×900, 1366×768 y 768×1024.

## 12. Pruebas

- Unit (domain): costo por lotes §91 (52.000), inventario remanente §92 (38.000 / 475), margen §93
  (44.000 / 45,83 %), precios y prioridad, redondeo, estado de pago, aplicación de señas,
  sobreaplicación, saldo con signo, límite de crédito, asignación reserva + FEFO.
- Integración: §94–§102 y los 32 invariantes del §90, concurrencia, rollback de venta y de cobro,
  idempotencia, tenencia (empresa B), autorización y visibilidad de costos, zona horaria,
  migración desde 0009 con clientes, pedidos, reservas, lotes, producciones y costos.
- E2E (desktop + tablet): pedido → venta §103, entrega parcial §104, venta directa §105, margen
  negativo §106, seña + cancelación §107.

## 13. Riesgos

Cambio de semántica del promedio de producto (mitigado: renombre + recálculo + trigger),
devoluciones no modeladas, sin facturación fiscal ni impuestos formales, crédito a favor sin flujo
de reembolso, cobros ≠ conciliación bancaria, margen sólo material, reservas de materia prima
proyectadas, consolidación productiva pendiente, pedidos de 5A que exigen cotización antes de
entregar.

## 14. Cierre

Documentación (README, PRODUCT, ARCHITECTURE, DOMAIN_MODEL, DATABASE, ROADMAP, TESTING,
PERMISSIONS, DECISIONS, UX_BACKLOG), ADR-057 a ADR-062, reporte `FASE_5B_REPORTE.md`, CI remoto
verde. Fin: `FASE_5B_STATUS = COMPLETE_PENDING_HUMAN_ACCEPTANCE`; no se comienza UX/DESIGN
OPTIMIZATION sin aceptación humana.
