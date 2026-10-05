# Auditoría UX — Organización, Configuración y Shell

Alcance: `configuracion/*`, `empleados/*`, `usuarios/*`, `proveedores/*`, `auditoria`, `(app)/page.tsx`,
`(app)/[section]/page.tsx`, `login`, `not-found`, y los componentes `app-shell.tsx`,
`masters/{settings,users,employees,suppliers,audit,entity-form,master-list,ui}.tsx`,
`lib/navigation.ts`, `app/globals.css`.

Rutas de archivo relativas a `apps/web/src/` salvo indicación. Los números de línea son del archivo fuente.

**Escala de prioridad usada**

- **P0**: bloquea una tarea crítica, o hay riesgo de error grave, de datos o de seguridad.
- **P1**: pantalla de uso frecuente o de alto impacto con fricción importante, o una acción importante que falta.
- **P2**: inconsistencia o fricción moderada, o deuda de accesibilidad.
- **P3**: detalle cosmético o de redacción.

**Mapa de roles** (de `packages/shared/src/roles.ts` / `docs/PERMISSIONS.md`): ADMIN y OWNER tienen los 96 permisos.
ADMINISTRATION lee empresa, usuarios, roles y auditoría, y gestiona empleados, proveedores y categorías.
SALES, PURCHASING, PRODUCTION y WAREHOUSE tienen `units.read`, `categories.read` y `warehouses.read`.

---

## 1. Fichas por ruta

### 1.1 `/` — Inicio

- **Ruta:** `app/(app)/page.tsx`
- **Módulo:** Shell / Inicio
- **Roles que la usan:** los 7 roles. Tienen `dashboard.view`, aunque la página no lo verifica. Solo ADMIN, OWNER y ADMINISTRATION (`audit.read`) ven "Actividad reciente".
- **Objetivo principal:** pantalla de arranque del día: qué pasa hoy en la panadería y qué requiere atención.
- **Acciones primarias:** ninguna.
- **Acciones secundarias:** ninguna. No hay ni un enlace.
- **Información crítica:** hoy solo hay un saludo, un texto fijo y las últimas 8 entradas de auditoría (fecha, acción y usuario).
- **Frecuencia esperada:** muy alta. Es la primera pantalla de cada sesión, para todos los roles.
- **Problemas encontrados:**
  - `page.tsx:30-36`: el panel "Indicadores del negocio" es un texto fijo ("aparecerán aquí a medida que se habiliten los módulos"). Ya existen Compras, Stock, Producción, Lotes, Pedidos, Ventas y Cuentas a cobrar (fase 5). La pantalla más vista no tiene contenido accionable.
  - Para SALES, PURCHASING, PRODUCTION y WAREHOUSE (`page.tsx:13-14,38`), la página queda en saludo + texto fijo, sin nada útil.
  - `page.tsx:44-61`: "Actividad reciente" no dice qué registro cambió. No hay columna de módulo, registro ni detalle, ni enlace. "Producto modificado" sin decir cuál.
  - `page.tsx:56`: el fallback `?? a.action` muestra el código técnico de la acción (p. ej. `PRODUCT_UPDATED`) si falta la etiqueta.
  - `page.tsx:15-19`: arma su propio `Intl.DateTimeFormat` en lugar de `formatDateTime` de `lib/format.ts`. El formato es corto con año de 2 dígitos ("5/10/26, 9:57 a. m."), mientras que `formatDate` usa "05/10/2026". Hay dos formatos de fecha en la app.
  - `page.tsx:57`: el actor "—" (acciones del sistema) no tiene explicación.
  - No hay accesos rápidos ("Nueva venta", "Nuevo pedido", "Recibir compra") según el rol.
- **Redundancias:** "Actividad reciente" repite la primera página de `/auditoria`, con menos columnas.
- **Deuda UX ya registrada:** DASHBOARD [F3] stock bajo mínimo / compras pendientes, [F4] órdenes en curso con faltante, [F4.5] lotes por vencer, [F5A] pedidos de hoy y mañana / en riesgo.
- **Prioridad:** **P1**. Es la pantalla más frecuente y hoy no aporta valor a 4 de los 7 roles.

### 1.2 `/[section]` — Módulo futuro ("Disponible en próxima etapa")

- **Ruta:** `app/(app)/[section]/page.tsx`
- **Módulo:** Shell
- **Roles que la usan:** los 7. Los ítems con `phase > CURRENT_PHASE` se muestran a todos, sin control de permiso (`lib/navigation.ts:154`).
- **Objetivo principal:** avisar que el módulo (Caja, Cuentas a pagar, Gastos, Facturación, Reportes) todavía no existe.
- **Acciones primarias:** ninguna.
- **Acciones secundarias:** ninguna. No hay "Volver" ni alternativa.
- **Información crítica:** el nombre del módulo y que todavía no está disponible.
- **Frecuencia esperada:** baja, pero se visita por error (5 ítems del menú llevan acá).
- **Problemas encontrados:**
  - `page.tsx:24`: "Este módulo se implementa en la Fase {n} del roadmap." Es jerga interna del proyecto ("Fase", "roadmap") mostrada al usuario de negocio.
  - `page.tsx:22-25`: estado vacío genérico, sin alternativa. Por ejemplo, en Cuentas a pagar podría decir "mientras tanto, consultá las compras recibidas".
  - `page.tsx:9`: el título de metadata cae en "No encontrado" para slugs desconocidos, pero la página llama a `notFound()`. No es grave.
  - Para SALES y WAREHOUSE estos ítems son 5 de 12 entradas del menú (ver §2).
- **Redundancias:** —
- **Deuda UX ya registrada:** NAVIGATION [F3] "mezcla módulos implementados con 'Disponible en próxima etapa'… ocultar o atenuar los módulos futuros".
- **Prioridad:** **P2**. La pantalla en sí es inocua. El problema es su presencia en el menú (§2).

### 1.3 `/login` — Ingresar

- **Ruta:** `app/login/page.tsx` + `app/login/login-form.tsx`
- **Módulo:** Acceso
- **Roles que la usan:** todos (sin sesión).
- **Objetivo principal:** entrar al sistema con email y contraseña.
- **Acciones primarias:** "Ingresar" (`button--primary`).
- **Acciones secundarias:** ninguna. No hay "¿Olvidaste tu contraseña?" ni "mostrar contraseña".
- **Información crítica:** campos Email y Contraseña, y el error de credenciales.
- **Frecuencia esperada:** diaria por usuario. En mostrador o tablet compartida, varias veces por día.
- **Problemas encontrados:**
  - `login-form.tsx:45-63`: no existe recuperación ni restablecimiento de contraseña, y la API tampoco la tiene (`apps/api/src/modules/users/users.service.ts` solo hashea al crear). Un usuario que olvida la clave queda bloqueado hasta que alguien con acceso técnico intervenga (ver 1.24).
  - `login-form.tsx:47-54`: los inputs no marcan `aria-invalid` cuando hay error. El error de credenciales es global (`role="alert"`, correcto) pero no se asocia con `aria-describedby`.
  - `login-form.tsx:53`: no hay botón para mostrar u ocultar la contraseña (útil en tablet).
  - `page.tsx:21-24`: la marca "Panificadora ERP" es genérica y "ERP" es jerga. No muestra el nombre ni el logo de la empresa. Hay un `logoUrl` en Empresa que no se usa en ningún lado.
  - `globals.css:125`: `border-radius: 12px` está fijo y no usa `--radius`.
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P1** por la falta de recuperación de contraseña (el resto es P3).

### 1.4 `not-found` — Página no encontrada

- **Ruta:** `app/not-found.tsx`
- **Módulo:** Shell
- **Roles que la usan:** todos.
- **Objetivo principal:** recuperar al usuario de un enlace roto.
- **Acciones primarias:** "Volver al inicio" (primary).
- **Acciones secundarias:** —
- **Información crítica:** que la dirección no existe.
- **Frecuencia esperada:** baja.
- **Problemas encontrados:**
  - `not-found.tsx:5-6`: reutiliza la tarjeta del login (`.login`, `.login__card`) y es el único `not-found` del árbol. Un usuario autenticado que llega a `/xyz` o a un `notFound()` de `[section]` pierde el menú lateral y el topbar.
  - `not-found.tsx:8`: "La dirección no existe." Seco, sin sugerencia (buscar, volver atrás).
  - `not-found.tsx:6`: la `section` no tiene `aria-labelledby`, a diferencia del login.
  - No hay ningún `error.tsx`, `global-error.tsx` ni `loading.tsx` en `app/`. Un error de render muestra la página de error por defecto de Next, en inglés.
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P2**. Sube por la ausencia total de `error.tsx`.

### 1.5 `/configuracion` — Configuración (hub)

- **Ruta:** `app/(app)/configuracion/page.tsx` → `SettingsHub` (`masters/settings.tsx:39-58`)
- **Módulo:** Configuración
- **Roles que la usan:** los 7. Todos tienen `units.read`, `categories.read` y `warehouses.read`. ADMIN, OWNER y ADMINISTRATION ven 5 tarjetas. SALES, PURCHASING, PRODUCTION y WAREHOUSE ven 3 (Unidades, Categorías, Depósitos), todas de solo lectura.
- **Objetivo principal:** acceder a datos de empresa y catálogos base.
- **Acciones primarias:** 5 tarjetas-enlace del mismo peso visual (Empresa, Unidades de medida, Categorías, Depósitos, Roles y permisos).
- **Acciones secundarias:** —
- **Información crítica:** cuál catálogo tocar. No muestra conteos ni estado (p. ej. "3 depósitos activos").
- **Frecuencia esperada:** muy baja (puesta en marcha y altas esporádicas).
- **Problemas encontrados:**
  - `lib/navigation.ts:141`: el ítem "Configuración" se habilita con cualquiera de 5 permisos, y `units.read`/`categories.read` los tiene todo rol. Resultado: los 4 roles operativos tienen "Sistema → Configuración" en el menú para ver 3 catálogos que no pueden modificar.
  - `settings.tsx:48-55`: las tarjetas no indican si son de solo lectura para el usuario actual.
  - `settings.tsx:46`: el subtítulo "catálogos que usan los demás módulos" es abstracto.
  - El patrón de subnavegación por tarjetas difiere del de pestañas de Inventario y Necesidades.
