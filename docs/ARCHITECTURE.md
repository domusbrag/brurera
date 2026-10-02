# Arquitectura

## Resumen

**Monolito modular** en TypeScript dentro de un monorepo pnpm. Un solo backend (API HTTP), una
aplicación web y una base PostgreSQL. Sin microservicios, sin colas, sin event sourcing.

```
 Navegador ──HTTP──▶ apps/web (Next.js :3000)
                         │  páginas server-side: GET /api/auth/me con la cookie
                         │  rewrite /api/* ─────────────────────────┐
                         ▼                                          ▼
                    apps/api (Fastify :4000) ──▶ packages/database (Drizzle) ──▶ PostgreSQL 16
                         │
                         ├──▶ packages/shared (permisos, roles, esquemas zod, DTOs)
                         └──▶ packages/domain (reglas puras: unidades, costos, inventario; decimal.js)
```

## Componentes

### apps/api — backend

- **Fastify 5** + TypeScript estricto. `src/app.ts` arma la aplicación a partir de dependencias
  explícitas (`config`, `db`), lo que permite tests de integración con `app.inject()` sin red.
- **Módulos** en `src/modules/<módulo>/`: rutas (`*.routes.ts`), servicios de aplicación
  (`*.service.ts`) y plugins. Fase 0: `health`, `auth`, `audit`. Fase 1: `company-settings`,
  `employees`, `users`, `roles`, `customers`, `suppliers`, `units`, `categories`, `raw-materials`,
  `products`, `warehouses`. Fase 2: `recipes` (recetas, versiones, costo teórico, snapshots) y
  `PUT /api/raw-materials/:id/reference-cost`. Fase 3: `presentations` (presentaciones de compra por
  materia prima), `purchases` (compras y recepciones: `purchases.service.ts`,
  `receipts.service.ts`) e `inventory` (consultas y operaciones manuales en `inventory.service.ts`;
  núcleo transaccional del stock en `ledger.ts`). Fase 4: `production` (órdenes de producción:
  `production.service.ts` con las transiciones y el completado atómico, `production.data.ts` con
  lecturas, plan en vivo, disponibilidad y DTOs) y, en `inventory`, `product-stock.service.ts`
  (stock y costo de productos terminados). Fase 4.5: `lots` (`lots.service.ts`: lote al completar,
  congelar / descongelar, merma, bloqueo, disponibilidad a una fecha, próximos a vencer y resumen
  por producto; `conservation.service.ts`: perfil de conservación; `lots.data.ts`: lecturas y
  DTOs) y, en `ledger.ts`, `postLotMovement` y el saldo por lote. Fase 5A: `orders`
  (`orders.service.ts`: alta, edición, vista previa, confirmar, replan, cancelar, preparación y
  listo; `orders.plan.ts`: resolución de líneas y plan FEFO + receta por pedido; `orders.data.ts`:
  lecturas, cobertura efectiva, proyección de materias primas y DTOs; `reservations.ts`:
  comprometido por lote, locks e invalidación; `requirements.ts`: vínculo necesidad ↔ orden de
  producción; `planning.service.ts`: Necesidades). Fase 5B: `sales` (`sales.service.ts`: borrador,
  vista previa, posteo atómico y cancelación; `sales.allocation.ts`: qué lotes salen, reservas
  del pedido primero y después FEFO libre; `sales.data.ts`: lecturas y DTOs con costo y margen
  según permiso), `price-lists` (`pricing.ts`: precio vigente y congelado al confirmar un pedido;
  `price-lists.service.ts`: listas e ítems) y `payments` (`payments.service.ts`: cobros, señas,
  imputaciones y cuentas a cobrar; `account.ts`: ledger de cuenta corriente con saldo corrido y
  ajustes). `src/lib/sql.ts` tiene `qualified(column)` para subconsultas correlacionadas (Drizzle
  omite el nombre de la tabla en SELECTs de una sola tabla). Los módulos futuros siguen la lista de la
  especificación (§30).
- **Patrón de maestros:** `GET /api/x?search&status&page&pageSize` (paginado en el servidor,
  `status` = active/inactive/all), `GET /api/x/:id`, `POST /api/x` (201), `PATCH /api/x/:id`,
  `POST /api/x/:id/deactivate` y `/activate`. No hay `DELETE`. Un id de otra empresa responde 404
  como si no existiera; una referencia a otra empresa en un alta, 422 `INVALID_REFERENCE`.
