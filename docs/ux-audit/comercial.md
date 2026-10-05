# Auditoría UX — Área COMERCIAL (Pedidos, Ventas, Clientes, Listas de precios, Cuentas a cobrar)

Alcance leído completo: las 19 `page.tsx` de `apps/web/src/app/(app)/{pedidos,ventas,clientes,listas-de-precios,cuentas-a-cobrar}` (todas son envoltorios de una línea que delegan en un componente), `components/orders/order-form.tsx`, `order-pages.tsx`, `order-replan.tsx`, `order-shared.tsx`, `components/sales/*` (sale-form, sale-pages, sale-shared, account-pages, price-list-pages), `components/masters/customers.tsx`. Se leyeron también las piezas que usan: `masters/ui.tsx` (ConfirmAction, Details, ErrorState), `masters/master-list.tsx`, `lib/api-client.ts`, `lib/format.ts`, `lib/navigation.ts`, `app/globals.css`, y las partes de la API que deciden acciones y mensajes (`apps/api/src/modules/orders/orders.data.ts`, `sales/sales.data.ts`, `sales/sales.service.ts`, `payments/payments.service.ts`, `price-lists/price-lists.service.ts`).

Convenciones: rutas de archivo relativas a `apps/web/src/components/` salvo que se indique otra cosa. "Plano" = `className="button"` (peso secundario). "Primario" = `button--primary`. "Peligro" = `button--danger`.

Mapa permiso → roles (de docs/PERMISSIONS.md) usado abajo:
- `orders.read`: ADMIN, OWNER, ADMINISTRATION, SALES, PRODUCTION, WAREHOUSE · `orders.create/update/confirm/cancel`: ADMIN, OWNER, SALES · `orders.replan`: ADMIN, OWNER, ADMINISTRATION, SALES · `orders.prepare`: ADMIN, OWNER, PRODUCTION · `orders.ready`: ADMIN, OWNER, WAREHOUSE
- `sales.read`: ADMIN, OWNER, ADMINISTRATION, SALES, WAREHOUSE · `sales.create/update/post`: ADMIN, OWNER, ADMINISTRATION, SALES · `sales.price_override`, `sales.cost.read`, `sales.margin.read`: ADMIN, OWNER, ADMINISTRATION
- `customers.read/create/update`: ADMIN, OWNER, ADMINISTRATION, SALES · `customers.deactivate`: ADMIN, OWNER, ADMINISTRATION
- `price_lists.read`: ADMIN, OWNER, ADMINISTRATION, SALES · `price_lists.manage`: ADMIN, OWNER, ADMINISTRATION
- `customer_accounts.read`, `payments.*`, `order_advances.create`: ADMIN, OWNER, ADMINISTRATION, SALES · `customer_accounts.adjust`: ADMIN, OWNER, ADMINISTRATION

---

## 1. PEDIDOS

### /pedidos
- **Ruta:** /pedidos → `OrderList` (order-pages.tsx:72-204)
- **Módulo:** Comercial › Pedidos
- **Roles que la usan:** `orders.read` → ADMIN, OWNER, ADMINISTRATION, SALES, PRODUCTION, WAREHOUSE. Botón "Nuevo pedido" sólo con `orders.create` (ADMIN, OWNER, SALES). Filtro "Cliente" sólo con `customers.read`.
- **Objetivo principal:** ver qué pidieron los clientes, para cuándo, y si está cubierto con stock o hay que producir; entrar al pedido para actuar.
- **Acciones primarias:** "Nuevo pedido" (primario, master-list.tsx:131). Única acción primaria.
- **Acciones secundarias:** búsqueda, filtro estado (por defecto "Abiertos (sin cancelar)"), filtros Cobertura, Prioridad, Cliente, Entrega ("Sólo próximas entregas"), Faltantes, fechas "Entrega desde/hasta"; link en el código del pedido; paginación Anterior/Siguiente (pequeños, planos). 7 controles de filtro al mismo nivel visual.
- **Información crítica:** código, cliente + evento, fecha/hora de entrega, productos (oculto en md), estado, cobertura, falta producir (oculto en sm), prioridad (oculto en md).
- **Frecuencia esperada:** diaria (varias veces).
- **Problemas encontrados:**
  - El filtro "Cliente" se arma con `fetchOptions` que trae como máximo 100 clientes activos (lib/api-client.ts:89-95; order-pages.tsx:77). Con más de 100 clientes, los restantes no aparecen y no hay búsqueda en el `<select>`.
  - No hay vista "Hoy / Mañana" ni orden por fecha de entrega explícito; "Sólo próximas entregas" es un filtro binario poco descubrible (order-pages.tsx:124-129). Para la operación diaria de la panadería el corte por día es el principal.
  - El estado por defecto "Abiertos (sin cancelar)" (order-pages.tsx:97) incluye entregados: el rótulo es ambiguo ("abiertos" sugiere pendientes).
  - 8 columnas; en tablet se ocultan Productos y Prioridad (hide-md), justo lo que distingue un pedido de catering de otro.
  - La fila no es clickeable: sólo el código monoespaciado es enlace (order-pages.tsx:145-147), objetivo táctil chico.
  - Estado y cobertura en dos columnas con badges ("Confirmado" + "Cobertura parcial") que compiten.
  - Filtros de fecha `type="date"` nativos (master-list.tsx:182-189): formato del navegador.
- **Redundancias:** Necesidades → "Pedidos en riesgo" muestra un subconjunto parecido (faltantes); el inicio no lo muestra.
- **Deuda UX ya registrada:** NAVIGATION [F5A]/[F5B] reagrupar Comercial; TABLES [F3] `hide-sm` sin forma de ver columnas ocultas; TABLES [F4.5] demora de búsqueda 300 ms; DASHBOARD [F5A] pedidos de hoy y mañana; FORMS [F4]/[F5A] selector de fecha propio; VISUAL_HIERARCHY [F5A] estado + cobertura como dos badges.
- **Prioridad:** P0

### /pedidos/nuevo
- **Ruta:** /pedidos/nuevo → `OrderForm` sin id → `OrderEditor` (order-form.tsx:319-643)
- **Módulo:** Comercial › Pedidos
- **Roles que la usan:** `orders.create` → ADMIN, OWNER, SALES (order-form.tsx:437; sin permiso muestra "No tenés permiso para esta operación." pero recién después de cargar todo el catálogo).
- **Objetivo principal:** tomar un pedido (encargo, catering, mayorista): cliente, fecha/hora de entrega o retiro, productos y datos de contacto; dejarlo en borrador.
- **Acciones primarias:** "Guardar borrador" (primario, order-form.tsx:629-631).
- **Acciones secundarias:** "Cancelar" (link plano), "Agregar producto" (plano, mismo tamaño que el primario, order-form.tsx:237), "Quitar" por línea (plano pequeño), selectores Unidad y Conservación por línea.
- **Información crítica:** cliente, fecha y hora (por defecto mañana 10:00, order-form.tsx:351 + order-shared.tsx:62-65), modalidad, dirección (sólo entrega), prioridad, evento, contacto, teléfono, notas, productos/cantidades, "Precio actual", vista previa de cobertura (tarjetas por producto con 8 métricas + tabla de materias primas).
- **Frecuencia esperada:** diaria.
- **Problemas encontrados:**
  - Selector de cliente `<select>` sin búsqueda y limitado a 100 (order-form.tsx:472-484; api-client.ts:89-95). Si el cliente número 101 llama, no se le puede cargar el pedido.
  - Selector de producto `<select>` sin búsqueda y limitado a 100 productos (order-form.tsx:157-169).
  - No se puede dar de alta un cliente nuevo desde el formulario (hay que abandonar el pedido e ir a /clientes/nuevo).
  - "Precio actual" muestra `product.salePrice` (order-form.tsx:219), no el precio de la lista del cliente, que es el que se acuerda al confirmar (orders.service.ts:952). El precio mostrado puede no coincidir con el acordado. Además usa `formatMoney` sin la moneda de la empresa (por defecto ARS).
  - La nota "El precio es informativo… el precio final se define al vender" (order-form.tsx:240-242) contradice el modelo real: el precio se acuerda al confirmar el pedido (orders.service.ts:952), no al vender.
  - No hay total del pedido ni forma de pactar precio o descuento por línea (catering suele negociar).
  - No hay campo de seña en el alta: se registra después desde el detalle.
  - La vista previa de cobertura (order-form.tsx:283-305, order-shared.tsx:118-251) muestra a ventas Stock físico, Stock válido para la fecha, Ya comprometido, Disponible, Reservado, Falta producir, Sin cubrir, lotes, materias primas ("Para producir lo que falta: 3 kg de harina…", receta versión N) y la tabla de materias primas con "Proveedor sugerido": información de producción/compras que ventas no necesita para tomar un pedido. Alarga mucho la página.
  - 8 campos de cabecera visibles a la vez (cliente, fecha+hora, modalidad, prioridad, evento, contacto, teléfono, notas): no se separan los obligatorios de los opcionales y no hay marca de obligatorio (comparar con price-list-pages.tsx:303-305, que sí usa `form__required`).
  - `WallClockInput`: el input de hora tiene `aria-label="Hora"`, no está asociado al rótulo "Entrega o retiro" (order-shared.tsx:99-105); fecha nativa en el idioma del navegador.
  - Botón "Quitar" deshabilitado con una sola línea, sin explicación (order-form.tsx:226).
  - La línea usa inputs con estilo del navegador (sin `.line-editor`, order-form.tsx:132) a diferencia de la venta.
  - Errores de la vista previa se muestran como `notice` con el mensaje crudo de la API (order-form.tsx:613-614); un error genérico resulta en "Sin vista previa" (order-form.tsx:270).
