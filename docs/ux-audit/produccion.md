# Auditoría UX — Producción, Planificación (Necesidades) y Recetas

Alcance: `apps/web/src/app/(app)/{produccion,necesidades,recetas}/**/page.tsx`,
`components/production/*`, `components/recipes/*`, `components/orders/planning-pages.tsx`
(más los componentes compartidos que usan: `components/masters/ui.tsx`, `master-list.tsx`,
`lib/api-client.ts`, `lib/format.ts`, `components/orders/order-shared.tsx`).

Rutas de archivos abreviadas:
- `PP` = `apps/web/src/components/production/production-pages.tsx`
- `PF` = `apps/web/src/components/production/production-form.tsx`
- `PS` = `apps/web/src/components/production/production-shared.tsx`
- `PL` = `apps/web/src/components/orders/planning-pages.tsx`
- `RP` = `apps/web/src/components/recipes/recipe-pages.tsx`
- `RE` = `apps/web/src/components/recipes/recipe-editor.tsx`
- `CV` = `apps/web/src/components/recipes/cost-views.tsx`
- `UI` = `apps/web/src/components/masters/ui.tsx`
- `ML` = `apps/web/src/components/masters/master-list.tsx`
- `AC` = `apps/web/src/lib/api-client.ts`

Ninguna ruta tiene guarda de permisos propia: `app/(app)/layout.tsx` sólo exige sesión. El menú
(`lib/navigation.ts:70-78`) oculta las entradas, pero si alguien entra por URL ve el encabezado y los
filtros y recién después un "No se pudo cargar / No tenés permiso para esta operación" (`UI:98-105`).

---

## 1. `/necesidades` — Necesidades → Producción

- **Ruta:** `/necesidades` (`app/(app)/necesidades/page.tsx` → `ProductionNeeds`, `PL:160-247`)
- **Módulo:** Planificación → Necesidades
- **Roles que la usan:** `order_planning.read` → ADMIN, OWNER, ADMINISTRATION, PRODUCTION. El botón
  "Crear orden" exige `order_production.create` + `production_orders.create` (`PL:168`) → ADMIN, OWNER,
  PRODUCTION. ADMINISTRATION sólo consulta.
- **Objetivo principal:** saber qué hay que hornear (por producto y cantidad) para cubrir los pedidos
  confirmados que no alcanzan con el stock reservado, y lanzar la orden de producción de cada uno.
- **Acciones primarias:** "Crear orden" (un `Link.button--small` por cada necesidad de cada pedido,
  `PL:220-230`).
- **Acciones secundarias:** pestañas Producción · Materias primas · Pedidos en riesgo (`PL:86-97`);
  horizonte "Entregas hasta" (fecha + hora) + "Aplicar horizonte" + "Sin horizonte" (`PL:99-123`);
  enlaces al pedido (`PL:207`) y a la orden ya creada (`PL:215`).
  Peso visual: "Aplicar horizonte", "Sin horizonte" y todos los "Crear orden" son el mismo
  `button--small` neutro; con N pedidos hay N botones idénticos sin jerarquía. Además `.table a`
  (`globals.css:388`) pisa el color del botón dentro de la tabla (texto en color primario, negrita).
- **Información crítica:** producto, cantidad a producir, "sin receta" en rojo, primera entrega,
  pedidos con cantidad y estado/problema de cada necesidad.
- **Frecuencia esperada:** diaria (varias veces al día en temporada), rol PRODUCCIÓN.
- **Problemas encontrados:**
  - Fecha/hora inconsistente dentro del mismo módulo: "Primera entrega" usa `formatDateTime`
    (Intl es-AR `dateStyle: short` → "5/10/26, 10:00", año de 2 dígitos) en `PL:202`, mientras que
    "Pedidos en riesgo" y la leyenda del horizonte usan `formatWallClock` ("05/10/2026 10:00") en
    `PL:137` y `PL:381`.
  - La fecha de entrega de cada pedido no se ve: sólo la "primera entrega" del producto (`PL:202`). Para
    decidir qué orden lanzar primero hay que entrar a cada pedido.
  - Necesidad con problema "Sin receta activa" / "La receta no se puede escalar" (`PL:209-211`,
    `REQUIREMENT_PROBLEM_LABELS`): callejón sin salida, no hay enlace a "Crear receta" ni a la receta.
  - Cuando ya hay orden (`PRODUCTION_CREATED`) se muestra el código OP pero no su estado
    (borrador/planificada/en curso) (`PL:212-219`): no se sabe si "ya se está haciendo".
  - Horizonte: exige elegir fecha **y** hora con inputs nativos y luego "Aplicar" (`PL:103-111`); no
    hay atajos "Hoy / Mañana / Esta semana", que son el uso diario. El `<label htmlFor="horizon">`
    apunta sólo al input de fecha; el de hora tiene `aria-label="Hora"` (`order-shared.tsx:99-104`).
  - Tope de 100 filas (`PL:147`) con aviso "Acotá el horizonte" (`PL:150-156`): no hay paginación.
  - Estado de carga al cambiar el horizonte: `useResource` conserva los datos viejos mientras carga los
    nuevos (`UI:23-48` no limpia `data` al cambiar `path`), así que la tabla anterior queda visible sin
    indicador → el usuario puede actuar sobre datos del horizonte anterior.
  - Vacío genérico: "No hay nada para producir: los pedidos están cubiertos." (`PL:172`) aunque haya un
    horizonte aplicado (no lo menciona).
  - Lista de pedidos dentro de la celda crece sin límite (`PL:204-233`).
  - "Crear orden" no lleva el contexto del horizonte ni vuelve a Necesidades al terminar: el alta
    redirige al detalle de la orden (`PF:363`).
- **Redundancias:** el mismo "Crear orden" existe en el detalle del pedido
  (`components/orders/order-pages.tsx:712`). El texto al pie sobre consolidación (`PL:241-244`)
  repite la deuda `PRODUCTION_CONSOLIDATION`.
- **Deuda UX ya registrada:** NAVIGATION [F5A] pestañas por enlace con horizonte en URL;
  TABLES [F5A] pedidos dentro de la celda; WORKFLOW [F5A] `PRODUCTION_CONSOLIDATION`;
  FORMS [F5A] `WallClockInput` con selector nativo; DASHBOARD [F5A] (pedidos de hoy/mañana).
- **Prioridad:** **P0**.

## 2. `/necesidades/materias-primas` — Necesidades → Materias primas

- **Ruta:** `/necesidades/materias-primas` (`MaterialNeeds`, `PL:251-337`)
- **Módulo:** Planificación → Necesidades
- **Roles que la usan:** `order_planning.read` → ADMIN, OWNER, ADMINISTRATION, PRODUCTION. **COMPRAS
  (PURCHASING) no tiene `order_planning.read`**: el rol que tiene que actuar sobre "Falta comprar" no
  puede ver esta pantalla (docs/PERMISSIONS.md, fila `order_planning.read`).
- **Objetivo principal:** proyectar cuánta materia prima piden los pedidos confirmados y cuánto falta
  comprar.
