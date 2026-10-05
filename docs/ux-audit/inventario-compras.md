# Auditoría UX — Inventario, Lotes, Compras y Maestros de artículos

Alcance: rutas `stock/*`, `compras/*`, `materias-primas/*`, `productos/*` y componentes
`components/inventory/*`, `components/lots/*`, `components/purchases/*`, `components/masters/items.tsx`
(más las piezas compartidas que renderizan: `masters/master-list.tsx`, `masters/ui.tsx`, `lib/api-client.ts`).
Fecha: 2026-10-05. Sin cambios en el repo.

Abreviaturas de archivo (todas bajo `apps/web/src/`):

| Abrev.  | Archivo                                        |
| ------- | ---------------------------------------------- |
| `INV`   | `components/inventory/inventory-pages.tsx`     |
| `OP`    | `components/inventory/stock-operation.tsx`     |
| `PST`   | `components/inventory/product-stock-pages.tsx` |
| `PRES`  | `components/inventory/presentations.tsx`       |
| `LOT`   | `components/lots/lot-pages.tsx`                |
| `LSH`   | `components/lots/lot-shared.tsx`               |
| `CONS`  | `components/lots/conservation.tsx`             |
| `PP`    | `components/purchases/purchase-pages.tsx`      |
| `PF`    | `components/purchases/purchase-form.tsx`       |
| `ITEMS` | `components/masters/items.tsx`                 |
| `ML`    | `components/masters/master-list.tsx`           |
| `UI`    | `components/masters/ui.tsx`                    |
| `API`   | `lib/api-client.ts`                            |
| `CSS`   | `app/globals.css`                              |

Notas de contexto que afectan a todas las rutas:

- **Las páginas no comprueban permisos.** `app/(app)/layout.tsx` sólo exige sesión; las rutas
  `page.tsx` montan el componente sin guardia. El permiso sólo oculta el botón que lleva a la ruta,
  pero la URL directa (o un enlace de otra pantalla) abre el formulario completo y el 403 aparece
  recién al enviar ("No tenés permiso para esta operación.", `API:20`).
- **`fetchOptions` trae como máximo 100 registros** (`API:89-96`, `pageSize: 100`, y el máximo del
  esquema es 100, `packages/shared/src/pagination.ts:7`). Todos los `<select>` de materias primas,
  proveedores, depósitos y unidades se truncan en silencio a partir del registro 101 y no tienen
  búsqueda.
- **No hay estilo global para `<a>`**: `CSS` sólo estiliza `.table a` (388), `.breadcrumb a` (316) y
  `.details a` (530). Los enlaces dentro de `.panel__header`, `.notice`, `.muted`, `.form__hint`,
  `.panel--empty` y `.cost-summary` salen con el azul/violeta de visitado del navegador.