- **Redundancias:** la misma vista previa se repite en el detalle del borrador (`DraftPreview`, order-pages.tsx:422-429). El editor de líneas se comparte con /modificar (bien), pero difiere del editor de ventas.
- **Deuda UX ya registrada:** INFORMATION_ARCHITECTURE [F5A] tarjetas de cobertura con 8 métricas; FORMS [F5B] tablas editables con estilo del navegador; FORMS [F5B] el pedido no permite cambiar el precio de una línea; FORMS [F4]/[F5A] selector de fecha propio; FORMS [F3] input numérico con formato es-AR.
- **Prioridad:** P0

### /pedidos/[id]
- **Ruta:** /pedidos/[id] → `OrderDetail` (order-pages.tsx:219-420)
- **Módulo:** Comercial › Pedidos
- **Roles que la usan:** `orders.read` → los 7 roles. Las acciones dependen de `data.actions` (orders.data.ts:889-905): Entregar y vender (`sales.create`+`sales.post`, y pedido READY/PARTIALLY_DELIVERED con precio), Acordar precio (`orders.update`+precios), Registrar seña (`order_advances.create`), Confirmar (`orders.confirm`), Actualizar cobertura y Modificar (`orders.replan`), Empezar preparación (`orders.prepare` → PRODUCTION), Marcar listo (`orders.ready` → WAREHOUSE), Editar (`orders.update`), Cancelar (`orders.cancel`). Crear orden de producción (`order_production.create`+`production_orders.create` → PRODUCTION).
- **Objetivo principal:** seguir un pedido: confirmarlo (reservar), cobrar la seña, saber si está cubierto, prepararlo, marcarlo listo y entregarlo/venderlo.
- **Acciones primarias:** "Entregar y vender" / "Entregar el resto" (primario, order-pages.tsx:249-253), sólo en READY/PARTIALLY_DELIVERED.
- **Acciones secundarias (cabecera, order-pages.tsx:247-321):** Acordar precio, Registrar seña, Confirmar pedido, Actualizar cobertura, Modificar pedido, Empezar/Volver a preparación, Marcar listo (activo o deshabilitado), Editar / Editar contacto y notas, Cancelar pedido (peligro). En el cuerpo: "Ver historial de reservas" (pequeño), "Crear orden de producción" por necesidad (pequeño). Ejemplos de peso visual:
  - Borrador visto por SALES: Registrar seña, Confirmar pedido, Editar = 3 planos + Cancelar pedido (peligro). **La acción principal del borrador, "Confirmar pedido", es un botón plano** porque `ConfirmAction` nunca es primario (masters/ui.tsx:160-163).
  - Confirmado visto por SALES: Registrar seña, Actualizar cobertura, Modificar pedido, Editar contacto y notas = 4 planos + Cancelar (peligro); ninguno primario.
  - Confirmado visto por ADMIN/OWNER: hasta 7 planos (seña, actualizar, modificar, preparación, marcar listo, editar) + cancelar.
- **Información crítica:** estado + cobertura en el título; cliente, modalidad y fecha; avisos (`issues`); bloqueos de entrega/listo; datos del pedido (11 campos); productos y cobertura; "Precio, señas y ventas"; lotes reservados; producción necesaria; materias primas necesarias; historial.
- **Frecuencia esperada:** diaria.
- **Problemas encontrados:**
  - Demasiadas acciones al mismo nivel y la principal según el estado no se destaca (ver arriba). La acción que sigue en el flujo (confirmar → seña → listo → entregar) no se señala.
  - `ConfirmAction` arma `aria-labelledby={`${label}-title`}` con el rótulo que contiene espacios ("Cancelar pedido-title", masters/ui.tsx:170-171): un IDREF con espacios se interpreta como varios ids, ninguno existe, así que los diálogos de Confirmar, Actualizar cobertura, Preparación, Marcar listo, Cancelar y Acordar precio quedan sin nombre accesible.
  - Cancelar: el motivo es obligatorio en la API (`requiredText`, packages/shared/src/orders.ts:247) pero el diálogo no lo valida; si está vacío, `apiFetch` convierte `VALIDATION_ERROR` en "Revisá los datos marcados." (lib/api-client.ts:61-63) y `ConfirmAction` sólo muestra `err.message` (masters/ui.tsx:152): no se marca ningún campo.
  - El flujo de entrega depende de dos roles: SALES no puede "Marcar listo" (`orders.ready` sólo WAREHOUSE) y "Entregar y vender" sólo aparece en READY (orders.data.ts:62, 901). Un pedido confirmado y cubierto no puede venderse por SALES sin que depósito lo marque listo; el mensaje "Sólo se entrega un pedido listo (con todo el producto reservado)" (orders.data.ts:810) aparece sólo cuando el estado ya es READY/PARTIALLY_DELIVERED (order-pages.tsx:326-332), así que en CONFIRMED el vendedor no ve por qué no hay botón de entregar.
  - Terminología inconsistente: el bloqueo dice "cotizalo antes de entregar" (orders.data.ts:813) pero el botón se llama "Acordar precio" (order-pages.tsx:939).
  - Términos técnicos: "Plan vigente: Revisión N" (order-pages.tsx:384), "rev. N" (order-pages.tsx:627), "Sin cubrir", "Ya comprometido", "Invalidado".
  - Montos sin moneda de la empresa: `formatMoney(...)` sin `currency` en order-pages.tsx:525, 530, 818, 872, 876, 884, 902, 920 (cae en ARS aunque `data.currency` existe).
  - Fechas con dos formatos en la misma página: `formatWallClock` → "05/10/2026 10:00" (order-pages.tsx:246, 380) y `formatDateTime` (Intl es-AR `dateStyle: short`) → "5/10/26, 10:00" (order-pages.tsx:385-391, 609, 879-880, 901, 919).
  - Los enlaces a ventas dentro de "Ventas del pedido" están en `.plain-list` (order-pages.tsx:911-916): no los alcanza ni `.table a` ni `.details a` (globals.css:388, 530), quedan con el color del navegador y monoespaciados.
  - "Materias primas necesarias" con "Proveedor sugerido" (order-pages.tsx:405-414) y "Producción necesaria" se muestran a SALES y WAREHOUSE: información de planificación que no es de su tarea. Lo mismo los lotes reservados con vencimiento.
  - "Datos del pedido" muestra 11 filas con "—" para los vacíos (`Details`, masters/ui.tsx:113).
  - La seña: el diálogo no muestra el total acordado ni propone monto (order-pages.tsx:255-266; sale-shared.tsx:88-255 sin `max` ni `defaultAmount`); se puede registrar una seña mayor que el pedido sin aviso.
  - "Registrar seña" se ofrece también en borrador (`open` incluye DRAFT, orders.data.ts:815, 904): se cobra seña de un pedido que todavía no tiene precio acordado.
  - El badge "Hay N nuevos" explica qué hacer sólo con `title` (tooltip, order-pages.tsx:485-491), invisible en táctil y para lectores de pantalla.
  - "Marcar listo" deshabilitado explica el motivo en `title` (order-pages.tsx:306-313); se repite como texto chico más abajo (order-pages.tsx:346-350), separado del botón.
  - Las etiquetas de inelegibilidad de lotes están escritas a mano en order-shared.tsx:233-238 ("Vence antes", "Bloqueado", "Otra conservación") en vez de usar `ORDER_INELIGIBILITY_LABELS` (packages/shared/src/orders.ts:141-145, "Vence antes de la fecha", "Bloqueado por calidad"…).
  - Página muy larga: Datos, avisos, productos, comercial, reservas, producción, materias primas, historial, todo a la vez.
- **Redundancias:** "Actualizar cobertura" y "Modificar pedido" son dos caminos para replanificar (el diálogo lo admite: "Para ver antes el resultado, usá «Modificar pedido»", order-pages.tsx:778). "Editar" (borrador) vs "Editar contacto y notas" (confirmado) vs "Modificar pedido": tres pantallas de edición. Materias primas también en Necesidades.
- **Deuda UX ya registrada:** INFORMATION_ARCHITECTURE [F5A] detalle largo; VISUAL_HIERARCHY [F5A] dos badges en el título y "—" en Datos del pedido; WORKFLOW [F5A] "Hay nuevo stock" → entrar a cada pedido; WORKFLOW [F5A] consolidación de producción; WORKFLOW [F5B] devolución de seña al cancelar; WORKFLOW [F5B] enlaces a ventas con estilo por defecto; ACCESSIBILITY [F3] foco de `ConfirmAction`; NAVIGATION [F3] cabecera recargada de acciones.
- **Prioridad:** P0

