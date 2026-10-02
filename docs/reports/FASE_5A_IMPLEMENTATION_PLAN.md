# Fase 5A — Pedidos + demanda comprometida + necesidades · Plan de implementación

Base: `main` en `f9c0157` (Fase 4.5 mergeada, CI verde run 36940779544). Rama `fase-5a-pedidos`.
Este plan se siguió tal cual; las decisiones que lo concretan están en ADR-050 a ADR-056.

## 1. Modelo y migración `0009_customer_orders`

- Tablas nuevas: `customer_orders`, `customer_order_lines`, `product_lot_reservations`,
  `order_production_requirements`, `order_material_requirements` y `customer_order_operations`
  (idempotencia). Columna opcional `production_orders.source_order_requirement_id`.
- FKs compuestas con `company_id` en todo; índices de §92 (empresa, cliente, fecha, estado,
  cobertura, producto de línea, reservas por lote activas y por pedido, necesidades por producto,
  materias primas por materia prima).
- Triggers: pedidos y líneas no se borran (se cancelan / `removed_at`), reservas y necesidades
  inmutables salvo estado, Σ reservas activas ≤ saldo del lote, saldo nunca debajo de lo reservado,
  lote bloqueado sin reservas activas. 0000–0008 intactas.

## 2. Dominio (`packages/domain/src/orders.ts`)

Máquina de estados; `availabilityForOrder` (físico / elegible / comprometido / disponible por
conservación pedida, reutilizando elegibilidad y FEFO de 4.5); `allocateFefo`; cobertura;
`expandRecipe` con el escalado de Producción; `aggregateMaterialDemand`; invalidación por merma
(menor prioridad y entrega más lejana primero) y cantidad transformable.

## 3. API (`apps/api/src/modules/orders`)

- `/orders` (listado con filtros, alta, detalle, edición), `coverage-preview` (sin guardar),
  `confirm`, `replan-preview`, `replan`, `cancel`, `start-preparation`, `mark-ready`.
- `/planning/production-needs`, `/material-demand` (horizonte `until`), `/orders-at-risk`,
  `/requirements/:id` (prellenado de la orden de producción).
- Locks: pedido → líneas → necesidades → lotes ordenados → saldos → reservas; lotes nunca toman el
  pedido. Merma y bloqueo invalidan antes de escribir (triggers no diferibles).
- Integración con Fase 4.5: transformar respeta lo comprometido (`LOT_QUANTITY_COMMITTED`),
  disponibilidad y resumen de stock con comprometido / disponible, detalle de lote con reservas.
- Integración con Fase 4: crear orden desde una necesidad (permiso propio), cancelar → `OPEN`,
  completar → `SATISFIED`.
- Permisos §62 y auditoría §64.

## 4. Web

- Comercial → Pedidos: listado, alta con vista previa, detalle por secciones, edición,
  modificar con antes/después. Planificación → Necesidades con tres pestañas y horizonte.
- `WallClockInput` (hora de la empresa) y corrección de la disponibilidad a una fecha de 4.5.
- Stock: Comprometido y Disponible ahora; lote: comprometido, libre y pedidos.

## 5. Pruebas y cierre

Unit (§72–74), integración (§75–84, concurrencia, rollback, tenencia, roles, zona horaria),
migración desde 4.5, E2E principal / replan / calidad en desktop y tablet con el navegador en otra
zona, revisión manual en 1440×900, 1366×768 y 768×1024, documentación y reporte. Fin:
`FASE_5A_STATUS = COMPLETE_PENDING_HUMAN_ACCEPTANCE`; no se comienza Fase 5B.
