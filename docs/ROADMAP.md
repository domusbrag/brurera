# Roadmap

Cada fase tiene alcance explícito, criterios de aceptación, pruebas, documentación y un **gate
humano**: no se avanza a la siguiente sin revisión y aprobación.

Disciplina por fase: inspeccionar estado → plan breve → implementar → pruebas focales → corregir →
gates → revisión manual de UX → actualizar docs → resumen (CAMBIOS, ARCHIVOS, MIGRACIONES, TESTS,
RESULTADOS, RIESGOS, DEUDA, SIGUIENTE PASO) → detenerse.

| Fase | Nombre                                       | Estado                         |
| ---- | -------------------------------------------- | ------------------------------ |
| 0    | Discovery + Foundation                       | Completa — aceptada            |
| 1    | Maestros                                     | Completa — aceptada            |
| 2    | Recetas + costo teórico                      | Completa — aceptada            |
| 3    | Compras + inventario                         | Completa — aceptada            |
| 4    | Producción                                   | Completa — aceptada            |
| 4.5  | Lotes + conservación + vida útil             | Completa — aceptada            |
| 5A   | Pedidos + demanda comprometida + necesidades | Completa — aceptada            |
| 5B   | Ventas + cobros + cuenta corriente + margen  | **Completa — esperando gate**  |
| UX   | UX/DESIGN OPTIMIZATION                       | Pendiente (después de Fase 5B) |
| 6    | Proveedores + finanzas + caja                | Pendiente                      |
| 7    | Facturación interna                          | Pendiente                      |
| 8    | Dashboard y reportes                         | Pendiente                      |
| 9    | Piloto                                       | Pendiente                      |

## Fase 0 — Discovery + Foundation

Repositorio, README, documentación (`PRODUCT`, `ARCHITECTURE`, `DOMAIN_MODEL`, `DATABASE`,
`ROADMAP`, `TESTING`, `DECISIONS`), monorepo, PostgreSQL con Docker Compose, ORM y migraciones de
tablas fundacionales, auth (login, logout, sesión, protección de rutas, admin seed), shell UI,
health, estructura de tests, CI básico, scripts raíz.

**Gate:** arranca desde cero con un comando documentado; base creada por migraciones; login
funcional; test suite ejecutable; worktree limpio; test, lint, typecheck y build en verde.

## Fase 1 — Maestros

Empresa (edición), usuarios (alta, roles, activar/desactivar, cambio de contraseña), roles y
permisos (asignación), empleados, clientes, proveedores, unidades y conversiones, categorías,
materias primas (sin stock editable), productos, depósitos.

CRUD profesional con validaciones, búsqueda, paginación server-side, activo/inactivo, permisos por
módulo, auditoría de cambios sensibles (p. ej. `USER_ROLE_CHANGED`, `PRICE_CHANGED`) y tests.

**Gate:** existen todos los maestros necesarios para operar.

**Implementado:** membresía usuario ↔ empresa (un usuario puede tener roles distintos en varias
empresas), empresa, empleados, usuarios, roles (lectura), clientes, proveedores, unidades con
conversión, categorías, materias primas, productos y depósitos, con tenancy verificada en la base,
auditoría y tests (ver [reports/FASE_1_REPORTE.md](reports/FASE_1_REPORTE.md)). Quedaron fuera por
decisión explícita: cambio/recuperación de contraseña, edición de roles propios de la empresa,
lista de precios del cliente (Fase 5) y selector de empresa.

## Fase 2 — Recetas + costo teórico

Recetas, versiones, ingredientes, rendimiento, costo calculado.
**Demostración:** crear producto A → receta v1 → ingredientes → calcular costo → crear v2 →
confirmar que v1 no cambió.

**Implementado:** receta por producto con versiones `DRAFT → ACTIVE → ARCHIVED` (una vigente y un
borrador por receta; las publicadas son inmutables también en la base), ingredientes con unidad
compatible con la unidad base de la materia prima, rendimiento en unidad compatible con la de
venta, merma teórica informativa, costo de referencia manual por materia prima (permiso propio y
auditado), costo teórico por lote y por unidad de venta con decimal.js, snapshot de costo al
publicar, comparación snapshot vs. costo actual con variación, margen bruto teórico, costo
incompleto explícito (nunca $0), duplicar versión, diff entre versiones y versión vigente a una
fecha. Ver [reports/FASE_2_REPORTE.md](reports/FASE_2_REPORTE.md). Quedan para fases siguientes:
costo promedio ponderado desde compras (Fase 3), consumo y costo real (Fase 4), packaging
específico por artículo y costos indirectos.