### /pedidos/[id]/editar
- **Ruta:** /pedidos/[id]/editar → `OrderForm id` (order-form.tsx:319-643). En borrador edita todo; en confirmado (`infoOnly`, order-form.tsx:348) sólo modalidad, dirección, prioridad, evento, contacto, teléfono y notas.
- **Módulo:** Comercial › Pedidos
- **Roles que la usan:** `orders.update` → ADMIN, OWNER, SALES.
- **Objetivo principal:** corregir un borrador o actualizar los datos de contacto/entrega de un pedido confirmado.
- **Acciones primarias:** "Guardar cambios" (primario).
- **Acciones secundarias:** "Cancelar" (plano); en confirmado "Modificar fecha o productos" (plano, order-form.tsx:594-598), mismo peso que Cancelar.
- **Información crítica:** igual que el alta; en confirmado, lista de productos de sólo lectura.
- **Frecuencia esperada:** ocasional.
- **Problemas encontrados:**
  - Mismos problemas del alta (selectores sin búsqueda limitados a 100, precio informativo engañoso, vista previa larga).
  - Pedido cancelado: panel con un enlace "Volver" fuera de tabla/detalles → color de enlace del navegador (order-form.tsx:326-331).
  - En confirmado la "Modalidad" puede pasarse a "Entrega" pero la dirección queda opcional sin validación en el cliente.
  - El cliente y la fecha en modo `infoOnly` se muestran como `<p>` debajo de un `<label htmlFor>` que apunta a un id inexistente (order-form.tsx:468-470, 489-491).
- **Redundancias:** con /pedidos/[id]/modificar (fecha y productos) y con el detalle.
- **Deuda UX ya registrada:** FORMS [F5B] editor de líneas; FORMS [F5B] sin cambio de precio.
- **Prioridad:** P2

### /pedidos/[id]/modificar
- **Ruta:** /pedidos/[id]/modificar → `OrderReplan` (order-replan.tsx:44-189)
- **Módulo:** Comercial › Pedidos
- **Roles que la usan:** `orders.replan` → ADMIN, OWNER, ADMINISTRATION, SALES (order-replan.tsx:178).
- **Objetivo principal:** cambiar fecha o productos de un pedido confirmado y ver antes/después de reservas, producción y materias primas antes de aplicar.
- **Acciones primarias:** "Aplicar cambios" (primario, order-replan.tsx:175-182).
- **Acciones secundarias:** "Cancelar" (link plano), "Agregar producto", "Quitar" por línea.
- **Información crítica:** fecha nueva vs "Antes", cobertura actual vs nueva (con número de revisión), reservas que se mantienen/liberan/nuevas (códigos de lote), tablas de cambio en Producción y Materia prima, tarjetas de cobertura por producto, tabla de materias primas.
- **Frecuencia esperada:** semanal.
- **Problemas encontrados:**
  - En un replan iniciado por ventas lo que importa es "¿llego con la fecha?"; la pantalla muestra todo el detalle de lotes y materias primas a la vez (order-replan.tsx:291-349).
  - "Cobertura actual (revisión N)" / "Cobertura nueva (revisión N)" (order-replan.tsx:299, 309): término técnico.
  - Las listas de lotes muestran sólo `l.code: cantidad de producto` con `formatQuantity(l.quantity, l.unit)` donde `l.unit` es un string (order-replan.tsx:243) — consistente, pero sin vencimiento ni depósito.
  - "Aplicar cambios" está deshabilitado sin explicación mientras no hay vista previa o falta permiso (order-replan.tsx:178).
  - Las líneas existentes no permiten cambiar producto y no se explica junto al selector bloqueado (order-form.tsx:154-156).
  - Pedido no modificable: enlace "Volver al pedido" con estilo del navegador (order-replan.tsx:55).
  - Errores de validación de la vista previa sólo marcan `requestedAt`; no se muestra mensaje junto al campo (order-replan.tsx:141, sin `describedBy`).
- **Redundancias:** con "Actualizar cobertura" del detalle (mismo endpoint `/replan`, order-pages.tsx:783) y con /editar.
- **Deuda UX ya registrada:** FORMS [F5A] la línea existente no cambia de producto; INFORMATION_ARCHITECTURE [F5A] cobertura con 8 métricas.
- **Prioridad:** P1

---

## 2. VENTAS

### /ventas
- **Ruta:** /ventas → `SaleList` (sale-pages.tsx:64-183)
- **Módulo:** Comercial › Ventas
- **Roles que la usan:** `sales.read` → ADMIN, OWNER, ADMINISTRATION, SALES, WAREHOUSE. "Nueva venta" con `sales.create` (sin WAREHOUSE). Columnas Total/Pendiente sólo con `price_lists.read` (WAREHOUSE no las ve); "Margen sobre materiales" con `sales.margin.read` (ADMIN, OWNER, ADMINISTRATION).
- **Objetivo principal:** consultar ventas del día/periodo, encontrar las pendientes de cobro, entrar a una venta; iniciar una venta nueva.
- **Acciones primarias:** "Nueva venta" (primario).
- **Acciones secundarias:** búsqueda; filtros Estado, Cobro, Origen, Cliente; Desde/Hasta; enlace en el código; paginación.
- **Información crítica:** código, fecha, cliente (+ código de pedido), estado, cobro, total, pendiente, margen.
- **Frecuencia esperada:** diaria.
- **Problemas encontrados:**
  - Filtro Cliente limitado a 100 clientes sin búsqueda (sale-pages.tsx:70-76; api-client.ts:89-95).
  - No hay totales del día (suma de ventas, cobrado, pendiente) ni filtro rápido "Hoy": para el cierre del mostrador hay que sumar a mano.
  - Estado por defecto "Todos los estados" (sale-pages.tsx:90): borradores y descartadas mezclados con las entregadas.
  - Columna "Margen sobre materiales" en el listado de ventas diario para ADMINISTRATION (sale-pages.tsx:171-179): costo/margen visible en una pantalla operativa.
  - Columna "Cobro" muestra "—" para borradores (sale-pages.tsx:151-152) y "Pendiente" "—" cuando está saldada: el guion significa cosas distintas.
  - Fila no clickeable, sólo el código.
  - Fechas con `formatWallClock` ("05/10/2026 14:30") mientras el detalle usa `formatDateTime` ("5/10/26, 14:30").
- **Redundancias:** Cuentas a cobrar muestra las ventas pendientes por cliente; el detalle del pedido lista sus ventas.
- **Deuda UX ya registrada:** TABLES [F3] rango de fechas común y `hide-sm`; TABLES [F4.5] demora de búsqueda; NAVIGATION [F5B] reagrupar.
- **Prioridad:** P1

### /ventas/nueva
- **Ruta:** /ventas/nueva (directa) y /ventas/nueva?orderId=… (entrega de pedido) → `NewSale` → `SaleForm` (sale-form.tsx:130-597)
- **Módulo:** Comercial › Ventas (mostrador y entrega de pedidos)
- **Roles que la usan:** `sales.create` → ADMIN, OWNER, ADMINISTRATION, SALES (la página no verifica el permiso en el cliente: sin permiso falla recién al guardar con "No tenés permiso para esta operación."). Precio visible con `price_lists.read`; edición de precio/descuento con `sales.price_override` (ADMIN, OWNER, ADMINISTRATION) (sale-form.tsx:218-219).
- **Objetivo principal:** registrar una venta de mostrador (Consumidor Final por defecto) o la entrega de un pedido.
- **Acciones primarias:** "Guardar y ver la entrega" (primario, sale-form.tsx:578-580).
- **Acciones secundarias:** "Agregar producto" (plano pequeño), "Quitar" (link-button), "Cancelar" (link plano).
- **Información crítica:** cliente, depósito, productos, cantidad, precio vigente y su origen, importe por línea, "Total estimado", notas.
- **Frecuencia esperada:** diaria (decenas de veces en mostrador).
- **Problemas encontrados:**
  - **Guardar no vende.** El botón guarda un borrador y lleva al detalle, donde hay que revisar la vista previa y confirmar (sale-form.tsx:318, 346; sale-pages.tsx:336-337). Una venta de mostrador exige 2 pantallas y 2 confirmaciones (ver Workflow).
  - Selector de producto `<select>` sin búsqueda, sin código, sin precio ni stock en la opción, limitado a 100 productos (sale-form.tsx:434-453; sale-form.tsx:121; api-client.ts:89-95). No hay lector de código de barras ni favoritos.
  - Selector de cliente sin búsqueda, limitado a 100 (sale-form.tsx:356-366). Riesgo: si "Consumidor Final" no está entre los 100 primeros, `customerId` queda "" (sale-form.tsx:220-223) y el `<select>` muestra visualmente el primer cliente aunque la venta se registrará al Consumidor Final (la API toma el walk-in con `customerId` nulo, apps/api/src/modules/sales/sales.service.ts:182). Lo que se ve no es lo que se guarda.
  - Depósito por defecto = primer depósito del catálogo (sale-form.tsx:226-228), no el depósito del mostrador; hay que verificarlo en cada venta.
  - Cantidad sin valor por defecto (placeholder "Ej.: 10", sale-form.tsx:463): para mostrador lo normal es 1 unidad.
  - Precio: con `sales.price_override` aparecen dos inputs (Precio + "Desc. $") y, si cambian, un tercero obligatorio "Motivo" (sale-form.tsx:473-501) dentro de la celda: la línea crece y en 768 px el producto queda angosto. Sin override, el precio se muestra con `formatMoney` y su origen; mientras resuelve, la celda queda vacía y el importe en "—" sin indicador de carga (sale-form.tsx:243-265, 520).
  - El "Total estimado" desaparece si alguna línea no tiene precio (sale-form.tsx:270-274, 550): no hay total hasta que todo resuelve.
  - Errores de la API de líneas se muestran por índice (`lines.${i}.…`), bien; pero "Revisá las cantidades." (sale-form.tsx:569-571) no indica cuál.
  - No hay vuelto, medio de pago ni cobro en esta pantalla: el cobro está en el diálogo de confirmación del detalle.
  - Venta desde pedido: el subtítulo es una oración larga con instrucciones (sale-form.tsx:343-347).
  - Diferencia con el pedido: la venta no permite elegir unidad (`unitId: null`, sale-form.tsx:96) mientras que el pedido sí (order-form.tsx:183-195).