- **`ConfirmAction` genera ids inválidos**: `id={`${label}-title`}` y `aria-labelledby` con el mismo
  valor (`UI:170-171`). Con etiquetas con espacio ("Confirmar pedido", "Cancelar compra", "Cambiar
  costo") el `aria-labelledby` se interpreta como dos IDREF ("Confirmar", "pedido-title") y el diálogo
  queda sin nombre accesible. En tablas (presentaciones: "Renombrar", "Desactivar" por fila) los ids
  se duplican.

---

## 1. Inventario — materias primas

### `/stock`

- **Ruta:** `/stock` → `StockList` (`INV:117-196`).
- **Módulo:** Inventario › Materias primas.
- **Roles que la usan:** `inventory.read` → ADMIN, OWNER, ADMINISTRATION, PURCHASING, PRODUCTION, WAREHOUSE. Columnas de costo sólo con `inventory.cost.read` (ADMIN, OWNER, ADMINISTRATION, PURCHASING). Botones: Ajustar/Registrar merma → WAREHOUSE (+ADMIN/OWNER); Cargar stock inicial → ADMINISTRATION (+ADMIN/OWNER).
- **Objetivo principal:** saber cuánto hay de cada insumo, qué está bajo mínimo y cuánto vale el inventario.
- **Acciones primarias / secundarias:** no hay acción primaria marcada. Cabecera: pestañas (5) + "Ajustar stock", "Registrar merma", "Cargar stock inicial" (`INV:88-102`): **3 botones con el mismo peso visual** (`className="button"`). Por fila: enlace al nombre. Filtros: búsqueda, estado, depósito.
- **Información crítica:** stock actual (negrita), mínimo, estado (badge), costo promedio y valor (con permiso).
- **Frecuencia esperada:** diaria (depósito y compras), varias veces al día en temporada.
- **Problemas encontrados:**
  - Columna "Depósito" muestra "Todos" cuando no hay filtro (`INV:163`): parece un depósito llamado "Todos".
  - "Costo promedio" usa `formatReferenceCost` (hasta 6 decimales sin redondear, `INV:183`) mientras compras usa `formatUnitCost` (2 decimales) para el mismo concepto (`PP:278-282`): "$850,125 / kg" vs "$850,13 / kg".
  - Para PRODUCTION/WAREHOUSE desaparecen dos columnas sin indicación (`INV:178-192`); no es un "—" pero el usuario no sabe que existe valorización.
  - "Stock mínimo" muestra "—" cuando es 0 (`INV:174`), igual que un dato faltante; en el detalle se dice "Sin mínimo" (`INV:496`).
  - Filtro de depósito sin búsqueda y truncado a 100 (`INV:107-115`); aceptable porque son pocos.
  - Estado vacío genérico "No hay materias primas para mostrar." (`INV:130`) sin enlace a crear materia prima ni a cargar stock inicial.
  - "Mínimo" y "Faltante" ocultos en tablet (`hide-sm`) sin forma de verlos (backlog TABLES F3).
  - Carga: texto "Cargando…" que reemplaza toda la tabla (`ML:196`, `UI:90-96`); sin skeleton, el layout salta.
  - Búsqueda con `router.replace` diferido 300 ms (`ML:103-108`): si se navega antes, vuelve al listado (backlog F4.5).
- **Redundancias:** misma información de costos que `/materias-primas` (columna "Costo usado"); pestaña "Bajo mínimo" duplica el filtro de estado "Bajo mínimo o sin stock" (`INV:135`).
- **Deuda UX ya registrada:** NAVIGATION F3 (pestañas propias), F3 (acciones en cabecera), F4/F4.5 (5 pestañas), TABLES F3 (`hide-sm`), TABLES F4.5 (búsqueda 300 ms), DASHBOARD F3 (alertas bajo mínimo).
- **Prioridad:** P1.

### `/stock/[id]`

- **Ruta:** `/stock/[id]` → `StockDetail` (`INV:440-612`).
- **Módulo:** Inventario › Materias primas › Ficha de stock.
- **Roles que la usan:** `inventory.read` (los 6 roles de arriba). Costos promedio/valor e historial con `inventory.cost.read`. "Nueva compra" con `purchases.create` (PURCHASING). Presentaciones con `presentations.read` (ADMIN, OWNER, ADMINISTRATION, PURCHASING, WAREHOUSE).
- **Objetivo principal:** ver existencias por depósito, costo vigente, última compra y movimientos de un insumo, y operar sobre él.
- **Acciones primarias / secundarias:** primaria "Nueva compra" (`button--primary`, `INV:469-479`). Secundarias con el mismo peso: Ajustar stock, Registrar merma, Cargar stock inicial (`INV:468`). "Nueva presentación", "Renombrar", "Desactivar/Reactivar" por presentación (`PRES:43-47, 101-119`). Enlace "Ver todos" movimientos (`INV:678`). Hasta **4 botones en cabecera + 3 por fila de presentación**.
- **Información crítica:** stock total y por depósito, mínimo, faltante, costo promedio, costo de referencia, costo usado por recetas, valor, última compra.
- **Frecuencia esperada:** diaria/semanal (consulta antes de comprar o al recibir).
- **Problemas encontrados:**
  - Página larga: 6 paneles (Existencias, Costos, Presentaciones, Movimientos, Historial de costo + cabecera) (`INV:484-609`).
  - **Costos parcialmente visibles sin permiso**: sin `inventory.cost.read` se oculta promedio y valor, pero se muestran "Costo de referencia manual" y "Costo usado por recetas" (`INV:549-575`) — y el costo usado ES el promedio cuando su origen es compras. Agujero de permiso de presentación.
  - "Última compra" enlaza a `/compras/{id}` sin chequear `purchases.read` (`INV:589`): PRODUCTION abre una página que da 403.
  - En la tabla de movimientos, `ReferenceLink` enlaza a `/compras/...` y `/produccion/...` sin chequear permiso (`INV:223-229`), y el lote a `/stock/lotes/...` (`INV:280`) aunque PURCHASING no tenga `product_lots.read`.
  - "Ver todos" (`INV:678`) está en `.panel__header` → estilo de enlace por defecto del navegador (backlog TABLES F4, confirmado).
  - Origen del costo mezcla etiqueta hardcodeada "compras (promedio ponderado)" con `COST_SOURCE_LABELS` en minúscula (`INV:567-571`).
  - Errores de submódulos se muestran como `error.message` en gris (`INV:681`, `INV:731`) sin reintento.
  - `metadata.title` fijo "Stock de materia prima · Inventario" (`app/(app)/stock/[id]/page.tsx:5`): todas las pestañas del navegador se llaman igual.
  - Presentaciones: diálogos con ids duplicados por fila (`UI:170`, usado en `PRES:102-119, 142`).
- **Redundancias:** panel "Presentaciones de compra" idéntico al de `/materias-primas/[id]` (`ITEMS:378`); costos de referencia/usado repetidos en ambas fichas.
- **Deuda UX ya registrada:** INFORMATION_ARCHITECTURE F3 (ficha MP vs ficha stock), VISUAL_HIERARCHY F3 (tres costos), F2/F3 (`cost-summary`), TABLES F4 ("Ver todos" con color por defecto), NAVIGATION F3 (acciones en cabecera).
- **Prioridad:** P1.

### `/stock/ajuste`

- **Ruta:** `/stock/ajuste` → `StockOperationForm kind="adjust"` (`OP:69-441`).
- **Módulo:** Inventario › Operaciones.
- **Roles que la usan:** `inventory.adjust` → ADMIN, OWNER, WAREHOUSE.
- **Objetivo principal:** corregir el stock tras un recuento físico o un error, dejando motivo.
- **Acciones primarias / secundarias:** paso 1: "Revisar" (primaria) y "Cancelar" (enlace con estilo de botón) (`OP:381-389`). Paso 2: "Confirmar ajuste" (primaria) y "Volver a editar" (`OP:419-435`).
- **Información crítica:** stock antes / movimiento / stock después en el depósito elegido (`OP:196-215`), costo de valorización en entradas.
- **Frecuencia esperada:** semanal (recuentos) u ocasional.
- **Problemas encontrados:**
  - **`datetime-local` en la zona del navegador** (`OP:356-364`, `localNow` en `OP:63-67`, envío con `new Date(occurredAt).toISOString()` en `OP:169`). Con navegador en otra zona, el movimiento queda en otra hora; `max` también en hora del navegador.
  - `<select>` de materia prima sin búsqueda y truncado a 100 (`OP:99-103`, `OP:246-260`).
  - El depósito se elige solo con el primero de la lista (`OP:109`) sin avisarlo.
  - "Revisar" deshabilitado sin decir qué falta (`OP:381`); el motivo no tiene marca de obligatorio (`OP:340`).
  - "Tipo de ajuste" con valor por defecto "Salida" (`OP:88`): un recuento que da de más exige cambiarlo; elección que define el signo escondida en un select.
  - El asterisco de costo obligatorio es texto plano en la etiqueta (`OP:309`), sin `aria-required`.
  - Sin la página protegida por permiso: un usuario sin `inventory.adjust` llena el formulario y recibe 403 al confirmar.
  - Errores: mapea `INSUFFICIENT_STOCK` y `VALUATION_COST_REQUIRED`; el resto cae en `err.message` o une todos los `fieldErrors` con ". " (`OP:181-189`), p. ej. "Referencia inválida" (texto genérico de `packages/shared/src/validation.ts:35`).
  - Signo negativo con "−" (U+2212) en el impacto (`OP:205`) y "-" en movimientos (`INV:208-213`).
- **Redundancias:** misma pantalla para ajuste/merma/inicial con textos distintos; está bien, pero se llega desde 2 cabeceras distintas.
- **Deuda UX ya registrada:** FORMS F5A (`datetime-local` en `stock-operation.tsx`), FORMS F3 (formato numérico en vivo), NAVIGATION F3 (acciones en cabecera).
- **Prioridad:** P1 (fecha en zona incorrecta = dato contable incorrecto).

### `/stock/merma`

- **Ruta:** `/stock/merma` → `StockOperationForm kind="waste"`.
- **Módulo:** Inventario › Operaciones.
- **Roles que la usan:** `inventory.waste` → ADMIN, OWNER, WAREHOUSE.
- **Objetivo principal:** registrar insumo perdido (vencido, roto) que sale al costo promedio.
- **Acciones primarias / secundarias:** "Revisar" / "Cancelar"; luego "Confirmar merma" (`button--danger`, `OP:422`) / "Volver a editar".
- **Información crítica:** impacto en el depósito y valor de la merma (`OP:407-412`).
- **Frecuencia esperada:** semanal / diaria en insumos perecederos.
- **Problemas encontrados:** los mismos de `/stock/ajuste` (datetime-local `OP:356-364`, select sin búsqueda `OP:246`, depósito por defecto `OP:109`, "Revisar" mudo `OP:381`). El valor de la merma sólo aparece en el paso de revisión y sólo si hay costo promedio; no depende de `inventory.cost.read` (WAREHOUSE ve el valor `OP:407-412` aunque en `/stock` no ve costos).
- **Redundancias:** ver ajuste.
- **Deuda UX ya registrada:** FORMS F5A.
- **Prioridad:** P1.

### `/stock/inicial`

- **Ruta:** `/stock/inicial` → `StockOperationForm kind="initial"`.
- **Módulo:** Inventario › Operaciones (puesta en marcha).
- **Roles que la usan:** `inventory.initial_stock` → ADMIN, OWNER, ADMINISTRATION.
- **Objetivo principal:** cargar las existencias valorizadas con que arranca el sistema.
- **Acciones primarias / secundarias:** "Revisar" / "Cancelar"; "Confirmar stock inicial" / "Volver a editar".
- **Información crítica:** cantidad, costo unitario obligatorio, valor total.
- **Frecuencia esperada:** una vez por insumo y depósito (alta del sistema); luego nunca.
- **Problemas encontrados:** carga de a una materia prima por vez (no hay carga masiva) para una tarea de arranque con decenas de insumos; mismos problemas de fecha (`OP:356-364`) y select (`OP:246-260`). El botón "Cargar stock inicial" sigue en la cabecera de `/stock` y de cada ficha para siempre (`INV:98-102`), con el mismo peso que operaciones diarias.
- **Redundancias:** —
- **Deuda UX ya registrada:** NAVIGATION F3 (acciones en cabecera), FORMS F5A.
- **Prioridad:** P2.

### `/stock/movimientos`

- **Ruta:** `/stock/movimientos` → `MovementList` (`INV:319-371`).
- **Módulo:** Inventario › Movimientos.
- **Roles que la usan:** `inventory.read` (6 roles); columna de costo unitario con `inventory.cost.read`.
- **Objetivo principal:** auditar qué entró y salió, quién y por qué.
- **Acciones primarias / secundarias:** ninguna acción; filtros (búsqueda, tipo, artículo, depósito, desde, hasta) y enlaces por fila (artículo, lote, origen).
- **Información crítica:** fecha, artículo, tipo, cantidad con signo, saldo, origen/motivo, usuario.
- **Frecuencia esperada:** semanal / ante diferencias.
- **Problemas encontrados:**
  - 9 columnas (`INV:255-316`); en tablet se ocultan depósito, saldo, costo y usuario.
  - Enlaces de origen (`/compras`, `/produccion`) y de lote sin chequeo de permiso (`INV:223-229`, `INV:280`) → 403 para PRODUCTION/WAREHOUSE/PURCHASING según el caso.
  - Filtros de fecha `type="date"` en formato del navegador (`ML:181-189`).
  - Motivo desconocido cae al código crudo (`INV:203-204`: `?? m.reason`).
  - Sin filtro por referencia (compra, producción) aunque la API lo admite (backlog).
  - Estado vacío "Todavía no hay movimientos." (`INV:330`) idéntico con o sin filtros (sólo la búsqueda cambia el texto, `ML:198`).
- **Redundancias:** "Movimientos" también como panel en ficha de MP, de producto y de lote.
- **Deuda UX ya registrada:** TABLES F3 (filtros de fecha/referencia; rango común), FORMS F4 (`type=date`).
- **Prioridad:** P2.

### `/stock/bajo-minimo`

- **Ruta:** `/stock/bajo-minimo` → `LowStockList` (`INV:373-436`).
- **Módulo:** Inventario › Bajo mínimo.
- **Roles que la usan:** `inventory.read`; "Crear compra" con `purchases.create` (PURCHASING, ADMIN, OWNER).
- **Objetivo principal:** decidir qué reponer.
- **Acciones primarias / secundarias:** por fila "Crear compra" (`button--small`, `INV:419-428`) — **una por insumo**; ninguna acción global.
- **Información crítica:** stock, mínimo, faltante (negrita), proveedor preferido.
- **Frecuencia esperada:** diaria/semanal (compras).
- **Problemas encontrados:** comprar 5 insumos del mismo proveedor exige 5 compras (cada "Crear compra" abre `/compras/nueva` con una sola línea, `PF:191`); la columna "Proveedor preferido" se oculta en tablet (`INV:413`); no muestra compras ya pedidas pendientes de recibir (riesgo de duplicar pedidos); sin filtro de depósito ni proveedor; estado vacío positivo ok (`INV:382`).
- **Redundancias:** filtro "Bajo mínimo o sin stock" en `/stock`.
- **Deuda UX ya registrada:** WORKFLOW F3 (agrupar por proveedor), DASHBOARD F3.
- **Prioridad:** P1.

## 2. Inventario — productos terminados y lotes

### `/stock/productos`

- **Ruta:** `/stock/productos` → `ProductStockList` (`PST:42-168`).
- **Módulo:** Inventario › Productos terminados.
- **Roles que la usan:** `inventory.read` → ADMIN, OWNER, ADMINISTRATION, PURCHASING, PRODUCTION, WAREHOUSE. Costos con `inventory.cost.read`.
- **Objetivo principal:** ver cuánto producto hay, cuánto se puede vender ya, cuánto está reservado y por vencer.
- **Acciones primarias / secundarias:** ninguna; enlaces a producto y a última producción.
- **Información crítica:** físico, por conservación, utilizable, comprometido, disponible, próximo a vencer, costo, valor.
- **Frecuencia esperada:** diaria, varias veces (mostrador, producción, depósito).
- **Problemas encontrados:**
  - **Hasta 13 columnas** con costos (`PST:75-165`): Producto, Depósito, Físico, Fresco, Refrigerado, Congelado, Utilizable, Comprometido, Disponible, Próximo a vencer, Costo, Valor, Última producción.
  - **Falta "Descongelado"**: sólo se listan FRESH/REFRIGERATED/FROZEN (`PST:95`); lo descongelado no aparece en ninguna columna de estado.
  - **Bloqueado y vencido no se muestran** aunque el DTO los trae (`packages/shared/src/inventory.ts` `ProductLotSummaryDto.blocked/expired`): "Físico" ≠ suma visible y no se explica.
  - "Comprometido" oculto en tablet (`PST:114`): en el dispositivo del depósito no se ve lo reservado.
  - "Próximo a vencer" usa badge amarillo (`PST:129`), el detalle usa texto rojo (`PST:231`).
  - "Físico" / "Utilizable ahora" / "Disponible ahora" sin ayuda contextual que explique la diferencia (sólo en el subtítulo genérico, `PST:51`).
  - Enlace "Última producción" a `/produccion/...` sin chequear `production_orders.read` (`PST:155`) → 403 para WAREHOUSE/PURCHASING.
  - Estado vacío "No hay productos que controlen stock." (`PST:55`) también se muestra si el filtro "Sólo con stock" no devuelve nada (mensaje incorrecto).
  - Subtítulo dice "salen por merma" (`PST:51`): desde Fase 5B también salen por venta.
- **Redundancias:** "Próximo a vencer" duplica la pestaña homónima; "Utilizable" vs "Disponible" sin jerarquía.
- **Deuda UX ya registrada:** TABLES F4.5 (9 columnas, mini gráfico), NAVIGATION F4/F4.5, VISUAL_HIERARCHY F4.5.
- **Prioridad:** P0 (es la pantalla que responde "qué puedo vender" y oculta bloqueado/vencido/descongelado/comprometido en tablet).

### `/stock/productos/[id]`

- **Ruta:** `/stock/productos/[id]` → `ProductStockDetail` (`PST:170-405`) + `ProductLotsPanel`, `AvailabilityAtDate` (`LOT:109-356`).
- **Módulo:** Inventario › Productos terminados › Ficha.
- **Roles que la usan:** `inventory.read`; lotes y disponibilidad con `product_lots.read` (ADMIN, OWNER, ADMINISTRATION, PRODUCTION, WAREHOUSE — **PURCHASING no ve lotes**); "Nueva orden de producción" con `production_orders.create` (PRODUCTION); acciones de lote según `product_lots.transform/waste`.
- **Objetivo principal:** entender el stock de un producto por lote, cuánto habrá utilizable en una fecha, y operar lotes.
- **Acciones primarias / secundarias:** primaria "Nueva orden de producción" (`PST:194-201`). Secundarias: enlaces "Ver próximos a vencer" (`PST:208`), "Ver todas" (`PST:352`), "Ver todos" movimientos, checkbox "Mostrar agotados" (`LOT:125-135`), por lote: "Congelar" / "Descongelar" / "Merma" como enlaces de texto con el mismo peso (`LOT:83-105`) — la merma (destructiva) no se distingue.
- **Información crítica:** físico, utilizable, comprometido, disponible, próximo a vencer, vencido, bloqueado, lotes FEFO, disponibilidad a fecha.
- **Frecuencia esperada:** diaria (producción y depósito).
- **Problemas encontrados:**
  - Página muy larga: 7 paneles (Existencias, Lotes, Disponibilidad, Precio y margen, Producciones, Movimientos, Historial de costo) (`PST:205-402`).
  - Vencido y bloqueado aparecen sólo como texto chico gris al pie (`PST:252-260`), no como métricas.
  - La tabla de lotes no muestra lo comprometido por lote (el DTO `ProductLotDto` no lo trae), hay que entrar a cada lote.
  - Precio de venta con `formatReferenceCost` ("$1.500 / u", hasta 6 decimales, `PST:301`) mientras `/productos` usa `formatMoney` ("$1.500,00", `ITEMS:468`); margen idem (`PST:311` vs `ITEMS:670`).
  - El precio de venta se muestra a PRODUCTION/WAREHOUSE (`PST:301`), que no tienen `price_lists.read`.
  - Enlaces "Ver próximos a vencer", "Ver todas", "Ver todos" en `.panel__header` → estilo por defecto del navegador (`PST:208, 352`; `INV:678`).
  - Enlaces a `/produccion/...` en "Última producción" del listado y en historial de costo sin chequeo (`PST:452`).
  - `ProductLotsPanel` y `AvailabilityAtDate` devuelven `null` sin permiso (`LOT:119, 233`): PURCHASING ve "Utilizable/Comprometido" pero no puede saber de qué lotes.
  - "Orden de uso" muestra "—" para no elegibles (`LOT:328`).
  - Tabla de disponibilidad sin estado vacío explícito (`LOT:306`).
- **Redundancias:** "Precio y margen" + "Receta activa" duplican `/productos/[id]` (costo teórico); conservación se configura en Maestros y se consulta acá.
- **Deuda UX ya registrada:** INFORMATION_ARCHITECTURE F4 (ficha de producto vs stock) y F4.5 (ficha larga → pestañas; acceso directo a conservación), VISUAL_HIERARCHY F4.5 (dos badges de lote), FORMS F4.5 (`datetime-local`, corregido con `WallClockInput`), TABLES F4 (enlaces "Ver todas").
- **Prioridad:** P1.

### `/stock/productos/por-vencer`

- **Ruta:** `/stock/productos/por-vencer` → `ExpiringList` (`LOT:996-1071`).
- **Módulo:** Inventario › Próximos a vencer.
- **Roles que la usan:** `inventory.expiry.read` → ADMIN, OWNER, ADMINISTRATION, PRODUCTION, WAREHOUSE. Acciones de fila con `product_lots.transform` (PRODUCTION, WAREHOUSE) y `product_lots.waste` (WAREHOUSE).
- **Objetivo principal:** decidir cada día qué usar primero, congelar o descartar.
- **Acciones primarias / secundarias:** por fila "Congelar" / "Descongelar" / "Merma" como enlaces de texto equivalentes (`LOT:1067`, `LOT:93-103`).
- **Información crítica:** lote, producto, conservación, cantidad, utilizable hasta + tiempo restante, estado.
- **Frecuencia esperada:** diaria (apertura y cierre).
- **Problemas encontrados:**
  - El producto aparece como subtexto gris bajo el código del lote (`LOT:1040-1045`): se busca por producto, pero se lee primero un código.
  - No muestra lo comprometido por lote (no se sabe si lo que vence ya está reservado para un pedido).
  - No incluye lotes bloqueados (filtro sólo vencidos/próximos, `LOT:1008-1012`).
  - Sin totales por producto.
  - La ruta no se protege: sin `inventory.expiry.read` la pestaña se oculta (`INV:60-62`) pero la URL directa muestra `ErrorState` "No se pudo cargar" + mensaje de 403 (`UI:98-105`).
  - "Utilizable hasta" "—" cuando no hay vencimiento (`LOT:1060`), pero en ficha dice "Sin vencimiento" (`LOT:181`).
  - Fechas `formatDateTime` con `dateStyle: "short"` → año de 2 dígitos ("05/10/26"), distinto de `formatDate` (4 dígitos) usado en compras (`lib/format.ts:85-91` vs `77-82`).
- **Redundancias:** columna "Próximo a vencer" en `/stock/productos`.
- **Deuda UX ya registrada:** WORKFLOW F4.5 ("Registrar merma" directo en la fila: **ya resuelto**, existe el enlace "Merma"), WORKFLOW F4.5 (congelado masivo), DASHBOARD F4.5, NAVIGATION F4.5.
- **Prioridad:** P1.

### `/stock/lotes/[id]`

- **Ruta:** `/stock/lotes/[id]` → `LotDetail` (`LOT:403-683`).
- **Módulo:** Inventario › Lote.
- **Roles que la usan:** `product_lots.read` → ADMIN, OWNER, ADMINISTRATION, PRODUCTION, WAREHOUSE. Congelar/Descongelar `product_lots.transform`; Merma `product_lots.waste`; Bloquear/Desbloquear `product_lots.quality` (WAREHOUSE).
- **Objetivo principal:** ver estado, vencimiento, reservas y trazabilidad de un lote, y operarlo.
- **Acciones primarias / secundarias:** cabecera con hasta **4 botones**: "Congelar", "Descongelar", "Registrar merma" (los 3 `button` sin jerarquía, `LOT:434-448`) y "Bloquear" (`button--danger` vía `ConfirmAction`, `LOT:452-478`) o "Desbloquear" (`LOT:480-489`). Ninguna primaria.
- **Información crítica:** cantidad, comprometido, libre, utilizable hasta, estado de calidad, reservas por pedido, valor.
- **Frecuencia esperada:** varias veces por semana.
- **Problemas encontrados:**
  - Bloquear pide "Motivo" en un `<input>` sin marca de obligatorio ni validación previa (`LOT:470-477`); si la API lo rechaza el error aparece dentro del diálogo vía `err.message`.
  - "Registrar merma" (destructiva) con el mismo estilo que "Congelar".
  - Tabla "Movimientos del lote" sin estado vacío ni paginación (`LOT:635-661`).
  - Historial muestra el código de acción crudo si falta etiqueta (`LOT:670`: `?? a.action`).
  - Alertas de bloqueado y vencido usan `.alert` con `role="status"` (`LOT:495-505`); vencido no muestra botón directo para la merma (está en la cabecera).
  - Título combina dos badges (conservación + estado) (`LOT:423-424`).
  - Motivo de no-transformación se muestra concatenado como un párrafo gris (`LOT:582-589`).
  - `metadata.title` "Lote · Inventario" sin código de lote (`app/(app)/stock/lotes/[id]/page.tsx:5`).
- **Redundancias:** movimientos también en ficha de producto y en Movimientos global.
- **Deuda UX ya registrada:** VISUAL_HIERARCHY F4.5 (dos badges), ACCESSIBILITY F3 (foco de `ConfirmAction`).
- **Prioridad:** P2.

### `/stock/lotes/[id]/congelar`

- **Ruta:** `/stock/lotes/[id]/congelar` → `LotOperationForm kind="freeze"` (`LOT:695-992`).
- **Módulo:** Inventario › Lote › Operación.
- **Roles que la usan:** `product_lots.transform` → ADMIN, OWNER, PRODUCTION, WAREHOUSE.
- **Objetivo principal:** pasar parte o todo un lote a congelado (crea lote hijo con nuevo vencimiento).
- **Acciones primarias / secundarias:** "Usar todo" (link-button, `LOT:898-904`), "Revisar" / "Cancelar"; luego "Confirmar congelado" / "Volver a editar".
- **Información crítica:** libre vs reservado, lote antes/después, lote nuevo y su vencimiento (`LOT:784-825`).
- **Frecuencia esperada:** diaria al cierre (panadería: congelar sobrante).
- **Problemas encontrados:** un lote por vez (cierre del día = N formularios × 3 clics); "Revisar" deshabilitado sin explicar (`LOT:939`); el resumen usa `−` aunque congelar no es pérdida (`LOT:792`, mismo rojo que una merma); si la operación está bloqueada se muestra un panel con mensaje y "Volver al lote" (`LOT:844-852`) en lugar de no ofrecer la ruta; la ruta no se protege por permiso.
- **Redundancias:** —
- **Deuda UX ya registrada:** WORKFLOW F4.5 (congelado masivo).
- **Prioridad:** P2.

### `/stock/lotes/[id]/descongelar`

- **Ruta:** `/stock/lotes/[id]/descongelar` → `LotOperationForm kind="thaw"`.
- **Módulo:** Inventario › Lote › Operación.
- **Roles que la usan:** `product_lots.transform` → ADMIN, OWNER, PRODUCTION, WAREHOUSE.
- **Objetivo principal:** sacar del freezer la cantidad que se va a vender/usar.
- **Acciones primarias / secundarias:** igual que congelar; "Confirmar descongelado" primaria.
- **Información crítica:** vida útil tras descongelar, advertencia de irreversibilidad (`LOT:863-868`, `LOT:964-968`).
- **Frecuencia esperada:** diaria.
- **Problemas encontrados:** buena advertencia irreversible (`alert--warn`) pero el botón final es `button--primary`, no de riesgo (`LOT:973`); mismos puntos de "Revisar" mudo y un lote por vez; el vencimiento se calcula desde `openedAt` (momento de abrir el form, `LOT:709`) — si el usuario tarda, el resumen difiere del real.
- **Redundancias:** —
- **Deuda UX ya registrada:** —
- **Prioridad:** P2.

### `/stock/lotes/[id]/merma`

- **Ruta:** `/stock/lotes/[id]/merma` → `LotOperationForm kind="waste"`.
- **Módulo:** Inventario › Lote › Operación.
- **Roles que la usan:** `product_lots.waste` → ADMIN, OWNER, WAREHOUSE.
- **Objetivo principal:** descartar producto vencido/dañado de un lote.
- **Acciones primarias / secundarias:** "Usar todo", "Revisar" / "Cancelar"; "Confirmar merma" (`button--danger`) / "Volver a editar".
- **Información crítica:** cantidad, motivo (precargado "Vencido" si el lote venció, `LOT:711-713`), reservas afectadas (`LOT:815-823`), valor (con costos).
- **Frecuencia esperada:** diaria.
- **Problemas encontrados:** el aviso "La merma toca stock reservado" sólo aparece si la cantidad supera lo libre y está en el bloque de resumen (`LOT:738-739, 815-823`), no junto al campo; el motivo sin marca de obligatorio (`LOT:909`); "Usar todo" usa el total incluyendo reservado (`available = lot.quantity` para merma, `LOT:734`) sin advertir antes de escribir.
- **Redundancias:** `/stock/merma` es para materias primas con un formulario casi igual pero distinto (selector de artículo + depósito); el usuario debe saber cuál usar.
- **Deuda UX ya registrada:** WORKFLOW F4.5 (merma desde por vencer — resuelto).
- **Prioridad:** P2.

## 3. Compras

### `/compras`

- **Ruta:** `/compras` → `PurchaseList` (`PP:83-142`).
- **Módulo:** Operaciones › Compras.
- **Roles que la usan:** `purchases.read` → ADMIN, OWNER, ADMINISTRATION, PURCHASING, WAREHOUSE. "Nueva compra" con `purchases.create` (PURCHASING).
- **Objetivo principal:** seguir los pedidos a proveedores y qué falta recibir.
- **Acciones primarias / secundarias:** primaria "Nueva compra" (`PP:98-100`); filtros búsqueda, estado (incluye "Pendientes de recibir"), proveedor.
- **Información crítica:** número, proveedor, fecha, estado, total, recibido, pendiente.
- **Frecuencia esperada:** diaria (compras y depósito).
- **Problemas encontrados:**
  - **WAREHOUSE no tiene `suppliers.read`**: el filtro de proveedor queda vacío en silencio (`PP:86-90`, `catch → []`).
  - Filtro de proveedor sin búsqueda y truncado a 100 (`PP:87`).
  - Proveedor por `legalName` en filtro (`PP:88`) y `supplier.name` en columna (`PP:125`), `tradeName ?? legalName` en el maestro (`ITEMS:149`): nombres distintos para el mismo proveedor.
  - Falta "Fecha esperada" (lo que el depósito necesita para saber qué llega hoy); "Fecha" se oculta en tablet (`PP:126`).
  - "Recibido" y "Pendiente" en dinero (`PP:129-138`), no en mercadería.
  - Número con clase `code` (monoespaciado) (`PP:120`).
  - Estado vacío "Todavía no hay compras cargadas." (`PP:101`) aparece también al filtrar por estado sin resultados.
- **Redundancias:** —
- **Deuda UX ya registrada:** INFORMATION_ARCHITECTURE F3 (sin listado global de recepciones), DASHBOARD F3 (compras pendientes), NAVIGATION F5A (Proveedores con Compras).
- **Prioridad:** P1.

### `/compras/nueva`

- **Ruta:** `/compras/nueva` → `PurchaseForm` (`PF:129-684`).
- **Módulo:** Compras › Alta.
- **Roles que la usan:** `purchases.create` → ADMIN, OWNER, PURCHASING; "Guardar y confirmar pedido" requiere además `purchases.order`.
- **Objetivo principal:** cargar un pedido a proveedor con sus líneas y precios.
- **Acciones primarias / secundarias:** "Guardar y confirmar pedido" (primaria, `PF:663-672`), "Guardar borrador" (botón submit secundario, `PF:660`), "Cancelar" (`PF:673-678`), "Agregar materia prima" (`PF:597-603`), "✕" quitar línea por fila (`PF:573-588`). **3 botones al pie con el mismo tamaño**; el submit del formulario (Enter) es "Guardar borrador", no la primaria.
- **Información crítica:** proveedor, fecha, líneas (materia prima, presentación, cantidad, precio, descuento, neto), equivalencia en unidad base y costo de adquisición, totales.
- **Frecuencia esperada:** varias por semana (PURCHASING).
- **Problemas encontrados:**
  - **Duplicación de compras**: "Guardar y confirmar pedido" hace POST + POST `/order` (`PF:323-326`); si el segundo falla, el borrador ya existe pero el formulario sigue en modo alta (`existing === null`) y un nuevo clic crea **otra** compra.
  - "Guardar y confirmar pedido" no pide confirmación, mientras que "Confirmar pedido" desde el detalle sí abre diálogo (`PP:183-192`): mismo efecto, dos fricciones distintas.
  - `<select>` de proveedor (`PF:382-394`) y de materia prima por línea (`PF:476-492`) sin búsqueda y truncados a 100 (`PF:93-96`).
  - Editor de líneas = tabla ancha de 7 columnas con inputs nativos (`PF:442-594`).
  - Botón "✕" sin texto visible (tiene `aria-label`, `PF:576`) y sin confirmación ni deshacer; si queda una sola línea la vacía (`PF:581-583`).
  - Presentación "—" como opción vacía (`PF:515`); la presentación se autoselecciona en render (`PF:231-237`) sin indicarlo.
  - Fecha `type="date"` en formato del navegador (`PF:406-412`); `today()` usa la fecha del navegador, no la de la empresa (`PF:78-82`).
  - Errores de validación: proveedor vacío → "Referencia inválida" (`packages/shared/src/validation.ts:35`, `purchases.ts:119`); precio vacío → "Número inválido (máximo 6 decimales)" (`validation.ts:56`); textos técnicos para "elegí un proveedor" / "falta el precio".
  - No hay validación previa en el cliente: todo se descubre al guardar (`PF:300-350`).
  - Asterisco de obligatorio `aria-hidden` sin `aria-required` en el control (`PF:378-380`, `PF:402-404`).
  - Crear una presentación faltante obliga a salir del formulario (`PF:604-609`) y perder lo cargado.
  - Totales: "Impuestos (informativos)" en el bloque 3 junto a Observaciones y botones (`PF:613-680`).
- **Redundancias:** —
- **Deuda UX ya registrada:** FORMS F3 (tabla ancha → tarjetas), FORMS F3 (alta rápida de presentación), FORMS F3 (formato numérico en vivo), FORMS F5B (editor de líneas único), FORMS F4 (`type=date`), WORKFLOW F3 (bajo mínimo → compra de una línea).
- **Prioridad:** P0 (riesgo de compras duplicadas + selects truncados).

### `/compras/[id]`

- **Ruta:** `/compras/[id]` → `PurchaseDetail` (`PP:144-379`).
- **Módulo:** Compras › Detalle.
- **Roles que la usan:** `purchases.read` → ADMIN, OWNER, ADMINISTRATION, PURCHASING, WAREHOUSE. Editar `purchases.update`, Confirmar pedido `purchases.order`, Cancelar `purchases.cancel` (PURCHASING); Registrar recepción `purchases.receive` (PURCHASING, WAREHOUSE). Historial con `audit.read`.
- **Objetivo principal:** ver el pedido, su avance de recepción y ejecutar el siguiente paso.
- **Acciones primarias / secundarias:** en BORRADOR: "Editar" (`button`), "Confirmar pedido" (`button` vía `ConfirmAction`, `PP:183-192`), "Cancelar compra" (`button--danger`) — **el paso siguiente no es primario**; "Editar" y "Confirmar pedido" con el mismo peso. En PEDIDA: "Registrar recepción" (primaria) + "Cancelar compra" (peligro). Enlaces a recepciones por fila.
- **Información crítica:** estado, total/recibido/pendiente, líneas con pedido/recibido/pendiente, recepciones.
- **Frecuencia esperada:** diaria.
- **Problemas encontrados:**
  - Columnas "Recibido" y "Pendiente" son números sin unidad (`formatDecimal`, `PP:295-296`) mientras "Pedido" dice "4 × Bolsa 25 kg" (`PP:285`).
  - La materia prima de cada línea no enlaza a su stock (`PP:273`): para ver el efecto de la recepción hay que ir a Inventario y buscar.
  - Costos y precios visibles para WAREHOUSE (que no tiene `inventory.cost.read`), inconsistente con `/stock`.
  - Diálogo "Confirmar pedido"/"Cancelar compra": `aria-labelledby` roto por espacios (`UI:170-171`).
  - Motivo de cancelación opcional (`PP:399`).
  - Recepciones "Descartada" (borradores fallidos de `PF:780-784`) aparecen en la tabla de recepciones como ruido (`PP:350-368`).
  - Subtotal/descuentos/impuestos en la fila del pie como un solo texto, oculto en tablet (`PP:302-306`).
  - Cancelada: aviso `.notice` (`PP:201-207`).
  - Historial de auditoría al pie: largo de página medio.
- **Redundancias:** "Proveedor" y "Fecha" en subtítulo y otra vez en Details (`PP:169`, `PP:228-229`).
- **Deuda UX ya registrada:** WORKFLOW F3 ("recibida con faltante"), INFORMATION_ARCHITECTURE F3 (recepciones dentro de la compra).
- **Prioridad:** P1.

### `/compras/[id]/editar`

- **Ruta:** `/compras/[id]/editar` → `PurchaseForm id` (`PF:137-154`).
- **Módulo:** Compras › Edición de borrador.
- **Roles que la usan:** `purchases.update` → ADMIN, OWNER, PURCHASING.
- **Objetivo principal:** corregir un borrador antes de pedirlo.
- **Acciones primarias / secundarias:** igual que alta ("Guardar y confirmar pedido", "Guardar borrador", "Cancelar").
- **Información crítica:** igual que alta.
- **Frecuencia esperada:** semanal.
- **Problemas encontrados:** si la compra ya no es borrador, se muestra un panel suelto sin `PageHeader` ni breadcrumb, con "Volver" como enlace por defecto del navegador (`PF:142-151`); el texto dice que una compra pedida admite cambios de notas, fecha esperada y documento, pero **no existe UI para hacerlo** (no hay acción en `PP`). Resto: mismos problemas que `/compras/nueva`.
- **Redundancias:** —
- **Deuda UX ya registrada:** ver `/compras/nueva`.
- **Prioridad:** P2.

### `/compras/[id]/recepcion`

- **Ruta:** `/compras/[id]/recepcion` → `ReceiptForm` (`PF:704-1030`).
- **Módulo:** Compras › Recepción.
- **Roles que la usan:** `purchases.receive` → ADMIN, OWNER, PURCHASING, WAREHOUSE.
- **Objetivo principal:** registrar lo que llegó y que entre al stock con su costo.
- **Acciones primarias / secundarias:** paso 1: "Revisar recepción" (primaria) / "Cancelar". Paso 2: "Confirmar recepción" (primaria) / "Volver a editar".
- **Información crítica:** depósito, fecha, remito, cantidades recibidas vs pendientes, equivalencia en unidad base, valor que ingresa.
- **Frecuencia esperada:** diaria (depósito).
- **Problemas encontrados:**
  - **`datetime-local` en zona del navegador** (`PF:698-702`, `PF:850-856`, envío `PF:766`); el resumen convierte con `new Date(receivedAt)` y lo muestra en zona de empresa (`PF:1023`): puede mostrar otra hora que la escrita.
  - Las cantidades se precargan con todo lo pendiente (`PF:727`) sin un "recibir todo / nada" explícito; para "todo menos X" hay que editar fila por fila.
  - "Pedido", "Recibido antes", "Pendiente" sin unidad (`PF:906-910`).
  - Depósito preseleccionado con el primero (`PF:724`) sin aviso.
  - WAREHOUSE ve costos y valor en la revisión (`PF:981-1000`).
  - Si no admite recepciones, panel suelto sin cabecera y "Volver" por defecto (`PF:730-740`).
  - Si falla la confirmación crea y descarta un borrador (`PF:780-784`) que queda visible como "Descartada".
  - Errores: `RECEIPT_EXCEEDS_PENDING` traducido; el resto une `fieldErrors` (`PF:787-793`).
  - Resumen en tarjetas (`PF:965-997`) — una por línea; con muchas líneas la página se alarga.
- **Redundancias:** —
- **Deuda UX ya registrada:** WORKFLOW F3 (recibir todo vs parcial), FORMS F5A (`datetime-local` en `purchase-form.tsx`), INFORMATION_ARCHITECTURE F3 (sin listado de recepciones).
- **Prioridad:** P0 (fecha de ingreso de stock/costo en zona incorrecta, es dato contable).

### `/compras/[id]/recepciones/[receiptId]`

- **Ruta:** `/compras/[id]/recepciones/[receiptId]` → `ReceiptDetail` (`PP:411-508`).
- **Módulo:** Compras › Recepción (detalle).
- **Roles que la usan:** `purchases.read` → ADMIN, OWNER, ADMINISTRATION, PURCHASING, WAREHOUSE.
- **Objetivo principal:** consultar qué entró, a qué costo y quién lo confirmó.
- **Acciones primarias / secundarias:** ninguna (sólo breadcrumb).
- **Información crítica:** fecha, depósito, remito, valor ingresado, líneas.
- **Frecuencia esperada:** ocasional (controles, reclamos).
- **Problemas encontrados:** si el `receiptId` no pertenece a la compra de la URL, queda en "Cargando…" para siempre (`PP:422`); "Pedido 4 · antes 0" sin unidad (`PP:489-490`); materia prima sin enlace a stock (`PP:483`); costos visibles a WAREHOUSE; aviso "Confirmada" (`PP:438-443`) repite el badge; sin acción para imprimir/compartir el remito.
- **Redundancias:** "Depósito" en subtítulo y en Details (`PP:436`, `PP:448`).
- **Deuda UX ya registrada:** INFORMATION_ARCHITECTURE F3.
- **Prioridad:** P3.

## 4. Maestros de artículos

### `/materias-primas`

- **Ruta:** `/materias-primas` → `RawMaterialList` (`ITEMS:91-136`).
- **Módulo:** Inventario › Materias primas (maestro).
- **Roles que la usan:** `raw_materials.read` → ADMIN, OWNER, ADMINISTRATION, PURCHASING, PRODUCTION, WAREHOUSE; alta con `raw_materials.create` (ADMIN, OWNER, PURCHASING).
- **Objetivo principal:** mantener el catálogo de insumos.
- **Acciones primarias / secundarias:** "Nueva materia prima" (primaria); filtros búsqueda, estado, categoría.
- **Información crítica:** código, nombre, categoría, unidad base, costo usado, estado.
- **Frecuencia esperada:** semanal / mensual.
- **Problemas encontrados:** "Costo usado" visible para todos los roles (`ITEMS:112-128`), incluso sin `inventory.cost.read`; no muestra stock (hay que ir a `/stock`); filtro de categoría con etiqueta automática "Categoría: todas" (`ML:173`); estado vacío genérico (`ITEMS:104`).
- **Redundancias:** casi la misma tabla que `/stock` (nombre + costo) en dos módulos del mismo grupo de menú.
- **Deuda UX ya registrada:** INFORMATION_ARCHITECTURE F3.
- **Prioridad:** P2.

### `/materias-primas/nuevo`

- **Ruta:** `/materias-primas/nuevo` → `RawMaterialForm` (`ITEMS:138-257`).
- **Módulo:** Maestro de materias primas.
- **Roles que la usan:** `raw_materials.create` → ADMIN, OWNER, PURCHASING (costo inicial con `raw_materials.update_cost`).
- **Objetivo principal:** dar de alta un insumo con unidad, mínimo, proveedor y costo de referencia.
- **Acciones primarias / secundarias:** "Crear materia prima" / "Cancelar" (`EntityForm`).
- **Información crítica:** nombre, categoría, unidad base, mínimo, proveedor preferido, costo.
- **Frecuencia esperada:** mensual.
- **Problemas encontrados:**
  - **Jerga interna de fases** en ayudas visibles: "Se usará para alertas desde la fase de inventario." (`ITEMS:193`), "hasta que las compras (Fase 3) lo calculen" (`ITEMS:215`).
  - Proveedor preferido: select sin búsqueda, truncado a 100 (`ITEMS:146-152`).
  - Título de pestaña "Nuevo materia prima" (concordancia) (`app/(app)/materias-primas/nuevo/page.tsx:5`).
  - No permite crear la presentación de compra en el mismo alta (hay que ir al detalle).
- **Redundancias:** —
- **Deuda UX ya registrada:** FORMS F3 (presentación desde la compra).
- **Prioridad:** P2.

### `/materias-primas/[id]`

- **Ruta:** `/materias-primas/[id]` → `RawMaterialDetail` (`ITEMS:259-382`).
- **Módulo:** Maestro de materias primas › Ficha.
- **Roles que la usan:** `raw_materials.read`; Editar `raw_materials.update` (PURCHASING); Desactivar `raw_materials.deactivate` (ADMIN, OWNER); Cambiar costo `raw_materials.update_cost` (ADMINISTRATION, PURCHASING); presentaciones según `presentations.*`.
- **Objetivo principal:** ver datos maestros y costo de referencia; mantener presentaciones.
- **Acciones primarias / secundarias:** "Editar" y "Desactivar" (peligro) en cabecera, "Cambiar costo" (diálogo, `ITEMS:385-439`), "Nueva presentación", "Renombrar"/"Desactivar" por presentación. **Ninguna primaria**; "Editar" y "Cambiar costo" mismo peso.
- **Información crítica:** categoría, unidad, mínimo, proveedor, costo de referencia, costo usado.
- **Frecuencia esperada:** mensual.
- **Problemas encontrados:** enlace a Inventario dentro de `.notice` con estilo por defecto (`ITEMS:372-377`); diálogo "Cambiar costo" con `aria-labelledby` roto (`UI:170`); "Stock mínimo" con `formatDecimal` + símbolo concatenado en vez de `formatQuantity` (`ITEMS:305`); costos visibles para PRODUCTION/WAREHOUSE; `metadata.title` fijo "Materias primas" (`app/(app)/materias-primas/[id]/page.tsx:5`); proveedor por `legalName` (`ITEMS:306`).
- **Redundancias:** panel de presentaciones y costos iguales a `/stock/[id]`.
- **Deuda UX ya registrada:** INFORMATION_ARCHITECTURE F3, VISUAL_HIERARCHY F3.
- **Prioridad:** P2.

### `/materias-primas/[id]/editar`

- **Ruta:** `/materias-primas/[id]/editar` → `RawMaterialForm id`.
- **Módulo:** Maestro de materias primas.
- **Roles que la usan:** `raw_materials.update` → ADMIN, OWNER, PURCHASING.
- **Objetivo principal:** corregir datos maestros.
- **Acciones primarias / secundarias:** "Guardar cambios" / "Cancelar".
- **Información crítica:** idem alta (sin costo).
- **Frecuencia esperada:** ocasional.
- **Problemas encontrados:** la "Unidad base" se puede elegir aunque haya movimientos (el form no la bloquea, `ITEMS:180-187`) — si la API la rechaza, el error llega al guardar; mismas ayudas con "fase" (`ITEMS:193`); breadcrumb "Volver a la materia prima" (genérico).
- **Redundancias:** —
- **Deuda UX ya registrada:** —
- **Prioridad:** P3.

### `/productos`

- **Ruta:** `/productos` → `ProductList` (`ITEMS:446-475`).
- **Módulo:** Inventario › Productos (maestro).
- **Roles que la usan:** `products.read` → ADMIN, OWNER, ADMINISTRATION, SALES, PRODUCTION, WAREHOUSE; alta con `products.create` (ADMIN, OWNER).
- **Objetivo principal:** mantener el catálogo de lo que se vende.
- **Acciones primarias / secundarias:** "Nuevo producto" (primaria).
- **Información crítica:** código, nombre, categoría, unidad, precio, estado.
- **Frecuencia esperada:** semanal (precios), mensual (altas).
- **Problemas encontrados:** precio con `formatMoney` sin unidad (`ITEMS:468`) vs "$X / u" en la ficha de stock (`PST:301`); no indica si controla stock ni enlaza al stock; estado vacío genérico.
- **Redundancias:** convive con `/stock/productos` y listas de precios (precio en tres lugares).
- **Deuda UX ya registrada:** INFORMATION_ARCHITECTURE F4.
- **Prioridad:** P3.

### `/productos/nuevo`

- **Ruta:** `/productos/nuevo` → `ProductForm` (`ITEMS:477-566`).
- **Módulo:** Maestro de productos.
- **Roles que la usan:** `products.create` → ADMIN, OWNER.
- **Objetivo principal:** dar de alta un producto vendible.
- **Acciones primarias / secundarias:** "Crear producto" / "Cancelar".
- **Información crítica:** nombre, categoría, unidad de venta, precio, controla stock.
- **Frecuencia esperada:** mensual.
- **Problemas encontrados:** "URL de imagen" como campo de texto técnico (`ITEMS:528`); la conservación (vida útil, que define vencimientos) no se ofrece en el alta y sólo puede configurarla ADMIN/OWNER después; unidades sin filtrar (todas, `ITEMS:481`) en select sin búsqueda.
- **Redundancias:** —
- **Deuda UX ya registrada:** INFORMATION_ARCHITECTURE F4.5 (conservación).
- **Prioridad:** P3.

### `/productos/[id]`

- **Ruta:** `/productos/[id]` → `ProductDetail` (`ITEMS:568-625`) + `ConservationSummary` (`CONS:28-84`).
- **Módulo:** Maestro de productos › Ficha.
- **Roles que la usan:** `products.read`; Editar `products.update` (ADMINISTRATION); Desactivar `products.deactivate`; costo teórico con `recipes.read` (ADMIN, OWNER, ADMINISTRATION, PRODUCTION); conservación con `product_conservation.read` y "Configurar" con `.manage` (ADMIN, OWNER).
- **Objetivo principal:** ver precio, costo teórico/margen y conservación del producto.
- **Acciones primarias / secundarias:** "Editar", "Desactivar" (peligro), enlaces "Configurar conservación" (`CONS:40`), "Crear receta"/"Ver receta" (`ITEMS:646-651`). Sin primaria.
- **Información crítica:** precio, costo por unidad, margen, conservación.
- **Frecuencia esperada:** semanal.
- **Problemas encontrados:** "Configurar conservación" en `.panel__header` y "Crear receta" en `.muted` con estilo por defecto (`CONS:40`, `ITEMS:646`); "Calculando…" sin `role="status"` (`ITEMS:654`); PRODUCTION ve margen bruto (`ITEMS:668-671`) aunque no tiene `production.cost.read` ni `sales.margin.read`; sin enlace a la ficha de stock del producto; conservación se oculta si no controla stock (`ITEMS:621`) sin explicarlo; `metadata.title` fijo "Productos".
- **Redundancias:** costo/margen/receta duplicados con `/stock/productos/[id]` (que usa otro costo: promedio de lotes).
- **Deuda UX ya registrada:** INFORMATION_ARCHITECTURE F4 y F4.5.
- **Prioridad:** P2.

### `/productos/[id]/editar`

- **Ruta:** `/productos/[id]/editar` → `ProductForm id`.
- **Módulo:** Maestro de productos.
- **Roles que la usan:** `products.update` → ADMIN, OWNER, ADMINISTRATION.
- **Objetivo principal:** cambiar datos y precio.
- **Acciones primarias / secundarias:** "Guardar cambios" / "Cancelar".
- **Información crítica:** precio de venta, controla stock.
- **Frecuencia esperada:** semanal (precios).
- **Problemas encontrados:** desmarcar "Controla stock" con stock existente no advierte consecuencias en el form (`ITEMS:523-527`); el aviso "El costo no se carga a mano" (`ITEMS:551-555`) ocupa espacio en cada edición.
- **Redundancias:** precio también en Listas de precios.
- **Deuda UX ya registrada:** —
- **Prioridad:** P3.

### `/productos/[id]/conservacion`

- **Ruta:** `/productos/[id]/conservacion` → `ConservationForm` (`CONS:118-351`).
- **Módulo:** Maestro de productos › Conservación.
- **Roles que la usan:** `product_conservation.manage` → ADMIN, OWNER.
- **Objetivo principal:** definir en qué estados se guarda el producto, cuánto dura y cuándo avisar.
- **Acciones primarias / secundarias:** "Guardar conservación" (primaria) / "Cancelar".
- **Información crítica:** estados habilitados, vida útil, estado inicial, umbral de aviso.
- **Frecuencia esperada:** una vez por producto; rara vez después.
- **Problemas encontrados:** la lista de problemas se muestra de entrada, antes de que el usuario toque algo (`CONS:149-160`, `322-328`), con `className="form__error"` en un `<ul>`; el select "Estado inicial por defecto" ofrece estados deshabilitados (`CONS:302-306`); umbral sólo en horas enteras (`CONS:159`) — "3 días" obliga a escribir 72; notas ocultas en tablet (`CONS:222, 273`); tabla de 5 columnas con checkboxes sin etiquetas visibles (tienen `aria-label`, `CONS:235-271`).
- **Redundancias:** —
- **Deuda UX ya registrada:** FORMS F4.5 (tarjetas por estado), INFORMATION_ARCHITECTURE F4.5 (acceso directo).
- **Prioridad:** P3.

---

## Hallazgos transversales

1. **Rutas sin guardia de permiso** (P1). Ninguna `page.tsx` del alcance verifica permisos; los formularios (`/stock/ajuste`, `/stock/merma`, `/stock/inicial`, `/compras/nueva`, `/compras/[id]/recepcion`, operaciones de lote, conservación) se pueden completar enteros y fallan al final con 403. Además hay **enlaces internos a pantallas prohibidas**: `ReferenceLink` (`INV:223-229`), lote en movimientos (`INV:280`), "Última compra" (`INV:589`), "Última producción" (`PST:155`), historial de costo de producto (`PST:452`).
2. **Selects de entidades truncados a 100 y sin búsqueda** (P0 en compras). `fetchOptions` fija `pageSize: 100` (`API:89-96`). Afecta proveedores (`PF:94`, `PP:87`, `ITEMS:147`), materias primas (`PF:95`, `OP:100`), unidades (`PF:96`, `PRES:189`, `ITEMS:73`), depósitos (`INV:110`, `OP:84`, `PF:709`). Una panadería con >100 insumos (envases, decoraciones) no puede comprar el 101º.
3. **Fechas en la zona del navegador** (P0/P1). `datetime-local` + `new Date(...)` en recepción (`PF:698-702, 850-856, 766`) y operaciones de stock (`OP:63-67, 356-364, 169`); `today()` local en compras (`PF:78-82`). `WallClockInput` ya existe (`components/orders/order-shared.tsx`) y se usa en lotes (`LOT:240`): el patrón está, falta aplicarlo.
4. **Formato inconsistente de costos y cantidades.**
   - Mismo concepto "costo por unidad" con dos helpers: `formatReferenceCost` (sin redondeo, hasta 6 decimales) en inventario (`INV:183, 302, 545, 595`; `PST:140, 242, 301, 311, 391`; `LOT:547`) y `formatUnitCost` (2 decimales) en compras (`PP:80, 278, 497`; `PF:499, 987`).
   - Precio de venta: `formatMoney` (`ITEMS:468, 614`) vs `formatReferenceCost` (`PST:301`).
   - Cantidades sin unidad en compras/recepciones (`PP:295-296, 489-490`; `PF:906-910`); `formatDecimal` + símbolo manual en `ITEMS:305`.
   - Fechas: `formatDate` (dd/mm/aaaa) en compras y `formatDateTime` con `dateStyle:"short"` (dd/mm/aa) en inventario/lotes (`lib/format.ts:85-91`).
   - Signo negativo "−" (`OP:205`, `LOT:792`) vs "-" (`INV:208-213`).
   - Vacío como "—" con significados distintos: "sin dato", "cero" (`PST:99, 112, 127`; `INV:174`) y "sin vencimiento" (`LOT:1060`).
5. **Visibilidad de costos incoherente por rol** (P1). `inventory.cost.read` oculta promedio/valor en `/stock`, pero: costo de referencia y costo usado se ven sin permiso (`INV:549-575`, `ITEMS:112-128, 318-370`); WAREHOUSE ve precios, valor y costo de adquisición en compras/recepciones (`PP:209-225, 286-294`; `PF:981-1000`) y el valor de la merma (`OP:407-412`); PRODUCTION ve margen teórico (`ITEMS:668`). No hay "—" en las columnas: desaparecen, así que el usuario no sabe que el dato existe.
6. **Jerarquía de acciones débil.** Cabeceras con 3–4 botones `button` iguales (`INV:88-102`, `LOT:434-489`, `PP:177-196` en borrador); el siguiente paso del flujo ("Confirmar pedido") no es primario; acciones destructivas como enlaces de texto iguales a las neutrales (`LOT:93-103` "Merma"); "Guardar borrador" es el submit por Enter en vez de la primaria (`PF:366, 660`).
7. **Enlaces con estilo del navegador** (P2). Sin regla global para `a` (`CSS` sólo `.table a`, `.breadcrumb a`, `.details a`). Afecta "Ver todos/Ver todas" (`INV:678`, `PST:352`), "Ver próximos a vencer" (`PST:208`), "Configurar conservación" (`CONS:40`), enlace en `.notice` (`ITEMS:375`), "Crear receta/Ver receta" (`ITEMS:646, 651`), "Volver" en paneles vacíos (`PF:148, 736`).
8. **Accesibilidad.** `aria-labelledby` roto/duplicado en `ConfirmAction` (`UI:170-171`); asteriscos `aria-hidden` sin `aria-required` (`PF:378, 402, 828`; `OP:309`); botones "Revisar" deshabilitados sin explicación (`OP:381`, `LOT:939`); "✕" como único contenido visual (`PF:587`); cargas como "Cargando…" que reemplazan el contenido; foco no vuelve tras diálogos (backlog).
9. **Errores técnicos al usuario.** Validación compartida con mensajes genéricos/técnicos: "Referencia inválida" (`packages/shared/src/validation.ts:35`), "Fecha inválida (AAAA-MM-DD)" (`validation.ts:30`), "Número inválido (máximo 6 decimales)" (`validation.ts:56`); fallback a `err.message` en todos los formularios (`OP:188`, `PF:343, 792`, `LOT:776`, `CONS:187`); códigos crudos si falta etiqueta (`INV:203-204` motivo, `LOT:670` y `UI:469-470` acción de auditoría). No se ven UUIDs en pantalla (los ids sólo van en URLs y `aria-label` usa el código de lote).
10. **Estados vacíos y de carga genéricos.** Mismo texto con y sin filtros (`ML:198` sólo distingue la búsqueda); sin CTA ("crear", "cargar stock inicial"); tabla de movimientos de lote sin vacío (`LOT:635-661`); recepción con id cruzado queda cargando para siempre (`PP:422`).
11. **Pantallas largas / fichas solapadas.** Ficha de stock de producto (7 paneles), ficha de stock de MP (6), ficha de lote (hasta 6). Ficha de maestro y ficha de stock de cada artículo duplican costos, presentaciones, receta y precio.
12. **Títulos de pestaña genéricos.** `metadata.title` fijo en detalles (`stock/[id]`, `stock/lotes/[id]`, `compras/[id]`, `materias-primas/[id]`, `productos/[id]`): con varias pestañas abiertas no se distinguen.
13. **Proveedor con tres nombres distintos**: `legalName` (`PP:88`, `PF:391`, `ITEMS:306`), `tradeName ?? legalName` (`ITEMS:149`), `supplier.name` (`PP:125`, `INV:412`).

---

## Workflow compras — ANTES

Escenario: PURCHASING crea una compra con 2 líneas, la pide, se recibe y se verifica stock/costo.

| #   | Pantalla        | Acción exacta                                                                                                                                                  | Clics              | Navegación                   | Código                         |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------- | ------------------------------ |
| 1   | Cualquiera      | Menú lateral "Operaciones → Compras"                                                                                                                           | 1                  | → `/compras`                 | `lib/navigation.ts:65`         |
| 2   | `/compras`      | "Nueva compra" (primaria, cabecera)                                                                                                                            | 1                  | → `/compras/nueva`           | `PP:98-100`, `ML:130-134`      |
| 3   | Nueva compra    | Proveedor: abrir select y elegir (obligatorio; ≤100, sin búsqueda)                                                                                             | 2                  | —                            | `PF:382-394`                   |
| 4   | Nueva compra    | Fecha: precargada con hoy del navegador (obligatoria)                                                                                                          | 0                  | —                            | `PF:186`, `PF:78-82`           |
| 5   | Línea 1         | Materia prima: abrir select y elegir (≤100)                                                                                                                    | 2                  | —                            | `PF:476-492`                   |
| 6   | Línea 1         | Presentación: se autoselecciona la primera activa o la unidad base; cambiarla = 2 clics                                                                        | 0–2                | —                            | `PF:231-237`, `PF:504-521`     |
| 7   | Línea 1         | Cantidad (escribir, obligatoria) y Precio unitario (escribir, obligatorio); Descuento opcional                                                                 | 2 campos           | —                            | `PF:529-567`                   |
| 8   | Nueva compra    | "Agregar materia prima"                                                                                                                                        | 1                  | —                            | `PF:597-603`                   |
| 9   | Línea 2         | Repetir pasos 5–7                                                                                                                                              | 2 clics + 2 campos | —                            | —                              |
| 10  | Nueva compra    | (Opcional) Impuestos, fecha esperada, documento, observaciones                                                                                                 | —                  | —                            | `PF:417-435, 616-631, 651-658` |
| 11  | Nueva compra    | "Guardar y confirmar pedido" (sin diálogo de confirmación; POST + POST `/order`)                                                                               | 1                  | → `/compras/[id]` (Pedida)   | `PF:663-672`, `PF:323-327`     |
| 11b | (alternativa)   | "Guardar borrador" → detalle → "Confirmar pedido" → diálogo "Confirmar pedido"                                                                                 | +2                 | → `/compras/[id]`            | `PF:660`, `PP:182-193`         |
| 12  | `/compras/[id]` | "Registrar recepción" (primaria)                                                                                                                               | 1                  | → `/compras/[id]/recepcion`  | `PP:172-176`                   |
| 13  | Recepción       | Depósito (preseleccionado el primero; obligatorio), fecha/hora (precargada, zona del navegador), remito opcional; cantidades precargadas con todo lo pendiente | 0                  | —                            | `PF:724-727`, `PF:832-870`     |
| 14  | Recepción       | "Revisar recepción"                                                                                                                                            | 1                  | (mismo URL, paso 2)          | `PF:940-946`                   |
| 15  | Revisión        | "Confirmar recepción" (POST receipt + POST `/post`)                                                                                                            | 1                  | → `/compras/[id]` (Recibida) | `PF:1003-1010`, `PF:756-777`   |
| 16  | `/compras/[id]` | Las líneas no enlazan a stock (`PP:273`). Menú "Inventario → Stock"                                                                                            | 1                  | → `/stock`                   | `lib/navigation.ts:84`         |
| 17  | `/stock`        | Escribir nombre de MP 1 en la búsqueda + clic en el nombre                                                                                                     | 1 + texto          | → `/stock/[id]`              | `INV:157-160`                  |
| 18  | `/stock/[id]`   | Ver "Stock total", "Costo promedio de inventario" (sólo con `inventory.cost.read`), "Última compra"                                                            | 0                  | —                            | `INV:486-600`                  |
| 19  | —               | Volver (breadcrumb, 1) y repetir 17–18 para MP 2                                                                                                               | 2 + texto          | → `/stock` → `/stock/[id]`   | `INV:452`                      |

**Totales (camino corto con "Guardar y confirmar pedido"):** ≈ 19–21 clics, 8 campos escritos (4 cantidades/precios + 2 búsquedas + opcionales), **8 navegaciones** (`/compras` → `/compras/nueva` → `/compras/[id]` → `/compras/[id]/recepcion` → `/compras/[id]` → `/stock` → `/stock/[id]` → `/stock` → `/stock/[id]`).

**Campos obligatorios:** proveedor, fecha, por línea materia prima + presentación/unidad (auto) + cantidad + precio unitario; en la recepción depósito (auto) y al menos una cantidad > 0.

**Fricciones en el camino:** selects sin búsqueda/truncados (pasos 3, 5); errores técnicos si falta proveedor o precio ("Referencia inválida", "Número inválido…"); riesgo de compra duplicada si falla el paso 11; fecha de recepción en zona del navegador (13); cantidades de recepción sin unidad (`PF:906-910`); no hay enlace del resultado (compra/recepción) al stock del insumo; WAREHOUSE que recibe no encuentra el filtro de proveedor (`PP:86-90`). Alternativa para ver el efecto: `/stock/movimientos` filtrando por tipo, donde la fila enlaza a la compra (`INV:223-224`) pero no al revés.

---

## Workflow inventario perecedero — ANTES

Escenario: a las 7:00, depósito/producción necesita saber, para productos terminados perecederos, qué hay, qué está reservado, qué se puede vender, qué vence pronto y qué está bloqueado. Punto de partida: cualquier pantalla. Rol con todos los permisos de lectura (WAREHOUSE o ADMINISTRATION).

| Pregunta                             | Dónde se responde                                                                                                                                               | Clics / pantallas                                                                                     | Notas y código                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **¿Qué tengo?** (total por producto) | `/stock/productos`, columna "Físico"                                                                                                                            | 2 clics (menú Stock → pestaña "Productos terminados"), 1 pantalla                                     | La pestaña por defecto de Stock es Materias primas (`INV:58`); "Físico" `PST:90-94`. Por estado sólo Fresco/Refrigerado/Congelado, **sin Descongelado** (`PST:95`) y ocultas en tablet (`hide-md`). Por lote: +1 clic por producto (`PST:293`, `LOT:109-213`).  |
| **¿Qué está reservado?**             | `/stock/productos`, columna "Comprometido"                                                                                                                      | 2 clics, 1 pantalla (en escritorio)                                                                   | Oculta en tablet (`PST:114`, `hide-sm`). **Por lote/pedido**: producto (+1) → lote (+1) → panel "Reservado para pedidos" (`LOT:361-401`) = 4 clics y 3 pantallas por lote; la tabla de lotes no tiene columna de reservado (el DTO `ProductLotDto` no lo trae). |
| **¿Qué puedo vender?**               | `/stock/productos`, columna "Disponible ahora" (negrita)                                                                                                        | 2 clics, 1 pantalla                                                                                   | `PST:117-122`. Convive con "Utilizable ahora" sin explicación. **Para una fecha futura** (p. ej. sábado): +1 clic al producto y elegir fecha/hora en "Disponibilidad a una fecha" (`LOT:216-356`) = 3 clics + 2 campos por producto.                            |
| **¿Qué vence pronto?**               | `/stock/productos/por-vencer`                                                                                                                                   | 2 clics (menú Stock → pestaña "Próximos a vencer"), 1 pantalla                                        | `INV:60-62`, `LOT:996-1071`. Filtro de ventana opcional (+2). No muestra si lo que vence está reservado. Alternativa resumida: columna "Próximo a vencer" en `/stock/productos` (`PST:123-134`).                                                                |
| **¿Qué está bloqueado?**             | **No hay pantalla global.** Sólo en la ficha de stock de cada producto (texto chico "bloqueado X", `PST:256-257`) o como badge en la tabla de lotes (`LOT:187`) | 3 clics y 3 pantallas **por producto** (menú → pestaña → producto), revisando N productos uno por uno | El listado (`PST:75-165`) no muestra `lots.blocked` ni `lots.expired` aunque el DTO los trae; "Próximos a vencer" no incluye bloqueados (`LOT:1008-1012`). Con 20 productos ≈ 2 + 20×2 = 42 clics.                                                              |

**Resumen:** 4 de las 5 preguntas se responden en 2 clics, pero repartidas en **2 pantallas distintas** (Productos terminados + Próximos a vencer) y con columnas clave (Comprometido, estados de conservación) ocultas en tablet, el dispositivo típico del depósito. La quinta (bloqueado) no tiene respuesta agregada: escala lineal con la cantidad de productos. El detalle por lote de reservado también escala lineal (4 clics por lote). Vencido sólo se ve en "Próximos a vencer" (filtro "Sólo vencidos") o en texto chico en la ficha (`PST:254-255`). El inicio no muestra ninguna alerta de vencimiento (backlog DASHBOARD F4.5).
