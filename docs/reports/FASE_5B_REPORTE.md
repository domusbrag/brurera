# Fase 5B — Ventas, entrega, cobros, cuenta corriente y margen

## Estado

```
FASE_5A_TECHNICAL_REVIEW = PASS
FASE_5A_HUMAN_GATE = ACCEPTED
FASE_5A_STATUS = CLOSED
FASE_5B_CLOSURE_HARDENING = PASS
FASE_5B_STATUS = COMPLETE_PENDING_HUMAN_ACCEPTANCE
```

Todos los gates de §117 y los de cierre (C1–C14, ver [Cierre](#cierre-idempotencia-de-imputaciones-y-ajustes))
están en verde, incluido el CI remoto. No empezó UX/DESIGN OPTIMIZATION.

## Base commit

`main` en `4c95051` (PR #7 de Fase 5A mergeado, CI de `main` verde en ese commit). Rama
`fase-5b-ventas-cobros`.

## PR

[#8](https://github.com/domusbrag/brurera/pull/8), con base `main`. Plan previo:
[FASE_5B_IMPLEMENTATION_PLAN.md](FASE_5B_IMPLEMENTATION_PLAN.md).

## Sale model

- `sales`: código `VTA-0001`, cliente, `source_order_id` opcional, depósito, `status`,
  `payment_status`, fecha, lista de precios, subtotal, descuentos, total, `material_cost_total`,
  margen (monto y %), moneda, `credit_limit_exceeded` y actores con su fecha.
- `sale_lines`: `source_order_line_id` opcional, cantidad, unidad, cantidad normalizada,
  precio, descuento y neto. También `price_source`, `price_override_reason`, costo material,
  costo unitario promedio informativo y margen.
- `sale_lot_allocations`: cada lote que salió por línea, con reserva opcional, cantidad, costo
  unitario y costo total, enlazado 1:1 con su `stock_movement`.
- Los montos son `numeric(14,2)`, las cantidades `numeric(18,6)` y el margen % `numeric(14,4)`.
  El cálculo usa decimal.js y nunca float.

## Sale lifecycle

`DRAFT → POSTED` o `DRAFT → CANCELLED` (ADR-058).

- **DRAFT:** editable; no mueve stock, no consume reservas y no genera deuda. Tiene vista previa
  (`GET /sales/:id/preview`), que no escribe.
- **POSTED:** la entrega ocurrió. La venta queda inmutable y triggers (`sales_guard` y
  `sale_lines_guard`) rechazan cualquier cambio.
- **CANCELLED:** sólo desde borrador ("Descartar borrador").
- Una venta entregada no se cancela; la devolución queda como deuda (`SALE_RETURN`,
  `SALE_REVERSAL`, `CREDIT_NOTE`).
- `payment_status` (`UNPAID`, `PARTIALLY_PAID`, `PAID`) va por separado y se deriva de Σ
  aplicaciones, no del saldo global del cliente.

## Order delivery lifecycle

El pedido suma `PARTIALLY_DELIVERED` y `DELIVERED`, con el recorrido `READY →
PARTIALLY_DELIVERED → DELIVERED`.

- `DELIVERED` es terminal: no admite más entregas ni cancelación (`409`).
- Un pedido entregado parcialmente no se replanifica; se cancela sólo con las reglas de 5A sobre
  lo pendiente.
- Auditoría: `ORDER_PARTIALLY_DELIVERED` y `ORDER_DELIVERED`.

## Partial delivery

- Un pedido genera una o varias ventas (ADR-059). Cada línea lleva `delivered_quantity`, y el
  pendiente se calcula como pedido − entregado.
- Entregar más que lo pendiente devuelve `409 DELIVERY_EXCEEDS_PENDING`.
- Las reservas suman `fulfilled_quantity` con `0 ≤ fulfilled ≤ reserved` (CHECK + trigger).
  Siguen `ACTIVE` mientras queda cantidad y pasan a `FULFILLED` al completarse; no se borra
  historia.
- Test: 150 kg entregados en 100 + 50. Después de la primera entrega quedan 50 reservados, y al
  final las reservas quedan `FULFILLED` y el pedido `DELIVERED`.

## Direct sales

- Venta sin pedido, por defecto a **Consumidor Final**. Hay un cliente de mostrador por empresa
  (`is_walk_in`, índice único parcial); lo crea la migración o el aprovisionamiento, sin UUID fijo.
- Toma stock libre FEFO, calculado como físico − reservas activas de todos los pedidos, sólo de
  lotes `AVAILABLE`, no vencidos y con la conservación pedida.
- Si no alcanza devuelve `409 INSUFFICIENT_FREE_PRODUCT_STOCK` con el disponible. Nunca toca lo
  comprometido; hay tests de 80 reservados más 20 libres.

## Price lists

- Tablas `price_lists` (código `LP-0001`, `is_default` único por empresa) y `price_list_items`
  (único por lista y producto).
- `customers.default_price_list_id` es opcional; una lista inactiva o inexistente devuelve `422`.
- Un ítem no se borra: se desactiva ("Quitar de la lista").
- UI: Comercial → Listas de precios. El detalle muestra cada producto con su precio de lista
  editable en línea; la lista se asigna desde la ficha del cliente.

## Order pricing

- Precio por línea: `quoted_unit_price`, `quoted_discount_amount`, `quoted_net_amount`,
  `price_source` y `price_override_reason`.
- Por pedido: `quoted_subtotal`, `quoted_discount_total`, `quoted_total`, `price_list_id` y
  `pricing_status` (`UNPRICED` o `AGREED`).
- Prioridad (`resolveUnitPrice`, dominio): precio acordado → lista del cliente → lista general →
  `Product.salePrice`.
- Los pedidos de 5A migran como `UNPRICED`, sin inventar precio. No se entregan
  (`409 ORDER_UNPRICED`) hasta "Acordar precio" (`POST /orders/:id/quote`, auditado
  `ORDER_QUOTED`), que toma el precio vigente de forma explícita.

## Price freezing

- Confirmar un pedido congela precio, descuento y total, y pasa a `AGREED`. Cambiar la lista
  después no lo modifica (test: lista 1.200 → 1.300, el pedido sigue en 180.000).
- La replanificación conserva el precio de las líneas existentes; una línea nueva toma el precio
  vigente, visible antes de aplicar.
- La venta desde un pedido copia el precio acordado (`ORDER_QUOTE`) sin volver a consultar la
  lista. La venta directa resuelve el precio vigente y lo congela al postear (test §99: el pedido
  queda en 800 y la venta directa nueva sale a 900).
- Override: requiere `sales.price_override` (si no, `403`) y motivo (si no, `422`). Queda como
  `MANUAL` y se audita `SALE_PRICE_OVERRIDDEN`. La UI muestra el precio vigente al lado.

## Sale lot allocation

- Venta desde pedido: primero las reservas `ACTIVE` de su línea, es decir lo prometido. Lo que
  falta sale de stock libre FEFO del depósito de la venta.
- Venta directa: FEFO libre.
- Cada lote retirado genera una `sale_lot_allocation` y un `StockMovement` `SALE` (cantidad
  negativa, con `product_lot_id` y `sale_line_id` obligatorios).
- La asignación es append-only (trigger) e identifica la reserva cuando corresponde.
- En la UI de mostrador el usuario no elige lotes: ve "Se utilizarán los lotes más próximos a
  vencer" y el detalle en la vista previa.

## Specific lot valuation

El costo de venta de producto terminado es Σ valor real retirado de los lotes (ADR-057). Unit
§91: 80 de A a 400 + 40 de B a 500 = 52.000. Integración: 100 kg de A (678,20) + 20 kg de B
(1.128,20) = 90.384.

## Inventory valuation evolution

- `product_inventory_costs.moving_average_cost` pasa a `average_material_cost` (opción A de §7),
  recalculado como `inventory_value / quantity` con redondeo a 6 decimales (`ROUND_HALF_UP`).
  Con cantidad 0 queda `null`.
- Las materias primas siguen con promedio ponderado móvil.
- Invariantes verificados después de producción, transformación, merma, venta y entrega parcial
  (`reconciliationProblems` + `salesProblems`):
  - Σ saldos de lote = saldo del producto.
  - Σ valor de lote = valor de inventario.
  - Promedio = valor / cantidad.
- §92 remanente: 20 A + 60 B = 38.000 / 80 = 475.

## COGS

`sale_lines.material_cost` es Σ asignaciones y `sales.material_cost_total` es Σ líneas. Se
congela al postear y nunca cambia. Test §100: el pedido reservó el lote A a 678,20; después
entra un lote a costo mucho mayor, y la venta sigue costando 6.782.

## Material margin

- Margen = neto − costo material, y % = margen / neto × 100 (con neto 0 queda `null`).
- La UI dice "Margen sobre materiales" / "Costo material"; nunca "ganancia".
- Un margen negativo no bloquea: muestra "Precio inferior al costo material de los lotes
  seleccionados." en la vista previa y el margen en rojo en el detalle (unit, integración y E2E).

## Order advances

"Registrar seña" en el pedido (`POST /orders/:id/advances`, permiso `order_advances.create`)
crea un `CustomerPayment` `POSTED` de tipo `ORDER_ADVANCE`, vinculado al pedido, con su
`PAYMENT_CREDIT`.

- Antes de entregar, el saldo del cliente queda negativo (crédito a favor).
- Al postear la venta del pedido, las señas sin aplicar se aplican solas hasta min(disponible,
  total), por antigüedad.
- Seña mayor que la venta: la venta queda `PAID` y el resto sigue como crédito a favor (test:
  seña de 12.000 para una venta de 9.000 deja 3.000 a favor).
- Cancelar un pedido con seña libera las reservas y la seña queda como crédito, con el aviso
  "La seña de $X queda como crédito a favor del cliente." (API y E2E). El reembolso real queda
  como deuda `PAYMENT_REFUND`.

## Payments

- `customer_payments`: código `COB-0001`, cliente, pedido opcional, tipo (`ORDER_ADVANCE`,
  `SALE`, `ON_ACCOUNT`), `POSTED`, fecha, monto, medio (`CASH`, `TRANSFER`, `DEBIT_CARD`,
  `CREDIT_CARD`, `OTHER`), referencia, notas y actores. Inmutables por trigger.
- Hay tres formas de cobrar: desde una venta (`POST /sales/:id/payments`), a cuenta
  (`POST /customers/:id/payments`) y en el momento al confirmar la entrega (`initialPayment`,
  que exige `payments.create` + `payments.post`).
- **Política B** (§59): un cobro nunca se edita ni se anula. Los errores se corrigen con
  `ADJUSTMENT_DEBIT/CREDIT` autorizado (`customer_accounts.adjust`, motivo obligatorio).

## Payment applications

- `customer_payment_applications` (cobro, venta, monto, actor y origen: `ADVANCE_AUTO`,
  `SALE_PAYMENT` o `MANUAL`) no genera movimiento de cuenta.
- Triggers de capacidad: una aplicación no supera lo pendiente de la venta
  (`PAYMENT_EXCEEDS_SALE_BALANCE`) ni lo disponible del cobro.
- Un cobro a cuenta se imputa a mano con "Imputar" (`POST /payments/:id/applications`); no se
  reparte solo entre ventas.

## Customer account

- `customer_account_movements` es append-only: `SALE_DEBIT`, `PAYMENT_CREDIT`,
  `ADJUSTMENT_DEBIT` y `ADJUSTMENT_CREDIT`, con `balance_after` y secuencia.
- `customer_account_balances` es una proyección custodiada (trigger), con el mismo patrón que
  stock.
- Signo: positivo = el cliente debe; negativo = crédito a favor.
- UI de la cuenta corriente: saldo como "Debe $X", "Sin saldo" o "Crédito a favor $X"; ventas
  pendientes, crédito sin imputar y movimientos con Debe / Haber / Saldo en lenguaje de negocio.
- Cuentas a cobrar (Finanzas) lista los clientes con saldo y filtros.

## Credit balances

El saldo negativo está permitido y se muestra como "Crédito a favor". El crédito sin imputar de
cada cobro se ve en la cuenta y se imputa a ventas pendientes.

## Credit limit

Si `creditLimit` existe, la vista previa calcula el saldo proyectado y avisa cuánto excede,
pero no bloquea. Al postear igual, la venta queda con `credit_limit_exceeded = true` y se audita
`CUSTOMER_CREDIT_LIMIT_EXCEEDED`.

## Atomicity

Postear una venta (§55/§56) es una sola transacción:

1. Asignación con locks.
2. Movimientos `SALE`.
3. Saldos de lote, de producto y costo.
4. Reservas cumplidas.
5. Costo y margen congelados.
6. `SALE_DEBIT` y saldo de la cuenta.
7. Señas aplicadas y cobro inicial.
8. Estados de la venta y del pedido.
9. Auditoría.

Un cobro (pago, movimiento, aplicación, estado y auditoría) también es una sola transacción.

## Locks

ADR-062 extiende ADR-034/042/053 con un orden global sin ciclos:

pedido → líneas del pedido → venta → líneas → lotes (ordenados) → saldos de lote → reservas →
costos de producto → saldos de producto → cuenta del cliente → cobros.

- Las operaciones de lote (merma, bloqueo, transformación) y producción respetan el mismo
  prefijo.
- Cobros e imputaciones toman la cuenta antes que los cobros.
- La disponibilidad se revalida después de bloquear.

## Concurrency

En `sales-concurrency.test.ts`, con conexiones reales del pool:

- Dos ventas de 70 sobre 100 libres: una entra y la otra devuelve
  `INSUFFICIENT_FREE_PRODUCT_STOCK`; quedan 30.
- Reserva y venta directa a la vez: nunca se vende lo prometido.
- Confirmar un pedido y vender el mismo stock a la vez: nada queda negativo.
- Dos cobros de 9.000 sobre 10.000 pendientes: `[201, 422]`.
- Cobros, seña, venta y cobro a cuenta del mismo cliente en paralelo: saldo exacto 8.500.

## Idempotency

- Postear la misma venta 5 veces en paralelo da `[200, 409×4]` y un solo juego de movimientos;
  en serie da `[200, 409, 409]`.
- Toda operación financiera lleva un `operationId` por intento, único por empresa y guardado en la
  fila que produce la consecuencia, en la misma transacción (ADR-062 y ADR-063):

  | Operación                                         | Dónde se guarda                                                 | Huella comparada en el reintento |
  | ------------------------------------------------- | --------------------------------------------------------------- | -------------------------------- |
  | Cobro de una venta, cobro a cuenta, cobro inicial | `customer_payments.operation_id`                                | tipo, destino, monto y medio     |
  | Seña (`OrderAdvance`)                             | `customer_payments.operation_id`                                | pedido, monto y medio            |
  | Imputación manual                                 | `customer_payment_applications.operation_id`                    | cobro, venta y monto             |
  | Ajuste de cuenta                                  | `customer_account_movements.operation_id` (CHECK: sólo ajustes) | cliente, tipo, monto y motivo    |

- Reintento idéntico: `200` con `replayed: true`, sin segunda fila, movimiento ni auditoría. Cobros
  ×3 en paralelo dan `[200, 200, 201]`; imputación y ajuste ×5 en paralelo dan
  `[200, 200, 200, 200, 201]`.
- El mismo id con otra huella devuelve `409 OPERATION_ID_REUSED` y no produce nada. Las notas no
  forman parte de la huella (no cambian la consecuencia).

## Rollback

- **Venta:** una falla inyectada en el `SALE_DEBIT` (después de los movimientos `SALE`) da
  `500`. Lotes, saldos, reservas, costos, movimientos, asignaciones, cuenta, aplicaciones y
  auditoría quedan idénticos; la venta sigue `DRAFT`, el pedido `READY` y la seña disponible.
  Sin la falla, la misma venta se confirma.
- **Cobro (§86):** una falla inyectada en la aplicación (después del `PAYMENT_CREDIT`) no deja
  cobro, movimiento, aplicación ni auditoría, y el saldo no cambia. El reintento con el mismo
  `operationId` se registra normalmente.
- **Imputación manual y ajuste (C6):** una falla inyectada después de insertar la imputación o el
  movimiento (en la auditoría) da `500` y no deja nada; el mismo `operationId` funciona después.

## Tenancy

- FKs compuestas `(company_id, id)` en todas las tablas nuevas, y la empresa siempre sale de la
  sesión.
- Test con la empresa B: no ve ni confirma la venta, y no ve los cobros ni la cuenta de A
  (`404`). Las referencias cruzadas las rechazan las FKs compuestas.

## Permissions

- Nuevos: `sales.read/create/update/post/price_override/cost.read/margin.read`,
  `price_lists.read/manage`, `payments.read/create/post`, `customer_accounts.read/adjust` y
  `order_advances.create`.
- Roles:
  - OWNER y ADMIN: todo.
  - VENTAS: ventas, precios y cobros, sin costo ni margen.
  - ADMINISTRACIÓN: ventas, cobros, cuenta corriente, costos y márgenes.
  - DEPÓSITO: ve la venta sin montos.
  - PRODUCCIÓN: no ve ventas.
- La matriz completa está en [PERMISSIONS.md](../PERMISSIONS.md) (regenerada) y se verifica
  contra la API en `authorization.test.ts`.

## Cost visibility

Sin `sales.cost.read`, la API no devuelve el costo de lote ni de venta. Sin `sales.margin.read`,
no devuelve el margen. La UI oculta lo mismo. Hay tests por rol para Ventas, Depósito, Producción
y Administración.

## Audit

Se auditan:

- Ventas: `SALE_CREATED`, `SALE_UPDATED`, `SALE_POSTED`, `SALE_DRAFT_CANCELLED` y
  `SALE_PRICE_OVERRIDDEN`.
- Pedidos: `ORDER_PARTIALLY_DELIVERED`, `ORDER_DELIVERED` y `ORDER_QUOTED`.
- Listas de precios: `PRICE_LIST_CREATED`, `PRICE_LIST_UPDATED` y `PRICE_LIST_ITEM_CHANGED`.
- Cobros: `CUSTOMER_PAYMENT_CREATED`, `CUSTOMER_PAYMENT_POSTED`, `PAYMENT_APPLIED` y
  `ORDER_ADVANCE_PAYMENT_POSTED`.
- Cuenta corriente: `CUSTOMER_ACCOUNT_ADJUSTED` y `CUSTOMER_CREDIT_LIMIT_EXCEEDED`.

Todas tienen etiqueta en español en el historial.

## Migrations

`0010_sales_payments` va después de `0009` y no modifica migraciones cerradas.

- Crea 9 tablas, columnas de precio y entrega en pedidos, `fulfilled_quantity` en reservas,
  `default_price_list_id` e `is_walk_in` en clientes, y renombra `average_material_cost`.
- Agrega índices de performance (§111) y triggers.
- Sobre datos de 5A:
  - pedidos `UNPRICED` y sin líneas cotizadas;
  - un Consumidor Final por empresa;
  - promedio = round(valor / cantidad, 6);
  - reservas, revisiones, estados y cobertura intactos;
  - tablas nuevas vacías.
- Hay test sobre DB limpia (Gate A) y desde 5A con datos (Gate B, en `migration-fase4.test.ts`).
- `0011_idempotent_applications_adjustments` (cierre): `operation_id` nulo en imputaciones y
  movimientos de cuenta, índices únicos parciales por empresa y CHECK. No modifica 0000–0010 ni
  cambia saldos o movimientos. Probado sobre base vacía y sobre una base en 0010 con un cobro, su
  crédito y un ajuste: todo idéntico y la base rechaza un segundo ajuste con el mismo id.
- **Pasos manuales en una base existente:** `pnpm db:migrate` y después
  `pnpm db:sync-reference`. Sin este último paso los roles no reciben los permisos nuevos y
  Ventas no aparece en el menú.

## API

| Método y ruta                                                                                  | Uso                                                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET/POST /sales`, `GET/PATCH /sales/:id`                                                      | Listado con filtros de fecha, cliente, estado de cobro, origen y pendientes; borrador |
| `GET /sales/:id/preview`                                                                       | Vista previa (no escribe)                                                             |
| `POST /sales/:id/post`                                                                         | «Confirmar entrega y venta», con `initialPayment` opcional                            |
| `POST /sales/:id/cancel`                                                                       | Descartar borrador                                                                    |
| `POST /sales/:id/payments`                                                                     | Cobro de una venta                                                                    |
| `GET /payments`, `GET /payments/:id`, `POST /payments/:id/applications`                        | Cobros e imputación manual                                                            |
| `POST /customers/:id/payments`                                                                 | Cobro a cuenta                                                                        |
| `GET /customers/:id/account`, `POST /customers/:id/account/adjustments`                        | Cuenta corriente y ajustes                                                            |
| `GET /customer-accounts`                                                                       | Cuentas a cobrar                                                                      |
| `GET/POST /price-lists`, `GET/PATCH /price-lists/:id`, `PUT /price-lists/:id/items/:productId` | Listas de precios e ítems                                                             |
| `GET /price-lists/resolve`                                                                     | Precio vigente                                                                        |
| `POST /orders/:id/advances`, `POST /orders/:id/quote`                                          | Seña y acordar precio                                                                 |

Diferencias con el plan:

- No hay `/orders/:id/delivery`: la entrega se inicia desde el detalle del pedido
  (`/ventas/nueva?orderId=`).
- Los ajustes viven bajo la cuenta del cliente.
- Los ítems de lista no se borran, se desactivan.

## UI

- **Ventas** (Comercial):
  - Listado con filtros.
  - Nueva venta directa o desde un pedido, con el precio vigente en vivo y motivo si se cambia.
  - Detalle con datos, montos, lotes, cobros e historial.
  - La vista previa de entrega de un borrador muestra lotes, faltantes, costo, margen, seña a
    aplicar y saldo posterior.
  - «Confirmar entrega y venta» con "Cobrar ahora" opcional.
- **Listas de precios:** listado, detalle con precios editables y alta/edición.
- **Cuentas a cobrar** (Finanzas): listado y cuenta corriente con cobro a cuenta, imputar y
  ajustar saldo.
- **Pedido:**
  - Acciones «Entregar y vender» / «Entregar el resto», «Acordar precio» y «Registrar seña».
  - Columnas Entregado / Pendiente / Precio acordado.
  - Sección «Precio, señas y ventas».
- **Cliente:** lista de precios, acceso a la cuenta corriente y aviso de Consumidor Final (que no
  se desactiva).
- **Pruebas manuales:**
  - Se revisaron 9 pantallas en 1440×900, 1366×768 y 768×1024, sin desborde horizontal, UUIDs ni
    errores de consola (capturas en `bakery-erp/fase5b-ux/`).
  - Corregido durante la revisión: inputs del editor de líneas sin estilo (`.line-editor`) y la
    etiqueta de auditoría `defaultPriceListId`.

## Tests

| Paquete                                                                        | Tests |
| ------------------------------------------------------------------------------ | ----: |
| domain (unit, incluye `sales.test.ts` con 21: §91–§93 exactos)                 |   170 |
| shared (unit)                                                                  |    42 |
| database (unit)                                                                |     5 |
| web (unit)                                                                     |    22 |
| api (integración, incluye `sales.test.ts` 28 y `sales-concurrency.test.ts` 15) |   396 |

Los §90 1–32 están cubiertos entre dominio, integración y E2E. El detalle está en
[TESTING.md](../TESTING.md#cobertura-de-fase-5b).

## E2E

`e2e/fase5b-ventas.spec.ts` tiene 4 tests en desktop y tablet (8 en verde):

1. Pedido con lista del cliente, seña, entrega parcial con vista previa, cobro, entrega del
   resto (`DELIVERED`) y cuenta corriente con cobro a cuenta e imputación (§103/§104).
2. Mostrador con Consumidor Final, FEFO, precio cambiado con motivo, margen negativo y cobro en
   el momento (§105/§106).
3. Lista de precios asignada, venta y ajuste de saldo.
4. Seña y cancelación: reservas liberadas, pedido cancelado y la seña como crédito a favor en la
   cuenta (§107).

La suite completa de todas las fases está en verde. Se actualizaron `smoke`, `fase1-maestros` y
`fase5a-pedidos`, que esperaban "Disponible en próxima etapa", el aviso viejo del cliente o un
único `dl.details`.

## UX findings

- El editor de líneas de la venta estaba sin estilo; se corrigió.
- En 768 px el selector de producto queda angosto porque Precio + Descuento ocupan dos campos.
- Los enlaces de ventas dentro del pedido usan el estilo por defecto.
- El pedido no permite override de precio en su formulario.
- No se puede elegir lote a mano en la vista previa.

## UX backlog

Registrado en [UX_BACKLOG.md](../UX_BACKLOG.md) con la etiqueta [F5B]:

- reagrupar Comercial y Finanzas;
- unificar el editor de líneas;
- descuento en una segunda fila;
- override de precio en el pedido;
- `LOT_PICKING_OVERRIDE`;
- devolución de señas;
- "imputar a las más viejas";
- estilo de los códigos enlazados.

## Gates

| Gate                                | Estado | Evidencia                                                                                        |
| ----------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| A DB limpia                         | ✅     | global-setup migra desde cero; `database.test.ts` y `schema.test.ts`                             |
| B Migración desde 5A                | ✅     | `migration-fase4.test.ts`, describe 0010                                                         |
| C Unit                              | ✅     | domain 170 / shared 42 / web 22                                                                  |
| D Sale lifecycle                    | ✅     | borrador, posteo, descarte, inmutable                                                            |
| E Order pricing                     | ✅     | AGREED al confirmar; UNPRICED + acordar precio                                                   |
| F Price lists                       | ✅     | prioridad, una general, ítems                                                                    |
| G Direct sale pricing               | ✅     | precio vigente (§99)                                                                             |
| H Reserved lot fulfillment          | ✅     | `fromReservation`, `FULFILLED`                                                                   |
| I Partial delivery                  | ✅     | 100 + 50; E2E                                                                                    |
| J Direct sale FEFO                  | ✅     | A antes que B                                                                                    |
| K Committed stock protection        | ✅     | 80 reservados / 20 libres; concurrencia                                                          |
| L Lot-specific COGS                 | ✅     | 52.000; 90.384; §100                                                                             |
| M Inventory value reconciliation    | ✅     | `reconciliationProblems` después de cada operación                                               |
| N Derived average                   | ✅     | 475; round 6                                                                                     |
| O Material margin                   | ✅     | 45,83 %; negativo                                                                                |
| P Customer ledger                   | ✅     | append-only                                                                                      |
| Q Account projection reconciliation | ✅     | `salesProblems`: saldo = Σ = `balance_after`                                                     |
| R Order advance                     | ✅     | crédito negativo                                                                                 |
| S Advance application               | ✅     | automática, sin movimiento extra                                                                 |
| T Partial payment                   | ✅     |                                                                                                  |
| U Payment status                    | ✅     | derivado de aplicaciones                                                                         |
| V Customer credit balance           | ✅     | seña > venta                                                                                     |
| W Credit limit warning              | ✅     | avisa y audita                                                                                   |
| X Idempotent sale posting           | ✅     | `[200, 409×4]`                                                                                   |
| Y Idempotent payments               | ✅     | `[200, 200, 201]`; reuso con otro monto da 409                                                   |
| Z Sale concurrency                  | ✅     | 70 + 70                                                                                          |
| AA Reservation/sale concurrency     | ✅     |                                                                                                  |
| AB Payment concurrency              | ✅     | `[201, 422]`                                                                                     |
| AC Rollback sale                    | ✅     |                                                                                                  |
| AD Rollback payment                 | ✅     |                                                                                                  |
| AE Tenancy                          | ✅     |                                                                                                  |
| AF Authorization                    | ✅     | matriz rol × endpoint                                                                            |
| AG Cost visibility                  | ✅     | por rol                                                                                          |
| AH Timezone                         | ✅     | fechas de venta y filtros en la zona de la empresa; E2E de 5A con navegador en Tokio sigue verde |
| AI E2E pedido→venta                 | ✅     |                                                                                                  |
| AJ E2E entrega parcial              | ✅     |                                                                                                  |
| AK E2E venta directa                | ✅     |                                                                                                  |
| AL E2E margen negativo              | ✅     |                                                                                                  |
| AM E2E anticipo/cancelación         | ✅     |                                                                                                  |
| AN UX manual                        | ✅     | 3 viewports × 9 pantallas                                                                        |
| AO Lint                             | ✅     |                                                                                                  |
| AP Typecheck                        | ✅     |                                                                                                  |
| AQ Build                            | ✅     |                                                                                                  |
| AR Worktree clean                   | ✅     |                                                                                                  |
| AS Remote CI                        | ✅     | workflow `verify` verde en el PR #8                                                              |

## CI

El CI de `main` está verde en `4c95051`. El workflow `verify` del PR #8 (lint, typecheck,
migraciones, seed, tests, build y E2E) está verde. En el cierre, la primera corrida falló en lint
por formato de cuatro docs editados; se corrigió y la siguiente pasó completa.

## Risks

- La venta por lote cambió la semántica del promedio de producto: hoy es sólo informativo
  (ADR-057).
- Devoluciones y notas de crédito no están modeladas: una venta entregada no se revierte.
- No hay facturación fiscal ni impuestos formales.
- El crédito a favor no tiene flujo de reembolso.
- Un cobro registrado no implica conciliación bancaria ni liquidación de tarjetas.
- El margen es sólo material; faltan mano de obra e indirectos.
- Las reservas de materias primas siguen proyectadas.
- La consolidación productiva sigue pendiente.

## Debt

- `SALE_RETURN`, `SALE_REVERSAL`, `CREDIT_NOTE`, `PAYMENT_REFUND`, `FISCAL_INVOICING`,
  `BANK_RECONCILIATION`, `CARD_SETTLEMENT`, `PRODUCTION_CONSOLIDATION`,
  `RAW_MATERIAL_RESERVATIONS`, `FULL_COSTING` y `DELIVERY_LOGISTICS`.
- Nuevas: `LOT_PICKING_OVERRIDE` y `ORDER_FORM_PRICE_OVERRIDE`.
- `APPLICATION_IDEMPOTENCY` quedó resuelta en el cierre (ADR-063): ya no es deuda.
- De paso se corrigió un bug previo: subconsultas correlacionadas sin calificar en inventario y
  lotes. Ahora usan `lib/sql.ts` `qualified()`.

## ADR

- ADR-057: costo por lote específico y promedio derivado.
- ADR-058: estado de venta y de cobro separados; POSTED inmutable.
- ADR-059: pedido → una o varias ventas.
- ADR-060: precios, congelado y override.
- ADR-061: cobros, señas y cuenta corriente (política B).
- ADR-062: orden global de locks, idempotencia y rollback.
- ADR-063: idempotencia de imputaciones manuales y ajustes de cuenta (cierre).

## Cierre: idempotencia de imputaciones y ajustes

Pedido por maxi como cierre de la Fase 5B (sin Fase 5C). Antes, la imputación manual y el ajuste
de cuenta sólo estaban protegidos por el botón deshabilitado de la UI.

- **API:** `POST /payments/:id/applications` y `POST /customers/:id/account/adjustments` exigen
  `operationId`. Primera vez `201`; reintento idéntico `200` con `replayed: true`.
- **Base:** migración 0011, índice único parcial (`company_id`, `operation_id`) en cada tabla.
  Si dos intentos con el mismo id no se serializan por el mismo lock (otro destino), el índice los
  frena y la API responde `409 OPERATION_ID_REUSED`.
- **Transacción:** la fila con el id es la misma que produce la consecuencia; el reintento se busca
  después de los locks (imputación: venta → cobro; ajuste: cuenta), así el segundo intento ve el
  primero confirmado.
- **UI:** se mantiene el botón deshabilitado; además cada diálogo genera un id por intento y lo
  renueva sólo después de un éxito.
- De paso se agregó `app/favicon.ico` (el mismo ícono): el navegador a veces pedía
  `/favicon.ico`, el 404 aparecía como error de consola y hacía fallar el E2E de maestros.

| Gate                              | Estado | Evidencia (`sales-concurrency.test.ts`, salvo indicación)                                                             |
| --------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| C1 PaymentApplication retry       | ✅     | `201` y luego `200 replayed`; una aplicación, una auditoría `PAYMENT_APPLIED`                                         |
| C2 PaymentApplication concurrency | ✅     | cobro de $50.000, venta de $50.000, 5 × $20.000 con el mismo id: `[200×4, 201]`, cobrado $20.000, sin imputar $30.000 |
| C3 AccountAdjustment retry        | ✅     | `201` y luego `200 replayed` (también con otra nota); un movimiento, una auditoría                                    |
| C4 AccountAdjustment concurrency  | ✅     | saldo $100.000, 5 créditos de $20.000 con el mismo id: saldo $80.000, un solo `ADJUSTMENT_CREDIT`                     |
| C5 OPERATION_ID_REUSED            | ✅     | imputación con otro monto u otra venta; ajuste con otro monto, tipo, motivo o cliente: `409`, sin filas nuevas        |
| C6 Rollback                       | ✅     | falla inyectada después de la fila: `500`, nada persiste, el mismo id funciona después                                |
| C7 Tenancy                        | ✅     | empresa B usa el mismo id para su ajuste (`201`, no replay); B no imputa ni ajusta en A (`422` / `404`)               |
| C8 Ledger reconciliation          | ✅     | `salesProblems` + `reconciliationProblems` vacíos después de cada test                                                |
| C9 Lint                           | ✅     | `pnpm lint`                                                                                                           |
| C10 Typecheck                     | ✅     | `pnpm typecheck`                                                                                                      |
| C11 Build                         | ✅     | `pnpm build`                                                                                                          |
| C12 E2E existentes                | ✅     | todas las fases, desktop y tablet                                                                                     |
| C13 Worktree clean                | ✅     |                                                                                                                       |
| C14 Remote CI                     | ✅     | workflow `verify` verde en el PR #8                                                                                   |

Regresión: dominio 170, shared 42, database 5, web 22 y API 396 (antes 389), todos en verde.

## Próximo paso

**UX/DESIGN OPTIMIZATION**, que no se comienza sin aceptación humana de la Fase 5B.
