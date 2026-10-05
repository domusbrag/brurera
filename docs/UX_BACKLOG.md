# UX backlog

Hallazgos de diseño que piden una revisión **transversal** de la aplicación. No es una lista de
bugs: los defectos funcionales se corrigen en la fase en que aparecen. Estas mejoras se abordan en
el sprint **UX/DESIGN OPTIMIZATION** previsto después de la Fase 5B (ver [ROADMAP](ROADMAP.md)).

Formato: categoría · hallazgo · dónde se vio · propuesta. Fase en que se registró entre corchetes.

## NAVIGATION

- [F3] El menú lateral crece con cada fase (Operaciones, Producción, Inventario, Comercial…) y
  mezcla módulos implementados con "Disponible en próxima etapa". Proponer: agrupar por tarea
  frecuente y ocultar o atenuar los módulos futuros.
- [F3] Inventario usa pestañas propias (Stock · Movimientos · Bajo mínimo) mientras que
  Configuración usa tarjetas. Unificar un patrón de subnavegación por módulo.
- [F3] Las acciones de inventario (ajustar, merma, stock inicial) están en la cabecera del listado
  y del detalle; con más acciones, la cabecera se recarga. Evaluar un menú de acciones.

- [F4] Producción suma "Órdenes" antes de "Recetas" y Stock suma la pestaña "Productos
  terminados": ya son cuatro pestañas en Inventario. Revisar junto con la subnavegación por módulo.

- [F4.5] Stock suma la pestaña "Próximos a vencer": ya son cinco pestañas en Inventario. Evaluar
  una sección "Producto terminado" con sub-pestañas (stock, lotes, por vencer).

- [F5A] Aparecen "Comercial → Pedidos" y un grupo nuevo "Planificación → Necesidades". Con Ventas
  (5B) Comercial tendrá Pedidos, Ventas, Clientes y Proveedores: revisar si Pedidos y Ventas van
  juntos en un grupo "Clientes" y Proveedores con Compras.
- [F5B] Comercial queda con Pedidos, Ventas, Listas de precios, Clientes y Proveedores, y
  Finanzas suma Cuentas a cobrar real junto a módulos futuros. Mismo hallazgo: reagrupar.
- [F5A] Necesidades usa pestañas por enlace (Producción · Materias primas · Pedidos en riesgo) con
  el horizonte en la URL; es el mismo patrón que Inventario pero con un filtro compartido. Tomarlo
  como base del patrón de subnavegación.

## INFORMATION_ARCHITECTURE

- [F3] La ficha de la materia prima (Maestros) y la ficha de stock (Inventario) muestran parte de
  la misma información (costos, presentaciones). Definir qué vive en cada una o fusionarlas con
  pestañas.
- [F3] Las recepciones de una compra se ven dentro de la compra y en una página propia; no hay un
  listado global de recepciones (p. ej. "lo que llegó hoy").

- [F4] La ficha de stock de un producto terminado y la ficha del producto (Maestros) se solapan
  (precio, receta). Mismo criterio que materias primas: definir qué vive en cada una.
- [F4] El detalle de una orden muestra receta, depósitos, lote y tiempos en un bloque de
  "Detalles" largo; en una orden en curso lo importante (consumo y salida) queda debajo del pliegue
  en 1366×768. Evaluar un encabezado compacto y la carga real arriba.

- [F4.5] La ficha de stock de un producto ya tiene Existencias, Lotes, Disponibilidad a una fecha,
  Precio y margen, Producciones, Movimientos e Historial de costo: es larga. Evaluar pestañas
  (Resumen · Lotes · Movimientos · Costos).
- [F4.5] La conservación se configura en la ficha del producto (Maestros) y se consulta en la ficha
  de stock; un acceso directo desde el lote o la ficha de stock acortaría el recorrido.

- [F5A] El detalle del pedido es largo (datos, avisos, productos, lotes, producción, materias
  primas, historial). En un pedido confirmado lo urgente (avisos y acciones) está arriba, pero
  lotes y producción quedan debajo del pliegue en 1366×768. Evaluar pestañas o un resumen lateral.
