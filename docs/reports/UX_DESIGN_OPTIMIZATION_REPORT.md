# UX / Design Optimization Sprint — Informe final

## Estado

```
FASE_5B_TECHNICAL_REVIEW   = PASS
FASE_5B_HUMAN_GATE         = ACCEPTED
FASE_5B_CLOSURE_HARDENING  = PASS
FASE_5B_STATUS             = CLOSED

UX_DESIGN_OPTIMIZATION_STATUS = COMPLETE_PENDING_HUMAN_ACCEPTANCE
```

No se comenzó la Fase 6. No se agregaron módulos funcionales, reglas de stock, cambios contables, de
pricing ni de invariantes. No hay migraciones.

| Dato        | Valor                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| Base commit | `2a78810` (main con el PR #8 de Fase 5B mergeado)                                       |
| Rama        | `ux-design-optimization`                                                                |
| PR          | [#9](https://github.com/domusbrag/brurera/pull/9)                                       |
| Alcance     | 78 archivos fuera de capturas (+14.107 / −4.141 líneas), casi todo en `apps/web` y docs |

**Para correr en Windows después de traer la rama:** `pnpm install` y `pnpm build` (o `pnpm dev`). No
hace falta `pnpm db:migrate` (no hay migraciones) ni `pnpm db:sync-reference` (no se agregaron permisos
ni roles; sólo cambiaron rótulos de la matriz de permisos, que son texto de la interfaz).

## Auditoría inicial

[`docs/UX_AUDIT.md`](../UX_AUDIT.md) inventaría las **91 rutas** de la web con módulo, rol, objetivo,
acciones primarias y secundarias, información crítica, frecuencia, problemas, redundancias, deuda previa
y prioridad (P0–P3). El detalle por área está en:

- [ux-audit/comercial.md](../ux-audit/comercial.md) — pedidos, ventas, clientes, listas de precios, cobros.
- [ux-audit/produccion.md](../ux-audit/produccion.md) — planificación, órdenes, recetas.
- [ux-audit/inventario-compras.md](../ux-audit/inventario-compras.md) — stock, lotes, vencimientos, compras.
- [ux-audit/organizacion.md](../ux-audit/organizacion.md) — shell, navegación, maestros, usuarios, auditoría.

Cada informe de área termina con su "Workflow … — ANTES" medido sobre el código (clics, pantallas,
navegaciones, diálogos, campos), que es la base del antes/después de este informe.

Hallazgos transversales principales: navegación organizada por tipo de dato con 5 módulos futuros
visibles para todos; selects sin búsqueda para productos, clientes, proveedores y materias primas;
varias acciones con el mismo peso visual; mensajes de la API con códigos o números en formato inglés;
estados vacíos "No hay datos"; colores de estado distintos para la misma semántica; enlaces con estilo
del navegador; rutas sin permiso que terminaban en 403.

## Personas

Definidas en [UX_AUDIT.md › Personas](../UX_AUDIT.md#personas): Dueño/Admin, Ventas/Mostrador,
Producción, Depósito, Administración y Compras, cada una con lo que hace a diario y lo que necesita ver
primero. Una sola aplicación que se adapta por permisos.

## Information architecture

**Antes:** 9 grupos por tipo de dato (Operaciones, Producción, Planificación, Inventario, Comercial,
Finanzas, Equipo, Análisis, Sistema); los módulos futuros (Caja, Cuentas a pagar, Gastos, Facturación,
Reportes) ocupaban entre el 38 % y el 50 % del menú de los roles operativos; Configuración visible a
quien sólo lee unidades; "Stock", "Órdenes" y "Necesidades" ambiguos.

**Después:** grupos por tarea, en orden de frecuencia: Comercial, Producción, Inventario, Compras,
Finanzas, Catálogo y Organización. Variaciones respecto de la propuesta de referencia, con su
justificación en [UX_AUDIT.md › Después](../UX_AUDIT.md#después):

- Planificación dentro de Producción (la usa quien decide qué hornear).
- Proveedores dentro de Compras.
- _Catálogo_ separa los maestros (Productos, Materias primas) del stock: consultar stock ya no se
  confunde con editar el artículo.
- "Próximos a vencer" y "Movimientos" tienen entrada propia en el menú.
- "Lotes" no es un ítem de menú: los lotes se abren desde Productos terminados y Próximos a vencer (la
  miga es Inventario › Productos terminados › Producto › Lote).
- "Cobros" no es un ítem aparte: los cobros se registran desde la venta o la cuenta corriente;
  Finanzas queda con Cuentas a cobrar.
- Los módulos futuros salen del menú.

## Navegación

- **Por permisos:** `visibleNavigation` muestra sólo lo que el rol puede abrir. Menú resultante:
  ADMIN/OWNER/ADMINISTRATION 20 ítems; SALES 6; PURCHASING 6; PRODUCTION 10; WAREHOUSE 9 (detalle en
  la auditoría). Lo verifican `apps/web/test/navigation.test.ts` y `e2e/ux.spec.ts`.
- **Guardia de rutas:** `canOpenRoute` en `lib/navigation.ts`. Si alguien abre por URL una sección sin
  permiso, ve "No tenés acceso a esta sección" en lugar de una pantalla que termina en 403. Las
  garantías del backend no cambiaron.
- **Acciones rápidas** en la barra superior y en Inicio según permiso (Vender, Tomar pedido, Nueva
  orden de producción, Nueva compra, Registrar un cobro).
- **Migas** en jerarquías profundas (lote, ficha de stock, detalle de compra, cuenta corriente) en una
  `nav` "Ubicación"; no se usan en listados de primer nivel.
- **Deep links** preservados: todas las rutas existentes siguen funcionando; los códigos enlazan a su
  entidad (pedido ↔ venta ↔ orden de producción ↔ lote).

## App shell

Sidebar fija en escritorio; en tablet un cajón con botón "Abrir menú", que se cierra con Escape o al
navegar y devuelve el foco. "Saltar al contenido" es el primer foco. Encabezado de página único
(`PageHeader`): migas, título con estado, una acción primaria y secundarias. Contexto de empresa y
usuario en la barra superior.

## Design system

Tokens en `:root` de `apps/web/src/app/globals.css` (71 variables): espaciado (8 pasos), tipografía
(familias, tamaños, pesos, interlineado), radios, bordes (incluye `--color-border-input` con contraste
3,4:1 para campos), elevación (3 niveles), superficies, foco, deshabilitado y las cinco semánticas
success / warning / danger / info / neutral (fondo, borde y texto cada una, todas ≥ 6:1 sobre su
fondo). No se usaron gradientes, transparencias decorativas ni animaciones largas; las transiciones son
de 120 ms y sólo en hover/foco.

Semántica de color aplicada igual en todos los módulos (tabla en
[UX_TERMINOLOGY.md › Estados y colores](../UX_TERMINOLOGY.md)): pedido listo = success, con faltantes =
warning, lote bloqueado o vencido = danger, informativo = info, borrador/cancelado = neutral.

## Componentes

Sólo donde había repetición demostrada:

| Componente                                 | Uso                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`                               | Migas, título con estado, acción primaria y secundarias en todas las páginas                                                             |
| `StatusBadge` (+ tonos en `ui/status.tsx`) | Un único badge para pedidos, producción, compras, ventas, cobros, lotes, cobertura, calidad y conservación                               |
| `MasterList`                               | Patrón de tabla: búsqueda, filtros, chips de filtros activos, orden, paginación, vacío, carga, error                                     |
| `EmptyState` / `ErrorState` / `Loading`    | Estados vacíos con contexto y CTA por permiso; errores traducidos con reintento                                                          |
| `ConfirmAction`                            | Acciones destructivas: consecuencia explicada, motivo cuando corresponde, foco de vuelta                                                 |
| `Combobox`                                 | Selector con búsqueda para producto, cliente, proveedor, materia prima y receta                                                          |
| `LineList` / `LineRow` / `LineField`       | Editor de líneas de compra, pedido y venta (producto, cantidad, unidad, precio, descuento, subtotal, quitar); en tablet pasa a dos filas |
| `CopyableCode`                             | Códigos PED/VTA/OP/LOT visibles, copiables y enlazables con un estilo único                                                              |
| `Icon`                                     | Set de íconos de trazo único; nunca es la única pista de una acción                                                                      |
| `FlashProvider`                            | Confirmaciones de operaciones importantes en una región `status` única                                                                   |
| `AuditHistory`                             | Historial al final de las fichas, con nombres de rol y campos en castellano                                                              |

Deuda F5B de descuentos resuelta: en ancho reducido el editor parte la línea en dos filas y el selector
de producto conserva el ancho completo.

## Dashboard

`components/dashboard/dashboard.tsx`. Inicio responde "¿qué requiere mi atención ahora?" con datos de
endpoints existentes y sólo los que el usuario puede leer:

- **Acciones rápidas** según permiso.
- **Requiere atención:** pedidos para hoy, pedidos en riesgo, producción abierta, lotes vencidos,
  lotes por vencer, materias primas bajo mínimo, compras por recibir, ventas en borrador, saldos de
  clientes. Cada tarjeta enlaza al listado filtrado y se oculta si el rol no tiene el permiso.
- **Próximas entregas**, **Producción pendiente** y **Actividad reciente** (esta última sólo con
  `audit.read`).

Sin gráficos decorativos.

## Venta (mostrador)

"Nueva venta" abre con Consumidor Final, el depósito de la empresa y "Cobrar ahora" marcado con
Efectivo; el producto se busca con el combobox; el total se ve siempre; "Paga con (opcional)" calcula
el vuelto; "Confirmar venta y cobrar" registra, entrega y cobra en un paso y vuelve con "Venta X
registrada · cobrada · vuelto …" y la acción "Otra venta". FEFO sigue resolviéndose internamente; la
columna de lotes sólo aparece con `product_lots.read` y plegada. Si la vista previa tiene problemas, la
venta queda en borrador y se explica por qué.

## Pedidos

Detalle con estado, cobertura y prioridad en el título; métricas "Para cuándo", Cliente, Total, Seña,
Pendiente y Falta producir; **una** acción primaria según el siguiente paso (Confirmar → Actualizar
cobertura → Acordar precio → Planificar producción → Marcar listo → Empezar preparación → Entregar y
vender) y un aviso de quién sigue cuando el paso es de otro rol. Secciones en orden: productos,
preparación, entregas y ventas, cobros, historial. Formulario con combobox de cliente y producto,
editor de líneas, opcionales plegados y total estimado.

## Producción

Detalle de orden con Producto, Cantidad, Para cuándo, Pedido y Lote en el encabezado; primaria por
estado (Planificar / Iniciar / Revisar y completar); motivo visible cuando una acción está bloqueada;
el diálogo de revisión avisa que lo cargado ya quedó guardado y muestra el lote que se va a crear; el
aviso final incluye el código del lote. Planificación muestra "Falta producir" con atajos de horizonte
y materias primas con "Comprometido por pedidos" y "Disponible después".

## Inventario

Productos terminados muestra Físico, Comprometido (también en tablet), Disponible ahora y una columna
"Vencimientos y bloqueos" con badges, más un resumen de vencidos y próximos a vencer. Se agregó el
estado Descongelado. La ficha de lote tiene código copiable, avisos de vencido/próximo, métricas con
tono, enlace a la orden de origen y bloqueo con motivo obligatorio. Operaciones de stock con fecha en
la zona de la empresa (`WallClockInput`, mismo payload) y costo oculto sin permiso.

## Compras

Combobox de proveedor y materia prima, editor de líneas con unidades, una sola primaria por estado,
líneas que enlazan al stock de la materia prima, recepción en la zona de la empresa y costos ocultos sin
permiso. **Bug corregido:** si fallaba la confirmación después de crear la compra, reintentar creaba un
duplicado; ahora navega al borrador creado con un aviso.

## Finanzas

Cuentas a cobrar con Cliente, Saldo, Ventas sin cobrar, Desde y Límite. Cuenta corriente con métricas
(Saldo, Ventas sin cobrar y la más antigua, Crédito sin imputar, Límite), "Registrar cobro a cuenta"
con monto sugerido igual al saldo y saldo posterior, "Cobrar" por venta pendiente con "queda … después",
"Imputar crédito" con vista previa, libro con "Cargo (Debe)" y "Pago (Haber)" y saldo negativo
expresado como "a favor".

## Responsive

Revisado en 1440×900, 1366×768 y 768×1024 (capturas) y con el proyecto E2E `tablet` (820×1180). En
tablet: cajón de navegación, columnas secundarias ocultas por prioridad (`hide-md`/`hide-sm`, nunca
letra más chica), editor de líneas en dos filas, diálogos anchos con pie fijo, targets de 40 px.

## Accessibility

Objetivo WCAG 2.2 AA razonable: navegación completa por teclado, "Saltar al contenido", foco visible
con token propio, labels asociados, `aria-required`, `aria-invalid` y `aria-describedby` en campos,
foco al primer error, diálogos con título por `useId` y foco de vuelta al botón que los abrió, tablas
semánticas, íconos con texto o `aria-label`, `aria-busy` mientras una tabla recarga, `aria-current` en
el menú. Contraste: badges ≥ 6:1, bordes de campos 3,4:1 (antes 1,8:1).

## Terminología

[`docs/UX_TERMINOLOGY.md`](../UX_TERMINOLOGY.md): vocabulario único (Stock físico, Disponible,
Comprometido, Falta producir, Costo material, Margen sobre materiales, Crédito a favor, Pedido, Venta,
Cobro…), estados y colores, formatos de dinero (`$ 12.345,67`), cantidades (`1,5 kg`, `250 u`), fechas
en la zona de la empresa y tono (voseo). Los mensajes de la API se muestran con números en formato
argentino (`localizeNumbers`) y los errores conocidos se traducen (`describeError`). Se alinearon dos
textos de la API con el botón real ("usá «Acordar precio» antes de entregar") y el validador de roles
("Asigná al menos un rol").

## UX backlog

[`docs/UX_BACKLOG.md`](../UX_BACKLOG.md) clasifica los 68 ítems previos:

| Clasificación    | Ítems | Significado                                                 |
| ---------------- | ----- | ----------------------------------------------------------- |
| DONE             | 33    | Resueltos en este sprint                                    |
| FIX_NOW          | 8     | Arreglos chicos hechos en este sprint (detalle en la tabla) |
| DEFER_FUNCTIONAL | 19    | Necesitan capacidad funcional o datos nuevos; fuera         |
| WONT_FIX         | 5     | Se decidió no cambiar, con motivo                           |
| DUPLICATE        | 3     | Repetidos                                                   |

Se mantuvieron fuera, como deuda funcional: SALE_RETURN / devoluciones, devolución de señas,
LOT_PICKING_OVERRIDE (sólo se mejoró la explicación de FEFO) y ORDER_FORM_PRICE_OVERRIDE.

## Before / after

Conteos sobre el código y los E2E, sin tiempos (no se midieron). "Antes" viene de los informes de área.

| Workflow              | Antes                                                                                                                                        | Después                                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Venta mostrador       | 12 clics mínimos + 2 entradas; 3 pantallas, 2 navegaciones, 1 diálogo; depósito y método a verificar                                         | 4 clics (Vender, elegir producto en el combobox, Confirmar venta y cobrar) + cantidad; 1 pantalla + resultado, 0 diálogos; cliente, depósito y método ya puestos; "Otra venta" a 1 clic                                                     |
| Pedido catering       | ≈ 17 clics + 5 entradas; 3 pantallas, 2 diálogos; cliente y productos en selects sin búsqueda; el detalle no decía cuánto falta ni qué sigue | Mismos pasos de dominio (crear, confirmar, seña); clientes y productos con búsqueda; el detalle responde en el encabezado qué pidió, para cuándo, estado, cobertura, total, seña, pendiente y falta producir, con una sola acción siguiente |
| Producción            | 11 clics, 3–4 navegaciones, 3 diálogos; pedido y fecha sólo en "Detalles"; lote no visible al completar                                      | 3 diálogos (las transiciones de dominio no cambiaron); pedido, para cuándo y lote en el encabezado y en el aviso final: el paso "ver el lote" ya no exige buscarlo (≈ 10 clics, 2–3 navegaciones)                                           |
| Compras               | ≈ 19–21 clics, 8 navegaciones, 2 búsquedas por texto para ver el stock; riesgo de compra duplicada                                           | Las líneas enlazan al stock (sin pasar por el menú ni buscar); selectores con búsqueda; reintento sin duplicados                                                                                                                            |
| Cobro                 | 7–9 clics + 2 entradas; 2 pantallas, 2 diálogos; saldo posterior no visible                                                                  | "Cobrar" en la venta pendiente: 2 clics (Cobrar, Registrar cobro) con monto sugerido; 1 diálogo que muestra cuánto queda después                                                                                                            |
| Inventario perecedero | 4 de 5 preguntas en 2 clics pero en 2 pantallas; "bloqueado" sin vista global (≈ 42 clics con 20 productos); comprometido oculto en tablet   | Las 5 preguntas en Productos terminados (2 clics, 1 pantalla) más avisos en Inicio; bloqueados y vencidos como badges por producto; comprometido visible en tablet                                                                          |

Información que el usuario ya no tiene que recordar: el depósito del mostrador, el pedido de una orden
de producción, el lote creado, el saldo que queda después de un cobro y qué rol sigue en un pedido.

## Screenshots

`ux-design-review/` (fuera del runtime): `capture.mjs` + `routes.json` generan las mismas 18 rutas en
1440, 1366 y 768, en `before/` (54) y `after/` (54): Inicio, Pedidos, Pedido detalle, Pedido nuevo,
Ventas, Venta nueva (mostrador), Venta detalle, Planificación, Producción, Orden de producción, Stock,
Ficha de stock, Productos terminados, Próximos a vencer, Compras, Compra, Cuentas a cobrar y Cuenta
corriente. Nota: en capturas de página completa la barra lateral termina a 100 vh porque es fija; en
pantalla real ocupa todo el alto.

## Tests

Unitarios (`pnpm test`): domain 170, shared 42, web 32, database 5, api 396 — todos verdes. Nuevos:
`apps/web/test/ux.test.ts` (traducción de errores, números localizados, búsqueda de opciones, tonos de
estado) y casos de `canOpenRoute` en `navigation.test.ts`.

**Flaky watch (`orders-access.test.ts`, cancelar y replanificar a la vez):** pasó en todas las corridas
de este sprint; no se tocó.

## E2E

Los 56 E2E (escritorio y tablet) pasan. Los existentes se actualizaron sólo en selectores y pasos donde
cambió la interfaz, sin quitar assertions de negocio:

- Ayudas compartidas en `e2e/support.ts` (abrir sección desde el menú, combobox o select, métricas,
  migas).
- Rótulos nuevos del menú; venta de mostrador con el flujo nuevo (mismas verificaciones de stock, lote,
  cobro y saldo); enlaces "← X" reemplazados por migas; texto de acceso denegado.

Nuevos en `e2e/ux.spec.ts`: menú por rol con usuarios reales SALES y WAREHOUSE (y ruta sin permiso),
una acción primaria por listado, búsqueda sin resultados con chips y "Limpiar filtros", errores sin
códigos ni UUID y 404 con salida, teclado (saltar al contenido) y cajón en tablet. En
`fase5b-ventas.spec.ts`: venta de mostrador en un paso con vuelto.

## Performance findings

- La búsqueda con demora podía navegar a una fila vieja: Enter aplica en el acto y la tabla se marca
  ocupada (`aria-busy`, atenuada) mientras el filtro está pendiente.
- Los listados mantienen los datos anteriores mientras recargan (`stale`) en lugar de vaciar la tabla.
- Inicio pide sólo los endpoints que el rol puede leer, en paralelo, y cada panel carga por separado.
- No se optimizó backend: no hubo medición que lo justificara.

## Riesgos

- Cambios amplios en la web (78 archivos). Mitigado con lint, typecheck, build, unitarios y los 56 E2E.
- La guardia de rutas es sólo de interfaz; si un permiso nuevo no se mapea en `navigation.ts`, la
  ruta mostraría "No tenés acceso" a quien sí lo tiene. Lo cubre `navigation.test.ts`.
- Las capturas `after/` son de una base de datos de prueba; con datos reales pueden variar los conteos.

## Deuda

**Decisiones para maxi (no se cambiaron, serían cambios de permisos):**

1. Producción ve costo, precio y margen en Recetas (`recipes.read` incluye el costo teórico) pero no
   los costos de las órdenes (`production.cost.read`).
2. El costo de referencia y el usado por recetas se ven sin `inventory.cost.read`; el precio de venta
   lo ve Producción.

**Posibles bugs de dominio encontrados (no se tocaron, fuera de alcance):**

1. Se puede registrar una seña sobre un pedido en borrador sin precio acordado.
2. Ventas depende de Depósito para marcar un pedido listo.
3. Una recepción de compra fallida deja un borrador cancelado ("Descartada") como registro sin uso.
4. Una receta inactiva con borrador sólo se puede descartar, no editar ni publicar.
5. Planificación muestra el stock de materias primas de toda la empresa; la orden usa el del depósito
   de origen.

**Deuda funcional que sigue:** devoluciones, reembolso de señas, LOT_PICKING_OVERRIDE,
ORDER_FORM_PRICE_OVERRIDE, columna de pedido y total en listados (requiere DTO), conteo global de
bloqueados (endpoint), reseteo de contraseña / Mi cuenta, aviso de cambios sin guardar, y el resto de
DEFER_FUNCTIONAL del backlog.

## Gates

| Gate  | Tema                             | Estado | Evidencia                                                                |
| ----- | -------------------------------- | ------ | ------------------------------------------------------------------------ |
| UX-A  | Auditoría completa               | PASS   | `docs/UX_AUDIT.md` + 4 informes de área                                  |
| UX-B  | Inventario de rutas              | PASS   | 91 rutas en `UX_AUDIT.md › Inventario de rutas`                          |
| UX-C  | Personas / tareas                | PASS   | `UX_AUDIT.md › Personas`                                                 |
| UX-D  | IA aprobada internamente         | PASS   | `UX_AUDIT.md › Arquitectura de información` con justificación            |
| UX-E  | Navegación por permisos          | PASS   | `visibleNavigation` + `canOpenRoute`; `navigation.test.ts`, `ux.spec.ts` |
| UX-F  | App shell consistente            | PASS   | `AppShell` + `PageHeader`; E2E de teclado y cajón                        |
| UX-G  | Design tokens                    | PASS   | 71 tokens en `globals.css`                                               |
| UX-H  | Status system                    | PASS   | `StatusBadge` único; `ux.test.ts` (tonos)                                |
| UX-I  | Tables                           | PASS   | `MasterList`; E2E de chips y limpiar filtros                             |
| UX-J  | Forms                            | PASS   | `EntityForm`, `Combobox`, `LineList`; E2E de error en campo              |
| UX-K  | Sale workflow                    | PASS   | E2E "venta de mostrador en un paso"                                      |
| UX-L  | Order workflow                   | PASS   | E2E Fase 5A y 5B sobre el detalle nuevo                                  |
| UX-M  | Production workflow              | PASS   | E2E Fase 4 y 4.5                                                         |
| UX-N  | Inventory workflow               | PASS   | E2E Fase 4.5 + captura Productos terminados                              |
| UX-O  | Purchase workflow                | PASS   | E2E Fase 3; bug de duplicado corregido                                   |
| UX-P  | Finance workflow                 | PASS   | E2E Fase 5B (cobros, cuenta corriente)                                   |
| UX-Q  | Dashboard                        | PASS   | E2E por rol sobre tarjetas `attention-*`                                 |
| UX-R  | Error states                     | PASS   | `describeError`; E2E de errores traducidos                               |
| UX-S  | Empty / loading states           | PASS   | `EmptyState`, `Loading`, `is-busy`; E2E de búsqueda vacía                |
| UX-T  | Terminology                      | PASS   | `docs/UX_TERMINOLOGY.md`                                                 |
| UX-U  | Desktop review                   | PASS   | Capturas 1440 y 1366 revisadas                                           |
| UX-V  | Tablet review                    | PASS   | Capturas 768 + proyecto E2E tablet                                       |
| UX-W  | Keyboard / accessibility         | PASS   | E2E de teclado; foco en diálogos; contraste medido                       |
| UX-X  | Sin UUID ni terminología interna | PASS   | E2E "nunca muestra identificadores internos" y "errores sin códigos"     |
| UX-Y  | E2E de negocio existentes        | PASS   | 56/56                                                                    |
| UX-Z  | Nuevos tests UX                  | PASS   | `ux.spec.ts`, `ux.test.ts`, `navigation.test.ts`                         |
| UX-AA | Lint                             | PASS   | `pnpm lint` (eslint `--max-warnings=0` + prettier)                       |
| UX-AB | Typecheck                        | PASS   | `pnpm typecheck`                                                         |
| UX-AC | Build                            | PASS   | `pnpm build`                                                             |
| UX-AD | Worktree clean                   | PASS   | `git status` limpio tras el último commit                                |
| UX-AE | Remote CI                        | PASS   | CI del PR en verde (ver el PR)                                           |

## CI

`main` quedó verde después del merge del PR #8. El CI del PR de este sprint corre lint, typecheck,
build, unitarios y E2E; su estado final está en el PR.

---

DETENERSE. No comenzar Fase 6. Este informe queda para revisión humana.