- **Redundancias:** el subtítulo ya explica "después revisás la vista previa y confirmás", y el detalle lo repite en un `notice` (sale-pages.tsx:250-255).
- **Deuda UX ya registrada:** FORMS [F5B] selector de producto angosto en 768 px; FORMS [F5B] unificar editor de líneas; FORMS [F3] formato numérico es-AR.
- **Prioridad:** P0

### /ventas/[id]
- **Ruta:** /ventas/[id] → `SaleDetail` (sale-pages.tsx:192-345), con `SalePreview`/`PreviewView` (borrador), `SaleLines` y `SalePayments` (entregada), `PostSale` (sale-pages.tsx:665-830), `CancelSale` (sale-pages.tsx:832-863), `PaymentDialog` (sale-shared.tsx:88-255).
- **Módulo:** Comercial › Ventas
- **Roles que la usan:** `sales.read` → ADMIN, OWNER, ADMINISTRATION, SALES, WAREHOUSE. Confirmar (`sales.post`), Editar/Descartar (`sales.update`), Registrar cobro (`payments.create`+`payments.post`) → ADMIN, OWNER, ADMINISTRATION, SALES (sales.data.ts:407-412). Costos con `sales.cost.read`, margen con `sales.margin.read` → ADMIN, OWNER, ADMINISTRATION.
- **Objetivo principal:** confirmar la entrega (descontar stock), cobrar en el momento y consultar una venta ya hecha.
- **Acciones primarias:** "Confirmar entrega y venta" (primario, sale-pages.tsx:725-737) en borrador.
- **Acciones secundarias:** "Editar" (plano), "Descartar borrador" (peligro), "Registrar cobro" (plano, sale-shared.tsx:160-163) en entregadas con pendiente. Breadcrumb "← Ventas". No hay "Nueva venta" ni "Imprimir comprobante" tras confirmar.
- **Información crítica:** estado y cobro en el título; datos (cliente, pedido, depósito, entregada, creada, notas); totales (total, descuentos, cobrado, pendiente, costo material, margen); vista previa de lotes (FEFO) con faltantes; productos entregados con lotes; cobros aplicados; historial.
- **Frecuencia esperada:** diaria.
- **Problemas encontrados:**
  - **"Cobrar ahora" está desmarcado por defecto** (sale-pages.tsx:677, 755-764). En una venta de mostrador a Consumidor Final, confirmar sin tildarlo deja una deuda del Consumidor Final en cuenta corriente. El caso común (cobrar todo en efectivo) requiere una acción extra y el error fácil no está prevenido.
  - El botón "Confirmar entrega y venta" está habilitado mientras la vista previa carga (`disabled={preview ? !preview.canPost : false}`, sale-pages.tsx:728); si se abre el diálogo antes de que llegue, `due` es null y el bloque "Cobrar ahora" no aparece (sale-pages.tsx:687-690, 755).
  - Mismo rótulo en el botón de cabecera y en el botón del diálogo ("Confirmar entrega y venta", sale-pages.tsx:736 y 816).
  - El diálogo tiene 440 px de ancho (globals.css:569-576) y apila texto, avisos, checkbox y 3 campos; no calcula vuelto (sin campo "Paga con").
  - La vista previa siempre muestra "Lotes que salen" con códigos de lote, conservación y "stock libre"/"reservado" (sale-pages.tsx:347-375, 558, 584-591) a cualquier usuario, incluido el vendedor de mostrador: es información de depósito, no de venta. Sin `product_lots.read` (SALES) los códigos son texto plano sin significado.
  - Para ADMINISTRATION/OWNER, la pantalla de cobro muestra "Costo material" y "Margen" por línea y total (sale-pages.tsx:317-330, 567-576, 598-604, 618-631), y costo unitario por lote (sale-pages.tsx:369): datos sensibles a la vista del cliente en el mostrador.
  - Las columnas de costo/margen se ocultan por permiso (bien), pero `MarginText` devuelve "—" si `margin` es null (sale-shared.tsx:57) y `formatMoney(l.materialCost)` "—" si falta costo: huecos sin explicar.
  - Mensajes de la API en la vista previa con números sin formato es-AR: "faltan 2.5 kg", "quedan 3 por entregar" (sin unidad) (apps/api/src/modules/sales/sales.service.ts:560, 634, 646); avisos de crédito "saldo proyectado $ 12500.00 (límite $ 10000.00)" (sales.service.ts:1009), "Quedan $ 1500.00 de seña…" (sales.service.ts:1066). Se muestran tal cual en `Warnings`/`preview.issues` (sale-pages.tsx:249, 531-549, 748-754).
  - Error de la vista previa como `notice` con el mensaje crudo (sale-pages.tsx:513).
  - `CancelSale`: motivo obligatorio en la API (`cancelSaleSchema`, packages/shared/src/sales.ts:175) pero no validado; con motivo vacío aparece "Revisá los datos marcados." sin campo marcado (masters/ui.tsx:152; api-client.ts:62-63). Además el diálogo no tiene nombre accesible (IDREF con espacios, masters/ui.tsx:170).
  - Fechas: "Entregada"/"Creada"/cobros con `formatDateTime` ("5/10/26, 14:30", sale-pages.tsx:187-190, 493) vs listado con `formatWallClock`.
  - Tras confirmar no hay acción siguiente obvia ("Nueva venta", "Imprimir/enviar comprobante"): el usuario vuelve por breadcrumb.
  - "Editar" lleva a otra página que puede devolver "La venta ya no es un borrador" con un enlace sin estilo (sale-form.tsx:157-163).
- **Redundancias:** "Registrar cobro" aquí y "Registrar cobro a cuenta"+"Imputar" en cuenta corriente: dos caminos para cobrar una misma venta. Totales repetidos en "Datos de la venta" y en "Resumen de la entrega" del borrador.
- **Deuda UX ya registrada:** FORMS [F5B] no se puede elegir otro lote (LOT_PICKING_OVERRIDE); VISUAL_HIERARCHY [F2/F3] `cost-summary` para usos distintos; ACCESSIBILITY [F3] foco de `ConfirmAction`.
- **Prioridad:** P0

### /ventas/[id]/editar
- **Ruta:** /ventas/[id]/editar → `EditSale` (sale-form.tsx:149-166) → `SaleForm`
- **Módulo:** Comercial › Ventas
- **Roles que la usan:** `sales.update` → ADMIN, OWNER, ADMINISTRATION, SALES.
- **Objetivo principal:** corregir un borrador de venta antes de confirmarlo.
- **Acciones primarias:** "Guardar y ver la entrega" (primario).
- **Acciones secundarias:** "Cancelar", "Agregar producto", "Quitar".
- **Información crítica:** igual que /ventas/nueva.
- **Frecuencia esperada:** ocasional.
- **Problemas encontrados:** los de /ventas/nueva; venta no-borrador → panel vacío con enlace sin estilo (sale-form.tsx:159-162); el cliente queda editable salvo venta desde pedido, sin aviso de que cambia el precio vigente.
- **Redundancias:** con el detalle del borrador (la venta no se puede editar en línea).
- **Deuda UX ya registrada:** FORMS [F5B] editor de líneas.
- **Prioridad:** P2

---

## 3. CLIENTES

### /clientes
- **Ruta:** /clientes → `CustomerList` (masters/customers.tsx:34-59)
- **Módulo:** Comercial › Clientes
- **Roles que la usan:** `customers.read` → ADMIN, OWNER, ADMINISTRATION, SALES. "Nuevo cliente" con `customers.create` (mismos).
- **Objetivo principal:** buscar un cliente para ver sus datos, su cuenta, o dar de alta uno nuevo.
- **Acciones primarias:** "Nuevo cliente" (primario).
- **Acciones secundarias:** búsqueda, filtro de estado (Activos/Inactivos/Todos), enlace en el nombre, paginación.
- **Información crítica:** código, nombre, tipo, CUIT, teléfono, estado.
- **Frecuencia esperada:** semanal (diaria en un local con muchos mayoristas).
- **Problemas encontrados:**
  - No muestra saldo ni límite de crédito, ni accesos directos a "Nuevo pedido"/"Nueva venta"/"Cuenta corriente" del cliente.
  - En móvil se ocultan Tipo, CUIT y Teléfono (masters/customers.tsx:52-54): sólo quedan código, nombre y estado; el teléfono es el dato que más se busca.
  - `extraFilters={[]}` explícito y sin filtro por tipo de cliente (customers.tsx:45).
  - Sin subtítulo/explicación de "Consumidor Final" en el listado.