- [F5A] La cobertura por producto de la vista previa usa tarjetas con ocho métricas; con varios
  productos la vista previa se alarga. Evaluar una tabla compacta con detalle desplegable.

## VISUAL_HIERARCHY

- [F3] Los tres costos (promedio de inventario, referencia manual, usado por recetas) se
  distinguen por rótulo; falta una jerarquía visual que destaque el que efectivamente se usa.
- [F2/F3] Los resúmenes `cost-summary` se usan para cosas distintas (costos, totales, impacto de
  una merma). Un componente de "métricas" con variantes ayudaría a la consistencia.

- [F4] Costos de producción: esperado, estimado, real y diferencia se distinguen por rótulo y nota
  al pie. Falta una representación visual (p. ej. barra plan vs real) que destaque la diferencia.

- [F4.5] El estado de un lote combina dos badges (conservación + estado operativo). Definir un
  único indicador compacto (p. ej. ícono de copo para congelado + color por vencimiento).

- [F5A] El pedido muestra estado y cobertura como dos badges en el título; "Confirmado · Cobertura
  parcial" se entiende, pero compite con la prioridad. Definir una línea de estado del pedido.
- [F5A] El campo "Datos del pedido" muestra "—" para los datos vacíos (contacto, evento, listo);
  ocultar los vacíos acortaría el bloque.

## FORMS

- [F3] Los números se escriben con punto o coma pero se muestran con separador de miles; un input
  numérico con formato en vivo (es-AR) evitaría dudas con montos grandes ($30.000).
- [F3] El alta de compra es una tabla editable ancha; en tablet entra, pero con muchas líneas
  conviene un editor por tarjetas o un panel lateral por línea.
- [F3] Crear una presentación de compra exige ir a la ficha de la materia prima; un alta rápida
  desde el formulario de compra acortaría el recorrido.

- [F4] Consumo real: la columna "Diferencia" se recalcula al guardar el avance, no mientras se
  escribe. Calcularla en vivo en el navegador (misma función del dominio) daría feedback inmediato.
- [F4] El formulario de consumo extra es una fila de cinco campos; en 768 px pasa a dos columnas
  y queda largo. Evaluar un diálogo propio.
- [F4] Los campos de fecha (`input type=date`) muestran el formato del navegador (mm/dd/aaaa en un
  navegador en inglés) aunque la app muestre dd/mm/aaaa. Unificar con un selector propio.

- [F4.5] La vida útil se carga como número + unidad (días / horas) en una tabla de 4 filas; en
  tablet entra justo. Evaluar tarjetas por estado con interruptor.
- [F4.5] "Disponibilidad a una fecha" usa `datetime-local` en la zona del navegador, mientras que
  las fechas se muestran en la zona de la empresa. Unificar con el selector de fecha propio.
  _(F5A: corregido con `WallClockInput`, fecha + hora de la empresa.)_
- [F5A] Quedan dos campos `datetime-local` interpretados en la zona del navegador: fecha de
  recepción de compras (`purchase-form.tsx`) y fecha de operaciones de stock
  (`stock-operation.tsx`). Pasarlos a `WallClockInput` (deuda técnica, no sólo UX).
- [F5A] `WallClockInput` es fecha + hora nativas: el selector de fecha sigue el idioma del
  navegador (mm/dd/aaaa en inglés). Mismo hallazgo que [F4]: selector propio en es-AR.
- [F5A] Al modificar un pedido, la línea existente no cambia de producto (se quita y se agrega
  otra); explicarlo junto al selector bloqueado.
- [F5B] Las tablas editables de líneas (pedido, compra) usan inputs con el estilo del navegador;
  la venta y la lista de precios ya usan `.line-editor`. Unificar un único editor de líneas.
- [F5B] En 768 px el selector de producto de la venta queda angosto ("Elegí un pro…") porque
  Precio + Descuento ocupan dos campos. Evaluar el descuento en una segunda fila o un diálogo.
