# UX backlog

Hallazgos de diseño que piden una revisión **transversal** de la aplicación. No es una lista de
bugs: los defectos funcionales se corrigen en la fase en que aparecen. Estas mejoras se abordan en
el sprint **UX/DESIGN OPTIMIZATION** previsto después de la Fase 5 (ver [ROADMAP](ROADMAP.md)).

Formato: categoría · hallazgo · dónde se vio · propuesta. Fase en que se registró entre corchetes.

## NAVIGATION

- [F3] El menú lateral crece con cada fase (Operaciones, Producción, Inventario, Comercial…) y
  mezcla módulos implementados con "Disponible en próxima etapa". Proponer: agrupar por tarea
  frecuente y ocultar o atenuar los módulos futuros.
- [F3] Inventario usa pestañas propias (Stock · Movimientos · Bajo mínimo) mientras que
  Configuración usa tarjetas. Unificar un patrón de subnavegación por módulo.
- [F3] Las acciones de inventario (ajustar, merma, stock inicial) están en la cabecera del listado
  y del detalle; con más acciones, la cabecera se recarga. Evaluar un menú de acciones.

## INFORMATION_ARCHITECTURE

- [F3] La ficha de la materia prima (Maestros) y la ficha de stock (Inventario) muestran parte de
  la misma información (costos, presentaciones). Definir qué vive en cada una o fusionarlas con
  pestañas.
- [F3] Las recepciones de una compra se ven dentro de la compra y en una página propia; no hay un
  listado global de recepciones (p. ej. "lo que llegó hoy").

## VISUAL_HIERARCHY

- [F3] Los tres costos (promedio de inventario, referencia manual, usado por recetas) se
  distinguen por rótulo; falta una jerarquía visual que destaque el que efectivamente se usa.
- [F2/F3] Los resúmenes `cost-summary` se usan para cosas distintas (costos, totales, impacto de
  una merma). Un componente de "métricas" con variantes ayudaría a la consistencia.

## FORMS

- [F3] Los números se escriben con punto o coma pero se muestran con separador de miles; un input
  numérico con formato en vivo (es-AR) evitaría dudas con montos grandes ($30.000).
- [F3] El alta de compra es una tabla editable ancha; en tablet entra, pero con muchas líneas
  conviene un editor por tarjetas o un panel lateral por línea.
- [F3] Crear una presentación de compra exige ir a la ficha de la materia prima; un alta rápida
  desde el formulario de compra acortaría el recorrido.

## TABLES

- [F3] Movimientos de inventario: filtros por fecha y por referencia existen en la API pero no en
  la UI. Sumar un selector de rango de fechas común a todos los listados.
- [F3] Columnas ocultas en pantallas chicas (`hide-sm`) sin forma de verlas; evaluar filas
  expandibles.

## DASHBOARD

- [F3] El inicio todavía no muestra alertas de stock bajo mínimo ni compras pendientes de
  recibir (previsto en Fase 8, pero conviene un primer indicador).

## RESPONSIVE

- [F3] En 768 px de ancho el menú pasa a panel desplegable; las tablas con 6+ columnas dependen
  del scroll horizontal del contenedor. Revisar densidad para tablet en uso de depósito.

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