- **Redundancias:** Cuentas a cobrar es otro listado de clientes (con saldo).
- **Deuda UX ya registrada:** TABLES [F3] `hide-sm`; NAVIGATION [F5A]/[F5B] agrupar Pedidos/Ventas/Clientes.
- **Prioridad:** P1

### /clientes/nuevo
- **Ruta:** /clientes/nuevo → `CustomerForm` sin id (masters/customers.tsx:123-169), vía `EntityForm`
- **Módulo:** Comercial › Clientes
- **Roles que la usan:** `customers.create` → ADMIN, OWNER, ADMINISTRATION, SALES. Selector de lista de precios sólo con `price_lists.read`.
- **Objetivo principal:** dar de alta un cliente (minorista, mayorista, evento).
- **Acciones primarias:** "Crear cliente" (primario).
- **Acciones secundarias:** "Cancelar".
- **Información crítica:** código (auto), tipo, razón social, nombre comercial, CUIT/DNI, teléfono, email, dirección, localidad, provincia, CP, condición comercial, límite de crédito, lista de precios, observaciones (15 campos).
- **Frecuencia esperada:** semanal.
- **Problemas encontrados:**
  - 15 campos en una sola grilla sin agrupar (identificación / contacto / comercial) (customers.tsx:61-121); para un alta rápida desde el mostrador o un pedido sólo hacen falta nombre y teléfono.
  - SALES puede fijar el límite de crédito y la lista de precios del cliente (`customers.create`/`update`), aunque no puede administrar listas: decisión comercial expuesta a un rol operativo (dato de negocio, a validar).
  - No hay alta rápida embebida en pedido/venta (hay que salir del flujo).
  - Sin chequeo de duplicados por CUIT/teléfono visible antes de guardar.
- **Redundancias:** —
- **Deuda UX ya registrada:** FORMS [F3] input numérico es-AR (límite de crédito).
- **Prioridad:** P1

### /clientes/[id]
- **Ruta:** /clientes/[id] → `CustomerDetail` (masters/customers.tsx:171-241)
- **Módulo:** Comercial › Clientes
- **Roles que la usan:** `customers.read` → ADMIN, OWNER, ADMINISTRATION, SALES. Editar (`customers.update`), Cuenta corriente (`customer_accounts.read`), Desactivar/Reactivar (`customers.deactivate` → ADMIN, OWNER, ADMINISTRATION).
- **Objetivo principal:** ver la ficha del cliente y saltar a su cuenta corriente.
- **Acciones primarias:** ninguna primaria. "Editar", "Cuenta corriente" (planos), "Desactivar" (peligro) / "Reactivar" (plano): 2-3 botones al mismo peso.
- **Acciones secundarias:** —
- **Información crítica:** 11 datos (razón social, nombre comercial, CUIT, teléfono, email, dirección, localidad, condición comercial, límite de crédito, lista de precios, observaciones), historial de auditoría.
- **Frecuencia esperada:** semanal.
- **Problemas encontrados:**
  - La ficha no muestra saldo, pedidos abiertos ni últimas ventas: hay que ir a Cuenta corriente o filtrar Pedidos/Ventas por cliente (con el filtro limitado a 100).
  - No hay "Nuevo pedido para este cliente" ni "Nueva venta" (deep link con cliente preseleccionado inexistente).
  - Muestra "—" en todos los campos vacíos (masters/ui.tsx:113) y "Límite de crédito: —" cuando no tiene límite (formatMoney(null), customers.tsx:227), en vez de "Sin límite" como dice la cuenta corriente (account-pages.tsx:141).
  - El teléfono y el email no son enlaces (`tel:`/`mailto:`).
- **Redundancias:** con /cuentas-a-cobrar/[id] (dos fichas del mismo cliente: una con datos, otra con saldo; la de cuenta corriente también muestra el `AuditHistory` del cliente, account-pages.tsx:337).
- **Deuda UX ya registrada:** VISUAL_HIERARCHY [F5A] "—" en datos vacíos (registrado para pedido, aplica igual).
- **Prioridad:** P1

### /clientes/[id]/editar
- **Ruta:** /clientes/[id]/editar → `CustomerForm id`
- **Módulo:** Comercial › Clientes
- **Roles que la usan:** `customers.update` → ADMIN, OWNER, ADMINISTRATION, SALES.
- **Objetivo principal:** actualizar datos de contacto, condición comercial, límite o lista de precios.
- **Acciones primarias:** "Guardar cambios" (primario).
- **Acciones secundarias:** "Cancelar".
- **Información crítica:** mismos 14 campos (sin código).
- **Frecuencia esperada:** ocasional.
- **Problemas encontrados:** los del alta; título "Editar {razón social}" mientras el resto de la app muestra el nombre comercial (customers.tsx:143 vs 186); breadcrumb "Volver al cliente" en vez del nombre (customers.tsx:146); cambiar la lista de precios no avisa que no afecta pedidos ya confirmados.
- **Redundancias:** —
- **Deuda UX ya registrada:** —
- **Prioridad:** P2

---

## 4. LISTAS DE PRECIOS

### /listas-de-precios
- **Ruta:** /listas-de-precios → `PriceListList` (sales/price-list-pages.tsx:35-71)
- **Módulo:** Comercial › Listas de precios
- **Roles que la usan:** `price_lists.read` → ADMIN, OWNER, ADMINISTRATION, SALES. "Nueva lista" con `price_lists.manage` (ADMIN, OWNER, ADMINISTRATION).
- **Objetivo principal:** ver qué listas existen (general / por cliente) y entrar a cargar precios.
- **Acciones primarias:** "Nueva lista" (primario).
- **Acciones secundarias:** búsqueda, estado (Activas/Inactivas/Todos), enlace en código+nombre.
- **Información crítica:** lista, tipo (General/Por cliente), cantidad de productos, clientes, estado.
- **Frecuencia esperada:** ocasional.
- **Problemas encontrados:** no muestra fecha de última actualización (dato clave con inflación); el enlace mezcla código monoespaciado y nombre en el mismo `<a>` (price-list-pages.tsx:52-54).
- **Redundancias:** —
- **Deuda UX ya registrada:** NAVIGATION [F5B] reagrupar Comercial.
- **Prioridad:** P3

### /listas-de-precios/nuevo
- **Ruta:** /listas-de-precios/nuevo → `PriceListForm` (price-list-pages.tsx:245-372)
- **Módulo:** Comercial › Listas de precios
- **Roles que la usan:** `price_lists.manage` → ADMIN, OWNER, ADMINISTRATION (sin verificación en el cliente; SALES llega por URL y falla al guardar).
- **Objetivo principal:** crear una lista (nombre, código, general o no, activa, notas).
- **Acciones primarias:** "Guardar" (primario).
- **Acciones secundarias:** "Cancelar".
- **Información crítica:** nombre (obligatorio, marcado con *), código, general, activa, notas.
- **Frecuencia esperada:** ocasional.
- **Problemas encontrados:**
  - Marcar "Lista general" reemplaza a la general actual sin nombrarla ni pedir confirmación (price-list-pages.tsx:331-338).
  - No permite crear una lista copiando otra o aplicando un % sobre el precio del producto.
  - El error de código no tiene `aria-invalid` (price-list-pages.tsx:320-327), a diferencia del nombre.
- **Redundancias:** —
- **Deuda UX ya registrada:** —
- **Prioridad:** P3

### /listas-de-precios/[id]
- **Ruta:** /listas-de-precios/[id] → `PriceListDetail` + `PriceRow` (price-list-pages.tsx:73-243)
- **Módulo:** Comercial › Listas de precios
- **Roles que la usan:** `price_lists.read` → ADMIN, OWNER, ADMINISTRATION, SALES; edición en línea con `canManage` (ADMIN, OWNER, ADMINISTRATION).
- **Objetivo principal:** cargar y actualizar los precios de cada producto en la lista.
- **Acciones primarias:** ninguna primaria; "Editar" (plano) en la cabecera; por fila "Guardar" (pequeño, aparece al cambiar) y "Quitar de la lista" (link-button).
- **Acciones secundarias:** —
- **Información crítica:** nombre, estado, general, clientes asignados (sólo el número), código, notas, actualizada; tabla Producto · Precio del producto · Precio en la lista.
- **Frecuencia esperada:** semanal/mensual (actualizaciones de precio frecuentes en Argentina).
- **Problemas encontrados:**
  - La grilla trae todos los productos activos sin paginar ni buscar (apps/api/src/modules/price-lists/price-lists.service.ts:102-133; price-list-pages.tsx:134-143): con muchos productos la página es una tabla interminable sin filtro por categoría.
  - Guardado fila por fila: cada precio requiere escribir + "Guardar" (o Enter) (price-list-pages.tsx:200-219); no hay "Guardar todo" ni aumento masivo por %.
  - "Quitar de la lista" actúa al instante, sin confirmación ni deshacer (price-list-pages.tsx:220-231).
  - El estado de guardado no se ve: tras guardar se recarga toda la lista (`reload`, price-list-pages.tsx:80-83) sin mensaje "Guardado".
  - Sin `price_lists.manage`, la tabla mantiene la clase `line-editor` aunque es de solo lectura (price-list-pages.tsx:123).
  - No lista los clientes asignados (sólo el número; "se asigna desde la ficha del cliente", price-list-pages.tsx:97): para ver quiénes la usan hay que abrir cliente por cliente.
  - Tabla sin estado vacío si no hay productos.