- **Redundancias:** la descripción de cada tarjeta se define en `CONFIG_SECTIONS` (`navigation.ts:24-60`) y el subtítulo se repite en cada lista.
- **Deuda UX ya registrada:** NAVIGATION [F3] "Inventario usa pestañas… Configuración usa tarjetas. Unificar."
- **Prioridad:** **P2**.

### 1.6 `/configuracion/empresa` — Empresa

- **Ruta:** `app/(app)/configuracion/empresa/page.tsx` → `CompanySettings` (`settings.tsx:62-141`)
- **Módulo:** Configuración
- **Roles que la usan:** ADMIN y OWNER (editan, `company.update`). ADMINISTRATION solo lee (`company.read`). El resto recibe 403 si entra por URL.
- **Objetivo principal:** datos fiscales y de contacto de la panadería, moneda y zona horaria que definen el "hoy".
- **Acciones primarias:** "Guardar cambios" (primary).
- **Acciones secundarias:** "Cancelar" (vuelve a Configuración).
- **Información crítica:** razón social, nombre comercial, CUIT, moneda y zona horaria.
- **Frecuencia esperada:** muy baja (alta inicial y cambios excepcionales).
- **Problemas encontrados:**
  - `settings.tsx:78-83`: "Zona horaria" es texto libre obligatorio. Espera un identificador IANA (`America/Argentina/Buenos_Aires`) sin lista ni ejemplo. Un error de tipeo cambia el "hoy" de toda la empresa (vencimientos, cierres). Debería ser un select con las zonas de Argentina.
  - `settings.tsx:77`: "Moneda" es texto libre con hint técnico "Código ISO de 3 letras (ARS)". Jerga, y no hay select.
  - `settings.tsx:84`: "URL del logo" pide pegar una URL; no hay carga de archivo. Además el logo no se usa en el shell ni en el login.
  - `settings.tsx:70`: CUIT sin máscara, formato (`30-12345678-9`) ni validación de dígito verificador. Falta la condición frente al IVA, relevante para facturación (fase 7).
  - `settings.tsx:105-109`: el aviso "Cambios guardados." usa `.notice` (marrón, mismo color que los avisos informativos) y no un estilo de éxito. Además no desaparece: queda fijo aunque se vuelva a editar.
  - `settings.tsx:130-137`: en solo lectura (ADMINISTRATION) muestra los valores crudos de `timezone` y `currencyCode` ("America/Argentina/Buenos_Aires", "ARS").
  - `entity-form.tsx:127`: "Cancelar" navega sin advertir de cambios sin guardar (aplica a todos los formularios).
- **Redundancias:** el nombre comercial también aparece en el topbar (`app-shell.tsx:81`); está bien que se refresque (`settings.tsx:126`).
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P1** (la zona horaria en texto libre puede corromper fechas operativas).

### 1.7 `/configuracion/unidades` — Unidades de medida (listado)

- **Ruta:** `.../unidades/page.tsx` → `UnitList` (`settings.tsx:147-182`)
- **Módulo:** Configuración
- **Roles que la usan:** los 7 leen (`units.read`). Solo ADMIN y OWNER crean (`units.manage`).
- **Objetivo principal:** ver qué unidades existen y cómo se convierten (kg ↔ g, bolsa de 25 kg).
- **Acciones primarias:** "Nueva unidad" (primary, solo con `units.manage`).
- **Acciones secundarias:** búsqueda, filtro de estado, paginación ("Anterior"/"Siguiente") y enlace por código.
- **Información crítica:** nombre, símbolo y equivalencia.
- **Frecuencia esperada:** muy baja.
- **Problemas encontrados:**
  - `settings.tsx:161`: el enlace de la fila es el **código** técnico (`kg`, `bolsa25`) y no el nombre. Las demás listas enlazan por nombre (categorías, depósitos, proveedores).
  - `settings.tsx:164`: la etiqueta "Magnitud" es poco coloquial ("Tipo de medida").
  - `settings.tsx:152`: subtítulo largo y didáctico en cada visita.
  - `master-list.tsx:198`: estado vacío genérico ("No hay unidades.") sin CTA aunque se pueda crear.
  - `master-list.tsx:140-161`: los filtros no tienen etiqueta visible (solo `aria-label`).
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P3**.

### 1.8 `/configuracion/unidades/nuevo` — Nueva unidad

- **Ruta:** `.../unidades/nuevo/page.tsx` → `UnitForm` (`settings.tsx:184-276`)
- **Módulo:** Configuración
- **Roles que la usan:** ADMIN y OWNER. La página no verifica permiso: cualquier rol puede abrirla por URL y recibe 403 recién al guardar.
- **Objetivo principal:** dar de alta una unidad (p. ej. "bolsa de 25 kg").
- **Acciones primarias:** "Crear unidad".
- **Acciones secundarias:** "Cancelar" y "← Unidades de medida".
- **Información crítica:** magnitud, unidad base y factor.
- **Frecuencia esperada:** muy baja.
- **Problemas encontrados:**
  - `settings.tsx:224-234`: el select "Equivale a (unidad base)" lista **todas** las unidades base de todas las magnitudes y aclara "Debe ser de la misma magnitud.". No filtra por la magnitud elegida, así que el usuario puede elegir mal y recibe el error del servidor.
  - `settings.tsx:235-241`: "Factor" con hint algebraico "1 de esta unidad = factor × unidad base". Sería más claro: "¿Cuántos kg tiene 1 bolsa?". No es obligatorio aunque se haya elegido una unidad base.
  - `settings.tsx:209-214`: "Código… sin espacios (p. ej. bolsa25)" expone un identificador técnico que el usuario debe inventar.
  - `settings.tsx:200-206 / 242`: "Decimales" es un concepto técnico, sin ejemplo.
  - `nuevo/page.tsx:4`: título "Nuevo unidad · Unidades de medida", con error de género.
  - `entity-form.tsx:148-154`: los inputs obligatorios no tienen `required` ni `aria-required`. El asterisco es `aria-hidden` (`entity-form.tsx:225-229`), así que un lector de pantalla no anuncia la obligatoriedad.
  - `entity-form.tsx:232`: el hint no está enlazado por `aria-describedby`.
  - `entity-form.tsx:83-87`: con campos faltantes el foco no va al primer error ni al resumen.
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P2**.

### 1.9 `/configuracion/unidades/[id]` — Detalle de unidad

- **Ruta:** `.../unidades/[id]/page.tsx` → `UnitDetail` (`settings.tsx:278-396`)
- **Módulo:** Configuración
- **Roles que la usan:** los 7 leen. ADMIN y OWNER editan y desactivan.
- **Objetivo principal:** ver la definición de la unidad y su conversión.
- **Acciones primarias:** "Editar" (`button`, sin variante).
- **Acciones secundarias:** "Desactivar"/"Reactivar" (danger) y "Convertir" (herramienta "Probar conversión"). En la cabecera hay 2 botones con peso similar; el danger se distingue solo por el color del texto.
- **Información crítica:** magnitud, equivalencia y decimales.
- **Frecuencia esperada:** muy baja.
- **Problemas encontrados:**
  - `settings.tsx:332-338`: "Desactivar" ejecuta **sin confirmación** y sin explicar consecuencias. Depósitos, Proveedores y Usuarios sí confirman con `ConfirmAction`. Desactivar una unidad en uso por materias primas o recetas puede afectar selectores.
  - `settings.tsx:294-298`: `toggle()` no captura errores. Si la API rechaza (p. ej. unidad estándar o en uso), la promesa queda sin manejar y el usuario no ve nada.
  - `settings.tsx:323`: "Estándar" (`isSystem`) aparece como texto suelto en el subtítulo. El botón Desactivar se ofrece igual para unidades estándar.
  - `settings.tsx:321`: el código técnico se muestra en monoespaciado como dato principal.
  - `settings.tsx:357-392`: "Probar conversión" es una herramienta de verificación técnica en una ficha de uso de negocio. Ocupa espacio y es de frecuencia casi nula.
  - `settings.tsx:360-367`: el input de cantidad no tiene etiqueta visible (solo `aria-label`) y usa un estilo inline `maxWidth: 140`.
  - `settings.tsx:375-381`: el select de destino lista unidades de **todas** las magnitudes; elegir litros desde kg da error.
  - `settings.tsx:310`: el mensaje de error de la conversión se muestra en el mismo `<p role="status">` que el resultado, sin estilo de error.
  - `ui.tsx:459`: la columna "Detalle" del historial se oculta en pantallas chicas (`hide-sm`).
- **Redundancias:** "Equivale a" aparece en el listado y en el detalle (aceptable).
- **Deuda UX ya registrada:** ACCESSIBILITY [F3] foco de `ConfirmAction` (aquí ni siquiera hay diálogo).
- **Prioridad:** **P2** (acción de estado sin confirmación ni manejo de error).

### 1.10 `/configuracion/unidades/[id]/editar` — Editar unidad