- **Acciones primarias:** ninguna (sólo lectura).
- **Acciones secundarias:** horizonte (igual que §1), checkbox "Sólo con faltante" (`PL:124-133`),
  enlaces a pedidos (`PL:321`).
- **Información crítica:** stock actual, necesidad comprometida, queda, **falta comprar** (rojo),
  proveedor sugerido, pedidos.
- **Frecuencia esperada:** diaria/semanal (planificación de compras).
- **Problemas encontrados:**
  - No hay acción "Comprar" por fila ni "Comprar todo lo que falta", aunque el detalle de orden sí tiene
    "Comprar" (`PS:121-130`). La pantalla informa el faltante pero no deja resolverlo.
  - La materia prima no es enlace (`PL:309`) a su ficha de stock (en la tabla de disponibilidad sí lo
    es, `PS:110`).
  - "Proveedor sugerido" y "Pedidos" se ocultan en `hide-md` (`PL:296-301`) y "Queda" en `hide-sm`: en
    tablet desaparece justo el dato para comprar.
  - Stock "total de la empresa" (`PL:333`), mientras que la orden de producción mide por depósito de
    origen (`PS:72`): las cifras no coinciden entre pantallas sin explicación visible en la tabla.
  - Mismos problemas de horizonte, tope de 100 y carga silenciosa que §1.
  - Vacío: dos mensajes según el filtro (`PL:270-275`), correctos pero sin mencionar el horizonte.
- **Redundancias:** se solapa con "Bajo mínimo" de Inventario y con la tabla de disponibilidad de cada
  orden (`PS:64-143`).
- **Deuda UX ya registrada:** WORKFLOW [F3] "Desde Bajo mínimo se crea una compra de a una materia
  prima; agrupar por proveedor"; WORKFLOW [F4] "Comprar todo lo que falta"; TABLES [F3] `hide-sm`.
- **Prioridad:** **P1**.

## 3. `/necesidades/en-riesgo` — Necesidades → Pedidos en riesgo

- **Ruta:** `/necesidades/en-riesgo` (`OrdersAtRisk`, `PL:341-401`)
- **Módulo:** Planificación → Necesidades
- **Roles que la usan:** `order_planning.read` → ADMIN, OWNER, ADMINISTRATION, PRODUCTION. VENTAS y
  DEPÓSITO tienen `orders.read`, pero no ven esta lista.
- **Objetivo principal:** detectar a tiempo los pedidos que no se van a poder entregar completos.
- **Acciones primarias:** ninguna; sólo el enlace al pedido (`PL:370-372`).
- **Acciones secundarias:** horizonte.
- **Información crítica:** pedido, estado, prioridad, entrega, cliente, cobertura, problemas.
- **Frecuencia esperada:** diaria.
- **Problemas encontrados:**
  - No hay acciones en la fila ("Crear orden", "Comprar"): hay que ir al pedido y desde ahí a la
    necesidad.
  - El badge de prioridad lleva un espacio dentro del `<span>` (`PL:375-378`), así que el badge
    arranca con un hueco.
  - "Cliente" en `hide-sm` (`PL:359`). La columna "Problemas" muestra el `message` de la API
    (`PL:389`); está en castellano, pero el texto lo arma el servidor y no se ve en el código.
  - Vacío "Ningún pedido en riesgo: todos están cubiertos." (`PL:350`) aunque haya horizonte.
  - Sin orden por urgencia visible (depende de la API) ni conteo en la pestaña.
- **Redundancias:** el detalle del pedido muestra los mismos avisos.
- **Deuda UX ya registrada:** DASHBOARD [F5A] (pedidos en riesgo en el inicio).
- **Prioridad:** **P1**.

---

## 4. `/produccion` — Órdenes de producción (listado)

- **Ruta:** `/produccion` (`ProductionList`, `PP:64-163`, sobre `MasterList`)
- **Módulo:** Producción → Órdenes
- **Roles que la usan:** `production_orders.read` → ADMIN, OWNER, ADMINISTRATION, PRODUCTION.
  "Nueva orden": `production_orders.create` → ADMIN, OWNER, PRODUCTION. Columna "Costo real":
  `production.cost.read` → ADMIN, OWNER, ADMINISTRATION.
- **Objetivo principal:** ver qué hay que producir hoy, qué está en curso y qué se terminó, y entrar a
  la orden.
- **Acciones primarias:** "Nueva orden" (`ML:130-134`, primaria); clic en el código de la orden
  (`PP:120-122`).
- **Acciones secundarias:** búsqueda, filtro de estado, filtro de producto, filtro de responsable,
  Desde/Hasta (`PP:93-115`), Anterior/Siguiente.
- **Información crítica:** orden, producto, versión de receta, fecha, estado, planificado, producido,
  lote, responsable, costo real (hasta 10 columnas).
- **Frecuencia esperada:** diaria, varias veces (es la puerta de entrada para iniciar y completar).
- **Problemas encontrados:**
  - El filtro por defecto es "Todos los estados" (`PP:92`), no "Pendientes" ni "hoy": el uso diario
    exige cambiar el filtro en cada visita (queda en la URL, pero no al entrar desde el menú).
  - No hay columna "Pedido" ni indicador de que la orden fue creada para un pedido: desde el listado no
    se sabe para quién ni para cuándo se produce.
  - Filtro "Producto": `<select>` alimentado por `fetchOptions` con tope silencioso de 100 registros
    (`AC:90-96`, `PP:69-75`), sin búsqueda. Lo mismo "Responsable" (`PP:76-78`).
  - Los errores de carga de filtros se tragan: `.catch(() => setProducts([]))` (`PP:75`, `PP:78`), y el
    selector queda vacío sin aviso.
  - Fechas "Desde/Hasta" con `input type=date` nativo (`ML:181-189`).
  - Estado vacío: `ML:198` sólo distingue búsqueda. Con un filtro de estado, producto o fecha sin
    resultados muestra "Todavía no hay órdenes de producción." (`PP:91`), lo cual es falso y no ofrece
    "Limpiar filtros" ni "Nueva orden".
  - "Receta" muestra sólo "v3" (`PP:128`).
  - Columna "Producido" sólo para completadas (`PP:141-143`); para en curso con salida cargada muestra
    "—" aunque el detalle muestra "(cargado)".
  - Sin agrupación por estado; 9-10 columnas con `hide-sm/hide-md`.
  - El `<title>` es estático ("Órdenes · Producción") y no refleja el filtro.
- **Redundancias:** la ficha de stock del producto tiene "Producciones" con "Ver todas"
  (`inventory/product-stock-pages.tsx:352`) que lleva aquí con `productId`.
- **Deuda UX ya registrada:** TABLES [F4] 9 columnas / agrupar por estado; TABLES [F3] filtros de
  fecha y rango común; TABLES [F4.5] búsqueda con 300 ms; FORMS [F4] `input type=date`;
  NAVIGATION [F4] Órdenes antes que Recetas; DASHBOARD [F4].
- **Prioridad:** **P0**.

## 5. `/produccion/nueva` — Nueva orden de producción

- **Ruta:** `/produccion/nueva` (`ProductionForm`, `PF:124-686`); acepta `?requirementId=` (desde
  Necesidades o Pedido) y `?productId=` (desde la ficha de stock).