- **Empresa de la operación:** `operationContext(request)` (`src/lib/context.ts`) la toma de la
  sesión (membresía autorizada). Ningún endpoint acepta `companyId` del cliente; si llega, zod lo
  descarta.
- **Códigos de error estables** de Fase 1: `VALIDATION_ERROR`, `NOT_FOUND`, `CODE_TAKEN`,
  `EMAIL_TAKEN`, `DOCUMENT_TAKEN`, `INVALID_REFERENCE`, `INVALID_UNIT_DEFINITION`,
  `INCOMPATIBLE_UNITS`, `EMPLOYEE_ALREADY_LINKED`, `EMPLOYEE_INACTIVE`, `CANNOT_MODIFY_SELF`.
  Fase 2: `RECIPE_ALREADY_EXISTS`, `DRAFT_ALREADY_EXISTS`, `RECIPE_VERSION_IMMUTABLE`,
  `RECIPE_VERSION_NOT_ACTIVE`, `RECIPE_INACTIVE`, `RECIPE_INVALID` (422 con los problemas),
  `COST_INCOMPLETE_CONFIRMATION_REQUIRED`, `PRODUCT_INACTIVE`, `NO_ACTIVE_VERSION`,
  `NO_EFFECTIVE_VERSION`, `RAW_MATERIAL_IN_USE`, `SALE_UNIT_INCOMPATIBLE_WITH_RECIPE`.
  Fase 3: `INSUFFICIENT_STOCK` (409), `ALREADY_POSTED`, `RECEIPT_IMMUTABLE`, `RECEIPT_CANCELLED`,
  `RECEIPT_EXCEEDS_PENDING`, `RECEIPT_EMPTY`, `PURCHASE_NOT_RECEIVABLE`, `PURCHASE_HAS_RECEIPTS`,
  `PURCHASE_NOT_EDITABLE`, `PURCHASE_NOT_DRAFT`, `PURCHASE_ALREADY_CANCELLED`,
  `PURCHASE_WITHOUT_LINES`, `VALUATION_COST_REQUIRED`, `INITIAL_STOCK_ALREADY_LOADED`,
  `INCOMPATIBLE_PRESENTATION_UNIT`, `INCOMPATIBLE_PURCHASE_UNIT`, `DISCOUNT_EXCEEDS_GROSS`,
  `PRESENTATION_NAME_TAKEN`, `RAW_MATERIAL_INACTIVE`.
  Fase 4: `INVALID_PRODUCTION_TRANSITION`, `PRODUCTION_IMMUTABLE`, `PRODUCTION_ALREADY_COMPLETED`,
  `PRODUCTION_PLAN_LOCKED`, `PRODUCTION_NOT_IN_PROGRESS`, `INSUFFICIENT_MATERIALS_FOR_PRODUCTION`
  (409, con faltantes), `INSUFFICIENT_STOCK` (409, con materia prima, requerido, disponible y
  faltante), `PRODUCT_NOT_STOCK_CONTROLLED`, `PRODUCT_WITHOUT_RECIPE`, `PRODUCT_INACTIVE`,
  `NO_EFFECTIVE_VERSION`, `WAREHOUSE_INACTIVE`, `ACTUAL_OUTPUT_REQUIRED`,
  `ACTUAL_CONSUMPTION_REQUIRED`, `NO_CONSUMPTION`, `QUANTITY_NOT_POSITIVE`, `BATCH_CODE_TAKEN`.
  Las violaciones de unicidad de la base se traducen por nombre de constraint
  (`mapUniqueViolations`).
- **Regla de dependencias:** rutas → servicios → base de datos. Un módulo solo usa otro a través
  de su servicio exportado; nunca importa sus rutas. `audit` es un módulo hoja que cualquiera
  puede usar. Sin dependencias circulares.
- **Lógica de dominio** (costeo, conversiones, máquinas de estado) va en funciones puras dentro
  del módulo correspondiente (o en `packages/domain` cuando sea compartida), testeadas en unit
  tests. Nunca en rutas ni en componentes visuales. El costo teórico de recetas vive en
  `packages/domain/src/costing.ts`; la API lo usa para calcular y guardar snapshots y el editor
  web lo usa para la vista previa en vivo, así que ambos dan exactamente el mismo resultado.