- [F5B] El alta y la edición del pedido no permiten cambiar el precio de una línea (el override
  sólo está en la venta); hoy se acuerda el precio vigente al confirmar.
- [F5B] La vista previa de la entrega muestra los lotes FEFO elegidos, pero no se puede elegir
  otro lote a mano (deuda `LOT_PICKING_OVERRIDE`).

## TABLES

- [F3] Movimientos de inventario: filtros por fecha y por referencia existen en la API pero no en
  la UI. Sumar un selector de rango de fechas común a todos los listados. _(F4: se sumaron
  "Desde/Hasta" en movimientos y órdenes de producción; falta un componente de rango común.)_
- [F3] Columnas ocultas en pantallas chicas (`hide-sm`) sin forma de verlas; evaluar filas
  expandibles.

- [F4] El listado de órdenes tiene 9 columnas; en tablet se ocultan responsable, lote y costo.
  Evaluar agrupar por estado (en curso / planificadas / completadas) en lugar de una sola tabla.
- [F4] Los enlaces "Ver todas / Ver todos" de los paneles usan el color de enlace por defecto del
  navegador, no el de la marca (también en la ficha de stock de materias primas).

- [F4.5] Productos terminados tiene 9 columnas con costos; en tablet se ocultan fresco /
  refrigerado / congelado. Evaluar un mini gráfico apilado por estado en una sola columna.

- [F4.5] La búsqueda de los listados aplica el filtro con 300 ms de demora (`router.replace`); si
  se escribe y se navega enseguida, el reemplazo devuelve al listado. Cancelar el filtro pendiente
  al navegar.

- [F5A] Necesidades → Producción lista los pedidos de cada producto dentro de la celda; con muchos
  pedidos la fila crece. Evaluar filas expandibles por producto.

## DASHBOARD

- [F3] El inicio todavía no muestra alertas de stock bajo mínimo ni compras pendientes de
  recibir (previsto en Fase 8, pero conviene un primer indicador).

- [F4] El inicio no muestra órdenes en curso ni planificadas con faltante de materia prima.

- [F4.5] El inicio no avisa lotes vencidos o próximos a vencer; es la alerta diaria más útil para
  producción y mostrador.

- [F5A] El inicio no muestra pedidos de hoy y mañana ni pedidos en riesgo; Necesidades → Pedidos
  en riesgo es la base natural de ese indicador.

## RESPONSIVE

- [F3] En 768 px de ancho el menú pasa a panel desplegable; las tablas con 6+ columnas dependen
  del scroll horizontal del contenedor. Revisar densidad para tablet en uso de depósito.

- [F4] El diálogo "Revisar antes de completar" usa casi todo el alto en 768×1024 cuando hay
  muchas materias primas; tiene scroll propio, pero el botón "Confirmar producción" queda abajo.
  Evaluar un pie fijo dentro del diálogo.

- [F5A] En 768 px, el menú desplegable volvía a aparecer abierto al regresar a la página donde se
  había abierto (corregido en F5A). Los formularios con tablas anchas ensanchaban la página
  (corregido: `.form` con columna `minmax(0, 1fr)`).

## ACCESSIBILITY

- [F3] Los badges de estado usan color además de texto (bien), pero algunos contrastes de
  `badge--warn` sobre fondo claro están cerca del mínimo AA. Auditar contraste.
- [F3] Los diálogos de confirmación (`ConfirmAction`) no devuelven el foco al botón que los abrió
  en todos los navegadores.

## WORKFLOW

- [F3] Recepción: el formulario propone recibir todo lo pendiente; en depósito suele llegar
  "todo menos X". Evaluar un atajo "recibir todo" vs. "recibir parcial" explícito.
- [F3] Desde "Bajo mínimo" se crea una compra de a una materia prima; agrupar por proveedor
  preferido y generar un pedido con varias líneas.
- [F3] Una compra con faltante definitivo (el proveedor no entregará el resto) no tiene forma de
  cerrarse "recibida con faltante"; hoy queda "Recibida en parte". Requiere definición de negocio.
- [F4] Una orden planificada con faltante muestra "Comprar" por materia prima; con varios
  faltantes conviene "Comprar todo lo que falta" agrupado por proveedor preferido.
