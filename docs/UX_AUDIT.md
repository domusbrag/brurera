# Auditoría UX del ERP

Estado: realizada al inicio del sprint UX / DESIGN OPTIMIZATION (2026-10-05), sobre `main` después de
cerrar la Fase 5B. Es la base de las decisiones de diseño del sprint; el resultado está en
[reports/UX_DESIGN_OPTIMIZATION_REPORT.md](reports/UX_DESIGN_OPTIMIZATION_REPORT.md).

## Método

- Se leyó el código de cada pantalla (`apps/web/src/app/(app)/**/page.tsx` y los componentes que usan),
  las acciones y mensajes que decide la API, y los permisos por rol de `packages/shared/src/roles.ts`.
- Se capturó cada pantalla clave en 1440×900, 1366×768 y 768×1024 (`ux-design-review/before/`).
- Para cada ruta se registró: ruta, módulo, roles, objetivo, acciones primarias y secundarias,
  información crítica, frecuencia esperada, problemas, redundancias, deuda ya registrada en
  [UX_BACKLOG.md](UX_BACKLOG.md) y prioridad.
- Prioridades: **P0** bloquea o pone en riesgo la operación diaria; **P1** fricción alta en un flujo
  frecuente; **P2** inconsistencia o fricción en un flujo ocasional; **P3** pulido.
- Los cinco flujos principales (venta de mostrador, pedido de catering, producción, compras, cobro e
  inventario perecedero) se recorrieron paso a paso contando clics, pantallas, campos obligatorios,
  diálogos y acciones redundantes (sección "Workflow … — ANTES" de cada informe de área).

Fichas completas por área:

| Área | Rutas | Informe |
|---|---|---|
| Comercial: pedidos, ventas, clientes, listas de precios, cuentas a cobrar | 19 | [ux-audit/comercial.md](ux-audit/comercial.md) |
| Producción, planificación y recetas | 12 | [ux-audit/produccion.md](ux-audit/produccion.md) |
| Inventario, lotes, compras y artículos | 29 | [ux-audit/inventario-compras.md](ux-audit/inventario-compras.md) |
| Organización, configuración, acceso y shell | 31 | [ux-audit/organizacion.md](ux-audit/organizacion.md) |

## Personas

Una sola aplicación que se adapta por permisos; no hay "apps" separadas por rol.

| Persona | Rol del sistema | Qué hace todos los días | Qué necesita ver primero |
|---|---|---|---|
| Dueño / Admin | OWNER, ADMIN | Mira cómo viene el día, aprueba, resuelve excepciones, controla costos y márgenes | Lo que requiere acción: pedidos en riesgo, lotes por vencer, saldos, compras pendientes |
| Ventas / Mostrador | SALES | Vende rápido en mostrador, toma pedidos de catering, cobra señas y saldos | Vender y tomar pedido a un clic; próximas entregas; cuentas a cobrar. No ve stock ni costos (no tiene `inventory.read` ni permisos de costo) |
| Producción | PRODUCTION | Planifica qué hornear, lanza y completa órdenes, registra consumos reales | Necesidades de producción, órdenes abiertas, para qué pedido es cada orden |
| Depósito | WAREHOUSE | Recibe, ajusta, controla lotes y vencimientos, marca pedidos listos | Próximos a vencer, bloqueados, comprometido vs disponible |
| Administración | ADMINISTRATION | Compras, cobranzas, cuentas corrientes, maestros | Saldos de clientes, compras por recibir, ventas en borrador |
| Compras | PURCHASING | Compra materias primas y sigue recepciones | Bajo mínimo, compras pendientes de recibir |

## Arquitectura de información

### Antes