- **Transacciones:** las operaciones de negocio reciben/abren una transacción Drizzle
  (`db.transaction`) y la auditoría se escribe con la misma transacción (ver `recordAudit`).
- **Inventario como ledger (Fase 3, ADR-026/027):** `stock_movements` es la fuente de verdad,
  append-only. `stock_balances` (saldo por depósito) y `raw_material_inventory_costs` (cantidad,
  valor y promedio por materia prima a nivel empresa) son **proyecciones** que se actualizan en la
  misma transacción que el movimiento, junto con una fila de `inventory_cost_history`. La única
  puerta para cambiar existencias es `postStockMovement` (`modules/inventory/ledger.ts`): bloquea
  el costo de la materia prima y el saldo del depósito, calcula con `@bakery/domain`
  (`applyInbound`/`applyOutbound`, stock no negativo), inserta el movimiento, actualiza las dos
  proyecciones, registra el historial y, si cambió el promedio, audita
  `MOVING_AVERAGE_COST_CHANGED`. Triggers en la base rechazan cualquier cambio de saldo o costo
  que no corresponda exactamente a un movimiento nuevo, así que un `UPDATE` "a mano" falla.
- **Confirmar una recepción es atómico** (`postReceipt` en `receipts.service.ts`): en UNA
  transacción valida estados, revalida lo pendiente contra las líneas de compra bloqueadas,
  congela las líneas de la recepción, genera un movimiento por línea (con conversión a unidad base
  y costo de adquisición), actualiza lo recibido y el estado de la compra, marca la recepción
  `POSTED` y audita. Cualquier error revierte todo (hay un test que fuerza la falla en el último
  paso).
- **Concurrencia por orden fijo de locks:** compra → recepción → líneas de compra → filas de costo
  de las materias primas **ordenadas por id** → saldos de depósito. Las filas de costo y de saldo
  se crean vacías si no existen (`INSERT … ON CONFLICT DO NOTHING`) y se toman con
  `SELECT … FOR UPDATE`. Toda operación que toca una materia prima (recepción, stock inicial,
  ajuste, merma) se serializa sobre su fila de costo y nunca calcula sobre un estado viejo; como
  todas toman los locks en el mismo orden, no hay deadlocks.
- **Idempotencia:** confirmar dos veces una recepción responde `409 ALREADY_POSTED` (estado
  verificado con la recepción bloqueada) y, como segunda barrera, un índice único
  `(company_id, source_line_id)` en `stock_movements` impide que una línea de recepción genere dos
  movimientos.
- **Producción (Fase 4, ADR-039 a 042):** la orden es documento y lote. `DRAFT`, `PLANNED` e
  `IN_PROGRESS` no mueven stock; al planificar se fijan versión de receta, líneas escaladas y costo
  esperado (trigger `production_orders_guard` bloquea los campos estructurales). Completar
  (`completeOrder`) es UNA transacción de 22 pasos: bloquea la orden y sus líneas, normaliza lo
  real, bloquea costos y saldos de las materias primas por id, revalida stock, genera un
  `PRODUCTION_CONSUMPTION` por línea al promedio vigente, suma sus `total_value` como costo material
  real, bloquea costo y saldo del producto, genera un `PRODUCTION_OUTPUT` valorizado exactamente
  con ese total, actualiza el promedio del producto con `applyInbound` y su historial
  (`product_inventory_cost_history`), congela costos reales, pasa a `COMPLETED` y audita. El ledger
  tiene una segunda puerta para productos (`postProductMovement`) con las mismas garantías.
  Orden global de locks: orden → líneas → costos de materias primas → saldos de materias primas →
  costo del producto → saldo del producto. Idempotencia: estado con la orden bloqueada (`409
PRODUCTION_ALREADY_COMPLETED`) + único `(company_id, source_line_id)` (línea para consumos, orden
  para la salida). La vista previa del alta (`POST /api/production-orders/preview`) inserta la orden
  dentro de una transacción y la revierte, así muestra exactamente lo que se guardaría.
