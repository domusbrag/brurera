# Navegación y usabilidad — informe

Pedido de maxi (2026-11-11): mejorar la interfaz, la navegación y la usabilidad. Rama
`navegacion-usabilidad` sobre `ux-design-optimization` (con la revisión integral y el rediseño ya
mergeados). **Sólo frontend**: sin migraciones, sin permisos nuevos y sin cambios en la API. En
Windows alcanza con traer la rama, `pnpm install` y `pnpm build`.

## Cómo se revisó

Se levantó la app con los datos que deja la suite E2E y se recorrieron Inicio, Pedidos, Nueva
venta, Productos, Stock, Compras, Cuentas a cobrar y Planificación a 1440 px y a 390 px (celular),
con el marco de crítica de diseño (primera impresión, usabilidad, jerarquía, consistencia,
accesibilidad). Lo que más costaba:

| Hallazgo                                                                                                                               | Gravedad | Dónde        |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------ |
| No hay forma de ir directo a un cliente, pedido o producto: siempre menú → listado → búsqueda → fila.                                  | Alta     | Toda la app  |
| El menú tiene 20 ítems; en 1440×900 «Compras» y «Organización» quedan debajo del borde y, estando en Compras, el ítem activo no se ve. | Media    | Menú lateral |
| En el celular «Tomar pedido» desaparece de la barra superior y el menú queda en la esquina, lejos del pulgar.                          | Media    | 390 px       |
| Pedidos muestra ocho filtros en tres renglones antes del primer resultado (siete renglones en el celular).                             | Media    | Listados     |
| Inicio muestra nueve tarjetas «0 · Nada pendiente» al mismo tamaño que lo urgente.                                                     | Baja     | Inicio       |

## Qué cambió

### 1. Buscador global (Ctrl+K)

- Botón **Buscar… Ctrl K** en la barra superior; también se abre con **Ctrl+K / ⌘K** desde
  cualquier lado y con **/** cuando no se está escribiendo en un campo.
- Encuentra **acciones** (Nueva venta, Nuevo pedido, Nueva compra, Nuevo cliente, Nueva receta…),
  **pantallas** (todo el menú más las secciones de Configuración) y **registros**: clientes,
  productos, pedidos, ventas, materias primas, recetas, órdenes de producción, compras y
  proveedores (hasta 3 por tipo, desde 2 letras).
- Sin tildes ni mayúsculas («produccion» encuentra «Producción») y con sinónimos de mostrador
  («deudas» → Cuentas a cobrar, «kardex» → Movimientos, «encargos» → Pedidos).
- Sólo ofrece lo que el rol puede abrir: usa el mismo menú filtrado por permisos y cada tipo de
  registro pide su permiso de lectura (la API vuelve a autorizar).
- Teclado completo: ↑ ↓ para elegir, Enter para abrir, Esc para cerrar. Es un `combobox` con
  `listbox` (ARIA), anuncia la cantidad de resultados y devuelve el foco al cerrar.
- Usa los listados que ya existían (`search`), no hay endpoint nuevo.

### 2. Menú lateral

- Cada grupo (Comercial, Productos y recetas, Producción, Inventario, Compras, Organización) se
  **pliega** con un clic en su título y queda recordado en ese navegador.
- El grupo de la pantalla actual no se puede plegar: siempre se ve dónde se está.
- Si el ítem actual queda fuera de vista (por ejemplo «Compras» en una pantalla de 900 px de alto),
  el menú se desplaza solo hasta mostrarlo.

### 3. Celular: barra inferior

En pantallas de hasta 720 px aparece una barra fija abajo con **Inicio · Pedidos · Vender ·
Buscar · Menú** (cada uno según permisos). La barra superior queda sólo con la empresa, el tema y
Salir. La tablet (820 px) sigue igual.

### 4. Listados: «Más filtros»

En el listado compartido (`MasterList`), cuando hay más de tres filtros se ven la búsqueda y los dos
primeros; el resto queda detrás de **Más filtros**, con un contador de filtros aplicados. Si se
llega con un filtro escondido ya aplicado (enlace de Inicio, volver atrás), el panel se abre solo.
Los chips de filtros aplicados y «Limpiar filtros» siguen igual. Afecta a Pedidos (8 filtros) y a
cualquier listado con más de tres.

### 5. Inicio: «Requiere atención»

Las tarjetas grandes son sólo para lo pendiente. Lo que está en cero se resume en una línea
**«Al día: pedidos para entregar hoy · compras pendientes de recibir · …»** (cada uno sigue siendo
un enlace). Si todo está en cero se dice «Todo al día». Las nueve consultas se siguen haciendo en
paralelo.

## Capturas

En la carpeta del proyecto `bakery-erp/navegacion/`: antes y después de Inicio, Pedidos y Compras
a 1440 y 390 px, y el buscador vacío y con resultados.

## Pruebas

- Unitarias web: 37 (5 nuevas del buscador: tildes, sinónimos, permisos y orden).
- E2E nuevos en `e2e/ux.spec.ts`: buscador (Ctrl+K, «/», Esc, registros de la API, Enter navega),
  «Más filtros» (oculto, se abre, vuelve abierto con filtro aplicado), menú plegable (recordado,
  el grupo actual no se pliega) y barra del celular.
- Suite E2E completa: 62 de 62 verdes (escritorio y tablet). Lint, prettier y typecheck verdes.

## Herramientas

- Se usaron las guías de crítica de diseño y de accesibilidad disponibles en Claude.
- `web-artifacts-builder` sirve para armar páginas sueltas dentro de claude.ai, no para cambiar
  esta aplicación, por eso no se usó para el código.
- En el repo hay una rama aparte (`claude/clever-turing-922mfj`) que instala el plugin externo
  `ui-ux-pro-max` para Claude Code. No está mergeada ni se usó acá; si se quiere, se puede
  incorporar en un PR propio.

## Pendiente / ideas siguientes

- Recordar en el buscador los últimos registros abiertos.
- Atajos de teclado por pantalla (por ejemplo «N» para «Nuevo…» en cada listado).
- Unificar «Stock de materias primas» y la ficha de materia prima (IA1 del backlog, cambia rutas).
