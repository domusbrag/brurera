# Revisión integral del ERP (2026-11-11)

Pedido de maxi: revisar si el sistema es óptimo para la experiencia de usuario y para llevar el
control de la panificadora, y mejorar lo que haga falta. No es una fase nueva: se optimizó lo ya
construido (Fases 0 a 5B y el sprint de UX). Rama `revision-integral`, creada sobre
`ux-design-optimization` (PR #9, todavía sin mergear), para no pisar ese trabajo.

## Veredicto

**Base sólida, con huecos de control que se cerraron en esta revisión.**

Lo que ya estaba bien y no se tocó:

- Integridad de los números: stock, costos y cuenta corriente salen de libros append-only con saldos
  custodiados por triggers; el costo de una venta es el de los lotes que salieron; nada se borra y
  todo queda auditado.
- Operaciones a prueba de doble clic y concurrencia (idempotencia con `operationId`, orden global de
  locks, transacciones con rollback total).
- Experiencia: tras el sprint de UX cada pantalla dice qué sigue, los formularios tienen búsqueda,
  los diálogos muestran cómo queda todo antes de confirmar, y funciona en tablet.

Lo que no era óptimo para llevar el control (corregido):

| Problema                                                                                                                                        | Riesgo para el negocio                                     | Cambio                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Bajo mínimo" y "Necesidades → Materias primas" ignoraban lo ya pedido al proveedor                                                             | Comprar dos veces lo mismo; capital inmovilizado y mermas  | Columnas **En camino** (pedido y no recibido) y **Falta pedir** (faltante − en camino) en ambas pantallas                                                                                               |
| Para reponer había que crear una compra por materia prima, o ninguna desde Necesidades                                                          | Mucho trabajo manual; olvidos                              | **Armar compras**: un borrador por proveedor preferido con todas sus materias primas y la cantidad sugerida, redondeada hacia arriba a la presentación (bolsa, caja…). Nada se guarda sin revisión       |
| Recibir una compra eran dos llamadas (crear borrador + confirmar); si la segunda fallaba quedaba un borrador "Descartada" sin uso               | Registros basura en compras; confusión al auditar          | `POST /purchases/:id/receipts/posted`: crear y confirmar en **una transacción**. Si falla, no queda nada                                                                                                |
| Se podía cobrar una seña sobre un pedido en borrador (precio sólo cotizado)                                                                     | Plata atada a un pedido que puede no confirmarse nunca     | La seña exige pedido confirmado (`409 ORDER_NOT_CONFIRMED`); el botón no aparece en borrador                                                                                                            |
| No había un total de "cuánto me deben"                                                                                                          | No se ve la exposición total de la cuenta corriente        | Resumen en **Cuentas a cobrar**: te deben (total y clientes), venta sin cobrar más antigua, límites superados y crédito a favor (`GET /customer-accounts/summary`)                                      |
| Un cobro a cuenta se imputaba venta por venta                                                                                                   | Ventas que figuran impagas aunque el cliente ya pagó       | **Imputar a las ventas más viejas**: aplica todo el crédito sin imputar, la venta más antigua primero, con vista previa; atómico e idempotente (`POST /customers/:id/account/apply-oldest`)             |
| "Actividad reciente" de Inicio se llenaba de "Ingreso al sistema" y no decía qué registro cambió; la compra pedida decía "Pedido confirmado" | Lo importante quedaba tapado; confusión con pedidos de clientes | Inicio muestra sólo operaciones del negocio con el código del registro (VTA-0001, COM-0001…); la auditoría de compras dice "Compra pedida al proveedor"                                                  |
| Las notas de las métricas aparecían corridas a la derecha                                                                                       | Estético                                                   | Corregido en todas las métricas                                                                                                                                                                         |

## Archivos

- API: `purchases/on-order.ts` (en camino), `inventory.service.ts` y `planning.service.ts` (campos
  `onOrder` y `toOrder`), `receipts.service.ts` y `purchases.routes.ts` (recepción en un paso),
  `payments.service.ts` y `payments.routes.ts` (seña, resumen, imputación FIFO), `orders.data.ts`
  (acción de seña), `audit.routes.ts` (filtro `operational=1`).
- Shared: DTOs `LowStockItemDto`, `MaterialDemandDto` (`onOrder`, `toOrder`),
  `ReceivablesSummaryDto`, `applyOldestSchema`, etiqueta `PURCHASE_ORDERED`.
- Web: `purchases/buy-shortages.tsx` (nuevo), `purchase-form.tsx` (líneas precargadas con
  `items=`; recepción en un paso), `inventory-pages.tsx`, `planning-pages.tsx`,
  `account-pages.tsx`, `dashboard.tsx`, `globals.css`.
- Tests: `control-improvements.test.ts` (12 casos nuevos), matriz de autorización con los 3
  endpoints nuevos, E2E de smoke y Fase 3 ajustados a las etiquetas nuevas.

**Migraciones: ninguna. Permisos nuevos: ninguno** (los endpoints nuevos usan permisos existentes).

## Lo que queda (no se cambió)

Decisiones de maxi (cambian permisos o reglas):

1. Ventas depende de Depósito para marcar un pedido listo (`orders.ready`).
2. Producción ve costo y margen en Recetas; el costo de referencia se ve sin `inventory.cost.read`.
3. Planificación usa el stock de toda la empresa; la orden de producción, el del depósito de origen.

Pendientes chicos: aviso de cambios sin guardar en formularios largos; una receta inactiva con
borrador sólo se puede descartar.

Funcionalidad de fases futuras (se propone, no se construyó):

- Resumen diario "vendido / cobrado / margen" en Inicio y reportes con filtros → Fase 8.
- Cuentas a pagar a proveedores, caja y devolución de señas → Fase 6.
- Devoluciones de venta, elegir lote a mano (`LOT_PICKING_OVERRIDE`), precio pactado por línea del
  pedido (`ORDER_FORM_PRICE_OVERRIDE`) → deuda funcional de 5B.

## Cómo probarlo en Windows

Sin migraciones: alcanza con traer la rama, instalar y compilar. Si la rama todavía no está en
GitHub, se trae del paquete `revision-integral.bundle` (carpeta del proyecto
`bakery-erp/revision-integral/`), copiado por ejemplo a `C:\Users\maxi\Desktop`:

```powershell
cd C:\Users\maxi\Desktop\brurera\brurera
git fetch C:\Users\maxi\Desktop\revision-integral.bundle revision-integral:revision-integral
# (o, si ya está en GitHub: git fetch origin)
git checkout revision-integral
pnpm install
pnpm build
pnpm dev
```

La rama incluye el sprint de UX (PR #9): mergearla a main lleva también ese trabajo.

Recorrido sugerido: Stock → Bajo mínimo (ver "En camino" y "Armar compras"), crear una compra
desde ahí, confirmarla y volver a Bajo mínimo; registrar una recepción; en Cuentas a cobrar ver el
resumen y, en un cliente con un cobro a cuenta, usar "Imputar a las ventas más viejas".