- **Lotes (Fase 4.5, ADR-043 a 049):** el lote (`product_lots`) nace dentro de la transacción de
  completar, antes del `PRODUCTION_OUTPUT`, que lo referencia (`product_lot_id`). Todo movimiento
  de producto tiene lote y actualiza tres proyecciones en el mismo paso: saldo del lote, saldo
  agregado por depósito y costo del producto (Σ lotes = agregado, por trigger y por test).
  Congelar / descongelar (`transformLot`) y merma (`wasteLot`) son una transacción: bloquean el
  lote → saldo del lote → costo del producto → saldo del producto (orden global), revalidan saldo
  (`409 INSUFFICIENT_LOT_QUANTITY`) y estado (vencido, bloqueado, agotado), generan
  `LOT_TRANSFORMATION_OUT` + `IN` (neto cero, al costo del lote, promedio sin cambio) o `WASTE`
  (al costo del lote) y auditan. Idempotencia por `operationId` del cliente: reintento → `200
replayed: true`; el mismo id en otra operación → `409 OPERATION_ID_REUSED`. "Vencido", "próximo
  a vencer" y "agotado" se derivan al consultar (no hay jobs); la disponibilidad a una fecha y el
  orden FEFO salen de `@bakery/domain` (`calculateAvailabilityAt`, `sortFefo`).
- **Pedidos (Fase 5A, ADR-050 a 056):** confirmar, replanificar y cancelar son una transacción
  cada uno con orden de locks fijo (pedido → líneas → necesidades → lotes ordenados → saldos →
  reservas; las operaciones de lote nunca toman el pedido) e idempotencia por `operationId`
  (`customer_order_operations`, verificado después de bloquear el pedido). El plan reutiliza el
  dominio: elegibilidad y FEFO de Fase 4.5 más `availabilityForOrder` / `allocateFefo`
  (comprometido de otros pedidos descontado) y el escalado de recetas de Producción
  (`expandRecipe`). Reservar no escribe el ledger. La cobertura `NEEDS_REPLAN` se deriva de las
  reservas invalidadas de la revisión vigente, así merma y bloqueo no tocan el pedido. Ningún GET
  escribe: vistas previas (`coverage-preview`, `replan-preview`) calculan sin guardar. Necesidades
  (`/planning/*`) agrega en SQL y pagina en el servidor.
- **Ventas y cobros (Fase 5B, ADR-057 a 062):** postear una venta es una transacción con el orden
  de locks de ADR-062 (pedido → líneas del pedido → venta → líneas → lotes → saldos de lote →
  reservas → costos de producto → saldos de producto → cuenta → cobros). Escribe `SALE` por lote
  al costo real del lote, consume las reservas del pedido, actualiza entregado / pendiente, debita
  la cuenta y aplica las señas disponibles en la misma transacción. Cobros e imputaciones bloquean
  la cuenta del cliente; la capacidad de cada cobro y de cada venta la custodian triggers. La
  vista previa usa la misma asignación sin locks y no escribe. Costo y margen sólo salen en la
  respuesta con `sales.cost.read` / `sales.margin.read`.
- **Visibilidad de costos:** las rutas de inventario calculan `canSeeCosts` con el permiso
  `inventory.cost.read`; sin él, promedio, valor de inventario, costo unitario y valor de los
  movimientos y costo de la última compra vienen en `null`, e `GET /api/inventory/costs/:id`
  (historial) responde 403. El costo efectivo por unidad que usan las recetas sigue visible donde
  ya lo era en Fase 2. En producción, `production.cost.read` controla todo importe de la orden
  (costo esperado, estimado, real, por línea y valor de los movimientos): sin él vienen en `null`
  (`withoutProductionCosts`) y `cost-comparison` responde 403; las cantidades no se ocultan.
- **Validación:** toda entrada externa se valida con zod mediante `parseInput()`, que responde
  `400 VALIDATION_ERROR` con el detalle de campos.
- **Errores:** `AppError(status, code, message)` para errores esperados. El error handler central
  traduce a `{ error: { code, message, requestId } }`, registra los 5xx con contexto (ruta,
  usuario, request id) y nunca expone detalles internos.
- **Logs estructurados:** pino (logger de Fastify) en JSON. Redacción de `cookie`,
  `authorization`, `set-cookie` y campos `password`.
- **Correlation id:** cada request tiene `request.id` (se respeta `x-request-id` entrante si es
  válido) y se devuelve en el header `x-request-id`; se persiste en `audit_logs.request_id`.