- **Ruta:** `.../unidades/[id]/editar/page.tsx` → `UnitForm` con `id`
- **Módulo:** Configuración
- **Roles que la usan:** ADMIN y OWNER. No hay guard en la página.
- **Objetivo principal:** corregir nombre, símbolo o decimales.
- **Acciones primarias:** "Guardar cambios".
- **Acciones secundarias:** "Cancelar" y "← Volver a la unidad".
- **Información crítica:** el aviso de que magnitud y conversión no se modifican.
- **Frecuencia esperada:** muy baja.
- **Problemas encontrados:**
  - `settings.tsx:258-265`: el aviso es correcto, pero usa un estilo inline (`marginBottom`) y no muestra los valores fijos (magnitud y factor) como campos de solo lectura. El usuario no ve qué no puede cambiar.
  - `settings.tsx:247`: el título "Editar {nombre}" sin tipo de entidad ("Editar Kilogramo").
  - El resto, como en 1.8 (accesibilidad de `EntityForm`, sin guard de permiso).
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P3**.

### 1.11 `/configuracion/categorias` — Categorías (listado)

- **Ruta:** `.../categorias/page.tsx` → `CategoryList` (`settings.tsx:402-433`)
- **Módulo:** Configuración
- **Roles que la usan:** los 7 leen. ADMIN, OWNER y ADMINISTRATION gestionan (`categories.manage`).
- **Objetivo principal:** organizar materias primas y productos en grupos.
- **Acciones primarias:** "Nueva categoría".
- **Acciones secundarias:** búsqueda, filtro de estado, filtro "Tipo" y paginación.
- **Información crítica:** nombre, tipo y estado.
- **Frecuencia esperada:** baja.
- **Problemas encontrados:**
  - `master-list.tsx:173`: el filtro extra muestra "Tipo: todas" (`${f.label}: todas`). El género está fijado en femenino y no concuerda con "Tipo".
  - `settings.tsx:425`: la columna "Orden" (número de `sortOrder`) es un concepto técnico. Sería mejor ordenar arrastrando o con flechas.
  - `settings.tsx:424`: el tipo se muestra en plural ("Materias primas") como valor de una fila individual; se lee raro ("Tipo: Productos").
  - `settings.tsx:413`: estado vacío genérico sin CTA.
  - Faltan el conteo de ítems por categoría y un enlace a "ver productos de esta categoría".
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P3**.

### 1.12 `/configuracion/categorias/nuevo` — Nueva categoría

- **Ruta:** `.../categorias/nuevo/page.tsx` → `CategoryForm` (`settings.tsx:435-480`)
- **Módulo:** Configuración
- **Roles que la usan:** ADMIN, OWNER y ADMINISTRATION. Sin guard.
- **Objetivo principal:** crear una categoría de materia prima o de producto.
- **Acciones primarias:** "Crear categoría".
- **Acciones secundarias:** "Cancelar" y "← Categorías".
- **Información crítica:** tipo (no se puede cambiar después) y nombre.
- **Frecuencia esperada:** baja.
- **Problemas encontrados:**
  - `settings.tsx:441-451, 467`: "Tipo" viene preseleccionado en `RAW_MATERIAL` y no se avisa que **no se podrá cambiar** después (en edición el campo desaparece).
  - `settings.tsx:453`: "Orden" con hint "Menor número aparece primero." Es técnico.
  - `nuevo/page.tsx:4`: título "Nuevo categoría · Categorías", con error de género.
  - Accesibilidad de `EntityForm` (ver 1.8).
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P3**.

### 1.13 `/configuracion/categorias/[id]` — Detalle de categoría

- **Ruta:** `.../categorias/[id]/page.tsx` → `CategoryDetail` (`settings.tsx:482-533`)
- **Módulo:** Configuración
- **Roles que la usan:** los 7 leen. ADMIN, OWNER y ADMINISTRATION editan y desactivan.
- **Objetivo principal:** ver o editar una categoría.
- **Acciones primarias:** "Editar".
- **Acciones secundarias:** "Desactivar"/"Reactivar" (danger). Son 2 botones de peso casi igual.
- **Información crítica:** tipo, orden, descripción y en qué ítems se usa (esto último no se muestra).
- **Frecuencia esperada:** baja.
- **Problemas encontrados:**
  - `settings.tsx:510-516`: "Desactivar" **sin confirmación** ni texto de consecuencia. Inconsistente con Depósitos y Proveedores (`ActiveToggle`).
  - `settings.tsx:488-492`: `toggle()` sin manejo de error.
  - `settings.tsx:521-529`: no muestra cuántas materias primas o productos usan la categoría ni los enlaza. Al desactivar, el usuario no sabe a quién afecta.
- **Redundancias:** el tipo aparece en el subtítulo (`settings.tsx:500`) y en Details (`settings.tsx:524`).
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P2**.

### 1.14 `/configuracion/categorias/[id]/editar` — Editar categoría

- **Ruta:** `.../categorias/[id]/editar/page.tsx` → `CategoryForm` con `id`
- **Módulo:** Configuración
- **Roles que la usan:** ADMIN, OWNER y ADMINISTRATION.
- **Objetivo principal:** renombrar o reordenar.
- **Acciones primarias:** "Guardar cambios".
- **Acciones secundarias:** "Cancelar" y "← Volver a la categoría".
- **Información crítica:** el nombre.
- **Frecuencia esperada:** baja.
- **Problemas encontrados:** el tipo desaparece del formulario sin explicación (`settings.tsx:441`). Faltaría mostrarlo como solo lectura. Lo demás, como en 1.12.
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P3**.

### 1.15 `/configuracion/depositos` — Depósitos (listado)

- **Ruta:** `.../depositos/page.tsx` → `WarehouseList` (`settings.tsx:539-559`)
- **Módulo:** Configuración
- **Roles que la usan:** los 7 leen. ADMIN y OWNER gestionan (`warehouses.manage`).
- **Objetivo principal:** definir los lugares físicos de stock (cámara, freezer, depósito de harinas).
- **Acciones primarias:** "Nuevo depósito".
- **Acciones secundarias:** búsqueda, estado y paginación.
- **Información crítica:** nombre, dirección y estado. Falta cuánto stock tiene cada uno.
- **Frecuencia esperada:** muy baja.
- **Problemas encontrados:**
  - `settings.tsx:544`: el subtítulo "(se usa desde la fase de inventario)" está **desactualizado**: Inventario existe desde la Fase 3. También es jerga de roadmap.
  - `settings.tsx:552-553`: la primera columna es el código técnico `DEP-0001` y el nombre recién la segunda. El orden es inverso al de Unidades (que enlaza por código) y al de Categorías (solo nombre).
  - `settings.tsx:555`: `StatusBadge` usa el texto "Activo/Inactivo" (masculino) mientras que Unidades y Categorías usan "Activa/Inactiva". Es correcto por género, pero el filtro dice "Activos/Inactivos".
  - Para WAREHOUSE (el rol de depósito), esta lista está escondida en "Sistema → Configuración".
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P2** (por el texto desactualizado y por la ubicación).

### 1.16 `/configuracion/depositos/nuevo` — Nuevo depósito

- **Ruta:** `.../depositos/nuevo/page.tsx` → `WarehouseForm` (`settings.tsx:561-607`)
- **Módulo:** Configuración
- **Roles que la usan:** ADMIN y OWNER. Sin guard.
- **Objetivo principal:** crear un depósito.
- **Acciones primarias:** "Crear depósito".
- **Acciones secundarias:** "Cancelar" y "← Depósitos".
- **Información crítica:** el nombre.
- **Frecuencia esperada:** muy baja.
- **Problemas encontrados:**
  - `settings.tsx:564-569`: el placeholder "Automático (DEP-0001…)" expone el formato del código. Además, el campo opcional aparece **primero**, antes del único obligatorio (Nombre).
  - Falta el atributo de conservación o tipo (seco / refrigerado / congelado), relevante para lotes, aunque es tema de negocio.
  - Accesibilidad de `EntityForm` (ver 1.8).
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P3**.

### 1.17 `/configuracion/depositos/[id]` — Detalle de depósito

- **Ruta:** `.../depositos/[id]/page.tsx` → `WarehouseDetail` (`settings.tsx:609-656`)
- **Módulo:** Configuración
- **Roles que la usan:** los 7 leen. ADMIN y OWNER editan y desactivan.
- **Objetivo principal:** ver el depósito y qué contiene.
- **Acciones primarias:** "Editar".
- **Acciones secundarias:** "Desactivar"/"Reactivar" (con `ConfirmAction`). Son 2 botones de peso similar.
- **Información crítica:** stock actual, lotes y movimientos del depósito. **No se muestra nada de esto.**
- **Frecuencia esperada:** baja.
- **Problemas encontrados:**
  - `settings.tsx:652`: el aviso "El stock por depósito estará disponible en la fase de inventario." está **desactualizado y es falso** hoy. Además no enlaza a `/stock` filtrado por depósito.
  - `settings.tsx:631-639` + `ui.tsx:222`: el mensaje genérico de desactivación ("Deja de aparecer en listados y selectores…") no dice qué pasa con el stock que todavía hay en el depósito.
  - `settings.tsx:622`: el código técnico encabeza el subtítulo.
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P2**.

### 1.18 `/configuracion/depositos/[id]/editar` — Editar depósito

- **Ruta:** `.../depositos/[id]/editar/page.tsx` → `WarehouseForm` con `id`
- **Módulo:** Configuración
- **Roles que la usan:** ADMIN y OWNER.
- **Objetivo principal:** corregir el nombre, la dirección o la descripción.
- **Acciones primarias:** "Guardar cambios".
- **Acciones secundarias:** "Cancelar" y "← Volver al depósito".
- **Información crítica:** el nombre.
- **Frecuencia esperada:** muy baja.
- **Problemas encontrados:** el código no se muestra ni como solo lectura (`settings.tsx:562-571`). El resto, como en 1.16.
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P3**.

### 1.19 `/configuracion/roles` — Roles y permisos