## Fase 3 — Compras + inventario

Compras, recepción, `StockMovement`, costo promedio ponderado móvil, stock, ajustes, alertas de
mínimo, mermas.
**E2E obligatoria:** stock harina 0 → compra 100 kg → confirmar → stock 100 → otra compra de
100 kg a otro precio → promedio ponderado correcto.

**Implementado:** presentaciones de compra por materia prima ("Bolsa 25 kg" de esta harina),
compras `DRAFT → ORDERED → PARTIALLY_RECEIVED → RECEIVED` (o `CANCELLED` sin recepciones
confirmadas), recepciones parciales `DRAFT → POSTED` (inmutables al confirmar, idempotentes),
ledger append-only `stock_movements` con cantidad con signo (stock inicial, recepción, ajuste
positivo/negativo, merma), saldos por depósito y costo por empresa como proyecciones mantenidas en
la misma transacción y custodiadas por triggers, costo promedio ponderado móvil por empresa con
historial, stock negativo prohibido (`INSUFFICIENT_STOCK`), stock bajo mínimo, valorización
(con permiso `inventory.cost.read`) y costo efectivo de recetas (promedio → referencia manual →
incompleto). Ver [reports/FASE_3_REPORTE.md](reports/FASE_3_REPORTE.md). Quedan fuera: cuentas a
pagar y pagos (Fase 6), devoluciones a proveedor, cierre de compras con faltante, stock de
producto terminado (Fase 4/5) y transferencias entre depósitos.

## Fase 4 — Producción

**Completa — aceptada.** Órdenes de producción `OP-0001` que son también el lote
(`LOT-AAAAMMDD-NNN`), con estados `DRAFT → PLANNED → IN_PROGRESS → COMPLETED` (cancelables antes
de completar). La versión de receta se fija al planificar; el plan escala la receta y congela el
costo esperado; iniciar exige stock; en curso se cargan consumo real (unidades compatibles), consumos
extra con motivo y salida real; completar genera en una transacción `PRODUCTION_CONSUMPTION` al
costo promedio y `PRODUCTION_OUTPUT` al costo material real, con promedio móvil del producto
terminado e historial. Stock y ficha de productos terminados. Ver
[reports/FASE_4_REPORTE.md](reports/FASE_4_REPORTE.md). Quedan fuera (deuda o fases futuras):
reservas de stock (`INVENTORY_RESERVATIONS`), reversión de producciones (`PRODUCTION_REVERSAL`),
stock por lote, vencimientos y FIFO (resueltos en Fase 4.5), mano de obra, energía e indirectos en el costo, MRP y
planificación automática.

## Fase 4.5 — Lotes + conservación + vida útil

**Cerrada** (aceptada el 2026-10-01, mergeada a `main` en `f9c0157`). Cada producción completada crea un lote de producto
terminado (`ProductLot`, código = lote de la orden) con su estado de conservación (fresco,
refrigerado, congelado, descongelado), vida útil y "utilizable hasta" derivados del perfil de
conservación del producto (configurable por producto y estado, nada fijo en el código). Saldo por
lote (`product_lot_balances`) derivado de movimientos con `product_lot_id`. Congelar y descongelar
son transformaciones explícitas y parciales que crean un lote hijo (`LOT_TRANSFORMATION_OUT/IN`,
neto cero, sin cambiar el promedio); lo descongelado no se recongela. Merma por lote al costo del
lote. Bloqueo de calidad separado de la conservación. Disponibilidad a una fecha con FEFO
(`calculateProductAvailabilityAt`), vista "Próximos a vencer" y migración 0008 que reconstruye un
lote por orden completada (BLOCKER si algo no reconcilia). Ver
[reports/FASE_4_5_REPORTE.md](reports/FASE_4_5_REPORTE.md). Quedan fuera: reservas
(`INVENTORY_RESERVATIONS`, Fase 5A), consumo de lotes por ventas, transferencias de lotes entre
depósitos, refrigerar desde fresco y vencimientos con job de fondo (el estado es derivado).