9 grupos organizados por tipo de dato (Operaciones, Producción, Planificación, Inventario, Comercial,
Finanzas, Equipo, Análisis, Sistema); 5 módulos futuros (Caja, Cuentas a pagar, Gastos, Facturación,
Reportes) visibles para todos los roles y que llevaban a "Disponible en próxima etapa" (entre el 38 % y el
50 % del menú de los roles operativos); Configuración visible para roles que sólo leen unidades;
Proveedores dentro de Comercial; "Stock", "Órdenes" y "Necesidades" con nombres ambiguos. Detalle por
rol en [ux-audit/organizacion.md §2](ux-audit/organizacion.md).

### Después

Grupos por tarea de negocio, en orden de frecuencia: **Comercial** (vender y pedir), **Producción**
(planificar y hornear), **Inventario** (qué hay y qué vence), **Compras**, **Finanzas**, **Catálogo**
(maestros de artículos) y **Organización** (gente y sistema). Justificación de cada variación:

- *Planificación* pasa dentro de Producción: lo usa quien decide qué hornear.
- *Proveedores* pasa a Compras: es quien los usa.
- *Productos* y *Materias primas* (maestros) se separan del stock en *Catálogo*: se consultan poco y
  confundían "ver stock" con "editar el artículo".
- *Próximos a vencer* y *Movimientos* tienen acceso directo en el menú (antes sólo eran pestañas).
- Los módulos futuros salen del menú; su ruta directa sigue existiendo.
- *Configuración* sólo aparece a quien administra algo (empresa, unidades, categorías, depósitos o roles).
- Rótulos únicos y explícitos: "Stock de materias primas", "Productos terminados", "Órdenes de
  producción", "Planificación".
- Acciones rápidas por permiso en la barra superior: "Tomar pedido" y "Vender".

Menú resultante por rol (calculado de `visibleNavigation` con los permisos reales de cada rol; lo
verifica `apps/web/test/navigation.test.ts`):

```
ADMIN / OWNER / ADMINISTRATION (Inicio + 20 ítems, 7 grupos)
COMERCIAL       Pedidos · Ventas · Clientes · Listas de precios
PRODUCCIÓN      Planificación · Órdenes de producción · Recetas
INVENTARIO      Stock de materias primas · Productos terminados · Próximos a vencer · Movimientos
COMPRAS         Compras · Proveedores
FINANZAS        Cuentas a cobrar
CATÁLOGO        Productos · Materias primas
ORGANIZACIÓN    Empleados · Usuarios · Configuración · Auditoría

SALES (Inicio + 6 ítems, 3 grupos)
COMERCIAL       Pedidos · Ventas · Clientes · Listas de precios
FINANZAS        Cuentas a cobrar
CATÁLOGO        Productos

PURCHASING (Inicio + 6 ítems, 3 grupos)
INVENTARIO      Stock de materias primas · Productos terminados · Movimientos
COMPRAS         Compras · Proveedores
CATÁLOGO        Materias primas

PRODUCTION (Inicio + 10 ítems, 4 grupos)
COMERCIAL       Pedidos
PRODUCCIÓN      Planificación · Órdenes de producción · Recetas
INVENTARIO      Stock de materias primas · Productos terminados · Próximos a vencer · Movimientos
CATÁLOGO        Productos · Materias primas

WAREHOUSE (Inicio + 9 ítems, 4 grupos)
COMERCIAL       Pedidos · Ventas
INVENTARIO      Stock de materias primas · Productos terminados · Próximos a vencer · Movimientos
COMPRAS         Compras
CATÁLOGO        Productos · Materias primas
```

## Inventario de rutas

91 rutas auditadas. Prioridad según la ficha del área.

