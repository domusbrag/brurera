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

## VISUAL_HIERARCHY

- [F3] Los tres costos (promedio de inventario, referencia manual, usado por recetas) se
  distinguen por rótulo; falta una jerarquía visual que destaque el que efectivamente se usa.
- [F2/F3] Los resúmenes `cost-summary` se usan para cosas distintas (costos, totales, impacto de
  una merma). Un componente de "métricas" con variantes ayudaría a la consistencia.

- [F4] Costos de producción: esperado, estimado, real y diferencia se distinguen por rótulo y nota
  al pie. Falta una representación visual (p. ej. barra plan vs real) que destaque la diferencia.

- [F4.5] El estado de un lote combina dos badges (conservación + estado operativo). Definir un
  único indicador compacto (p. ej. ícono de copo para congelado + color por vencimiento).

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

## DASHBOARD

- [F3] El inicio todavía no muestra alertas de stock bajo mínimo ni compras pendientes de
  recibir (previsto en Fase 8, pero conviene un primer indicador).

- [F4] El inicio no muestra órdenes en curso ni planificadas con faltante de materia prima.

- [F4.5] El inicio no avisa lotes vencidos o próximos a vencer; es la alerta diaria más útil para
  producción y mostrador.

## RESPONSIVE

- [F3] En 768 px de ancho el menú pasa a panel desplegable; las tablas con 6+ columnas dependen
  del scroll horizontal del contenedor. Revisar densidad para tablet en uso de depósito.

- [F4] El diálogo "Revisar antes de completar" usa casi todo el alto en 768×1024 cuando hay
  muchas materias primas; tiene scroll propio, pero el botón "Confirmar producción" queda abajo.
  Evaluar un pie fijo dentro del diálogo.

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