- [F4] "Revisar y completar" guarda el avance antes de abrir la revisión; si el usuario vuelve
  sin confirmar, lo cargado ya quedó guardado (es lo esperado, pero no se avisa).
- [F4.5] Congelar se hace lote por lote; al cierre del día suele congelarse "todo lo fresco que
  sobró". Evaluar una acción masiva con FEFO inverso.
- [F4.5] Una merma de lote vencido exige entrar al lote; desde "Próximos a vencer" convendría
  "Registrar merma" directo en la fila.
- [F4] No hay reversa de una producción completada (deuda PRODUCTION_REVERSAL): un error de carga
  se corrige hoy con ajustes manuales de stock. Definir el flujo de reversa con negocio.
- [F5A] Cada necesidad de un pedido genera su propia orden de producción (deuda
  `PRODUCTION_CONSOLIDATION`): si tres pedidos piden medialunas para el sábado, son tres órdenes.
  Definir con negocio cómo consolidar (por producto y fecha) sin perder el vínculo a cada pedido.
- [F5A] Al terminar una producción el pedido avisa "Hay nuevo stock disponible" pero hay que
  entrar a cada pedido y "Actualizar cobertura". Evaluar una acción por lote "recalcular los
  pedidos afectados" (siempre explícita, nunca automática).
- [F5A] La seña del pedido sólo puede anotarse en Notas (`ORDER_ADVANCE_PAYMENT` es Fase 5B).
  _(F5B: «Registrar seña» en el pedido; se aplica sola al entregar.)_
- [F5A] Para empresas que ya existían, los permisos nuevos de pedidos llegan con
  `pnpm db:sync-reference` (o `pnpm bootstrap` en desarrollo); sin ese paso el menú no muestra
  Pedidos. Evaluar avisarlo en la pantalla de roles.
- [F5B] Cancelar un pedido con seña deja el crédito a favor del cliente y lo avisa, pero la
  devolución del dinero no existe (Caja, fase siguiente). Definir el flujo de devolución.
- [F5B] Imputar un cobro a cuenta es venta por venta; con muchas ventas pendientes conviene
  "imputar a las más viejas" en un paso.
- [F5B] Los enlaces a ventas dentro del pedido usan el estilo de enlace por defecto (azul,
  monoespaciado), distinto de los códigos del resto de la app.

---

## Clasificación del sprint UX/DESIGN OPTIMIZATION (2026-10-05)

Cada ítem de arriba quedó clasificado: **DONE** (resuelto en el sprint), **FIX_NOW** (resuelto en el
sprint como corrección puntual), **DEFER_FUNCTIONAL** (pide una regla de negocio, un endpoint o una
feature: no corresponde a un sprint de UX), **WONT_FIX** (se decidió no hacerlo, con motivo) o
**DUPLICATE** (cubierto por otro ítem). Detalle de cada cambio en
[reports/UX_DESIGN_OPTIMIZATION_REPORT.md](reports/UX_DESIGN_OPTIMIZATION_REPORT.md).