- **Ruta:** `.../roles/page.tsx` → `RolesMatrix` (`settings.tsx:660-712`)
- **Módulo:** Configuración
- **Roles que la usan:** ADMIN, OWNER y ADMINISTRATION (`roles.read`).
- **Objetivo principal:** entender qué puede hacer cada rol antes de asignarlo a una persona.
- **Acciones primarias:** ninguna (solo lectura).
- **Acciones secundarias:** —
- **Información crítica:** diferencias entre roles.
- **Frecuencia esperada:** muy baja.
- **Problemas encontrados:**
  - `settings.tsx:693-705`: es una tabla plana de **96 filas × 7 columnas**, sin agrupar por módulo, sin filtro ni búsqueda y sin encabezado fijo. Es muy difícil de leer.
  - `settings.tsx:696`: `PERMISSION_MODULE_LABELS[p.module] ?? p.module`. En `packages/shared/src/permission-matrix.ts:5-27` faltan las etiquetas de `production`, `product_lots`, `product_conservation`, `orders` y `order_planning`. **25 filas** muestran el módulo en snake_case inglés ("production: Ver órdenes…", "order_planning: …").
  - `settings.tsx:686-688`: los encabezados usan nombres largos ("Administrador del sistema") y fuerzan scroll horizontal. ADMIN y OWNER tienen columnas idénticas y nada explica la diferencia.
  - `settings.tsx:700-701`: "✓/—" con `aria-label` en un `<td>`, que no se anuncia de forma fiable. Mejor usar texto `.sr-only`.
  - `settings.tsx:672-679`: las tarjetas de rol se repiten arriba de la tabla con estilo inline (`marginBottom`) y no tienen ancla a su columna.
  - No avisa si faltan permisos nuevos sin sincronizar.
- **Redundancias:** "Permisos efectivos" en el detalle del usuario (1.24) es la misma información por persona.
- **Deuda UX ya registrada:** WORKFLOW [F5A] "Evaluar avisarlo en la pantalla de roles" (sincronización de permisos).
- **Prioridad:** **P2**.

### 1.20 `/empleados` — Empleados (listado)

- **Ruta:** `app/(app)/empleados/page.tsx` → `EmployeeList` (`masters/employees.tsx:36-69`)
- **Módulo:** Equipo
- **Roles que la usan:** ADMIN, OWNER y ADMINISTRATION (los 4 permisos de empleados).
- **Objetivo principal:** padrón de personal: quién trabaja, en qué puesto y si tiene acceso.
- **Acciones primarias:** "Nuevo empleado".
- **Acciones secundarias:** búsqueda (nombre, legajo, documento), estado y paginación.
- **Información crítica:** nombre, puesto y estado. El acceso al sistema es secundario.
- **Frecuencia esperada:** baja (altas y bajas mensuales).
- **Problemas encontrados:**
  - `employees.tsx:50`: el legajo técnico (`EMP-0001`) va como primera columna.
  - `employees.tsx:53` vs `employees.tsx:148`: el listado muestra "Apellido, Nombre" y el detalle `fullName` ("Nombre Apellido"). El orden es inconsistente.
  - `employees.tsx:59` vs `employees.tsx:234`: "Sí (desactivado)" contra "Sí, desactivado".
  - `employees.tsx:64` vs `employees.tsx:152`: el badge dice "Baja" en el listado y "Dado de baja" en el detalle. El filtro dice "Dados de baja" (`employees.tsx:48`).
  - `employees.tsx:57`: la columna "Usuario del sistema" usa la palabra técnica "usuario".
  - `employees.tsx:55,60`: Puesto y Acceso se ocultan en `hide-sm` sin forma de verlos.
- **Redundancias:** —
- **Deuda UX ya registrada:** TABLES [F3] columnas `hide-sm` sin forma de verlas.
- **Prioridad:** **P3**.

### 1.21 `/empleados/nuevo` — Nuevo empleado

- **Ruta:** `app/(app)/empleados/nuevo/page.tsx` → `EmployeeForm` (`employees.tsx:71-130`)
- **Módulo:** Equipo
- **Roles que la usan:** ADMIN, OWNER y ADMINISTRATION. Sin guard.
- **Objetivo principal:** registrar a una persona que trabaja en la panadería.
- **Acciones primarias:** "Crear empleado".
- **Acciones secundarias:** "Cancelar" y "← Empleados".
- **Información crítica:** nombre, apellido y documento.
- **Frecuencia esperada:** baja.
- **Problemas encontrados:**
  - `employees.tsx:72-80`: "Legajo" opcional, **primer campo**, con placeholder "Automático (EMP-0001…)".
  - `employees.tsx:91`: "Puesto" es texto libre. Generará variantes ("Panadero", "panadero", "Maestro panadero") y no se puede filtrar.
  - `employees.tsx:92`: `input type=date` nativo, que sigue el idioma del navegador.
  - `employees.tsx:85-90`: no hay validación ni máscara de DNI/CUIL según el tipo.
  - Al terminar no ofrece "Crear acceso al sistema" (solo desde el detalle).
  - Accesibilidad de `EntityForm` (ver 1.8).
- **Redundancias:** —
- **Deuda UX ya registrada:** FORMS [F4] fechas nativas mm/dd/aaaa.
- **Prioridad:** **P3**.

### 1.22 `/empleados/[id]` — Ficha del empleado

- **Ruta:** `app/(app)/empleados/[id]/page.tsx` → `EmployeeDetail` (`employees.tsx:132-255`)
- **Módulo:** Equipo
- **Roles que la usan:** ADMIN, OWNER y ADMINISTRATION. "Crear acceso" y "Ver usuario" dependen de los permisos de usuarios (solo ADMIN y OWNER crean).
- **Objetivo principal:** consultar los datos del empleado, darlo de baja o gestionar su acceso.
- **Acciones primarias:** "Editar" (cabecera, `button`) y "Crear acceso" (primary, en el panel inferior).
- **Acciones secundarias:** "Dar de baja"/"Reactivar" (cabecera, danger) y "Ver usuario". La única acción con estilo primary de la página está abajo, en un panel secundario. La cabecera tiene 2 botones de peso similar.
- **Información crítica:** estado, puesto, contacto y si tiene acceso al sistema.
- **Frecuencia esperada:** baja.
- **Problemas encontrados:**
  - `employees.tsx:164-192`: el diálogo de baja tiene un buen texto de consecuencia. La fecha de egreso es un `type=date` nativo con la etiqueta "(vacío = hoy)", que es jerga.
  - `employees.tsx:135,188`: el estado `terminationDate` no se limpia al cancelar el diálogo y reaparece si se vuelve a abrir.
  - `ui.tsx:170-171`: `aria-labelledby={`${label}-title`}` con label "Dar de baja" genera el id "Dar de baja-title", con espacios. Una IDREF con espacios apunta a 3 ids inexistentes, así que **el diálogo no tiene nombre accesible**.
  - `employees.tsx:231`: la fila "Empleado: Sí" en la sección de acceso es redundante (siempre es "Sí").
  - `employees.tsx:240-249`: si tiene acceso, no muestra sus roles ni el último ingreso. Hay que ir a Usuarios.
  - `employees.tsx:151`: el legajo técnico encabeza el subtítulo.
  - `ui.tsx:420`: el historial de auditoría muestra "Egreso: 2026-10-05" en formato ISO crudo (`metadata.terminationDate` sin `formatDate`).
- **Redundancias:** el estado de acceso aparece en el listado, en la ficha del empleado y en la ficha del usuario.
- **Deuda UX ya registrada:** ACCESSIBILITY [F3] foco de `ConfirmAction`. FORMS [F4] fechas nativas.
- **Prioridad:** **P2**.

### 1.23 `/empleados/[id]/editar` — Editar empleado

- **Ruta:** `app/(app)/empleados/[id]/editar/page.tsx` → `EmployeeForm` con `id`
- **Módulo:** Equipo
- **Roles que la usan:** ADMIN, OWNER y ADMINISTRATION.
- **Objetivo principal:** actualizar datos personales o el puesto.
- **Acciones primarias:** "Guardar cambios".
- **Acciones secundarias:** "Cancelar" y "← Volver al empleado".
- **Información crítica:** —
- **Frecuencia esperada:** baja.
- **Problemas encontrados:** el legajo no aparece ni como solo lectura (`employees.tsx:72-81`). El email del empleado y el email de ingreso del usuario son campos distintos y nada lo explica. El resto, como en 1.21.
- **Redundancias:** —
- **Deuda UX ya registrada:** FORMS [F4] fechas.
- **Prioridad:** **P3**.

### 1.24 `/usuarios` — Usuarios (listado)

- **Ruta:** `app/(app)/usuarios/page.tsx` → `UserList` (`masters/users.tsx:39-66`)
- **Módulo:** Equipo
- **Roles que la usan:** ADMIN, OWNER y ADMINISTRATION (`users.read`). Solo ADMIN y OWNER crean (`users.create` + `users.assign_roles`).
- **Objetivo principal:** ver quién tiene acceso al sistema y con qué roles.
- **Acciones primarias:** "Nuevo usuario".
- **Acciones secundarias:** búsqueda, estado ("Con acceso/Desactivados/Todos") y paginación.
- **Información crítica:** persona, roles, estado y último ingreso (este último no se muestra).
- **Frecuencia esperada:** baja.
- **Problemas encontrados:**
  - `users.tsx:52-63`: no hay columna "Último ingreso", útil para detectar accesos abandonados.
  - `users.tsx:51` vs `users.tsx:60`: el filtro dice "Desactivados" y el badge "Desactivado". El estado activo se llama "Con acceso", distinto del "Activo" del resto de la app.
  - `users.tsx:54-55`: Email y Empleado se ocultan en `hide-sm`.
- **Redundancias:** "Equipo" separa Empleados y Usuarios, que el usuario de negocio ve como una sola cosa: "las personas".
- **Deuda UX ya registrada:** TABLES [F3] `hide-sm`.
- **Prioridad:** **P3**.

### 1.25 `/usuarios/nuevo` — Nuevo usuario (dar acceso)