### apps/web — frontend

- **Next.js 16 (App Router)** + React 19. Desktop-first, responsive (menú lateral colapsable
  bajo 900 px para tablet).
- El navegador **solo habla con el origen web**. `next.config.ts` reescribe `/api/*` hacia la API,
  así la cookie de sesión es same-origin y no hace falta CORS.
- Las páginas autenticadas viven en el grupo `src/app/(app)/`. Su layout consulta
  `GET /api/auth/me` en el servidor en cada request; sin sesión válida redirige a `/login`.
  Esto es solo UX: **la autorización real siempre se valida en la API**.
- La web no contiene lógica de negocio ni secretos; solo presenta datos de la API.
- Las secciones futuras del menú muestran "Disponible en próxima etapa" (sin funcionalidad falsa).
- **Maestros (Fase 1):** componentes cliente genéricos en `src/components/masters/`: `MasterList`
  (búsqueda con demora, filtro de estado y filtros extra sincronizados con la URL, paginación del
  servidor), `EntityForm` (campos declarativos, errores por campo que devuelve la API) y piezas de
  detalle (`Details`, `ActiveToggle` con diálogo de confirmación, `AuditHistory`). Cada maestro
  define sus columnas, campos y detalle en su archivo; las rutas de `src/app/(app)/` solo los montan.
- La validación real la hace la API con los esquemas zod de `@bakery/shared`; la web muestra los
  errores por campo que recibe. Los permisos del usuario (`useCan`) solo ocultan acciones.
- **Recetas (Fase 2):** `src/components/recipes/` — listado, editor (`recipe-editor.tsx`, con
  costo calculado en vivo por `@bakery/domain`), detalle, versión en sólo lectura y piezas de costo
  (`cost-views.tsx`). Navegación: **Producción → Recetas**. Desde Fase 3 la columna de costo de
  ingredientes muestra el **costo usado** y su origen (promedio de compras o referencia manual).
- **Compras e inventario (Fase 3):** `src/components/purchases/` — listado, alta y edición del
  borrador con líneas y totales en vivo (`purchase-form.tsx`), detalle con recepciones y acciones
  por estado, registro y confirmación de recepciones (rutas bajo `/compras`).
  `src/components/inventory/` — stock con filtros, detalle por materia prima con los tres costos
  separados (promedio de inventario, referencia manual, costo usado por recetas), movimientos,
  bajo mínimo (`inventory-pages.tsx`), formularios de stock inicial, ajuste y merma con resumen
  antes/después (`stock-operation.tsx`) y el panel de presentaciones de compra
  (`presentations.tsx`), que aparece en la ficha de la materia prima y en la de stock (rutas bajo
  `/stock`). Navegación: **Operaciones → Compras** e **Inventario → Stock**, visibles con
  `purchases.read` e `inventory.read`.
- **Producción (Fase 4):** `src/components/production/` — listado con filtros (estado, producto,
  responsable, desde/hasta), alta y edición con resumen del plan en vivo desde la vista previa de
  la API (`production-form.tsx`), detalle por estado con plan y disponibilidad, carga de consumo y
  salida reales con consumos extra, diálogo "Revisar antes de completar" y plan contra real con
  movimientos (`production-pages.tsx`), y piezas comunes (`production-shared.tsx`: disponibilidad y
  los costos esperado / estimado / real / diferencia, siempre separados). Stock suma la pestaña
  **Productos terminados** (`inventory/product-stock-pages.tsx`) y los movimientos muestran
  materias primas y productos con enlace a la orden. Navegación: **Producción → Órdenes** (con
  `production_orders.read`) antes de Recetas.
- **Lotes (Fase 4.5):** `src/components/lots/` — `conservation.tsx` (resumen en la ficha del
  producto y formulario `/productos/[id]/conservacion` con vida útil en horas o días),
  `lot-pages.tsx` (lotes y disponibilidad a una fecha en la ficha de stock del producto, detalle
  `/stock/lotes/[id]` con bloqueo, formularios congelar / descongelar / merma con resumen y
  `operationId` por intento, y `/stock/productos/por-vencer`) y `lot-shared.tsx` (estados, vida
  útil y tiempo restante en palabras). Productos terminados suma columnas por conservación; los
  movimientos muestran el lote; la orden completada enlaza su lote y, si el producto admite varios
  estados iniciales, el diálogo de completar permite elegirlo.