| #   | Ítem                                                            | Clasificación    | Resolución                                                                                                                                                                     |
| --- | --------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N1  | [F3] Menú crece y mezcla módulos futuros                        | DONE             | Menú por tarea (Comercial, Producción, Inventario, Compras, Finanzas, Catálogo, Organización), filtrado por permisos; módulos futuros fuera del menú.                          |
| N2  | [F3] Pestañas de inventario vs tarjetas de configuración        | DONE             | Patrón único: subnavegación por pestañas dentro del módulo y accesos directos en el menú para lo frecuente. Configuración mantiene su hub (son ajustes, no tareas).            |
| N3  | [F3] Acciones de inventario recargan la cabecera                | DONE             | Una acción primaria por pantalla; "Cargar stock inicial" pasa a terciaria.                                                                                                     |
| N4  | [F4] Cuatro pestañas en inventario                              | DONE             | "Productos terminados", "Próximos a vencer" y "Movimientos" con acceso propio en el menú.                                                                                      |
| N5  | [F4.5] Cinco pestañas en inventario                             | DUPLICATE        | De N4.                                                                                                                                                                         |
| N6  | [F5A] Reagrupar Pedidos / Ventas / Proveedores                  | DONE             | Comercial = Pedidos, Ventas, Clientes, Listas de precios; Proveedores pasa a Compras.                                                                                          |
| N7  | [F5B] Comercial y Finanzas con módulos futuros                  | DUPLICATE        | De N1 y N6.                                                                                                                                                                    |
| N8  | [F5A] Necesidades como base del patrón de subnavegación         | DONE             | "Planificación" con pestañas (Falta producir · Materias primas · Pedidos en riesgo) y atajos de horizonte.                                                                     |
| IA1 | [F3] Ficha de materia prima vs ficha de stock                   | DEFER_FUNCTIONAL | Fusionar fichas cambia rutas y permisos; quedan enlazadas entre sí.                                                                                                            |
| IA2 | [F3] Sin listado global de recepciones                          | DEFER_FUNCTIONAL | Pide un listado nuevo (feature).                                                                                                                                               |
| IA3 | [F4] Ficha de producto vs stock de producto                     | DEFER_FUNCTIONAL | Mismo criterio que IA1.                                                                                                                                                        |
| IA4 | [F4] Detalle de orden largo; la carga real queda abajo          | DONE             | Resumen compacto arriba y, en curso, "Consumo y salida reales" justo debajo del resumen.                                                                                       |
| IA5 | [F4.5] Ficha de stock de producto larga                         | DONE             | Resumen con métricas y tonos; secciones en orden de uso; costos sólo con permiso. Pestañas: no hicieron falta.                                                                 |
| IA6 | [F4.5] Conservación en otra ficha                               | WONT_FIX         | Ya hay enlace desde la ficha de stock y desde el lote; mover la configuración cambia permisos.                                                                                 |
| IA7 | [F5A] Detalle del pedido largo                                  | DONE             | Resumen (para cuándo, cliente, total, seña, pendiente, falta producir), siguiente paso destacado y secciones ordenadas.                                                        |
| IA8 | [F5A] Tarjetas de cobertura con ocho métricas                   | DONE             | Tarjetas compactas (Pedido, Disponible, Reservado, Falta producir) con el cálculo plegado.                                                                                     |
| V1  | [F3] Tres costos sin jerarquía                                  | WONT_FIX         | Se unificó el formato (`formatUnitCost` / `formatReferenceCost`) y cada costo tiene rótulo; la jerarquía depende de la decisión pendiente sobre quién ve costos (ver informe). |
| V2  | [F2/F3] `cost-summary` para todo                                | DONE             | Componente de métricas (`dl.metrics`) con variantes de tono.                                                                                                                   |
| V3  | [F4] Plan vs real sin representación visual                     | DONE             | Columnas Requerido / Consumido / Diferencia y tono en la diferencia. Barra gráfica: no hizo falta.                                                                             |
| V4  | [F4.5] Dos badges por lote                                      | DONE             | `StatusBadge` único con tonos semánticos; conservación como etiqueta neutra, estado operativo con color.                                                                       |
| V5  | [F5A] Estado y cobertura compiten con la prioridad              | DONE             | Línea de estado en el encabezado: estado, cobertura y prioridad sólo si no es normal.                                                                                          |
| V6  | [F5A] "—" en datos vacíos del pedido                            | DONE             | `Details hideEmpty`.                                                                                                                                                           |
| F1  | [F3] Input numérico con formato en vivo                         | DEFER_FUNCTIONAL | Cambia cómo se parsean los montos en todos los formularios; se mantiene el ingreso con punto o coma y los totales en vivo.                                                     |
| F2  | [F3] Alta de compra como tabla ancha                            | DONE             | Editor de líneas único; en tablet cada línea pasa a dos filas.                                                                                                                 |
| F3  | [F3] Alta rápida de presentación desde la compra                | DEFER_FUNCTIONAL | Pide un alta anidada (feature).                                                                                                                                                |
| F4  | [F4] "Diferencia" se calcula al guardar                         | DEFER_FUNCTIONAL | Requiere exponer el cálculo del dominio en el cliente.                                                                                                                         |
| F5  | [F4] Consumo extra como fila de cinco campos                    | DONE             | Campos con rótulo, errores asociados y confirmación al quitar.                                                                                                                 |
| F6  | [F4] `input type=date` en idioma del navegador                  | WONT_FIX         | Un selector de fecha propio es un componente grande con riesgo de accesibilidad; el formato mostrado en toda la app es dd/mm/aaaa y la zona es la de la empresa.               |
| F7  | [F4.5] Vida útil en tabla de 4 filas                            | WONT_FIX         | Entra en tablet; se usa al configurar, no a diario.                                                                                                                            |
| F8  | [F4.5] Disponibilidad con `datetime-local`                      | DONE             | (Ya corregido en F5A.)                                                                                                                                                         |
| F9  | [F5A] `datetime-local` en recepción y operaciones de stock      | FIX_NOW          | Pasaron a `WallClockInput` con la zona de la empresa, mismo payload.                                                                                                           |
| F10 | [F5A] `WallClockInput` con fecha nativa                         | DUPLICATE        | De F6.                                                                                                                                                                         |
| F11 | [F5A] La línea existente no cambia de producto                  | DONE             | Se explica junto al selector bloqueado.                                                                                                                                        |
| F12 | [F5B] Editores de línea distintos                               | DONE             | `LineList`/`LineRow`/`LineField` en venta, pedido y compra. La lista de precios sigue como tabla editable (edita todos los productos, no agrega líneas).                       |
| F13 | [F5B] Selector de producto angosto en 768 px                    | DONE             | En tablet el producto ocupa todo el ancho y precio/descuento van en la segunda fila.                                                                                           |
| F14 | [F5B] Pedido sin precio por línea (`ORDER_FORM_PRICE_OVERRIDE`) | DEFER_FUNCTIONAL | Cambio de dominio (precio pactado por línea).                                                                                                                                  |
| F15 | [F5B] Elegir lote a mano (`LOT_PICKING_OVERRIDE`)               | DEFER_FUNCTIONAL | Cambio de dominio.                                                                                                                                                             |
| T1  | [F3] Filtro de fechas común                                     | DONE             | `MasterList` con fechas, chips de filtros activos y "Limpiar filtros".                                                                                                         |
| T2  | [F3] Columnas ocultas sin forma de verlas                       | DONE             | Las críticas (estado, cantidad, comprometido, disponible, vencimiento) quedan visibles en tablet; sólo se ocultan secundarias.                                                 |
| T3  | [F4] Listado de órdenes con 9 columnas                          | DONE             | Cinco columnas principales; responsable, lote y costo como secundarias.                                                                                                        |
| T4  | [F4] "Ver todas" con color del navegador                        | FIX_NOW          | Estilo global de enlaces y de códigos.                                                                                                                                         |
| T5  | [F4.5] Productos terminados con 9 columnas                      | DONE             | Columna "Vencimientos y bloqueos" con badges; conservación como secundaria.                                                                                                    |
| T6  | [F4.5] Búsqueda con demora pisa la navegación                   | FIX_NOW          | Enter aplica en el acto; mientras el filtro está pendiente la tabla se marca ocupada y no se puede abrir una fila vieja.                                                       |
| T7  | [F5A] Pedidos dentro de la celda en Necesidades                 | DONE             | Cada pedido con su fecha y estado; filas compactas.                                                                                                                            |
| D1  | [F3] Inicio sin bajo mínimo ni compras pendientes               | DONE             | Inicio operativo: "Requiere atención" por permisos.                                                                                                                            |
| D2  | [F4] Inicio sin órdenes en curso                                | DONE             | Panel "Producción pendiente".                                                                                                                                                  |
| D3  | [F4.5] Inicio sin lotes vencidos o por vencer                   | DONE             | Tarjetas de vencidos y próximos a vencer.                                                                                                                                      |
| D4  | [F5A] Inicio sin pedidos de hoy ni en riesgo                    | DONE             | Pedidos para hoy, pedidos en riesgo y "Próximas entregas".                                                                                                                     |
| R1  | [F3] Tablas anchas en tablet                                    | DONE             | Columnas por prioridad, menú en cajón, objetivos táctiles de 44 px.                                                                                                            |
| R2  | [F4] Botón de confirmar fuera de vista en el diálogo            | FIX_NOW          | Pie fijo en los diálogos anchos.                                                                                                                                               |
| R3  | [F5A] Menú reabierto / página ensanchada                        | DONE             | (Ya corregido en F5A; verificado en la prueba de tablet.)                                                                                                                      |
| A1  | [F3] Contraste de badges                                        | FIX_NOW          | Tonos nuevos: todos ≥ 6:1. Bordes de campos llevados a 3,4:1 (antes 1,8:1).                                                                                                    |
| A2  | [F3] El foco no vuelve al botón del diálogo                     | FIX_NOW          | `ConfirmAction`, `PaymentDialog` y confirmación de venta devuelven el foco; títulos con `useId`.                                                                               |
| W1  | [F3] Recepción "todo" vs "parcial"                              | DEFER_FUNCTIONAL | Atajo nuevo en el flujo de recepción.                                                                                                                                          |
| W2  | [F3] Compra agrupada desde bajo mínimo                          | DEFER_FUNCTIONAL | Feature de compras.                                                                                                                                                            |
| W3  | [F3] Compra "recibida con faltante"                             | DEFER_FUNCTIONAL | Requiere regla de negocio.                                                                                                                                                     |
| W4  | [F4] "Comprar todo lo que falta"                                | DEFER_FUNCTIONAL | Feature de compras.                                                                                                                                                            |
| W5  | [F4] "Revisar y completar" guarda sin avisar                    | FIX_NOW          | El diálogo de revisión avisa que el avance ya quedó guardado y muestra el lote que se va a crear y el pedido vinculado.                                                        |
| W6  | [F4.5] Congelado masivo                                         | DEFER_FUNCTIONAL | Operación de stock nueva.                                                                                                                                                      |
| W7  | [F4.5] Merma desde "Próximos a vencer"                          | DEFER_FUNCTIONAL | Acción por fila nueva.                                                                                                                                                         |
| W8  | [F4] Reversa de producción (`PRODUCTION_REVERSAL`)              | DEFER_FUNCTIONAL | Cambio de dominio.                                                                                                                                                             |
| W9  | [F5A] Consolidar producción (`PRODUCTION_CONSOLIDATION`)        | DEFER_FUNCTIONAL | Cambio de dominio.                                                                                                                                                             |
| W10 | [F5A] Recalcular pedidos afectados por un lote                  | DEFER_FUNCTIONAL | Acción masiva nueva.                                                                                                                                                           |
| W11 | [F5A] Seña sólo en notas                                        | DONE             | (Resuelto en F5B.)                                                                                                                                                             |
| W12 | [F5A] Permisos nuevos sin `db:sync-reference`                   | WONT_FIX         | Es un paso de despliegue, documentado en el README.                                                                                                                            |
| W13 | [F5B] Devolución de señas                                       | DEFER_FUNCTIONAL | Requiere Caja (fase siguiente).                                                                                                                                                |
| W14 | [F5B] Imputar a las más viejas                                  | DEFER_FUNCTIONAL | Imputación masiva nueva; la imputación por venta ahora muestra cómo quedan venta y cobro.                                                                                      |
| W15 | [F5B] Enlaces a ventas con estilo distinto                      | FIX_NOW          | Códigos con el estilo único de la app.                                                                                                                                         |

Deuda funcional que sigue abierta a propósito (no se implementa en un sprint de UX):
`LOT_PICKING_OVERRIDE`, `ORDER_FORM_PRICE_OVERRIDE`, devolución de señas, `SALE_RETURN`,
`PRODUCTION_REVERSAL`, `PRODUCTION_CONSOLIDATION`, reseteo de contraseña.