- **Redundancias:** el precio del producto se edita también en Maestros › Productos.
- **Deuda UX ya registrada:** FORMS [F3] input numérico con formato es-AR; FORMS [F5B] `.line-editor`.
- **Prioridad:** P2

### /listas-de-precios/[id]/editar
- **Ruta:** /listas-de-precios/[id]/editar → `PriceListForm id`
- **Módulo:** Comercial › Listas de precios
- **Roles que la usan:** `price_lists.manage` → ADMIN, OWNER, ADMINISTRATION.
- **Objetivo principal:** renombrar, activar/desactivar o volver general una lista.
- **Acciones primarias:** "Guardar" (primario).
- **Acciones secundarias:** "Cancelar".
- **Información crítica:** nombre, general, activa, notas (el código no es editable y desaparece del formulario).
- **Frecuencia esperada:** ocasional.
- **Problemas encontrados:** desactivar es un checkbox "Activa" sin confirmación ni explicación de la consecuencia (clientes asignados pasan a la lista general) (price-list-pages.tsx:339-342); mismo problema con "Lista general".
- **Redundancias:** con el detalle (editar precios vs editar datos están en pantallas distintas).
- **Deuda UX ya registrada:** —
- **Prioridad:** P3

---

## 5. CUENTAS A COBRAR

### /cuentas-a-cobrar
- **Ruta:** /cuentas-a-cobrar → `ReceivableList` (sales/account-pages.tsx:58-112)
- **Módulo:** Finanzas › Cuentas a cobrar (en el menú está en Finanzas, lib/navigation.ts:112-118)
- **Roles que la usan:** `customer_accounts.read` → ADMIN, OWNER, ADMINISTRATION, SALES.
- **Objetivo principal:** ver quién debe (o tiene saldo a favor) y entrar a cobrarle.
- **Acciones primarias:** ninguna (no hay botón primario en la página).
- **Acciones secundarias:** búsqueda, filtro (Clientes que deben / Con saldo a favor / Todos con movimientos), enlace en el nombre.
- **Información crítica:** cliente + código, saldo ("Debe $…", "A favor $…"), ventas pendientes (cantidad), límite de crédito (con "· superado").
- **Frecuencia esperada:** diaria/semanal.
- **Problemas encontrados:**
  - No hay total adeudado global ni antigüedad de la deuda (días desde la venta más vieja): no permite priorizar a quién cobrar.
  - No hay acción "Registrar cobro" en la fila: siempre hay que entrar al cliente.
  - "Ventas pendientes" muestra un número sin enlace; en sm se oculta.
  - "Ventas pendientes" "—" y "Límite" "—" cuando no aplica: el guion significa "cero" en uno y "sin límite" en otro (account-pages.tsx:93, 105).
- **Redundancias:** con /clientes (otro listado de clientes) y con /ventas filtrando "Sin cobrar".
- **Deuda UX ya registrada:** NAVIGATION [F5B] Finanzas con módulos futuros; TABLES [F3] `hide-sm`.
- **Prioridad:** P1

### /cuentas-a-cobrar/[id]
- **Ruta:** /cuentas-a-cobrar/[id] → `CustomerAccount` (account-pages.tsx:114-340), `ApplyPayment` (342-405), `AdjustAccount` (407-522), `PaymentDialog` (sale-shared.tsx:88-255)
- **Módulo:** Finanzas › Cuentas a cobrar
- **Roles que la usan:** `customer_accounts.read` → ADMIN, OWNER, ADMINISTRATION, SALES. "Registrar cobro a cuenta" e "Imputar" con `payments.create`+`payments.post` (mismos). "Ajustar saldo" con `customer_accounts.adjust` (ADMIN, OWNER, ADMINISTRATION).
- **Objetivo principal:** registrar un cobro de un cliente con cuenta corriente y aplicarlo a sus ventas; consultar movimientos; corregir con ajustes.
- **Acciones primarias:** ninguna primaria: "Registrar cobro a cuenta" (plano, sale-shared.tsx:160-163) y "Ajustar saldo" (plano, account-pages.tsx:455) al mismo peso; "Imputar" por cobro (plano). Ajustar, una acción correctiva y excepcional, pesa lo mismo que cobrar.
- **Acciones secundarias:** "Anteriores/Siguientes" de movimientos.
- **Información crítica:** saldo, ventas pendientes (cantidad), crédito sin imputar; tabla de ventas pendientes (venta, fecha, total, cobrado, pendiente); cobros con crédito sin imputar; movimientos (Debe/Haber/Saldo); historial.
- **Frecuencia esperada:** semanal (diaria para mayoristas).
- **Problemas encontrados:**
  - Cobrar no salda ventas: "Registrar cobro a cuenta" deja crédito sin imputar y hay que "Imputar" cada cobro a cada venta por separado, con un diálogo cada vez (account-pages.tsx:146-153, 243-250, 342-405). Las ventas pendientes siguen figurando como pendientes después de cobrar hasta que se imputan.
  - El diálogo de cobro a cuenta no muestra el saldo ni propone el monto (sin `max` ni `defaultAmount`, account-pages.tsx:146-153).
  - La tabla de ventas pendientes no tiene acción "Cobrar" por fila (account-pages.tsx:200-212).
  - `ApplyPayment` guarda `saleId` y `amount` en `useState` inicializados una vez (account-pages.tsx:353-356). Tras imputar, si el mismo cobro conserva crédito, la fila se re-renderiza con la misma `key` y el estado apunta a una venta que ya no está pendiente: el `<select>` muestra visualmente otra opción y el envío usa el `saleId` viejo (error de la API o imputación a la venta equivocada).
  - `ApplyPayment` y `AdjustAccount`: errores de validación sólo como mensaje general (masters/ui.tsx:152); `ApplyPayment` no tiene nombre accesible (`aria-labelledby="Imputar-title"` funciona por no tener espacios, pero se repite el mismo id en cada fila → ids duplicados cuando hay varios cobros sin imputar, masters/ui.tsx:170-171).
  - Mensajes de la API con montos sin formato es-AR: "Al cobro C-0001 le quedan $ 1500.00 sin imputar." y "Sin imputar: $ 1500.00" (apps/api/src/modules/payments/payments.service.ts:404-407).
  - Fechas mezcladas en la misma página: ventas pendientes con `formatDateTime` ("5/10/26, 14:30", account-pages.tsx:207) y movimientos con `formatWallClock` ("05/10/2026 14:30", account-pages.tsx:285).
  - Jerga contable: "Debe"/"Haber", "Imputar", "Crédito sin imputar", "Saldo negativo: crédito a favor del cliente." (account-pages.tsx:272-276, 335). El saldo negativo en verde (`text-positive`, account-pages.tsx:303) contradice la convención del signo.
  - Los códigos de cobro se muestran como texto sin enlace (account-pages.tsx:239, 293): no existe una pantalla de cobro.
  - Ajuste: el tipo por defecto es "A favor del cliente (Haber)" (account-pages.tsx:417), que reduce la deuda; error de dirección fácil sin una vista previa del saldo resultante.
  - La cabecera no muestra teléfono/contacto del cliente para gestionar la cobranza.
  - `AuditHistory entityType="customer"` muestra cambios de la ficha del cliente, no de la cuenta (account-pages.tsx:337).
- **Redundancias:** "Registrar cobro" en /ventas/[id] cobra una venta directamente (con máximo = pendiente); aquí se cobra a cuenta y se imputa. Datos del cliente repartidos con /clientes/[id].
- **Deuda UX ya registrada:** WORKFLOW [F5B] imputar venta por venta → "imputar a las más viejas"; WORKFLOW [F5B] devolución de dinero (Caja).
- **Prioridad:** P1

---

## Hallazgos transversales