- **Módulo:** Producción → Órdenes
- **Roles que la usan:** `production_orders.create` (+ `order_production.create` si viene de una
  necesidad, `PF:375-377`) → ADMIN, OWNER, PRODUCTION. La vista previa (`/preview`) exige
  `production_orders.create`. Costos de la vista previa sólo con `production.cost.read` (ADMIN, OWNER).
  El enlace "Comprar" exige `purchases.create` (ADMIN, OWNER, PURCHASING; **PRODUCCIÓN no lo ve**).
- **Objetivo principal:** decidir qué producir, cuánto, cuándo y con qué depósitos, verificando antes
  la receta y si alcanza la materia prima.
- **Acciones primarias:** "Crear borrador" (`PF:608-610`, primaria).
- **Acciones secundarias:** "Cancelar" (`PF:611-616`), enlace al pedido en el aviso (`PF:413`),
  "Comprar" por faltante dentro de la vista previa (`PS:121-130`), enlaces a materias primas
  (`PS:110`).
- **Información crítica:** producto, fecha, cantidad y unidad, receta o versión, depósitos,
  responsable, lote, notas; vista previa con receta, rinde por tanda, escala, avisos, disponibilidad y
  costo esperado. Desde un pedido: aviso con código, faltante y fecha de entrega (`PF:410-419`).
- **Frecuencia esperada:** diaria.
- **Problemas encontrados:**
  - `<select>` de **Producto** sin búsqueda y con tope silencioso de 100 (`PF:71`, `PF:427-442`;
    `AC:90-96`). Una panadería supera 100 productos con facilidad y los que pasan de ese número no
    aparecen.
  - `<select>` de Responsable y de depósitos sin búsqueda (`PF:524-572`). Los depósitos están bien por
    volumen; los responsables pueden crecer.
  - Errores de carga del catálogo tragados: `.catch(() => setRest({ products: [], … }))` (`PF:82`) y
    `useUnits` (`PS:50`). El formulario aparece con selectores vacíos y sin mensaje.
  - Depósitos por defecto = **el primero de la lista** (`PF:194`, `PF:229-230`), sin indicarlo.
  - "Comprar" en la vista previa navega a `/compras/nueva` (`PS:124-128`) y **pierde el formulario sin
    guardar**: no se avisa ni se abre en otra pestaña.
  - Sin marca de obligatorios (el editor de recetas usa `*`, `RE:386-389`), lo que es inconsistente.
  - Fecha con `input type=date` nativo (`PF:451-456`).
  - Formato de la entrega con `formatLocalDateTime` de `@bakery/shared` (`PF:416`), un tercer
    formateador distinto de `formatDateTime` (detalle, `PP:363`) y `formatWallClock` (Necesidades).
  - Si la API devuelve un error de validación sobre un campo que no está en pantalla (p. ej.
    `sourceOrderRequirementId`), el mensaje es "Revisá los datos marcados." (`AC:61-64`) sin ningún
    campo marcado (`PF:365-367`).
  - El alta sólo crea un **borrador**: planificar es otro paso con su diálogo en otra pantalla. No
    existe "Crear y planificar".
  - Página larga: formulario de 9 campos + resumen del plan con tabla de disponibilidad y costos. El
    botón "Crear borrador" queda al final, debajo de la vista previa.
  - No hay aviso de cambios sin guardar al pulsar "Cancelar" o al salir.
  - Sin `production.cost.read` el bloque de costos desaparece por completo (`PS:159`). No deja hueco
    roto, pero tampoco una nota que lo explique.
- **Redundancias:** tres puertas de entrada al mismo formulario (Necesidades `PL:225`, Pedido
  `order-pages.tsx:712`, ficha de stock `product-stock-pages.tsx:197`) y el listado.
- **Deuda UX ya registrada:** FORMS [F4] `input type=date`; FORMS [F3] inputs numéricos con formato;
  WORKFLOW [F4] "Comprar todo lo que falta"; WORKFLOW [F5A] consolidación.
- **Prioridad:** **P0**.

## 6. `/produccion/[id]` — Detalle de la orden de producción

- **Ruta:** `/produccion/[id]` (`ProductionDetail`, `PP:172-400`, con `StartButton`,
  `CancelProduction`, `PlanPanel`, `ActualsEditor`, `ExtraMaterialForm`, `RemoveExtra`, `ReviewDialog`,
  `PlanVsActual`, `OrderMovements`)
- **Módulo:** Producción → Órdenes
- **Roles que la usan:** lectura `production_orders.read` → ADMIN, OWNER, ADMINISTRATION, PRODUCTION.
  Planificar `production_orders.plan`, Iniciar `.start`, cargar el consumo `.update`, extras
  `.add_extra_material`, Completar `.complete`, Cancelar `.cancel` → ADMIN, OWNER, PRODUCTION.
  Costos: `production.cost.read` → ADMIN, OWNER, ADMINISTRATION. Enlace al lote: `product_lots.read`.
  Historial: `audit.read` → ADMIN, OWNER, ADMINISTRATION.
- **Objetivo principal:** llevar una orden de punta a punta: planificar, verificar la materia prima,
  iniciar, cargar lo que realmente se usó y lo que salió, y completar (ingresa el lote).
- **Acciones primarias (según estado):**
  - BORRADOR: "Planificar producción" (diálogo, `PP:207-229`).
  - PLANIFICADA: "Iniciar producción" (diálogo, `PP:230-232`, `PP:402-446`).
  - EN CURSO: "Revisar y completar" (`PP:831-841`) → diálogo de revisión → "Confirmar producción"
    (`PP:1224-1231`).
- **Acciones secundarias:** "Editar" / "Editar responsable, lote o notas" (`PP:233-243`), "Cancelar
  orden" (`PP:244-246`), "Volver a verificar" (`PP:385-387`), "Guardar avance" (`PP:843-852`),
  "Agregar consumo extra" (`PP:934-936`), "Quitar" (`PP:882-902`), "Comprar" por faltante, y enlaces a
  producto, receta, lote y pedido.
  **Peso visual:** `ConfirmAction` siempre renderiza `.button` neutro (`UI:163-167`), así que
  "Planificar producción" e "Iniciar producción" pesan **lo mismo** que "Editar" y apenas menos que
  "Cancelar orden" (borde rojo). En PLANIFICADA, el único botón primario aparece cuando "Iniciar"
  está **deshabilitado** (`PP:412-423`); habilitado pasa a ser neutro. Son 3 botones con el mismo peso
  en la cabecera de BORRADOR y PLANIFICADA, y 2 en EN CURSO, donde las acciones reales están al pie
  del panel de consumo.
- **Información crítica:** estado; producto, cantidad y fecha (subtítulo); avisos bloqueantes;
  planificado, producido y rendimiento; receta, escala, lote, depósitos, pedido de origen,
  responsable, tiempos; materias primas del plan; disponibilidad; consumo real; costos; movimientos.
