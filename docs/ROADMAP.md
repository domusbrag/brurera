# Roadmap

Cada fase tiene alcance explícito, criterios de aceptación, pruebas, documentación y un **gate
humano**: no se avanza a la siguiente sin revisión y aprobación.

Disciplina por fase: inspeccionar estado → plan breve → implementar → pruebas focales → corregir →
gates → revisión manual de UX → actualizar docs → resumen (CAMBIOS, ARCHIVOS, MIGRACIONES, TESTS,
RESULTADOS, RIESGOS, DEUDA, SIGUIENTE PASO) → detenerse.

| Fase | Nombre                        | Estado                        |
| ---- | ----------------------------- | ----------------------------- |
| 0    | Discovery + Foundation        | **Completa — esperando gate** |
| 1    | Maestros                      | Pendiente de aprobación       |
| 2    | Recetas + costo teórico       | Pendiente                     |
| 3    | Compras + inventario          | Pendiente                     |
| 4    | Producción                    | Pendiente                     |
| 5    | Ventas + clientes             | Pendiente                     |
| 6    | Proveedores + finanzas + caja | Pendiente                     |
| 7    | Facturación interna           | Pendiente                     |
| 8    | Dashboard y reportes          | Pendiente                     |
| 9    | Piloto                        | Pendiente                     |

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

## Fase 2 — Recetas + costo teórico

Recetas, versiones, ingredientes, rendimiento, costo calculado.
**Demostración:** crear producto A → receta v1 → ingredientes → calcular costo → crear v2 →
confirmar que v1 no cambió.

## Fase 3 — Compras + inventario

Compras, recepción, `StockMovement`, costo promedio ponderado móvil, stock, ajustes, alertas de
mínimo, mermas.
**E2E obligatoria:** stock harina 0 → compra 100 kg → confirmar → stock 100 → otra compra de
100 kg a otro precio → promedio ponderado correcto.

## Fase 4 — Producción

Órdenes de producción.
**E2E:** comprar materias primas → receta → orden → completar → verificar descuento exacto,
stock de producto, costo, versión de receta y auditoría. **Rollback:** provocar una falla dentro
de la transacción y verificar que no quedó stock parcialmente modificado.

## Fase 5 — Ventas + clientes

Ventas, precios, cliente, salida de stock, pagos, cuenta corriente.
**Prueba:** stock 100 → venta 20 → stock 80 → pago 50 % → saldo correcto → segundo pago → saldo 0.

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