- **Ruta:** `app/(app)/usuarios/nuevo/page.tsx` → `UserCreateForm` (`users.tsx:122-301`)
- **Módulo:** Equipo
- **Roles que la usan:** ADMIN y OWNER. Sin guard en la página: ADMINISTRATION puede abrirla y recibe 403 al enviar.
- **Objetivo principal:** dar acceso al sistema a una persona con una contraseña inicial y sus roles.
- **Acciones primarias:** "Crear usuario".
- **Acciones secundarias:** "Generar" (contraseña), "Cancelar" y "← Usuarios".
- **Información crítica:** email de ingreso, contraseña inicial y roles.
- **Frecuencia esperada:** baja.
- **Problemas encontrados:**
  - `users.tsx:182`: redirige a `/usuarios/{id}?creado=1`, pero **nadie lee `creado`** (verificado con grep en todo `apps/web/src`). No hay confirmación de éxito ni un paso de "Copiá las credenciales". El hint (`users.tsx:281-284`) advierte que la contraseña "no se vuelve a mostrar" y, como no hay reset (ver 1.26), si se pierde en ese momento no hay forma de recuperarla.
  - `users.tsx:264-280`: la contraseña se muestra en texto plano (`type="text"`) y no hay botón "Copiar".
  - `users.tsx:219-230`: el select "Empleado vinculado" no tiene búsqueda y muestra el código técnico entre paréntesis ("Juan Pérez (EMP-0007)").
  - `users.tsx:100-115`: el checklist de roles muestra solo el nombre, sin descripción ni enlace a la matriz. No avisa al marcar "Administrador del sistema" o "Dueño", que dan acceso total.
  - `users.tsx:97, 248, 261`: el asterisco no es `aria-hidden` (inconsistente con `EntityForm`) y los inputs no tienen `required`/`aria-required`.
  - `users.tsx:192-195`: los inputs con error no tienen `aria-describedby` hacia el mensaje. El error de `roleIds` se renderiza fuera del `fieldset` (`users.tsx:288`).
  - `packages/shared/src/masters.ts:136`: el mensaje de validación "Asigne al menos un rol" usa tratamiento de usted. La app usa voseo ("Completá", "Revisá").
  - `users.tsx:242`: el placeholder funciona como hint ("Si se deja vacío, se usa el nombre del empleado") y desaparece al escribir.
- **Redundancias:** el email se autocompleta desde el empleado (`users.tsx:150-161`). Está bien.
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P1** (sin confirmación de alta ni salida segura para la contraseña inicial).

### 1.26 `/usuarios/[id]` — Ficha del usuario

- **Ruta:** `app/(app)/usuarios/[id]/page.tsx` → `UserDetail` (`users.tsx:331-548`)
- **Módulo:** Equipo
- **Roles que la usan:** ADMIN y OWNER (editan, desactivan, asignan roles). ADMINISTRATION solo lee.
- **Objetivo principal:** controlar el acceso de una persona: roles, estado y nombre.
- **Acciones primarias:** ninguna marcada como primary en la cabecera.
- **Acciones secundarias:** "Editar nombre" (button), "Desactivar acceso" (danger) o "Reactivar acceso", y "Cambiar roles" (button--small, dentro del panel Roles). Las acciones están repartidas entre la cabecera y un panel.
- **Información crítica:** roles, estado, último ingreso y permisos efectivos.
- **Frecuencia esperada:** baja.
- **Problemas encontrados:**
  - **No existe "Restablecer contraseña"**, ni en la UI ni en la API. Es la tarea de soporte más frecuente sobre un usuario.
  - `users.tsx:489-529`: "Cambiar roles" guarda sin confirmación ni resumen del cambio ("Agrega: Ventas · Quita: Depósito"). No avisa que rige desde el siguiente request (`docs/PERMISSIONS.md:14-16`).
  - `users.tsx:437-458`: el editor inline de nombre no mueve el foco al input al abrirse. El botón "Guardar" no tiene estado pendiente ni `disabled` (doble envío posible). El error (`users.tsx:447`) no tiene `role="alert"` ni `aria-describedby`.
  - `users.tsx:537-543` + `users.tsx:317`: "Permisos efectivos" de un ADMIN lista **96 permisos** en 26 módulos sin colapsar. 5 módulos aparecen con el código crudo (`production`, `product_lots`, `product_conservation`, `orders`, `order_planning`).
  - `ui.tsx:419`: el historial muestra "Roles: ADMIN, SALES". Son los **códigos técnicos de rol** que guarda `users.service.ts:355`, no sus nombres.
  - `ui.tsx:170-171`: "Desactivar acceso" y "Reactivar acceso" generan ids con espacios en `aria-labelledby`, así que el diálogo queda sin nombre accesible.
  - No se puede cambiar el email de ingreso ni el empleado vinculado.
- **Redundancias:** "Email de ingreso" aparece en el subtítulo (`users.tsx:392`) y en Details (`users.tsx:463`).
- **Deuda UX ya registrada:** ACCESSIBILITY [F3] foco de `ConfirmAction`.
- **Prioridad:** **P1** (falta el reset de contraseña y el cambio de roles no se confirma).

### 1.27 `/proveedores` — Proveedores (listado)

- **Ruta:** `app/(app)/proveedores/page.tsx` → `SupplierList` (`masters/suppliers.tsx:25-48`)
- **Módulo:** Comercial (en el menú). Funcionalmente es Compras.
- **Roles que la usan:** ADMIN, OWNER, ADMINISTRATION y PURCHASING (leer, crear y modificar). Desactivar: ADMIN, OWNER y ADMINISTRATION.
- **Objetivo principal:** encontrar un proveedor y su contacto para hacer un pedido.
- **Acciones primarias:** "Nuevo proveedor".
- **Acciones secundarias:** búsqueda (nombre, código, CUIT, contacto), estado y paginación.
- **Información crítica:** nombre, contacto, teléfono y qué provee.
- **Frecuencia esperada:** media (semanal para Compras).
- **Problemas encontrados:**
  - `suppliers.tsx:28-35`: es el único listado de este alcance **sin subtítulo**.
  - `suppliers.tsx:37`: el código técnico `PROV-0001` va como primera columna.
  - `suppliers.tsx:42-43`: Contacto y Teléfono, los datos útiles para llamar, se **ocultan** en pantallas chicas y queda visible el código.
  - No hay columna "Qué provee" (materias primas con este proveedor preferido) ni "Última compra".
  - `navigation.ts:108`: está en "Comercial", junto a Clientes y lejos de Compras (Operaciones).
- **Redundancias:** —
- **Deuda UX ya registrada:** NAVIGATION [F5A]/[F5B] "Proveedores con Compras… reagrupar". TABLES [F3] `hide-sm`.
- **Prioridad:** **P2**.

### 1.28 `/proveedores/nuevo` — Nuevo proveedor

- **Ruta:** `app/(app)/proveedores/nuevo/page.tsx` → `SupplierForm` (`suppliers.tsx:50-104`)
- **Módulo:** Compras
- **Roles que la usan:** ADMIN, OWNER, ADMINISTRATION y PURCHASING. Sin guard.
- **Objetivo principal:** registrar un proveedor.
- **Acciones primarias:** "Crear proveedor".
- **Acciones secundarias:** "Cancelar" y "← Proveedores".
- **Información crítica:** razón social, CUIT y contacto.
- **Frecuencia esperada:** baja.
- **Problemas encontrados:**
  - `suppliers.tsx:53-59`: el código opcional va primero ("Automático (PROV-0001…)").
  - `suppliers.tsx:63`: CUIT sin máscara ni validación. No se detectan duplicados por CUIT.
  - `suppliers.tsx:70`: "Condiciones de pago" es texto libre ("Ej.: 30 días") y no servirá para calcular vencimientos de Cuentas a pagar (fase 6).
  - Falta la condición frente al IVA.
  - Accesibilidad de `EntityForm` (ver 1.8).
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P2**.

### 1.29 `/proveedores/[id]` — Ficha del proveedor

- **Ruta:** `app/(app)/proveedores/[id]/page.tsx` → `SupplierDetail` (`suppliers.tsx:106-171`)
- **Módulo:** Compras
- **Roles que la usan:** ADMIN, OWNER, ADMINISTRATION y PURCHASING.
- **Objetivo principal:** ver el contacto, las compras y qué se le compra al proveedor.
- **Acciones primarias:** "Editar".
- **Acciones secundarias:** "Desactivar"/"Reactivar" (`ActiveToggle`, danger) y el enlace "Ver las compras a este proveedor" dentro de un aviso. Falta "Nueva compra a este proveedor".
- **Información crítica:** contacto, condiciones, compras abiertas y materias primas.
- **Frecuencia esperada:** media.
- **Problemas encontrados:**
  - `suppliers.tsx:160-167`: el enlace a compras está **dentro de un `.notice`** junto a "Cuenta corriente y pagos estarán disponibles en una fase posterior.", que es jerga de roadmap. La acción más útil queda con aspecto de aviso.
  - `suppliers.tsx:134-140` + `ui.tsx:222`: el mensaje de desactivación es genérico. No dice qué pasa con compras abiertas ni con materias primas que lo tienen como proveedor preferido.
  - `suppliers.tsx:120` vs `suppliers.tsx:83`: el título del detalle usa `tradeName ?? legalName` y el de edición `legalName`. El mismo proveedor aparece con dos nombres.
  - `suppliers.tsx:144-157`: Details muestra 10 campos con "—" para vacíos.
  - No lista materias primas ni presentaciones del proveedor, ni compras recientes o pendientes de recibir.
- **Redundancias:** —
- **Deuda UX ya registrada:** VISUAL_HIERARCHY [F5A] "—" para datos vacíos (registrado en pedidos, aplica igual).
- **Prioridad:** **P2**.

### 1.30 `/proveedores/[id]/editar` — Editar proveedor