- **Pedidos y Necesidades (Fase 5A):** `src/components/orders/` — `order-shared.tsx` (estado,
  cobertura, `WallClockInput` de fecha + hora de la empresa, cobertura por producto explicada,
  proyección de materias primas), `order-form.tsx` (alta y edición con vista previa de cobertura
  en vivo), `order-pages.tsx` (listado con filtros y detalle con acciones; confirmar, actualizar
  cobertura y cancelar llevan `operationId` por intento), `order-replan.tsx` (modificar con
  comparación antes/después) y `planning-pages.tsx` (pestañas Producción / Materias primas /
  Pedidos en riesgo con horizonte). Rutas `/pedidos` y `/necesidades`; navegación **Comercial →
  Pedidos** (`orders.read`) y **Planificación → Necesidades** (`order_planning.read`). La orden de
  producción acepta `?requirementId=` para prellenarse desde una necesidad. Stock y lotes muestran
  comprometido y disponible.
- **Ventas, listas de precios y cuentas a cobrar (Fase 5B):** `src/components/sales/` —
  `sale-shared.tsx` (estados, margen, `PaymentDialog`, avisos), `sale-form.tsx` (venta directa o
  desde `?orderId=`, precio vigente resuelto en vivo y motivo si se cambia), `sale-pages.tsx`
  (listado, detalle, vista previa de la entrega y «Confirmar entrega y venta» con cobro opcional),
  `price-list-pages.tsx` y `account-pages.tsx` (cuentas a cobrar, cuenta corriente con Debe /
  Haber / Saldo, cobro a cuenta, imputar y ajustar). Rutas `/ventas`, `/listas-de-precios` y
  `/cuentas-a-cobrar`. El pedido suma «Entregar y vender», «Acordar precio», «Registrar seña» y la
  sección «Precio, señas y ventas»; el cliente, su lista de precios y el acceso a la cuenta.
- La interfaz nunca muestra UUIDs ni `companyId` (hay un E2E que lo verifica).

### packages/shared

Contratos entre API y web sin dependencias de servidor: catálogo de permisos, roles de sistema,
esquemas zod de alta/edición de cada maestro, DTOs de respuesta, etiquetas de auditoría y la matriz
de permisos que genera `docs/PERMISSIONS.md`. Es la fuente de verdad de los códigos de permiso.

### packages/domain

Reglas de negocio puras, sin base ni HTTP: conversión de unidades (`convertQuantity`,
`validateDerivedUnit`, unidades estándar), formato de códigos internos y costeo de recetas
(`calculateIngredientCost`, `normalizeRecipeYield`, `calculateUnitCost`, `calculateGrossMargin`,
`calculateCostVariation`, `calculateRecipeCost`, `validateRecipeVersion`, `diffRecipeVersions`,
`findEffectiveVersion`) e inventario (`inventory.ts`: `movementSign`, `baseQuantityPerPurchaseUnit`,
`calculatePurchaseLineAmounts`, `calculatePurchaseTotals`, `acquisitionUnitCost`, `applyInbound`,
`applyOutbound`, `positiveAdjustmentCost`, `nextBalance`, `stockStatus`, `shortage`,
`selectEffectiveCost`) y producción (`production.ts`: máquina de estados `assertTransition`,
`normalizeOutput`, `normalizeConsumption`, `scaleFactor`, `planProduction`, `consumptionVariance`,
`outputPerformance`, `actualMaterialCost`, `actualUnitMaterialCost`, `aggregateRequirements`,
`findShortages`, `formatBatchCode`) y lotes (`lots.ts`: transiciones `canTransform` /
`assertTransformation`, `shelfLifeToMinutes`, `calculateUsableUntil`, `resolveInitialConservation`,
`resolveTransformation`, `lotOutflow`, `applyLotMovement`, `lotEligibilityAt`, `isNearExpiry`,
`sortFefo`, `calculateAvailabilityAt`, `recommendFefo`, `childLotCode`). Usa `decimal.js` para toda aritmética (ADR-017, política en ADR-023).

### packages/database