| Ruta | Módulo | Frecuencia | Prioridad | Detalle |
|---|---|---|---|---|
| `/pedidos` | Comercial › Pedidos | diaria | P0 | [comercial](ux-audit/comercial.md) |
| `/pedidos/nuevo` | Comercial › Pedidos | diaria | P0 | [comercial](ux-audit/comercial.md) |
| `/pedidos/[id]` | Comercial › Pedidos | diaria | P0 | [comercial](ux-audit/comercial.md) |
| `/pedidos/[id]/editar` | Comercial › Pedidos | ocasional | P2 | [comercial](ux-audit/comercial.md) |
| `/pedidos/[id]/modificar` | Comercial › Pedidos | semanal | P1 | [comercial](ux-audit/comercial.md) |
| `/ventas` | Comercial › Ventas | diaria | P1 | [comercial](ux-audit/comercial.md) |
| `/ventas/nueva` | Comercial › Ventas (mostrador y entrega de pedidos) | diaria | P0 | [comercial](ux-audit/comercial.md) |
| `/ventas/[id]` | Comercial › Ventas | diaria | P0 | [comercial](ux-audit/comercial.md) |
| `/ventas/[id]/editar` | Comercial › Ventas | ocasional | P2 | [comercial](ux-audit/comercial.md) |
| `/clientes` | Comercial › Clientes | semanal | P1 | [comercial](ux-audit/comercial.md) |
| `/clientes/nuevo` | Comercial › Clientes | semanal | P1 | [comercial](ux-audit/comercial.md) |
| `/clientes/[id]` | Comercial › Clientes | semanal | P1 | [comercial](ux-audit/comercial.md) |
| `/clientes/[id]/editar` | Comercial › Clientes | ocasional | P2 | [comercial](ux-audit/comercial.md) |
| `/listas-de-precios` | Comercial › Listas de precios | ocasional | P3 | [comercial](ux-audit/comercial.md) |
| `/listas-de-precios/nuevo` | Comercial › Listas de precios | ocasional | P3 | [comercial](ux-audit/comercial.md) |
| `/listas-de-precios/[id]` | Comercial › Listas de precios | semanal/mensual | P2 | [comercial](ux-audit/comercial.md) |
| `/listas-de-precios/[id]/editar` | Comercial › Listas de precios | ocasional | P3 | [comercial](ux-audit/comercial.md) |
| `/cuentas-a-cobrar` | Finanzas › Cuentas a cobrar (en el menú está en Finanzas, li | diaria/semanal | P1 | [comercial](ux-audit/comercial.md) |
| `/cuentas-a-cobrar/[id]` | Finanzas › Cuentas a cobrar | semanal | P1 | [comercial](ux-audit/comercial.md) |
| `/necesidades` | Planificación → Necesidades | diaria | P0 | [produccion](ux-audit/produccion.md) |
| `/necesidades/materias-primas` | Planificación → Necesidades | diaria/semanal | P1 | [produccion](ux-audit/produccion.md) |
| `/necesidades/en-riesgo` | Planificación → Necesidades | diaria | P1 | [produccion](ux-audit/produccion.md) |
| `/produccion` | Producción → Órdenes | diaria, varias veces | P0 | [produccion](ux-audit/produccion.md) |
| `/produccion/nueva` | Producción → Órdenes | diaria | P0 | [produccion](ux-audit/produccion.md) |
| `/produccion/[id]` | Producción → Órdenes | diaria y varias veces por orden | P0 | [produccion](ux-audit/produccion.md) |
| `/produccion/[id]/editar` | Producción → Órdenes | ocasional | P2 | [produccion](ux-audit/produccion.md) |
| `/recetas` | Producción → Recetas | semanal / ocasional | P2 | [produccion](ux-audit/produccion.md) |
| `/recetas/nuevo` | Producción → Recetas | ocasional | P3 | [produccion](ux-audit/produccion.md) |
| `/recetas/[id]` | Producción → Recetas | semanal / ocasional. PRODUCCIÓN la consu | P2 | [produccion](ux-audit/produccion.md) |
| `/recetas/[id]/versiones/[versionId]` | Producción → Recetas | ocasional | P3 | [produccion](ux-audit/produccion.md) |
| `/recetas/[id]/versiones/[versionId]/editar` | Producción → Recetas | ocasional | P3 | [produccion](ux-audit/produccion.md) |
| `/stock` | Inventario › Materias primas | diaria | P1 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/[id]` | Inventario › Materias primas › Ficha de stock | diaria/semanal | P1 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/ajuste` | Inventario › Operaciones | semanal | P1 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/merma` | Inventario › Operaciones | semanal / diaria en insumos perecederos | P1 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/inicial` | Inventario › Operaciones (puesta en marcha) | una vez por insumo y depósito | P2 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/movimientos` | Inventario › Movimientos | semanal / ante diferencias | P2 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/bajo-minimo` | Inventario › Bajo mínimo | diaria/semanal | P1 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/productos` | Inventario › Productos terminados | diaria, varias veces | P0 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/productos/[id]` | Inventario › Productos terminados › Ficha | diaria | P1 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/productos/por-vencer` | Inventario › Próximos a vencer | diaria | P1 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/lotes/[id]` | Inventario › Lote | varias veces por semana | P2 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/lotes/[id]/congelar` | Inventario › Lote › Operación | diaria al cierre | P2 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/lotes/[id]/descongelar` | Inventario › Lote › Operación | diaria | P2 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/stock/lotes/[id]/merma` | Inventario › Lote › Operación | diaria | P2 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/compras` | Operaciones › Compras | diaria | P1 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/compras/nueva` | Compras › Alta | varias por semana | P0 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/compras/[id]` | Compras › Detalle | diaria | P1 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/compras/[id]/editar` | Compras › Edición de borrador | semanal | P2 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/compras/[id]/recepcion` | Compras › Recepción | diaria | P0 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/compras/[id]/recepciones/[receiptId]` | Compras › Recepción (detalle) | ocasional | P3 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/materias-primas` | Inventario › Materias primas (maestro) | semanal / mensual | P2 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/materias-primas/nuevo` | Maestro de materias primas | mensual | P2 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/materias-primas/[id]` | Maestro de materias primas › Ficha | mensual | P2 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/materias-primas/[id]/editar` | Maestro de materias primas | ocasional | P3 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/productos` | Inventario › Productos (maestro) | semanal | P3 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/productos/nuevo` | Maestro de productos | mensual | P3 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/productos/[id]` | Maestro de productos › Ficha | semanal | P2 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/productos/[id]/editar` | Maestro de productos | semanal | P3 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/productos/[id]/conservacion` | Maestro de productos › Conservación | una vez por producto; rara vez después | P3 | [inventario-compras](ux-audit/inventario-compras.md) |
| `/` | Shell / Inicio | muy alta. Es la primera pantalla de cada | P1 | [organizacion](ux-audit/organizacion.md) |
| `/[section]` | Shell | baja, pero se visita por error | P2 | [organizacion](ux-audit/organizacion.md) |
| `/login` | Acceso | diaria por usuario. En mostrador o table | P1 | [organizacion](ux-audit/organizacion.md) |
| `not-found` | Shell | baja | P2 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion` | Configuración | muy baja | P2 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/empresa` | Configuración | muy baja | P1 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/unidades` | Configuración | muy baja | P3 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/unidades/nuevo` | Configuración | muy baja | P2 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/unidades/[id]` | Configuración | muy baja | P2 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/unidades/[id]/editar` | Configuración | muy baja | P3 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/categorias` | Configuración | baja | P3 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/categorias/nuevo` | Configuración | baja | P3 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/categorias/[id]` | Configuración | baja | P2 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/categorias/[id]/editar` | Configuración | baja | P3 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/depositos` | Configuración | muy baja | P2 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/depositos/nuevo` | Configuración | muy baja | P3 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/depositos/[id]` | Configuración | baja | P2 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/depositos/[id]/editar` | Configuración | muy baja | P3 | [organizacion](ux-audit/organizacion.md) |
| `/configuracion/roles` | Configuración | muy baja | P2 | [organizacion](ux-audit/organizacion.md) |
| `/empleados` | Equipo | baja | P3 | [organizacion](ux-audit/organizacion.md) |
| `/empleados/nuevo` | Equipo | baja | P3 | [organizacion](ux-audit/organizacion.md) |
| `/empleados/[id]` | Equipo | baja | P2 | [organizacion](ux-audit/organizacion.md) |
| `/empleados/[id]/editar` | Equipo | baja | P3 | [organizacion](ux-audit/organizacion.md) |
| `/usuarios` | Equipo | baja | P3 | [organizacion](ux-audit/organizacion.md) |
| `/usuarios/nuevo` | Equipo | baja | P1 | [organizacion](ux-audit/organizacion.md) |
| `/usuarios/[id]` | Equipo | baja | P1 | [organizacion](ux-audit/organizacion.md) |
| `/proveedores` | Comercial (en el menú). Funcionalmente es Compras | media | P2 | [organizacion](ux-audit/organizacion.md) |
| `/proveedores/nuevo` | Compras | baja | P2 | [organizacion](ux-audit/organizacion.md) |
| `/proveedores/[id]` | Compras | media | P2 | [organizacion](ux-audit/organizacion.md) |
| `/proveedores/[id]/editar` | Compras | baja | P3 | [organizacion](ux-audit/organizacion.md) |
| `/auditoria` | Sistema | baja | P2 | [organizacion](ux-audit/organizacion.md) |

## Hallazgos transversales (resumen)

Cada informe de área tiene su sección "Hallazgos transversales" con referencias a archivo y línea. Los de
mayor impacto, comunes a varias áreas:

1. Selectores de entidades (`<select>`) sin búsqueda y truncados a 100 registros (clientes, productos,
   proveedores, materias primas, recetas).
2. Sin jerarquía de acciones: las acciones que hacen avanzar un flujo (confirmar, cobrar, completar) tenían
   el mismo peso que "Editar"; varias pantallas con 3 o más botones iguales.
3. Formatos inconsistentes: dos formatos de fecha en la misma pantalla, fechas en la zona del navegador
   (`datetime-local` en recepción de compras y operaciones de stock), montos sin moneda, cantidades sin
   unidad, números sin formato es-AR en mensajes de la API.
4. Estados vacíos y errores pobres: "Sin resultados" sin salida, errores de catálogos silenciados,
   "Cargando…" de página completa, mensajes genéricos sin acción.
5. Información de otros roles a la vista (lotes y FEFO en la venta, materias primas en el pedido, costos
   a quien no los necesita) y "—" usado como comodín para vacío, cero, sin permiso o no aplica.
6. Menú con módulos inexistentes y agrupado por tipo de dato; sin inicio operativo (el inicio sólo
   mostraba un texto y la actividad).
7. Flujos partidos entre roles sin indicar quién sigue ("esperando a depósito", etc.).
8. Editores de líneas distintos en pedido, venta, compra y lista de precios; el de venta se rompía en
   anchos chicos (deuda F5B de descuento).
9. Tablet usable sólo a medias: columnas críticas ocultas (Comprometido), objetivos táctiles chicos,
   menú sin cajón.
10. Accesibilidad: diálogos con `aria-labelledby` inválido, foco que no vuelve al abrir/cerrar, íconos o
    color como única señal, contraste de bordes de campos 1,35:1.

## Workflows — antes

Recorridos detallados en cada informe:

- Venta de mostrador: [comercial.md › Workflow venta mostrador — ANTES](ux-audit/comercial.md)
- Pedido de catering: [comercial.md › Workflow pedido catering — ANTES](ux-audit/comercial.md)
- Cobro: [comercial.md › Workflow cobro — ANTES](ux-audit/comercial.md)
- Producción: [produccion.md › Workflow producción — ANTES](ux-audit/produccion.md)
- Compras: [inventario-compras.md › Workflow compras — ANTES](ux-audit/inventario-compras.md)
- Inventario perecedero: [inventario-compras.md › Workflow inventario perecedero — ANTES](ux-audit/inventario-compras.md)

La comparación antes/después está en el informe final del sprint.