- **Ruta:** `app/(app)/proveedores/[id]/editar/page.tsx` → `SupplierForm` con `id`
- **Módulo:** Compras
- **Roles que la usan:** ADMIN, OWNER, ADMINISTRATION y PURCHASING.
- **Objetivo principal:** actualizar datos de contacto o condiciones.
- **Acciones primarias:** "Guardar cambios".
- **Acciones secundarias:** "Cancelar" y "← Volver al proveedor".
- **Información crítica:** —
- **Frecuencia esperada:** baja.
- **Problemas encontrados:** el título usa la razón social (`suppliers.tsx:83`) y el detalle el nombre comercial. El código no aparece. El resto, como en 1.28.
- **Redundancias:** —
- **Deuda UX ya registrada:** no.
- **Prioridad:** **P3**.

### 1.31 `/auditoria` — Auditoría

- **Ruta:** `app/(app)/auditoria/page.tsx` → `AuditLog` (`masters/audit.tsx`)
- **Módulo:** Sistema
- **Roles que la usan:** ADMIN, OWNER y ADMINISTRATION (`audit.read`).
- **Objetivo principal:** saber quién hizo qué, cuándo y sobre qué registro (control interno, investigar diferencias de stock o caja).
- **Acciones primarias:** ninguna.
- **Acciones secundarias:** filtro "Módulo" y paginación.
- **Información crítica:** fecha, usuario, acción, **registro afectado** y **detalle del cambio**. Los dos últimos no se muestran.
- **Frecuencia esperada:** baja (ocasional, ante un problema).
- **Problemas encontrados:**
  - `audit.tsx:10-24`: `ENTITY_LABELS` cubre 13 tipos. La API registra además `customer_order`, `customer_payment`, `price_list`, `product_lot`, `production_order` y `sale` (grep en `apps/api/src`). Esos **6 módulos no se pueden filtrar**, y en la columna "Módulo" aparecen en snake_case inglés (`audit.tsx:88`, fallback `?? item.entityType`).
  - `audit.tsx:68-94`: no muestra **qué registro** ni el detalle del cambio. Existe `describeChanges` en `ui.tsx:351-422`, pero solo lo usa `AuditHistory`. No hay enlace al registro.
  - `audit.tsx:42-58`: no hay filtros por usuario, por rango de fechas ni por acción, ni búsqueda. El filtro vive en `useState` (`audit.tsx:29-30`) y no en la URL como en `MasterList`: al volver se pierde.
  - `audit.tsx:84-85`: fallback al código de acción crudo.
  - `audit.tsx:64`: estado vacío genérico "Sin registros.".
  - `audit.tsx:98` vs `master-list.tsx:227`: "N registros" contra "N resultados", con paginación duplicada en vez del componente común.
  - `audit.tsx:73`: la columna "Módulo" se oculta en `hide-sm`.
- **Redundancias:** "Actividad reciente" del Inicio. El historial por registro (`AuditHistory`) es más rico que esta vista global.
- **Deuda UX ya registrada:** TABLES [F3] "selector de rango de fechas común a todos los listados".
- **Prioridad:** **P2** (6 módulos sin filtrar y sin detalle del cambio).

---

## 2. Navegación actual

Fuente: `lib/navigation.ts` (`NAVIGATION`, `visibleNavigation`, `CURRENT_PHASE = 5`) y `app-shell.tsx:45-66`.
Se usan los permisos de `packages/shared/src/roles.ts`. "Inicio" se agrega siempre, fuera de grupo y sin verificar
`dashboard.view` (`app-shell.tsx:45-47`). Los ítems con `phase > 5` (Caja 6, Cuentas a pagar 6, Gastos 6,
Facturación 7, Reportes 8) se muestran a todos y llevan a "Disponible en próxima etapa".
Se marcan con *(futuro)*.

### ADMIN — Administrador del sistema (23 entradas: Inicio + 22 ítems, 5 futuros, 9 grupos)
```
Inicio
OPERACIONES     Compras
PRODUCCIÓN      Órdenes · Recetas
PLANIFICACIÓN   Necesidades
INVENTARIO      Stock · Materias primas · Productos
COMERCIAL       Pedidos · Ventas · Listas de precios · Clientes · Proveedores
FINANZAS        Caja (futuro) · Cuentas a cobrar · Cuentas a pagar (futuro) · Gastos (futuro) · Facturación (futuro)
EQUIPO          Empleados · Usuarios
ANÁLISIS        Reportes (futuro)
SISTEMA         Configuración · Auditoría
```

### OWNER — Dueño (23 entradas, idéntico a ADMIN)
Igual a ADMIN: ambos tienen `ALL_PERMISSION_CODES`.

### ADMINISTRATION — Administración (23 entradas: Inicio + 22 ítems, 5 futuros, 9 grupos)
Igual a ADMIN. Tiene `purchases.read`, `production_orders.read`, `recipes.read`, `order_planning.read`,
`inventory.read`, `raw_materials.read`, `products.read`, `orders.read`, `sales.read`, `price_lists.read`,
`customers.read`, `suppliers.read`, `customer_accounts.read`, `employees.read`, `users.read`, `audit.read`
y los permisos de configuración. Ve los mismos 22 ítems aunque solo lee buena parte de ellos.

### SALES — Ventas (13 entradas: Inicio + 12 ítems, 5 futuros = 42 % del menú, 6 grupos)
```
Inicio
INVENTARIO      Productos
COMERCIAL       Pedidos · Ventas · Listas de precios · Clientes
FINANZAS        Caja (futuro) · Cuentas a cobrar · Cuentas a pagar (futuro) · Gastos (futuro) · Facturación (futuro)
ANÁLISIS        Reportes (futuro)
SISTEMA         Configuración   (Unidades, Categorías, Depósitos: solo lectura)
```

### PURCHASING — Compras (11 entradas: Inicio + 10 ítems, 5 futuros = 50 % del menú, 6 grupos)
```
Inicio
OPERACIONES     Compras
INVENTARIO      Stock · Materias primas
COMERCIAL       Proveedores
FINANZAS        Caja (futuro) · Cuentas a pagar (futuro) · Gastos (futuro) · Facturación (futuro)
ANÁLISIS        Reportes (futuro)
SISTEMA         Configuración   (solo lectura)
```

### PRODUCTION — Producción (14 entradas: Inicio + 13 ítems, 5 futuros = 38 %, 7 grupos)
```
Inicio
PRODUCCIÓN      Órdenes · Recetas
PLANIFICACIÓN   Necesidades
INVENTARIO      Stock · Materias primas · Productos
COMERCIAL       Pedidos
FINANZAS        Caja (futuro) · Cuentas a pagar (futuro) · Gastos (futuro) · Facturación (futuro)
ANÁLISIS        Reportes (futuro)
SISTEMA         Configuración   (solo lectura)
```

### WAREHOUSE — Depósito (13 entradas: Inicio + 12 ítems, 5 futuros = 42 %, 7 grupos)
```
Inicio
OPERACIONES     Compras
INVENTARIO      Stock · Materias primas · Productos
COMERCIAL       Pedidos · Ventas
FINANZAS        Caja (futuro) · Cuentas a pagar (futuro) · Gastos (futuro) · Facturación (futuro)
ANÁLISIS        Reportes (futuro)
SISTEMA         Configuración   (solo lectura; aquí están los Depósitos)
```

### Resumen

| Rol | Entradas (con Inicio) | Ítems reales | Futuros | Grupos | Grupos de 1 ítem |
| --- | :-: | :-: | :-: | :-: | --- |
| ADMIN | 23 | 17 | 5 | 9 | Operaciones, Planificación, Análisis |
| OWNER | 23 | 17 | 5 | 9 | Operaciones, Planificación, Análisis |
| ADMINISTRATION | 23 | 17 | 5 | 9 | Operaciones, Planificación, Análisis |
| SALES | 13 | 7 | 5 | 6 | Inventario, Análisis, Sistema |
| PURCHASING | 11 | 5 | 5 | 6 | Operaciones, Comercial, Análisis, Sistema |
| PRODUCTION | 14 | 8 | 5 | 7 | Planificación, Comercial, Análisis, Sistema |
| WAREHOUSE | 13 | 7 | 5 | 7 | Operaciones, Análisis, Sistema |

### Problemas de la navegación

1. **Los módulos futuros ocupan espacio y son iguales para todos.** Son 5 ítems (Caja, Cuentas a pagar, Gastos, Facturación, Reportes), es decir **entre el 22 % y el 50 % del menú** según el rol. Aparecen para roles que nunca los usarán (PRODUCTION y WAREHOUSE ven "Caja", "Gastos", "Facturación") y no hay atenuación visual (`navigation.ts:154`, `app-shell.tsx:51-63`). Para PURCHASING, la mitad del menú lleva a "Disponible en próxima etapa".
2. **"Finanzas" aparece para los 7 roles**, aunque PURCHASING, PRODUCTION y WAREHOUSE no tienen ningún permiso financiero. Para ellos es un grupo de 4 ítems vacíos.
3. **Grupos de un solo ítem.** "Operaciones" solo contiene Compras, y el nombre no ayuda (producir, vender y despachar también son operaciones). "Planificación" contiene solo Necesidades. "Análisis" tiene un único ítem futuro. Para los roles operativos, "Sistema" queda solo con Configuración.
4. **Ubicación incorrecta:**
   - Proveedores está en "Comercial", lejos de Compras (`navigation.ts:108`).
   - Depósitos está escondido en "Sistema → Configuración", mientras que WAREHOUSE (el rol de depósito) trabaja en "Inventario → Stock".
   - Unidades y Categorías (catálogos de producto) están en Sistema, separados de Materias primas y Productos.
   - "Materias primas" y "Productos" (maestros) cuelgan de "Inventario" junto a Stock, lo que mezcla catálogo con existencias.
   - "Necesidades" (de pedidos) está en un grupo aparte de Pedidos y de Producción.