- **Frecuencia esperada:** diaria y varias veces por orden (planificar, iniciar, cargar, completar).
- **Problemas encontrados:**
  - **Para quién y para cuándo:** el pedido de origen y su entrega están en la fila 8 de "Detalles"
    (`PP:354-367`), debajo de Resumen. La cabecera (`PP:199-204`) sólo muestra producto, cantidad y
    fecha programada. En el diálogo de revisión no aparece el pedido.
  - En EN CURSO, la carga real (`PP:392`) está después de Resumen y de 14 filas de Detalles: queda
    bajo el pliegue y obliga a desplazarse.
  - "Iniciar producción" deshabilitado explica el motivo sólo con `title` (`PP:416-420`), que no se ve
    en tablet ni con teclado. Además `.button:disabled { cursor: progress }` (`globals.css:67-70`)
    muestra un cursor de "cargando" en un botón bloqueado.
  - Diálogos de confirmación: `aria-labelledby` e `id` se arman con el **label con espacios**
    (`UI:170-171`: `id="Planificar producción-title"`), lo que es un IDREF inválido (se interpreta como
    dos ids), así que el diálogo queda sin nombre accesible. Pasa con "Planificar producción",
    "Iniciar producción" y "Cancelar orden".
  - "Cancelar orden": el diálogo tiene "Cancelar orden" (rojo) y "Cancelar" para cerrar
    (`UI:189-196`). Dos "Cancelar" con significados opuestos en el mismo diálogo.
  - **"Quitar" consumo extra borra sin confirmación** (`PP:882-902`) y no captura errores (`try/finally`
    sin `catch`): si la API falla no hay mensaje (promesa rechazada sin manejar).
  - Consumo real: los errores por línea no están asociados al input (`PP:713-727`, sin
    `aria-describedby`). Lo mismo con la salida (`PP:815`) y el formulario de extra (`PP:992`,
    `PP:1004`, `PP:1032`). La "Diferencia" se recalcula sólo al guardar (`PP:780`).
  - La salida real no se precarga (sólo placeholder, `PP:797`), mientras que el consumo sí (servicio
    `production.service.ts:896`). Está bien, pero el placeholder "Planificado: 120 u" se confunde con un
    valor cargado.
  - Formulario de consumo extra: 4 campos en línea con `<select>` de **materia prima sin búsqueda y con
    tope de 100** (`PP:923`, `PP:979-991`). Los errores de la API sobre `unitId` no se muestran (no hay
    `form__error` para la unidad, `PP:1006-1021`).
  - Diálogo "Revisar antes de completar": muestra plan contra real, pero **no el código del lote** que
    se va a crear (ya está fijado desde que se planificó, servicio `production.service.ts:738`) ni el
    pedido. El pie no es fijo (`globals.css:951-955`, `PP:1223-1240`). El botón "Confirmar" se
    deshabilita por faltante (`PP:1228`) y el motivo sólo se ve más arriba en la tabla.
  - "Revisar y completar" guarda el avance antes de abrir la revisión (`PP:835-838`) sin avisarlo.
  - Al completar, el aviso (`PP:258-264`) no nombra el lote ni ofrece "Ver lote" o "Volver al pedido".
    El enlace al lote está en "Detalles" (`PP:336-349`).
  - Merma teórica comparada con `Number(...) > 0` (`PP:333`), aritmética de punto flotante sobre un
    decimal string (la app evita floats por norma, `lib/format.ts:3-7`).
  - Errores de movimientos mostrados con `error.message` dentro de un `p.muted` (`PP:1348`), sin estado
    de error visual.
  - **Historial:** al editar una orden en borrador, el detalle muestra **nombres técnicos de campos**
    ("Cambió: productId, scheduledFor, plannedOutputQuantity, plannedOutputUnitId, recipeVersionId,
    sourceWarehouseId, outputWarehouseId"): `UI:409` cae en `FIELD_LABELS[k] ?? k` y `FIELD_LABELS`
    (`UI:245`) no tiene esas claves (las registra `production.service.ts:512-520`, `:611-624`). Lo ven
    ADMIN, OWNER y ADMINISTRATION.
  - Página muy larga: Resumen, Detalles (14 filas), Plan, Disponibilidad o Consumo real, Costos,
    Movimientos e Historial.
  - Costos: sin `production.cost.read` no hay huecos (`PP:489`, `PS:159`, `PP:1341`). Sin embargo, el
    mismo usuario de PRODUCCIÓN ve costo teórico, precio y margen en Recetas (ver §8). La regla no es
    coherente.
  - `<title>` estático "Orden de producción · Producción" (`app/(app)/produccion/[id]/page.tsx:4`):
    con varias pestañas abiertas no se distinguen.
- **Redundancias:** "Planificado / Producido / Rendimiento" aparecen en Resumen (`PP:284-315`), en el
  subtítulo (cantidad) y en el diálogo de revisión (`PP:1129-1146`). La fecha programada está en el
  subtítulo y en Detalles (`PP:351`). La tabla de disponibilidad aparece en el alta, en el detalle y
  otra vez en la revisión.
- **Deuda UX ya registrada:** INFORMATION_ARCHITECTURE [F4] "bloque Detalles largo, carga real
  bajo el pliegue"; VISUAL_HIERARCHY [F4] costos esperado/estimado/real; FORMS [F4] diferencia en vivo
  y consumo extra en fila de 5 campos; RESPONSIVE [F4] diálogo de revisión sin pie fijo;
  WORKFLOW [F4] "Revisar y completar guarda antes", "Comprar todo lo que falta", sin reversa
  (`PRODUCTION_REVERSAL`); WORKFLOW [F5A] "Hay nuevo stock: entrar a cada pedido";
  ACCESSIBILITY [F3] `ConfirmAction` sin devolver el foco; DASHBOARD [F4].
- **Prioridad:** **P0**.

## 7. `/produccion/[id]/editar` — Editar orden

- **Ruta:** `/produccion/[id]/editar` (`ProductionForm id`, `PF:132-175`, `PF:180-622`)
- **Módulo:** Producción → Órdenes
- **Roles que la usan:** `production_orders.update` (`PF:376`) → ADMIN, OWNER, PRODUCTION.
- **Objetivo principal:** corregir un borrador (todo) o, ya planificada o en curso, cambiar
  responsable, lote o notas.
- **Acciones primarias:** "Guardar cambios".
- **Acciones secundarias:** "Cancelar"; breadcrumb a la orden.
- **Información crítica:** los mismos campos que el alta; en modo operativo, producto, cantidad,
  receta y depósitos en sólo lectura.
- **Frecuencia esperada:** ocasional (borrador) o frecuente para asignar responsable.
- **Problemas encontrados:**
  - Para cambiar 3 campos (responsable, lote, notas) de una orden planificada o en curso se navega a
    una página completa con 6 campos de sólo lectura (`PF:424-557`). Sería un diálogo.
  - Si la orden está completada o cancelada: panel vacío **sin `PageHeader` ni breadcrumb**
    (`PF:146-155`), con enlace "Volver" con estilo de enlace del navegador (`.panel--empty` no tiene
    regla para `a`; sólo `.table a`, `.details a` y `.breadcrumb a` están estilizados,
    `globals.css:316,388,530`).
  - En borrador hereda todos los problemas de §5 (selector de producto con tope de 100, catálogo
    tragado, fechas nativas).
  - Lote: `maxLength=40` sin contador. El error de lote duplicado llega por API (`BATCH_CODE_TAKEN`) y se
    mapea bien a `batchCode`.
- **Redundancias:** duplicada con el alta (mismo componente). Los campos operativos se podrían
  editar en el propio detalle.
- **Deuda UX ya registrada:** FORMS [F4] `input type=date`.
- **Prioridad:** **P2**.

---

## 8. `/recetas` — Listado de recetas

- **Ruta:** `/recetas` (`RecipeList`, `RP:44-121`)
- **Módulo:** Producción → Recetas
- **Roles que la usan:** `recipes.read` → ADMIN, OWNER, ADMINISTRATION, PRODUCTION. "Nueva receta":
  `recipes.create` → ADMIN, OWNER, PRODUCTION.
- **Objetivo principal:** ubicar la receta de un producto, ver si tiene versión vigente y su costo
  teórico actual.
- **Acciones primarias:** "Nueva receta" (primaria, `ML:130-134`); clic en el producto
  (`RP:59`).
- **Acciones secundarias:** búsqueda, filtro Activas/Inactivas/Todos, paginación.
- **Información crítica:** producto, receta, versión vigente, rendimiento, costo teórico por unidad,
  estado del costo, actualización y borrador pendiente.
- **Frecuencia esperada:** semanal / ocasional.
- **Problemas encontrados:**
  - **Costo para quien no tiene permiso de costos:** "Costo teórico actual" (`RP:79-89`) se muestra a
    todo el que tiene `recipes.read`, PRODUCCIÓN incluida, que en Órdenes **no** ve costos
    (`production.cost.read`). La API tampoco lo filtra (`apps/api/src/modules/recipes/recipes.routes.ts`
    sólo pide `RECIPES_READ`).
  - No hay filtro "Con borrador pendiente" ni "Costo incompleto", que son las tareas de mantenimiento.
  - La columna "Receta" se oculta en `hide-md`. Si nombre de receta y producto coinciden, hay
    redundancia.
  - Vacío genérico "Todavía no hay recetas cargadas." (`RP:56`), también con el filtro "Inactivas"
    (`ML:198`).
- **Redundancias:** la ficha del producto (Maestros) enlaza a "Ver receta" / "Crear receta"
  (`masters/items.tsx:646-651`) y la ficha de stock muestra la receta vigente.
- **Deuda UX ya registrada:** VISUAL_HIERARCHY [F3] tres costos; INFORMATION_ARCHITECTURE [F4]
  solapamiento de fichas.
- **Prioridad:** **P2**.

## 9. `/recetas/nuevo` — Nueva receta

- **Ruta:** `/recetas/nuevo` (`RecipeCreate` → `RecipeEditor`, `RE:87-114`, `RE:185-682`); acepta
  `?producto=`.
- **Módulo:** Producción → Recetas
- **Roles que la usan:** `recipes.create` → ADMIN, OWNER, PRODUCTION (la página no lo verifica en el
  cliente; sólo la API).
- **Objetivo principal:** cargar qué lleva un producto, cuánto rinde, y ver su costo teórico en vivo.
- **Acciones primarias:** "Guardar borrador" (`RE:671-673`).
- **Acciones secundarias:** "Agregar ingrediente" (`RE:626-632`), "✕" por fila (`RE:602-617`),
  "Cancelar" (`RE:674-676`).
- **Información crítica:** producto, nombre, rendimiento y unidad, merma, ingredientes con cantidad y
  unidad, costo usado y costo por ingrediente, resumen de costo, precio y margen.
- **Frecuencia esperada:** ocasional (alta de productos).
- **Problemas encontrados:**
  - **`<select>` de materia prima por fila sin búsqueda y con tope silencioso de 100**
    (`RE:70`, `RE:540-556`, `AC:90-96`). Una receta con varios ingredientes obliga a recorrer la lista
    larga una vez por fila, y las materias primas más allá de la 100 no aparecen.
  - El selector de producto tiene el mismo tope (`RE:69`, `RE:391-403`). Además, `withRecipe` se arma
    con las primeras 100 recetas activas (`RE:72`, `RE:79`): con más de 100 se ofrecen productos que ya
    tienen receta y la API rechaza el alta.
  - Errores de catálogo tragados (`RE:82`): todos los selectores vacíos y sin mensaje.
  - Botón de quitar fila sólo con ícono "✕" (`RE:616`), sin texto visible (tiene `aria-label`).
  - El error general se pinta **arriba** del formulario (`RE:370-374`) y el botón de guardar está al
    final de la sección 4 (`RE:671`): al fallar no se ve el error, y no hay foco ni scroll.
  - Errores por campo sin `aria-describedby` (`RE:404-406`, `RE:441-443`, `RE:557-559`, …). Los
    obligatorios usan `*` con `aria-hidden` y sin `aria-required`.
  - Costos y margen a PRODUCCIÓN (`RE:589-600`, `CV:230-249`: precio de venta y margen bruto), aunque no
    tenga `price_lists.read` ni `production.cost.read`.
  - Validación duplicada: `RE:50-52` redefine `DECIMAL/toDecimal/isPositive`, mientras que producción
    usa `@/lib/decimal-input` (`PF:22`). Puede haber reglas distintas de coma o punto entre pantallas.
  - Sin aviso de cambios sin guardar. Página larga (4 secciones).
  - Tras guardar va al detalle y todavía hay que **publicar**, que PRODUCCIÓN no puede hacer (ver §10).
- **Redundancias:** ninguna relevante.
- **Deuda UX ya registrada:** FORMS [F3] inputs numéricos con formato; FORMS [F5B] editor de líneas
  único (`.line-editor`); VISUAL_HIERARCHY [F2/F3] `cost-summary`.
- **Prioridad:** **P3**.

## 10. `/recetas/[id]` — Detalle de receta

- **Ruta:** `/recetas/[id]` (`RecipeDetail`, `RP:125-282`, `VersionHistory` `RP:284-358`)
- **Módulo:** Producción → Recetas
- **Roles que la usan:** `recipes.read` → ADMIN, OWNER, ADMINISTRATION, PRODUCTION. Editar borrador:
  `recipes.update` (ADMIN, OWNER, PRODUCTION). Publicar: `recipes.publish` (**sólo ADMIN y OWNER**).
  Nueva versión: `recipes.create`. Desactivar/Reactivar: `recipes.archive` (ADMIN, OWNER).
- **Objetivo principal:** consultar la versión vigente (ingredientes, rendimiento, instrucciones,
  costo) y gestionar sus versiones.
- **Acciones primarias:** "Publicar" (si hay borrador) / "Nueva versión" (si no hay).
- **Acciones secundarias:** "Editar borrador", "Desactivar"/"Reactivar", "Ver borrador", "Ver
  versión", enlaces del historial, enlace al producto.
  **Peso visual:** hasta 3 botones neutros iguales en la cabecera ("Editar borrador", "Publicar",
  "Desactivar" en rojo), porque `ConfirmAction` nunca es primario (`UI:163-167`). "Publicar", que es la
  acción que cierra el ciclo, no se distingue.
- **Información crítica:** borrador pendiente con su costo; versión vigente (desde, por quién,
  rendimiento, merma); ingredientes con costo; costo del lote y por unidad, precio y margen;
  instrucciones; historial de versiones; auditoría.
- **Frecuencia esperada:** semanal / ocasional. PRODUCCIÓN la consulta para elaborar (instrucciones).
- **Problemas encontrados:**
  - PRODUCCIÓN puede crear y editar borradores pero **no publicar**, y la pantalla no lo explica (no
    hay "Pendiente de publicación por el dueño"): el botón simplemente no aparece (`RP:169-176`).
  - Costos y precio y margen visibles a PRODUCCIÓN (`RP:257-266`, `CV:230-249`), lo que es incoherente
    con Órdenes.
  - Carga parcial silenciosa: `activeCost`, `draftCost` y `activeVersion` se renderizan con
    `data && …` (`RP:217`, `RP:257`, `RP:268`). Mientras cargan no hay indicador, y **si fallan no se
    muestra error**: los ingredientes y el costo simplemente no aparecen.
  - La receta muestra los ingredientes sólo dentro de la tabla de costos (`RP:259-260`). Quien sólo
    quiere elaborar no tiene una vista "ficha de elaboración" sin plata.
  - Merma con `${formatDecimal(x)} %` (`RP:253`) en lugar de `formatPercent` (hasta 6 decimales contra
    2), inconsistente con producción (`PP:333`, que usa `formatPercent`).
  - Enlaces con estilo del navegador: "Producto: …" en el subtítulo (`RP:158`), "Ver borrador"
    (`RP:211`) y "Ver versión" (`RP:234`), porque ni `.page__title p` ni `.panel__header a` tienen
    estilo.
  - "Nueva versión" va con confirmación (`RP:178-190`), correcto. "Desactivar" (`RP:192-200`) se puede
    usar con versión vigente y órdenes abiertas; el mensaje no dice qué pasa con las órdenes
    planificadas.
  - La página es larga: borrador, vigente con 2 tablas, instrucciones, historial y auditoría.
  - `<title>` estático "Receta · Recetas".
- **Redundancias:** el costo del borrador aparece aquí y en `/versiones/[id]`; el costo vigente aquí y
  en el detalle de versión.
- **Deuda UX ya registrada:** VISUAL_HIERARCHY [F3] tres costos y [F2/F3] `cost-summary`;
  ACCESSIBILITY [F3] foco de `ConfirmAction`; TABLES [F4] enlaces con estilo por defecto (mismo
  hallazgo, distinto lugar).
- **Prioridad:** **P2**.

## 11. `/recetas/[id]/versiones/[versionId]` — Detalle de versión

- **Ruta:** `/recetas/[id]/versiones/[versionId]` (`VersionDetail`, `RP:362-524`)
- **Módulo:** Producción → Recetas
- **Roles que la usan:** `recipes.read`; acciones: `recipes.update` (editar o descartar borrador),
  `recipes.publish`, `recipes.archive` (archivar vigente).
- **Objetivo principal:** ver una versión puntual (cambios contra la anterior, costo al publicar contra
  el actual) y publicar, descartar o archivar.
- **Acciones primarias:** "Publicar" (borrador) / ninguna (publicada).
- **Acciones secundarias:** "Editar borrador", "Descartar borrador" (rojo), "Archivar" (rojo). Hasta
  3 botones con el mismo peso; 2 son destructivos.
- **Información crítica:** producto, rendimiento, merma, creada, publicada, archivada; costo al
  publicar (snapshot); costo teórico actual; cambios; instrucciones.
- **Frecuencia esperada:** ocasional.
- **Problemas encontrados:**
  - **Diff con carga infinita:** `diff.data ? <DiffView/> : <Loading />` (`RP:513`). Si la petición de
    diff falla, muestra "Cargando…" para siempre.
  - Costo: si `cost` falla, las secciones desaparecen sin aviso (`RP:472`, `RP:495`).
  - **Publicar con costo incompleto:** el diálogo pide marcar "Publicar igual" (`CV:393-404`), pero el
    botón "Publicar versión" **no se deshabilita** sin el tilde. Al confirmar, la API responde 409
    `COST_INCOMPLETE_CONFIRMATION_REQUIRED` (`recipes.service.ts:903-909`) y recién ahí se muestra el
    error. Además, si se abre antes de que cargue `cost`, `incomplete` es falso (`CV:371`) y el tilde
    ni aparece.
  - Inconsistencia: con la receta inactiva, "Editar borrador" y "Publicar" se ocultan (`RP:387`,
    `RP:406-418`) pero "Descartar borrador" sigue visible (`RP:419`), y no se explica por qué no se puede
    editar.
  - Error "La versión no es de esta receta." construido a mano con código `NOT_FOUND` (`RP:376-379`);
    se muestra sólo el mensaje, sin enlace de vuelta.
  - Merma con `formatDecimal … %` (`RP:455`, `CV:347`).
  - Costo, precio y margen visibles a PRODUCCIÓN (`RP:495-506`).
- **Redundancias:** costo actual igual que en el detalle de la receta.
- **Deuda UX ya registrada:** VISUAL_HIERARCHY [F3]; ACCESSIBILITY [F3].
- **Prioridad:** **P3**.

## 12. `/recetas/[id]/versiones/[versionId]/editar` — Editar borrador

- **Ruta:** `/recetas/[id]/versiones/[versionId]/editar` (`DraftEdit`, `RE:116-178` → `RecipeEditor`)
- **Módulo:** Producción → Recetas
- **Roles que la usan:** `recipes.update` → ADMIN, OWNER, PRODUCTION (sin verificación en el cliente:
  un usuario de ADMINISTRATION entra, edita todo y recibe 403 al guardar).
- **Objetivo principal:** ajustar ingredientes, rendimiento, merma o instrucciones de un borrador.
- **Acciones primarias:** "Guardar borrador".
- **Acciones secundarias:** "Agregar ingrediente", "✕", "Cancelar", breadcrumb "Volver a la receta".
- **Información crítica:** igual que §9; el producto queda fijo.
- **Frecuencia esperada:** ocasional.
- **Problemas encontrados:**
  - Todos los de §9: materia prima sin búsqueda y con tope de 100, error arriba, "✕", costos a
    PRODUCCIÓN.
  - **No verifica `recipes.update` en el cliente** (a diferencia de `PF:375-377`, `PF:406-407`): la
    persona edita y recién al guardar ve "No tenés permiso".
  - Si no es borrador: panel vacío sin `PageHeader` (`RE:121-131`) y "Volver" con estilo del navegador.
  - Materia prima inactiva: se agrega como "(inactiva)" con un objeto armado a mano (`RE:134-154`); el
    selector no la distingue visualmente más allá del texto.
  - Al guardar vuelve al detalle de la receta (`RE:327`), no al de la versión. Para publicar hacen
    falta 2 clics más (Publicar → confirmar).
  - Breadcrumb "Volver a la receta" (`RE:364`), distinto del patrón "← {nombre}" del resto.
- **Redundancias:** —
- **Deuda UX ya registrada:** FORMS [F3]/[F5B].
- **Prioridad:** **P3**.

---

## Hallazgos transversales

1. **Selectores de entidades sin búsqueda y truncados a 100.** `fetchOptions` trae `pageSize: 100`
   (`AC:89-96`) y alimenta los selectores de Producto (alta de orden `PF:71`, filtro del listado
   `PP:69`, alta de receta `RE:69`), Materia prima (ingredientes `RE:70`, consumo extra `PP:923`),
   Responsable, Depósito y Unidad. No hay combobox con búsqueda, y lo que pasa de 100 desaparece sin
   aviso. En recetas además rompe la lógica de "productos que ya tienen receta" (`RE:72`).
2. **Errores de carga tragados.** Los catálogos usan `.catch(() => [])` (`PF:82`, `RE:82`, `PS:50`,
   `PP:75`, `PP:78`, `PP:925`): selectores vacíos sin mensaje. Las cargas secundarias del detalle de
   receta y versión no muestran error (`RP:217`, `RP:257`, `RP:472`, `RP:495`) o quedan "Cargando…"
   para siempre (`RP:513`).
3. **Recarga silenciosa:** `useResource` (`UI:23-48`) no limpia `data` al cambiar `path`. Al cambiar el
   horizonte o los filtros se ven los datos viejos sin indicador hasta que llegan los nuevos.
4. **Jerarquía de acciones rota en los flujos de estado.** `ConfirmAction` siempre es `.button` neutro o
   `--danger` (`UI:163-167`). Las transiciones principales (Planificar, Iniciar, Publicar) pesan lo
   mismo que "Editar", y la única primaria visible en una orden planificada es la deshabilitada
   (`PP:412-423`).
5. **Diálogos de confirmación:** IDREF inválido en `aria-labelledby` cuando el label tiene espacios
   (`UI:170-171`), que son casi todos ("Planificar producción", "Cancelar orden", "Descartar
   borrador", "Nueva versión"). El botón "Cancelar" convive con "Cancelar orden" (`UI:189-196`). No se
   devuelve el foco (ya registrado). La acción destructiva "Quitar" consumo extra no pide confirmación
   y no muestra error (`PP:882-902`).
6. **Tres formatos de fecha y hora para el mismo concepto ("entrega"):** `formatDateTime` (Intl, año
   de 2 dígitos: `PL:202`, `PP:363`), `formatWallClock` / `formatLocalDateTime` (dd/mm/aaaa hh:mm:
   `PL:137`, `PL:381`, `PF:416`). Porcentaje de merma con `formatDecimal + " %"` (`RP:253`, `RP:455`,
   `CV:347`) frente a `formatPercent` (`PP:333`). Dinero y cantidades usan los helpers de forma
   consistente (no se encontraron números sin formatear en este alcance).
7. **Enlaces con estilo del navegador** fuera de `.table`, `.details` y `.breadcrumb`
   (`globals.css:316,388,530`): `RP:158`, `RP:211`, `RP:234`, `PF:152`, `PF:163`, `PF:413` (dentro de
   `.notice`) y `RE:127`.
8. **Costos: regla incoherente entre módulos.** Órdenes oculta costos sin `production.cost.read`
   (bien, sin huecos: `PP:148-159`, `PP:489`, `PS:159`, `PP:1341`), pero Recetas muestra costo teórico,
   **precio de venta y margen bruto** a cualquiera con `recipes.read`, incluida PRODUCCIÓN
   (`RP:79-89`, `CV:230-249`, `RE:589-600`). Además no hay ninguna nota que explique la ausencia de
   costos cuando faltan.
9. **Matriz de permisos y tareas:** COMPRAS no ve Necesidades → Materias primas (no tiene
   `order_planning.read`). PRODUCCIÓN no ve "Comprar" en los faltantes (`PS:67`, `purchases.create`) y
   no tiene un camino para avisarle a Compras. PRODUCCIÓN crea y edita borradores de receta pero no
   puede publicarlos y la UI no lo dice.
10. **Sin guardas de ruta por permiso** (`app/(app)/layout.tsx`): por URL se ve la cáscara y luego un
    error de la API. Los editores de receta no verifican permisos en el cliente (`RE` completo).
11. **Términos técnicos en el Historial:** `UI:409` muestra claves crudas (`productId`,
    `scheduledFor`, `plannedOutputQuantity`, `sourceWarehouseId`…) al editar una orden en borrador,
    porque faltan en `FIELD_LABELS` (`UI:245`). `UI:470` cae en el código de acción crudo si falta en
    `AUDIT_ACTION_LABELS` (hoy las acciones de producción están cubiertas, `packages/shared/src/audit.ts:79-87`).
12. **Estados vacíos genéricos:** `ML:198` ignora los filtros que no son búsqueda ("Todavía no hay
    órdenes…" con filtro aplicado). Los vacíos de Necesidades no mencionan el horizonte. No hay CTA en
    ningún vacío.
13. **Accesibilidad de formularios:** los errores por campo no se asocian con `aria-describedby` en el
    consumo real, el consumo extra y el editor de recetas (`PP:727`, `PP:815`, `PP:992-1032`,
    `RE:404-587`). El formulario de orden sí lo hace (`PF:378-388`). Los obligatorios no usan
    `aria-required`. Los motivos de deshabilitado sólo van en `title` (`PP:416-420`).
14. **Fechas nativas** (`input type=date`, `WallClockInput`) en alta de orden, filtros y horizonte;
    ya registrado.
15. **Páginas largas** sin pestañas ni cabecera compacta: detalle de orden, detalle de receta y
    editor de receta. **`<title>` estático** en todos los `page.tsx` de detalle (no incluyen el código
    ni el nombre).
16. **Validación decimal duplicada:** `RE:50-52` frente a `@/lib/decimal-input` (`PF:22`, `PP:23`).

---

## Workflow producción — ANTES

Recorrido "camino feliz" de un usuario PRODUCCIÓN con permisos completos de órdenes, desde una
necesidad de pedido hasta el lote creado, según el código actual.

| # | Paso | Pantalla / componente | Clics | Navegación | Diálogo | Campos | Contexto visible ("para qué pedido / para cuándo") |
|---|------|-----------------------|-------|-----------|---------|--------|------------------------------------------------------|
| 1 | Abrir Necesidades | Menú "Planificación → Necesidades" (`lib/navigation.ts:78`) → `/necesidades` (`PL:160`) | 1 | 1 | — | — | Por producto: cantidad, **primera entrega** (sólo la más temprana, `PL:202`), códigos de pedido con su cantidad y estado (`PL:205-231`). No se ve la entrega de cada pedido. |
| 1b | (Opcional) acotar horizonte | Fecha + hora + "Aplicar horizonte" (`PL:103-111`) | 3-5 | 0 (`router.replace`) | — | 2 | "Pedidos con entrega hasta el …" (`PL:135-139`). |
| 2 | Crear la orden desde la necesidad | "Crear orden" (`PL:223-228`) → `/produccion/nueva?requirementId=…` | 1 | 1 | — | — | Aviso: pedido, faltante, producto y entrega (`PF:410-419`). |
| 3 | Revisar el formulario prellenado y la vista previa | `ProductionEditor` (`PF:209-222`); vista previa automática a los 350 ms (`PF:293-319`) | 0 (si no se cambia nada) | 0 | — | **5 obligatorios** (producto, fecha, cantidad, depósito de MP, depósito de PT; `PF:324-334`), todos prellenados; 5 opcionales (unidad, receta, responsable, lote, notas con "Para el pedido X") | Aviso del pedido arriba; vista previa con receta, escala, **disponibilidad** (`PS:64-143`) y costo esperado (sólo con `production.cost.read`). Fecha por defecto = hoy (`PF:213`). |
| 3b | (Si falta materia prima) | Alerta "Se puede planificar igual, pero no iniciar" (`PS:73-75`); "Comprar" sólo con `purchases.create` (**PRODUCCIÓN no lo tiene**, `PS:67`), y navegar pierde el formulario | — | (+1 si compra) | — | — | — |
| 4 | Guardar | "Crear borrador" (`PF:608`) → `router.push('/produccion/{id}')` (`PF:363`) | 1 | 1 | — | — | Cabecera: "Orden OP-… · Borrador", subtítulo producto · cantidad · fecha programada (`PP:199-204`). **Pedido y entrega sólo en "Detalles", fila 8** (`PP:354-367`). |
| 5 | Planificar (fija receta, cantidades, costo y lote) | "Planificar producción" → diálogo → "Planificar producción" (`PP:207-229`) | 2 | 0 (se reemplaza en la página) | **1** | — | Diálogo: versión de receta y aviso si falta MP. No muestra pedido ni lote. |
| 6 | Verificar materia prima | Panel "Disponibilidad en {depósito}" + "Volver a verificar" (`PP:381-391`) | 0-1 | 0 | — | — | Tabla necesario / disponible / diferencia. |
| 6b | (Si falta) | "Iniciar producción" deshabilitado; el motivo sólo en `title` (`PP:410-424`). Hay que ir a Compras o Inventario, volver y pulsar "Volver a verificar". | +3-6 | +2 | — | — | — |
| 7 | Volver a la orden el día de producción (habitual: otro momento) | Menú "Producción → Órdenes" → filtro de estado (el predeterminado es "Todos", `PP:92`) → clic en el código | 2-3 | 1-2 | — | — | El listado no muestra el pedido (`PP:116-160`). |
| 8 | Iniciar | "Iniciar producción" → diálogo → "Iniciar producción" (`PP:427-445`) | 2 | 0 | **1** | — | Diálogo genérico ("Queda en curso…"). |
| 9 | Registrar el consumo real | Panel "Consumo y salida reales" (`PP:662-868`), **debajo de Resumen y Detalles** (requiere scroll) | 0 si coincide con el plan (precargado con lo planificado al iniciar, `production.service.ts:896`); 1 input y opcionalmente 1 select por línea que cambie | 0 | — | N líneas obligatorias (precargadas, `PP:593-601`); unidad por línea | Encabezado de página; nada del pedido en el panel. Diferencia sólo al guardar (`PP:780`). |
| 9b | (Opcional) consumo extra | "Agregar consumo extra" → materia prima (selector, tope 100) + cantidad + unidad + **motivo obligatorio** → "Agregar" (`PP:931-1053`) | ≥5 | 0 | — | 3 obligatorios + unidad | — |
| 9c | (Opcional) guardar avance | "Guardar avance" (`PP:843-852`) | 1 | 0 | — | — | "Avance guardado." |
| 10 | Registrar la salida real | Input "Cantidad obtenida de {producto}" (**no se precarga**, sólo placeholder, `PP:791-800`) + unidad | 1 foco + tipeo | 0 | — | **1 obligatorio** para completar (`PP:602-604`) | Texto "Entra a {depósito} al completar" (`PP:817-820`). |
| 11 | Revisar | "Revisar y completar" (`PP:831-841`): guarda el avance (PUT `/actuals`) y abre `ReviewDialog` (`PP:1057-1243`) | 1 | 0 | **1 (ancho, `dialog--wide`)** | 0-1 (estado del lote si hay más de una conservación inicial, `PP:1202-1217`) | Planificado / producido / rendimiento / stock suficiente; plan contra real; costo estimado (si hay permiso); "se descuentan… entran… en un lote fresco/… No se puede deshacer." **No muestra el código de lote ni el pedido.** |
| 12 | Completar | "Confirmar producción" (`PP:1224-1231`) → POST `/complete`; cierra y hace scroll arriba (`PP:860-864`) | 1 | 0 | — | — | Aviso "Producción completada: se descontaron… entraron…" (`PP:258-264`), **sin código de lote ni enlace**. |
| 13 | Ver el lote creado | "Detalles" → fila "Lote" → enlace (sólo con `product_lots.read`, `PP:336-349`) | 1 | 1 | — | — | Lote con badge de conservación. |
| 14 | (Fuera de alcance) Actualizar la cobertura del pedido | "Detalles" → "Pedido" (`PP:360`) → en el pedido, "Actualizar cobertura" | 2+ | 1 | — | — | Ya registrado en WORKFLOW [F5A]. |

**Totales del camino feliz (pasos 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13 sin opcionales ni faltantes, todo
en una sesión):**
- **Clics:** 1 + 1 + 0 + 1 + 2 + 2 + 0 + 1 (foco en la salida) + 1 + 1 + 1 = **11 clics** más el tipeo de
  la salida. Con el regreso habitual a la orden otro día (paso 7) son **13-14**. Con 1 consumo extra,
  **≥19**.
- **Navegaciones de página:** Necesidades → Nueva orden → Detalle → (Lote) = **3-4**; **+1-2** si se
  vuelve desde el listado.
- **Diálogos:** **3** (Planificar, Iniciar, Revisar y completar).
- **Campos obligatorios:** 5 en el alta (prellenados desde la necesidad) + N cantidades de consumo
  (precargadas) + **1 salida real que siempre se tipea** + 0-1 estado de conservación. Con consumo
  extra: +3 (materia prima, cantidad, motivo).
- **Estados por los que pasa la orden:** Borrador → Planificada → En curso → Completada. Son **4
  confirmaciones explícitas** (Crear borrador, Planificar, Iniciar, Confirmar producción), y las dos del
  medio son diálogos de una línea sin datos que decidir.

**Pérdida de contexto a lo largo del flujo:**
- "Para qué pedido / para cuándo" es explícito sólo en el paso 2-3 (aviso del formulario). Desde el
  paso 4 queda en la fila 8 de "Detalles" (`PP:354-367`) y no aparece en el listado, en los diálogos ni
  en el aviso final.
- En Necesidades se ve sólo la primera entrega por producto, no la de cada pedido (`PL:202`).
- El código de lote existe desde Planificar (`production.service.ts:738`), pero no se muestra en el
  diálogo de revisión ni en el aviso de completado.
- La disponibilidad se ve en el alta, en el detalle (BORRADOR/PLANIFICADA) y en la revisión, pero
  quien no tiene `purchases.create` (PRODUCCIÓN) no tiene ningún camino de acción ante un faltante.