1. **Selectores de entidades sin búsqueda y truncados a 100.** `fetchOptions` pide `pageSize: 100` (lib/api-client.ts:89-95) y todas las pantallas comerciales lo usan para clientes y productos: sale-form.tsx:120-121, order-form.tsx:66-67, order-pages.tsx:77, sale-pages.tsx:70. Los ítems 101+ no aparecen en el `<select>`, sin aviso. Ninguno tiene búsqueda (combobox). Es el problema de mayor impacto en los flujos diarios.
2. **`ConfirmAction` nunca es primario** (masters/ui.tsx:160-163): las acciones que hacen avanzar el flujo (Confirmar pedido, Marcar listo, Pasar a preparación, Acordar precio, Imputar) tienen el mismo peso que Editar. `PaymentDialog` tampoco (sale-shared.tsx:160-163): "Registrar seña", "Registrar cobro", "Registrar cobro a cuenta" son planos.
3. **Diálogos sin nombre accesible / ids duplicados:** `aria-labelledby={`${label}-title`}` con rótulos que contienen espacios (masters/ui.tsx:170-171) y repetidos por fila (Imputar).
4. **Validación de diálogos:** `ConfirmAction` muestra sólo `err.message`; para `VALIDATION_ERROR` el mensaje es "Revisá los datos marcados." (lib/api-client.ts:61-63) pero nada queda marcado (Cancelar pedido, Descartar venta, Imputar). Campos `required` no se validan en el cliente.
5. **Números sin formato es-AR en mensajes de la API** que la UI muestra tal cual: `showQty` → "2.5" (apps/api/src/modules/sales/sales.service.ts:560, 634, 646, 804, 845, 850) y montos "$ 1234.50" (sales.service.ts:1009, 1066, 1077-1078; payments.service.ts:238-239, 397-398, 406-407; orders.service.ts:1522). Contradice `formatMoney`/`formatQuantity` del resto de la pantalla.
6. **Dos formatos de fecha/hora en la misma pantalla:** `formatWallClock` ("05/10/2026 14:30") vs `formatDateTime` con `Intl` es-AR `short` ("5/10/26, 14:30") — order-pages.tsx, sale-pages.tsx, account-pages.tsx (207 vs 285).
7. **Moneda ignorada:** `formatMoney` sin `currency` en order-pages.tsx (525, 530, 818, 872, 876, 884, 902, 920) y order-form.tsx:219, aunque el DTO trae `currency`.
8. **Enlaces con estilo del navegador** fuera de `.table` y `.details` (globals.css:388, 530, sin regla global para `a`): order-pages.tsx:914 (ventas del pedido), sale-form.tsx:161, order-form.tsx:329, order-replan.tsx:55.
9. **Información de depósito/producción/costos en pantallas comerciales:** lotes y FEFO en la confirmación de venta (sale-pages.tsx:347-375, 558), materias primas y proveedor sugerido en pedidos (order-pages.tsx:405-414; order-form.tsx:301-302), costo y margen en la pantalla de cobro para ADMINISTRATION/OWNER (sale-pages.tsx:317-330, 567-631).
10. **"—" como comodín:** `Details` (masters/ui.tsx:113), `formatMoney(null)` (lib/format.ts:410), `MarginText` (sale-shared.tsx:57), columnas de listados: el guion significa vacío, cero, sin límite, sin costo o no aplica según el lugar.
11. **Términos técnicos o contables a la vista:** "Revisión N"/"rev. N", "Plan vigente", "Invalidado", "Sin cubrir", "Ya comprometido", "Imputar", "Debe/Haber", "Crédito sin imputar", "Margen sobre materiales", "Costo material".
12. **Sin accesos rápidos al trabajo diario:** "Nueva venta" y "Nuevo pedido" sólo existen como botón en sus listados (sale-pages.tsx:87, order-pages.tsx:92); ni el inicio ni la ficha del cliente los ofrecen, y no hay deep link con el cliente preseleccionado.
13. **Fichas del cliente fragmentadas:** datos en /clientes/[id], saldo en /cuentas-a-cobrar/[id], pedidos y ventas en listados filtrables (filtro limitado a 100). No hay vista 360°.
14. **Permisos de páginas de alta no verificados en el cliente:** /ventas/nueva, /listas-de-precios/nuevo y editar, /clientes/nuevo cargan el formulario y fallan al guardar; sólo /pedidos/nuevo muestra "No tenés permiso" (order-form.tsx:461-462) y aun así después de cargar el catálogo.
15. **Estados de carga genéricos:** "Cargando…" en toda la página (masters/ui.tsx:90-96) mientras se cargan catálogos completos (el formulario de venta espera clientes, productos y depósitos antes de mostrar nada, sale-form.tsx:145).
16. **Flujo de pedido partido entre roles sin indicación:** SALES confirma y cobra seña, PRODUCTION pasa a preparación, WAREHOUSE marca listo, SALES entrega. La UI de SALES no indica "esperando que depósito lo marque listo".
17. **Selectores de fecha nativos** (`type="date"`/`type="time"`) en pedidos y filtros: formato del navegador.
18. **Editores de línea distintos** entre pedido (inputs nativos, unidad y conservación) y venta (`.line-editor`, sin unidad, con precio/descuento/motivo).

---

## Workflow venta mostrador — ANTES

Caso: venta directa de 2 productos a Consumidor Final, pagada en efectivo, por un usuario SALES (con `price_lists.read`, sin `sales.price_override`, sin costos). Se parte del menú lateral.

| # | Pantalla | Acción | Clics | Código |
|---|---|---|---|---|
| 1 | cualquier | Menú › Comercial › "Ventas" | 1 (2 en ≤768 px: abrir menú) | lib/navigation.ts:100 |
| 2 | **/ventas** (pantalla 1) | "Nueva venta" | 1 | sale-pages.tsx:86-88; master-list.tsx:131 |
| 3 | **/ventas/nueva** (pantalla 2) | Espera "Cargando…" hasta tener clientes + productos + depósitos | 0 | sale-form.tsx:116-128, 145 |
| 4 | | Cliente: queda "Consumidor Final" (walk-in) si está entre los 100 primeros | 0 | sale-form.tsx:220-223 |
| 5 | | Depósito: queda el primero del catálogo; hay que verificar que sea el del mostrador (si no, 2 clics) | 0–2 | sale-form.tsx:226-228, 374-384 |
| 6 | | Producto 1: abrir `<select>` y elegir (sin búsqueda; scroll en hasta 100 productos) | 2 | sale-form.tsx:434-453 |
| 7 | | Cantidad 1: foco + tipear (vacía, no 1 por defecto) | 1 + teclado | sale-form.tsx:459-466 |
| 8 | | "Agregar producto" | 1 | sale-form.tsx:541-549 |
| 9 | | Producto 2: abrir y elegir | 2 | ídem 6 |
| 10 | | Cantidad 2: foco + tipear | 1 + teclado | ídem 7 |
| 11 | | (El precio se resuelve solo; se muestra "Total estimado" cuando todas las líneas tienen precio) | 0 | sale-form.tsx:243-265, 550-557 |
| 12 | | "Guardar y ver la entrega" → crea un **borrador** | 1 | sale-form.tsx:578-580, 309-318 |
| 13 | **/ventas/[id]** (pantalla 3) | Se lee: aviso de borrador, "Datos de la venta", "Vista previa de la entrega" con tabla **Lotes que salen** (código de lote, conservación, "stock libre"), "Falta", importes | 0 | sale-pages.tsx:250-255, 269-337, 518-661 |
| 14 | | "Confirmar entrega y venta" (cabecera) → abre diálogo | 1 | sale-pages.tsx:725-737 |
| 15 | diálogo | Tildar "Cobrar ahora" (**desmarcado por defecto**). El monto viene precargado con el total y el medio es "Efectivo" | 1 | sale-pages.tsx:677, 732, 755-764 |
| 16 | diálogo | "Confirmar entrega y venta" (mismo rótulo que el paso 14) | 1 | sale-pages.tsx:810-817 |
| 17 | /ventas/[id] | La página se actualiza a "Entregada · Cobrada". Para la venta siguiente: "← Ventas" + "Nueva venta" | 2 | sale-pages.tsx:213 |

**Totales (desde /ventas hasta venta cobrada):** 12 clics mínimos (pasos 2, 6×2, 7, 8, 9×2, 10, 12, 14, 15, 16) + 2 entradas de teclado; 14–16 si hay que corregir el depósito o se cuenta el menú. **3 pantallas** (listado → formulario → detalle) con **2 navegaciones** + **1 diálogo modal**. Volver a empezar: +2 clics y 2 navegaciones más.

**Campos obligatorios:** producto y cantidad por línea (sale-form.tsx:280-284). Cliente y depósito vienen precargados pero son editables y no hay forma de fijarlos para el puesto. En el cobro: monto (precargado).

**¿Ve lotes/FEFO/costos?** Sí ve lotes y FEFO: la vista previa (`FEFO_SALE_HINT` "Se utilizarán los lotes más próximos a vencer", sale-pages.tsx:529) y la columna "Lotes que salen" se muestran a todos. SALES ve códigos de lote como texto sin enlace. Si el usuario del mostrador es ADMINISTRATION/OWNER, además ve **Costo material**, **Margen** y costo unitario por lote en la vista previa y en el detalle (sale-pages.tsx:317-330, 369, 567-631), que puede quedar a la vista del cliente.