5. **Configuración visible a todos.** `anyOf: CONFIG_SECTIONS.map(...)` (`navigation.ts:141`) y `units.read`/`categories.read` en `CATALOG_READ` (`roles.ts:29`) hacen que SALES, PURCHASING, PRODUCTION y WAREHOUSE vean "Sistema → Configuración" con 3 catálogos de solo lectura y frecuencia casi nula, en un lugar fijo del menú.
6. **Ítems de baja frecuencia en lugar destacado.** Para ADMIN, OWNER y ADMINISTRATION, "Equipo" (Empleados, Usuarios) y "Sistema" (Configuración, Auditoría) ocupan 4 entradas, al mismo nivel que Ventas o Pedidos, que se usan muchas veces al día. "Listas de precios" está al mismo nivel que "Ventas".
7. **Orden de grupos no alineado con la frecuencia.** "Operaciones → Compras" va primero, y "Comercial" (Pedidos y Ventas, el uso más intenso para SALES y ADMINISTRATION) va en 5.º lugar. "Producción → Órdenes" va antes que Recetas.
8. **Nombres técnicos o ambiguos:**
   - "Órdenes" (fuera de contexto, ¿de compra? ¿de producción?).
   - "Necesidades" (no dice de qué).
   - "Stock" (anglicismo; "Existencias" o "Inventario").
   - "Panificadora ERP" en la marca.
   - Las etiquetas de grupo van en MAYÚSCULAS (`globals.css:169`).
9. **Mismo menú para ADMIN, OWNER y ADMINISTRATION.** ADMINISTRATION ve 22 ítems aunque en Usuarios, Roles, Empresa, Unidades y Depósitos solo puede leer.
10. **Accesibilidad del shell:**
    - El enlace "Inicio" no tiene `aria-current` (`app-shell.tsx:45-47`), a diferencia de los demás.
    - En ≤900 px el menú oculto solo se desplaza con `transform` (`globals.css:613-621`), sin `visibility:hidden` ni `inert`. Los 13–23 enlaces siguen en el orden de tabulación aunque no se ven.
    - No se cierra con Escape, no atrapa el foco y no lo devuelve al botón ☰ (`app-shell.tsx:72-80`).
    - El botón "☰" usa el glifo como contenido (tiene `aria-label`, así que está bien), pero el `aside` y el botón no se vinculan con `aria-controls`.
11. **El topbar no tiene acceso a "Mi cuenta"** (cambiar la propia contraseña o el nombre). "Salir" es un botón con el mismo peso que el resto (`app-shell.tsx:86-88`). Los roles del usuario se ocultan en ≤900 px (`globals.css:639-641`).
12. **`isActive` usa `startsWith`** (`app-shell.tsx:38`). Hoy no hay colisiones, pero un slug futuro como `/compras-x` o `/stock-historico` marcaría dos ítems como activos.

Deuda registrada: NAVIGATION [F3] (agrupar por tarea y atenuar futuros), [F5A] y [F5B] (reagrupar Comercial, Proveedores con Compras).

---

## 3. Design system actual (`app/globals.css`, 1112 líneas)

### 3.1 Tokens en `:root` (`globals.css:1-23`)

| Token | Valor | Uso |
| --- | --- | --- |
| `--color-bg` | `#f6f4f0` | fondo de body |
| `--color-surface` | `#ffffff` | paneles, botones, inputs, topbar |
| `--color-border` | `#e3ddd3` | bordes de todo (contraste 1,35:1 sobre blanco) |
| `--color-text` | `#2b2620` | texto |
| `--color-muted` | `#6d645a` | texto secundario, th, hints (5,8:1 sobre blanco) |
| `--color-primary` | `#9a5b1e` | botón primario, enlaces de tabla, foco, pestaña activa (5,4:1) |
| `--color-primary-contrast` | `#ffffff` | texto del botón primario |
| `--color-sidebar` | `#2f2821` | fondo del menú |
| `--color-sidebar-text` | `#e9e2d8` | texto del menú (11,3:1) |
| `--color-sidebar-active` | `#4a3f33` | hover y activo del menú |
| `--color-danger` | `#b3261e` | errores, botón danger, alert, asterisco (6,5:1) |
| `--radius` | `8px` | radio estándar |
| `--sidebar-width` | `240px` | ancho del menú |

No hay tokens de **éxito, advertencia ni información**, ni escalas de espaciado o tipografía, ni modo oscuro.

### 3.2 Hex y colores fijos fuera de tokens

| Línea | Selector | Valor | Semántica |
| --- | --- | --- | --- |
| 415–416 | `.badge` (por defecto) | fondo `#e8f3e6`, texto `#2f6b28` | **éxito / activo** (verde) |
| 421 | `.badge--off` | fondo `#efe9e1` (texto `--color-muted`) | inactivo / cancelado / agotado |
| 426 | `.badge--info` | fondo `#f5ead9` (texto `--color-primary`) | info / en curso / parcial / etiquetas |
| 507–508 | `.notice` | fondo `#f5ead9`, texto `#5c3e1c` | aviso informativo, **y también el éxito "Cambios guardados"** |
| 579 | `.dialog::backdrop` | `rgb(0 0 0 / 35%)` | velo del diálogo |
| 631 | `.shell__backdrop` | `rgb(0 0 0 / 35%)` | velo del menú móvil (duplicado) |
| 669–670 | `.badge--warn` | fondo `#fdf0d5`, texto `#8a5300` | advertencia |
| 674–675 | `.badge--draft` | fondo `#e7eef8`, texto `#2c4f7c` | borrador (el único azul de la app) |
| 697–699 | `.alert--warn` | borde `#b26b00` (mezclado al 40 %), fondo `#fff7e6`, texto `#6b4300` | advertencia (otra paleta ámbar) |
| 788 | `.text-positive` | `#2f6b28` | valor positivo (repite el verde del badge) |

Colores derivados con `color-mix` (`.button--danger` 328, `.table tr:hover` 385, `.alert` 498–499,
`.badge--danger` 821) usan porcentajes distintos para el mismo rojo: 40 %, 35 %, 6 % y 12 %.

### 3.3 Radios

- `--radius: 8px`: botón, input, panel, card, alert, notice, cost-summary, presentation-form y extra-form.
- `12px` fijo: `.login__card` (125) y `.dialog` (571).
- `6px` fijo: `.nav__link` (180), `.tabs__link` (842, solo arriba), y los inputs de `.ingredients-editor` (751), `.conservation-table` (1004) y `.line-editor` (1091).
- `999px`: `.badge` (412).

Son cuatro radios, tres de ellos sin token.

### 3.4 Espaciado y tamaños

- **Gaps y márgenes** en rem: 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2, 3. Son 17 valores y no hay escala.
- **Padding de paneles:** `.panel` 1.1rem 1.25rem; `.card` 1rem 1.1rem; `.login__card` 2rem; `.dialog` 1.25rem; `.panel--empty` 3rem 1.25rem.
- **Altura mínima de controles:**
  - `.button` 40px; `.button--small` 32px (debajo de 44px táctil, en paginación y "Cambiar roles").
  - `.form__field input` 42px, pero `.form__field select/textarea` 40px (353). Input y select del mismo formulario tienen distinta altura.
  - `.line-editor` 38px; `.extra-form` 42px.
- **Padding de inputs:** 0.55/0.7rem (93), 0.5/0.65rem (350), 0.4/0.5rem (749, 1002, 1089). Son tres densidades.
- **Tamaños de fuente:** 0.72, 0.78, 0.8, 0.85, 0.9, 0.92, 0.93, 1, 1.05, 1.1, 1.15, 1.25, 1.5rem. Son 13 valores.

### 3.5 Badges: variantes y semántica real en uso

| Variante | Colores | Usada para (grep en `components/`) |
| --- | --- | --- |
| `.badge` (sin modificador) | verde | Activo/Activa/Con acceso (`StatusBadge`), compra Recibida, recepción Registrada, venta Registrada, cobro Pagado, pedido Listo y Entregado, cobertura completa, lote Disponible, receta vigente, reserva activa |
| `.badge--off` | gris | Inactivo, Baja, Desactivado, Cancelado (compra, venta, pedido), lote Agotado, "Sin vigente" |
| `.badge--info` | marrón claro (primario) | **roles del usuario** (`users.tsx:524`), lista "General", compra Pedida, pedido Confirmado, Entregado en parte, venta "Pagada en parte" |
| `.badge--warn` | ámbar | compra Recibida en parte, pedido **En preparación**, cobertura parcial, venta Impaga, lote Por vencer, "Sin costo", "Incompleto", prioridad Alta (no urgente) |
| `.badge--draft` | azul | Borrador (compra, recepción, venta, pedido, receta) |
| `.badge--danger` | rojo | Urgente, Sin cobertura, Replanificar, lote Vencido, lote **Bloqueado**, reserva invalidada |

### 3.6 Botones

| Variante | Estilo | Notas |
| --- | --- | --- |
| `.button` | borde gris, fondo blanco | secundario por defecto. Se usa también para acciones principales de cabecera ("Editar") |
| `.button--primary` | fondo primario | una acción principal por formulario |
| `.button--danger` | **outline** (texto rojo, borde rojo al 40 %) | también se usa para la confirmación destructiva del diálogo (`ui.tsx:182`): el "Desactivar" final pesa menos que un primario |
| `.button--small` | 32px | paginación, "Cambiar roles" |
| `.link-button` | texto subrayado | sin estilo de foco propio |
| `.topbar__menu` | `.button` con glifo ☰ | — |

No hay variantes **ghost/terciaria**, **danger sólido** ni **icon-only**.

### 3.7 Inconsistencias del design system