## Fase 5A — Pedidos + demanda comprometida + necesidades

**Completa — aceptada.** Pedido para una fecha y hora (zona de la empresa) → cantidad
pedida → stock físico → stock utilizable en esa fecha (`calculateProductAvailabilityAt`, Fase 4.5)
→ stock ya comprometido → disponible real → reserva por lote (FEFO, sin mover stock) → cantidad a
producir → receta fijada → materias primas necesarias (demanda proyectada, sin reservar) → stock de
materias primas → faltantes a comprar. Estados `DRAFT`, `CONFIRMED`, `IN_PREPARATION`, `READY`,
`CANCELLED` (sin `DELIVERED`: la entrega es Fase 5B) y cobertura separada. REPLAN explícito con
`planRevision`; calidad y merma invalidan reservas; lo comprometido no se transforma. Orden de
producción prellenada desde una necesidad. Pantallas Comercial → Pedidos y Planificación →
Necesidades. Ver [reports/FASE_5A_REPORTE.md](reports/FASE_5A_REPORTE.md). Quedan fuera:
consolidar varios pedidos en una producción (`PRODUCTION_CONSOLIDATION`), reserva física de materia
prima y planificación por capacidad. Señas y entrega/venta llegaron en Fase 5B.

## Fase 5B — Ventas + cobros + cuenta corriente + margen

**Completa — esperando gate humano.** Pedido → una o varias ventas (entrega parcial y total
consumiendo las reservas) y venta directa (FEFO sobre stock libre, Consumidor Final). Estado de la
venta (borrador / entregada / descartada) separado del estado de cobro. Costo por lote específico y
promedio de producto derivado (ADR-057). Listas de precios con prioridad y precio congelado al
confirmar el pedido; pedidos de 5A sin precio hasta acordarlo. Override de precio con permiso y
motivo. Margen sobre materiales con aviso de margen negativo. Cobros (de venta, al entregar, a
cuenta), señas aplicadas solas, imputación manual, cuenta corriente con ledger (Debe / Haber /
Saldo) y ajustes con motivo (política B). Límite de crédito sólo avisa. Orden global de locks
(ADR-062), idempotencia y rollback probados. Pantallas Comercial → Ventas y Listas de precios,
Finanzas → Cuentas a cobrar. Ver [reports/FASE_5B_REPORTE.md](reports/FASE_5B_REPORTE.md). Quedan
fuera: devoluciones y notas de crédito, reembolsos, facturación, caja. No se comienza UX/DESIGN
OPTIMIZATION sin aceptación humana.

## UX/DESIGN OPTIMIZATION (después de Fase 5B)

Sprint de diseño transversal, **no** se ejecuta durante las fases funcionales: durante cada fase se
corrigen los problemas evidentes y se registran en [UX_BACKLOG.md](UX_BACKLOG.md) los hallazgos que
piden una revisión de conjunto.

Objetivos: arquitectura de información, navegación, densidad de tablas, formularios, consistencia
visual, dashboard, jerarquía, estados vacíos, recorridos frecuentes, accesibilidad, tablet y un
diseño profesional de producto.

**Gate:** backlog revisado (cada hallazgo resuelto o descartado con motivo), revisión manual en
desktop y tablet, sin regresiones en E2E.

## Fase 6 — Proveedores + finanzas + caja

Cuentas a pagar, pagos, gastos, caja, cierres/resúmenes diarios. Reconciliación básica.

## Fase 7 — Facturación interna

`Invoice`, `TaxInvoiceProvider`, `InternalInvoiceProvider`. Sin integración fiscal externa salvo
orden explícita.

## Fase 8 — Dashboard y reportes

Dashboard útil y reportes MVP (ventas, compras, stock, movimientos, bajo mínimo, producción,
mermas, saldos, caja, costos) con filtros. Cada métrica trazable a datos reales.

## Fase 9 — Piloto

Dataset cercano a una panificadora real. Flujo completo proveedor → compra → stock → receta →
producción → producto → cliente → venta → cobro → caja → informe. Pruebas manuales naturales y
registro de problemas.