**Acciones redundantes o de riesgo:**
- Guardar borrador + revisar vista previa + confirmar: dos pasos de confirmación para una venta en la que no se elige nada (los lotes salen por FEFO automático y no se pueden cambiar, deuda LOT_PICKING_OVERRIDE).
- "Confirmar entrega y venta" dos veces (cabecera y diálogo).
- "Cobrar ahora" debe tildarse siempre en mostrador; si se olvida, la venta queda "Sin cobrar" y genera deuda del Consumidor Final en cuenta corriente (sale-pages.tsx:700-711 envía `{}` sin `initialPayment`).
- Si se hace clic en "Confirmar entrega y venta" antes de que cargue la vista previa, el bloque de cobro no aparece (sale-pages.tsx:728, 755).
- No hay cálculo de vuelto ni comprobante al final.

---

## Workflow pedido catering — ANTES

Caso: SALES carga un pedido de catering para un cliente existente, con fecha de entrega, 2 productos, lo confirma y registra una seña en efectivo.

| # | Pantalla | Acción | Clics | Código |
|---|---|---|---|---|
| 1 | cualquier | Menú › Comercial › "Pedidos" | 1 | lib/navigation.ts:98 |
| 2 | **/pedidos** (pantalla 1) | "Nuevo pedido" | 1 | order-pages.tsx:91-93 |
| 3 | **/pedidos/nuevo** (pantalla 2) | Cliente: abrir `<select>` y elegir (sin búsqueda, máx. 100; obligatorio, sin cliente por defecto) | 2 | order-form.tsx:472-484, 398 |
| 4 | | Fecha: por defecto mañana 10:00; cambiar fecha (picker nativo) | 1–2 | order-form.tsx:351; order-shared.tsx:91-98 |
| 5 | | Hora: cambiar | 1 + teclado | order-shared.tsx:99-105 |
| 6 | | Modalidad: "Retira" por defecto; para catering con envío → "Entrega" (2) + Dirección (1 + teclado) | 0–3 | order-form.tsx:504-530 |
| 7 | | Evento / Contacto / Teléfono / Prioridad / Notas (opcionales) | 0–n | order-form.tsx:531-580 |
| 8 | | Producto 1: abrir y elegir (sin búsqueda, máx. 100) | 2 | order-form.tsx:157-169 |
| 9 | | Cantidad 1 (unidad = unidad de venta por defecto; conservación "Indistinto") | 1 + teclado | order-form.tsx:175-195, 202-216 |
| 10 | | "Agregar producto" | 1 | order-form.tsx:237 |
| 11 | | Producto 2 + cantidad 2 | 3 + teclado | ídem |
| 12 | | La vista previa de cobertura aparece sola (tarjetas de 8 métricas por producto + materias primas) | 0 | order-form.tsx:375-382, 610-621 |
| 13 | | "Guardar borrador" | 1 | order-form.tsx:629-631 |
| 14 | **/pedidos/[id]** (pantalla 3, borrador) | Se repite la vista previa de cobertura | 0 | order-pages.tsx:397-398, 422-429 |
| 15 | | "Confirmar pedido" (botón **plano**, junto a Registrar seña, Editar y Cancelar) → diálogo | 1 | order-pages.tsx:267, 729-760; masters/ui.tsx:162 |
| 16 | diálogo | "Confirmar pedido" (el precio se acuerda solo al confirmar) | 1 | masters/ui.tsx:180-186; apps/api/.../orders.service.ts:952 |
| 17 | /pedidos/[id] (confirmado) | "Registrar seña" (plano) → diálogo | 1 | order-pages.tsx:255-266; sale-shared.tsx:160-167 |
| 18 | diálogo | Monto (vacío, sin referencia al total acordado ni máximo): foco + tipear | 1 + teclado | sale-shared.tsx:175-194 |
| 19 | diálogo | Medio "Efectivo" por defecto; "Registrar cobro" | 1 | sale-shared.tsx:113, 235-242 |

**Totales:** ~17 clics mínimos (pasos 2, 3×2, 4, 5, 8×2, 9, 10, 11×3, 13, 15, 16, 17, 18, 19) + 5 entradas de teclado (hora, 2 cantidades, monto; más dirección/contacto si aplica); 20+ con modalidad Entrega y contacto. **3 pantallas** (listado → formulario → detalle) con **2 navegaciones** + **2 diálogos**.

**Campos obligatorios:** cliente, fecha y hora, producto y cantidad por línea (order-form.tsx:395-405). Ninguno se marca como obligatorio en la UI. En la seña: monto.

**¿Ve lotes/FEFO/costos?** Ve cobertura, lotes (en `<details>` "Lotes (N)" con código, conservación, físico, comprometido, reservado, "Sirve/Vence antes"), receta y materias primas con proveedor sugerido, tanto en el alta como en el detalle del borrador (order-shared.tsx:118-300). Tras confirmar, el detalle suma "Lotes reservados", "Producción necesaria" y "Materias primas necesarias" (order-pages.tsx:401-414). No ve costos (no se muestran en pedidos). El "Precio actual" del formulario es el del producto, no el que se acordará (order-form.tsx:219).

**Acciones redundantes o de riesgo:**
- La vista previa de cobertura se muestra dos veces (formulario y detalle del borrador).
- Guardar borrador y confirmar son dos pasos separados aunque el usuario ya revisó la vista previa; no existe "Guardar y confirmar".
- La seña no se puede cargar en el alta; y en el detalle se ofrece incluso en borrador, antes de que haya precio acordado.
- El diálogo de seña no muestra el total acordado: el vendedor tiene que buscarlo en "Precio, señas y ventas" más abajo en la página.
- Después de confirmar, el vendedor no puede avanzar: "Marcar listo" es de WAREHOUSE y "Entregar y vender" sólo aparece en READY; la pantalla no le dice que el siguiente paso depende de otro rol.

---

## Workflow cobro — ANTES

Caso: un cliente con cuenta corriente paga en efectivo y el usuario (SALES) lo registra desde la cuenta del cliente, aplicándolo a su venta pendiente.

| # | Pantalla | Acción | Clics | Código |
|---|---|---|---|---|
| 1 | cualquier | Menú › Finanzas › "Cuentas a cobrar" | 1 | lib/navigation.ts:112-118 |
| 2 | **/cuentas-a-cobrar** (pantalla 1, filtro "Clientes que deben") | Buscar el cliente: foco + tipear (espera de 300 ms) | 1 + teclado | account-pages.tsx:58-74; master-list.tsx:103-108 |
| 3 | | Clic en el nombre del cliente | 1 | account-pages.tsx:79-81 |
| 4 | **/cuentas-a-cobrar/[id]** (pantalla 2) | Leer saldo, ventas pendientes, movimientos | 0 | account-pages.tsx:162-217 |
| 5 | | "Registrar cobro a cuenta" (plano, al lado de "Ajustar saldo") → diálogo | 1 | account-pages.tsx:145-154 |
| 6 | diálogo | Monto: vacío, sin saldo ni máximo de referencia → foco + tipear | 1 + teclado | sale-shared.tsx:175-194 |
| 7 | diálogo | Medio "Efectivo" por defecto; "Registrar cobro" | 1 | sale-shared.tsx:113, 235-242 |
| 8 | /cuentas-a-cobrar/[id] | El saldo baja, pero la venta sigue en "Ventas pendientes de cobro" y aparece "Cobros con crédito sin imputar" | 0 | account-pages.tsx:179-258 |
| 9 | | "Imputar" en la fila del cobro → diálogo | 1 | account-pages.tsx:243-250, 360-373 |
| 10 | diálogo | Venta: la primera pendiente preseleccionada (si es otra: 2 clics); monto sugerido = mín(pendiente, disponible) | 0–2 | account-pages.tsx:353-356, 376-391 |
| 11 | diálogo | "Imputar" | 1 | masters/ui.tsx:180-186 |
| 12 | | Repetir 9-11 por cada venta adicional a saldar | +2–4 por venta | — |

**Totales (1 venta):** 7–9 clics + 2 entradas de teclado; **2 pantallas** (1 navegación desde el listado) + **2 diálogos**. Con N ventas: +2–4 clics y 1 diálogo por venta adicional. Desde la ficha del cliente: /clientes/[id] → "Cuenta corriente" (1 clic) reemplaza los pasos 1-3.

**Camino alternativo:** /ventas/[id] → "Registrar cobro" (con monto precargado = pendiente y máximo validado, sale-pages.tsx:231-244) cobra y aplica en un paso, pero hay que ir venta por venta, y un excedente obliga a volver a la cuenta corriente ("Registrá el excedente como cobro a cuenta…", sale-pages.tsx:238).

**Campos obligatorios:** monto (cobro) y venta + monto (imputación). Medio de pago con valor por defecto.

**¿Ve lotes/FEFO/costos?** No en la cuenta corriente. Sí si entra a la venta (ver venta mostrador).

**Acciones redundantes o de riesgo:**
- Dos pasos (cobrar + imputar) para el caso común "paga la venta X"; las ventas no quedan cobradas hasta imputar.
- No hay "Cobrar" por fila en "Ventas pendientes de cobro" ni "imputar a las más viejas".
- Estado del diálogo "Imputar" que no se reinicia tras una imputación (account-pages.tsx:353-356): riesgo de imputar a una venta ya saldada o de error.
- "Ajustar saldo" con el mismo peso que cobrar y "A favor del cliente" por defecto (account-pages.tsx:417, 455).
- Mensajes de error con montos "$ 1500.00" (payments.service.ts:404-407).