1. **Una semántica, distintos colores:**
   - "Parcial" se pinta warn en compra "Recibida en parte" y en "Cobertura parcial", pero info en pedido "Entregado en parte" y en venta "Pagada en parte".
   - Hay **tres ámbares** de advertencia: `.badge--warn` (#fdf0d5 / #8a5300), `.alert--warn` (#fff7e6 / #6b4300 / #b26b00) y `.notice` (#f5ead9 / #5c3e1c), que es casi igual al warn pero se usa como info.
   - El rojo de peligro usa cuatro porcentajes de `color-mix`.
2. **Un color, distintas semánticas:**
   - `.badge--info` sirve para etiquetas neutras (roles, "General") y para estados de proceso (Confirmado, Pedida).
   - `.badge--warn` sirve para un estado normal de flujo (pedido "En preparación") y para problemas reales ("Sin costo", "Por vencer").
   - `.badge--danger` iguala "Bloqueado" (decisión de calidad) con "Vencido".
   - `.notice` (marrón) se usa para éxito ("Cambios guardados", `settings.tsx:106`), para avisos informativos (`settings.tsx:260`) y como contenedor de un enlace de navegación (`suppliers.tsx:160`).
3. **El badge por defecto es verde.** Un `<span className="badge">` sin modificador significa "éxito". No existe una variante neutra explícita, así que una etiqueta neutra tiene que usar `--info` o `--off`.
4. **Sin estilo de éxito.** No existe `.alert--success`/`.notice--success`; el éxito se comunica igual que la información.
5. **El contraste no textual no cumple.** `--color-border` (#e3ddd3) sobre blanco da **1,35:1**. Es el único borde de inputs, selects y botones secundarios, y WCAG 1.4.11 pide ≥ 3:1 para identificar controles. `.badge--info` queda en 4,54:1 (al límite AA en 0.78rem bold).
6. **Foco visible incompleto.** `:focus-visible` cubre `.button`, `.nav__link`, inputs, selects, textareas, `.table a` y `.card`, pero **no** `.tabs__link`, `.link-button`, `.breadcrumb a` ni `.details a`. Esos dependen del outline del navegador.
7. **Reglas duplicadas:** `.shell__main { min-width: 0 }` dos veces (194 y 196) y `.details dd` en dos bloques (526 y 534).
8. **El CSS está organizado por fase del proyecto** ("Recetas y costos (Fase 2)", "Compras e inventario (Fase 3)", etc.) y no por componente. Por ejemplo, `.sr-only` y `.badge--warn` están en la sección "Fase 2", y `.badge--danger` en "Fase 3".
9. **Estilos inline en componentes** (12 en `components/masters/`, p. ej. `users.tsx:94,96,269,319,531,539`; `settings.tsx:260,366,672`). Pasan por encima del sistema.
10. **Tres editores de líneas con estilos de input propios** (`.ingredients-editor`, `.conservation-table`, `.line-editor`) más `.extra-form`. Repiten padding, borde y radio con valores levemente distintos.
11. **`.form__error` y `.alert`** se usan indistintamente para errores de nivel formulario: login y `content__alert` usan `.form__error`, y `EntityForm`/`UserCreateForm` usan `.alert`.

Deuda registrada: VISUAL_HIERARCHY [F2/F3] componente de métricas; ACCESSIBILITY [F3] contraste de `badge--warn`;
FORMS [F5B] unificar editor de líneas.

---

## 4. Hallazgos transversales

1. **Jerga de roadmap visible al usuario.** Textos como "Fase {n} del roadmap", "fase de inventario" o "fase posterior" aparecen en:
   - `[section]/page.tsx:24`
   - `settings.tsx:544` y `settings.tsx:652` (además desactualizados: el inventario existe)
   - `suppliers.tsx:166`

   Un usuario de negocio no sabe qué es una "fase".
2. **Códigos técnicos y snake_case en pantalla:**
   - Módulos de permisos sin etiqueta: `production`, `product_lots`, `product_conservation`, `orders`, `order_planning` (`permission-matrix.ts:5-27` → `settings.tsx:696`, `users.tsx:317`).
   - Seis tipos de entidad sin etiqueta en Auditoría (`audit.tsx:10-24, 88`).
   - Códigos de rol en el historial ("Roles: ADMIN, SALES", `ui.tsx:419`).
   - Claves de campo crudas como fallback (`ui.tsx:409` `FIELD_LABELS[k] ?? k`).
   - Códigos de acción como fallback (`page.tsx:56`, `audit.tsx:84`, `ui.tsx:469`).
   - Fecha ISO cruda "Egreso: 2026-10-05" (`ui.tsx:420`).
   - El validador `masters.ts:282` "Indique referenceCost (número o null)" expone el nombre del campo y `null`.
3. **Códigos internos como primera columna o primer campo.** En Proveedores, Depósitos, Empleados y Unidades el código autogenerado (`PROV-0001`, `DEP-0001`, `EMP-0001`, `kg`) encabeza la tabla. Los formularios de alta empiezan con el campo opcional "Código" ("Automático (XXX-0001…)") antes del nombre obligatorio. En el select de empleados se ve "(EMP-0007)".
4. **Los UUID no se muestran en pantalla**, pero sí están en todas las URLs de detalle y edición (`/usuarios/{uuid}`, `/empleados/{uuid}/editar`…). Esto afecta a compartir enlaces y a la legibilidad del historial del navegador. No es grave.
5. **Desactivar se comporta distinto según el maestro:**
   - Unidades y Categorías desactivan con un clic, sin diálogo ni manejo de error (`settings.tsx:294-298, 332-338, 488-492, 510-516`).
   - Depósitos y Proveedores usan `ActiveToggle` con un mensaje genérico (`ui.tsx:222`) que no explica el impacto específico: stock en el depósito, compras abiertas, materias primas con proveedor preferido.
   - Usuarios y Empleados tienen mensajes específicos y buenos.
6. **Los formularios no verifican permiso.** `UnitForm`, `CategoryForm`, `WarehouseForm`, `EmployeeForm`, `SupplierForm` y `UserCreateForm` se renderizan para cualquier rol que llegue por URL. El rechazo (403 "No tenés permiso…") aparece **después** de completar el formulario.
7. **Accesibilidad de formularios y diálogos (`entity-form.tsx`, `ui.tsx`, `users.tsx`):**
   - Faltan `required` y `aria-required` (el asterisco es `aria-hidden`).
   - Los hints no están en `aria-describedby`.
   - El foco no va al primer error.
   - `ConfirmAction` arma `aria-labelledby` con un id que contiene espacios cuando el label tiene varias palabras ("Dar de baja", "Desactivar acceso"), así que el diálogo queda sin nombre accesible. También duplica ids si hay dos acciones con el mismo label.
   - No se devuelve el foco explícitamente (deuda [F3]).
   - Los filtros de los listados no tienen etiqueta visible.
   - La celda de la matriz de roles depende de `aria-label` en `<td>`.
8. **Dos formatos de fecha.** `formatDate` produce "05/10/2026" y `formatDateTime`/Inicio produce "5/10/26, 9:57 a. m.". Los inputs de fecha son nativos y siguen el idioma del navegador (deuda FORMS [F4]).
9. **Concordancia y tono:**
   - Títulos "Nuevo unidad" y "Nuevo categoría" (`unidades/nuevo/page.tsx:4`, `categorias/nuevo/page.tsx:4`).
   - "Tipo: todas" (`master-list.tsx:173`).
   - Voseo en la UI ("Completá", "Revisá") contra usted en validaciones ("Asigne al menos un rol", "Indique…", `masters.ts:136,146,282`).
   - Estados con nombres distintos para lo mismo: "Activo / Con acceso / Activa" y "Inactivo / Desactivado / Baja / Dado de baja / Dados de baja".
10. **Estados vacíos genéricos y sin CTA:** "No hay unidades.", "No hay depósitos.", "No hay usuarios.", "Sin registros.", "Sin actividad registrada.". Ninguno ofrece el botón de alta aunque el usuario pueda crear (`master-list.tsx:198`).
11. **Feedback de éxito ausente o débil:**
    - Altas y ediciones redirigen al detalle sin confirmación.
    - El `?creado=1` de usuarios se pierde (`users.tsx:182`).
    - Empresa usa un `.notice` marrón permanente.
    - No hay un sistema de toasts.
12. **Sin `error.tsx` ni `loading.tsx` en el App Router.** Cada componente maneja su propio `Loading` con el texto "Cargando…". Un error de render cae en la pantalla por defecto de Next (en inglés). El `not-found` saca al usuario del shell.
13. **Ciclo de vida del acceso incompleto.** No hay reset de contraseña por administrador, ni "olvidé mi contraseña", ni "Mi cuenta" para cambiar la propia, ni paso de "copiar credenciales" al crear un usuario. Es el hueco funcional más importante de este alcance.
14. **Jerarquía de acciones plana.** En casi todas las fichas, "Editar" (`.button`) y "Desactivar" (`.button--danger` outline) tienen el mismo tamaño y relleno: la acción destructiva solo se distingue por el color del texto. La acción más útil a veces queda fuera de la cabecera ("Crear acceso" en Empleados, "Ver compras" en Proveedores dentro de un aviso) y la cabecera no tiene una acción primaria.
15. **Fichas sin relaciones.**
    - Depósito no muestra su stock.
    - Categoría no muestra sus ítems.
    - Proveedor no muestra materias primas ni compras recientes.
    - Empleado no muestra los roles de su acceso.

    En los cuatro casos el usuario tiene que navegar a otro módulo para responder la pregunta natural de la ficha.
16. **Paginación y conteos duplicados.** `AuditLog` reimplementa la paginación de `MasterList` con textos distintos ("registros" contra "resultados") y guarda el filtro en estado local en lugar de la URL.
17. **Densidad móvil.** `hide-sm` oculta justamente los datos de contacto (Teléfono y Contacto en Proveedores; Email en Usuarios) y deja visibles los códigos técnicos. `.button--small` (32px) queda debajo del tamaño táctil recomendado.
