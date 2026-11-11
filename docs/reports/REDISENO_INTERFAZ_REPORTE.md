# Rediseño de interfaz y alta de productos de corrido

Pedido de maxi (2026-11-11): una interfaz más amigable, moderna y con personalidad
(referencias: dashboards oscuros con acentos naranja/dorado y sitios de panadería), y
sobre todo que cargar un producto vendible no obligue a saltar entre pantallas. Tiene que
poder usarlo alguien que viene del papel y lápiz o de un Excel.

No es la Fase 6. Rama `rediseno-alta-productos`, sobre `ux-design-optimization` (que ya
incluye la revisión integral). Sin migraciones ni permisos nuevos.

## 1. Nuevo producto en una sola pantalla

Antes, para tener un producto listo para vender había que pasar por cinco pantallas:
Configuración → Categorías, Materias primas, Productos, Recetas (guardar borrador y
publicar) y Listas de precios. Ahora **Productos → Nuevo producto** (también desde
Inicio) hace todo en tres pasos en la misma página:

1. **¿Qué vas a vender?** Nombre, categoría, unidad de venta y precio. Si la categoría no
   existe se escribe y se crea («Crear la categoría «Facturas»»). Código, descripción y
   foto quedan en «Más datos (opcional)».
2. **¿Con qué se hace?** «Con esta receta salen [48] [unidades]» y los ingredientes. Cada
   insumo se busca escribiendo; si no existe, «Crear el insumo «Manteca»» y en la misma
   fila se elige en qué se mide y cuánto cuesta. Si un insumo que ya existe no tiene costo,
   se puede cargar ahí mismo. Interruptor «Tiene receta» para productos de reventa.
3. **¿A cuánto lo vendés en cada lista?** Las listas activas, con la general ya marcada y
   el mismo precio de venta; se cambia sólo donde es distinto.

A la derecha, un **resumen tipo ticket** se actualiza mientras se escribe: cuánto cuesta
hacerlo por unidad, a cuánto se vende, cuánto queda (con %), una barra de margen y la
lista de lo que se va a crear. Si faltan costos, avisa cuáles y muestra el piso del costo.

Al guardar, la API (`POST /api/product-setup`) hace todo en **una transacción**:
categoría (reutiliza una existente con el mismo nombre, sin distinguir mayúsculas),
insumos nuevos, costos cargados en el momento, producto, receta, publicación y precios en
listas. Reutiliza los servicios de cada módulo (mismas validaciones, códigos automáticos y
auditoría que pantalla por pantalla). Si algo falla, no queda nada a medias. Cada parte
exige su permiso (`categories.manage`, `raw_materials.create`, `raw_materials.update_cost`,
`recipes.create`, `recipes.publish`, `price_lists.manage`); la pantalla sólo ofrece lo que
el rol puede hacer. Publicar con costo incompleto sigue pidiendo confirmación explícita.

El formulario clásico de producto sigue para **Editar**. Recetas, Materias primas y
Listas de precios siguen funcionando como antes para los ajustes finos.

## 2. Aspecto

- Tema **oscuro cálido** por defecto (fondo casi negro con un brillo naranja, superficies
  marrón oscuro), acento **naranja tostado** y dorado. Tipografías: Fraunces (títulos, una
  serif con carácter de panadería) y Plus Jakarta Sans (texto). Van empaquetadas
  (`@fontsource-variable/*`), no dependen de internet.
- **Tema claro** a un clic (botón sol/luna arriba), recordado en ese navegador.
- Formas más redondeadas, botones tipo píldora, menú lateral flotante, tablas más aireadas.
- **Inicio** con bienvenida («Buenas tardes, …») y accesos grandes en tarjetas (Nueva
  venta, Nuevo pedido, Nueva orden de producción, **Nuevo producto**, Nueva compra,
  Registrar un cobro).
- Todos los colores salen de tokens: los estados (éxito, aviso, error) mantienen su
  significado y contraste en ambos temas.

## 3. Navegación

El menú agrupa todo lo que define un producto: **Productos y recetas** = Productos,
Recetas, Materias primas y Listas de precios. **Comercial** = Pedidos, Ventas, Clientes y
Cuentas a cobrar (el grupo Finanzas tenía un solo ítem). Producción queda con
Planificación y Órdenes de producción. Los permisos por rol no cambian.

## 4. Pruebas

- API: 416 tests (8 nuevos del alta de corrido: todo en un paso, reutilizar categoría,
  todo o nada ante un error, costo incompleto, borrador, costo de insumo existente,
  permisos por parte).
- E2E: 58 (56 anteriores + `alta-de-corrido.spec.ts` en escritorio y tablet).
- Lint, formato y typecheck en verde.

## 5. Para probarlo en Windows

```powershell
git fetch origin
git checkout rediseno-alta-productos
pnpm install
pnpm build
pnpm dev
```

No hay migraciones nuevas ni hace falta `db:sync-reference`.

## 6. Pendiente / ideas

- Fotos de producto: hoy es una dirección web; subir la foto desde la compu necesita
  almacenamiento de archivos.
- Vista en tarjetas (con foto) para el listado de productos y para la venta de mostrador.
- Las tres decisiones de permisos de la revisión integral siguen pendientes de maxi.