Esquema Drizzle (`src/schema/`), migraciones SQL versionadas (`migrations/`), cliente
(`createDatabase`), runner de migraciones y sincronización de datos de referencia (permisos y
roles de sistema). Los paquetes internos se consumen como código fuente TypeScript; la API se
empaqueta con tsup para producción.

## Autenticación y seguridad

| Aspecto       | Implementación                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Contraseñas   | Argon2id con `@node-rs/argon2` (parámetros por defecto de la librería). Nunca texto plano.                                          |
| Sesión        | Token aleatorio de 256 bits (`crypto.randomBytes`) en cookie `bakery_session`. En la tabla `sessions` se guarda solo su SHA-256.    |
| Cookie        | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` en producción, expiración = TTL de sesión (12 h por defecto).                        |
| Logout        | Revoca la sesión en el servidor (`revoked_at`); una cookie robada deja de servir.                                                   |
| CSRF          | SameSite=Lax + las requests que modifican estado deben ser JSON (`415` si no) + validación de `Origin` contra `WEB_ORIGIN` (`403`). |
| Enumeración   | Mismo error y tiempo similar (hash dummy) para usuario inexistente, deshabilitado o contraseña incorrecta.                          |
| Rate limiting | `@fastify/rate-limit` en `POST /api/auth/login` (10/min por IP por defecto).                                                        |
| Headers       | `@fastify/helmet` en la API; `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` en la web.                       |
| Autorización  | `requirePermission(...)` por ruta en la API. Permisos efectivos = unión de permisos de los roles del usuario.                       |
| Open redirect | `safeNextPath()` solo acepta rutas internas tras el login.                                                                          |
| Secretos      | Variables de entorno (`.env`, no versionado). El frontend no recibe secretos.                                                       |
| Auditoría     | Login exitoso/fallido y logout quedan en `audit_logs`; la tabla rechaza UPDATE/DELETE por trigger.                                  |

## Configuración

Variables de entorno validadas con zod al arrancar (`apps/api/src/config.ts`); configuración
inválida detiene el proceso con un mensaje claro. Ver `.env.example`.

## Fechas, dinero y cantidades

- Todas las marcas de tiempo son `timestamptz` (UTC). La zona horaria de presentación es la de la
  empresa (`companies.timezone`, por defecto `America/Argentina/Buenos_Aires`).
- Fechas de calendario sin hora (p. ej. fecha de ingreso) usan `date`.
- **Hora de pared de la empresa (Fase 5A, ADR-055):** una fecha y hora que el usuario elige (la
  entrega de un pedido, la disponibilidad a una fecha) viaja como `"AAAA-MM-DDTHH:mm"` en la zona de
  la empresa y la API la convierte con `zonedLocalToInstant`; las respuestas traen también la forma
  local (`requestedAtLocal`). La UI no usa `datetime-local` ni `new Date()` para interpretarla.
- Dinero, costos y cantidades comerciales: `numeric(p, s)` en PostgreSQL; en TypeScript viajan como
  strings decimales y se operan con `decimal.js` (nunca `number`). Hay un test que falla si
  aparece una columna `real`/`double precision`.
- **Política decimal (Fase 2, ADR-023):** el dominio calcula con precisión 40 y redondeo
  `ROUND_HALF_UP`, **sin redondeos intermedios**. Sólo se redondea al persistir o enviar: dinero y
  costos a 6 decimales (`numeric(20,6)`), cantidades de receta a 6 (`numeric(18,6)`), cantidades
  normalizadas a 10 (`numeric(28,10)`), porcentajes a 4 (`numeric(7,4)`). La UI redondea a 2
  decimales para mostrar dinero (HALF_UP), salvo costos por unidad menores a un centavo y costos de
  referencia, que se muestran tal como se cargaron (hasta 6).
- **Inventario (Fase 3, ADR-029):** cantidades de stock en unidad base a 10 decimales
  (`numeric(28,10)`), costos unitarios, valores y promedio a 6 (`numeric(20,6)`). El promedio se
  redondea a 6 (HALF_UP), pero no se usa para reconstruir el valor: el valor de inventario es
  siempre el anterior más el valor del movimiento (cantidad × costo, a 6 decimales), y el trigger
  de la base lo verifica.

## Qué NO se hace (deliberadamente)

Microservicios, event sourcing, CQRS, Kubernetes, colas, cachés distribuidas, BI avanzado, IA.
