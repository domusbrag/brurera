# Registro de decisiones de arquitectura (ADR)

Formato breve: contexto → decisión → consecuencias. Las decisiones se reemplazan con un ADR nuevo,
no se reescriben.

## ADR-001 — Monolito modular en un monorepo pnpm

**Contexto.** Producto que debe crecer por fases sin reescrituras; un equipo chico; la
especificación prohíbe microservicios y dos backends.
**Decisión.** Un único backend (`apps/api`), una web (`apps/web`) y paquetes internos
(`shared`, `database`) en un monorepo con **pnpm workspaces**, sin orquestador adicional (Turbo/Nx).
**Consecuencias.** Un solo despliegue de API, transacciones locales en una base. Los límites entre
módulos son convenciones de carpetas + revisión; si crecen, se puede agregar una regla de lint de
dependencias. `packages/domain` y `packages/ui` se crearán cuando haya lógica o componentes
compartidos reales (no se crean vacíos).

## ADR-002 — Fastify para la API (separada de Next.js)

**Contexto.** La especificación pide backend Node + TypeScript con API explícita y autorización en
servidor, y frontend React/Next.
**Decisión.** API HTTP con **Fastify 5** en `apps/api`. Next.js solo presenta; no tiene route
handlers de negocio. Next reescribe `/api/*` a la API.
**Consecuencias.** La lógica y autorización viven en un único lugar testeable con `inject()` sin
navegador. Hay dos procesos en desarrollo (API y web), pero un solo backend. La API puede servir a
futuros clientes (catálogo público, app) sin depender de Next.

## ADR-003 — Drizzle ORM con migraciones SQL versionadas

**Contexto.** Se requiere ORM con migraciones versionadas, tipos decimales y control fino de SQL
(índices parciales, triggers, transacciones).
**Alternativas.** Prisma: DX muy buena, pero su lenguaje de esquema propio hace menos directo el
SQL personalizado (triggers, índices parciales). TypeORM: tipado más débil.
**Decisión.** **Drizzle ORM** + `drizzle-kit` para generar migraciones SQL legibles; migraciones
custom para lo que Drizzle no modela; runner programático (`runMigrations`) usado por CLI y tests.
**Consecuencias.** SQL visible y revisable en cada PR; `numeric` se lee como string (se usará una
librería decimal en el dominio). Hay que revisar a mano cada migración generada.

## ADR-004 — PostgreSQL 16 en Docker Compose, puerto 5433

**Decisión.** `infra/docker-compose.yml` con `postgres:16-alpine`, healthcheck y volumen nombrado;
`docker compose up -d --wait`. Puerto host 5433 para no chocar con instalaciones locales.
**Consecuencias.** Entorno reproducible con un comando. Requiere Docker en la máquina de desarrollo.

## ADR-005 — Sesiones de servidor en PostgreSQL con cookie httpOnly

**Contexto.** Se pide login/logout/sesión con solución madura y sin criptografía propia. Un ERP
necesita revocar accesos (despidos, cambio de rol) al instante.
**Alternativas.** JWT stateless (revocación difícil, tokens largos en cliente); librerías de auth
completas para Next (acoplan la auth al frontend, contrario a ADR-002).
**Decisión.** Sesión opaca: token de 256 bits de `crypto.randomBytes` en cookie
`HttpOnly; SameSite=Lax; Secure (prod)`; en la tabla `sessions` solo su SHA-256. Contraseñas con
**Argon2id** (`@node-rs/argon2`). Primitivas estándar de Node y librerías maduras; no hay
algoritmos propios.
**Consecuencias.** Se agrega la tabla `sessions` (no listada en la especificación, necesaria para
esta estrategia). Logout y revocación reales. Cada request autenticada hace una consulta de sesión
(indexada) y una de roles/permisos; aceptable para el volumen previsto, cacheable más adelante si
hiciera falta. Falta limpieza periódica de sesiones expiradas (deuda menor).

## ADR-006 — Protección CSRF por SameSite + JSON + Origin

**Decisión.** No se usan tokens CSRF sincronizados. Toda request que modifica estado debe ser
`application/json` (los formularios cross-site no pueden enviarlo sin preflight CORS, que la API no
habilita) y, si trae `Origin`, debe estar en `WEB_ORIGIN`. La cookie es `SameSite=Lax`.
**Consecuencias.** Defensa en capas sin estado extra. Si en el futuro hay un cliente en otro
dominio, habrá que revisar esta decisión (CORS explícito + token).

## ADR-007 — Autorización por permisos; roles como datos

**Contexto.** La especificación pide permisos explícitos y no atar el diseño a roles hardcodeados.
**Decisión.** Catálogo de permisos `modulo.accion` definido en `@bakery/shared` y sincronizado a
la tabla `permissions`. Roles por empresa en `roles`, con los 7 iniciales marcados `is_system`. La
API solo pregunta por permisos (`requirePermission`), nunca por código de rol. ADMIN y DUEÑO
reciben todos los permisos como filas explícitas (sin comodín).
**Consecuencias.** Nuevos roles sin cambiar código. Cada fase agrega solo los permisos de lo que
implementa (en Fase 0: `dashboard.view`, `audit.read`) y `pnpm db:sync-reference` los aplica en
cualquier entorno.

## ADR-008 — `company_id` en todas las entidades de negocio

**Decisión.** Aunque haya una sola empresa operativa, toda entidad de negocio lleva `company_id`
y las consultas filtran por la empresa del usuario autenticado.
**Consecuencias.** No bloquea multiempresa. El email de usuario es único globalmente (el login no
pide empresa); si se requiere el mismo email en varias empresas, se revisará.

## ADR-009 — Auditoría solo-inserción, en la misma transacción que la operación

**Decisión.** `recordAudit(tx, entry)` recibe la transacción de la operación: auditoría y cambio se
confirman o revierten juntos. Un trigger de base rechaza `UPDATE`/`DELETE` en `audit_logs`. No se
guardan secretos (se audita el email en intentos fallidos, nunca la contraseña).
**Consecuencias.** Trazabilidad confiable. El volumen crecerá; se particionará o archivará cuando
sea necesario (no ahora).

## ADR-010 — Dinero y cantidades en `numeric`; fechas en `timestamptz`

**Decisión.** Prohibido `real`/`double precision` (test automático sobre el esquema). Marcas de
tiempo en UTC `timestamptz`; fechas de calendario en `date`; zona horaria de presentación por
empresa.
**Consecuencias.** En TypeScript los `numeric` llegan como string; la librería decimal para cálculo
se elegirá en la fase del primer cálculo de costos (Fase 2) y quedará en su propio ADR.

## ADR-011 — Seeds separados de migraciones; datos de referencia separados de datos demo

**Decisión.** Migraciones = estructura. `db:sync-reference` = datos necesarios en todo entorno
(permisos, roles de sistema). `db:seed` = datos demo de desarrollo, se niega a correr en producción.
**Consecuencias.** El código productivo no depende de datos demo. El alta de la primera empresa y
del primer admin en producción queda como tarea de Fase 1 (comando de bootstrap).

## ADR-012 — Validación con zod en los bordes

**Decisión.** Toda entrada externa (body, query, variables de entorno) se valida con zod.
Los esquemas compartidos con la web viven en `@bakery/shared`.
**Consecuencias.** Errores `400 VALIDATION_ERROR` consistentes, tipos inferidos del esquema.

## ADR-013 — Testing en tres niveles con base real

**Decisión.** Vitest para unit e integración (PostgreSQL real, sin mocks de base), Playwright para
smoke E2E. Ver [TESTING.md](TESTING.md).
**Consecuencias.** `pnpm test` requiere PostgreSQL arriba (`pnpm db:up`), algo explícito en README
y CI.

## ADR-014 — Next.js 16 App Router con verificación de sesión server-side

**Decisión.** El layout del grupo `(app)` consulta `GET /api/auth/me` en el servidor y redirige a
`/login` si no hay sesión. Sin middleware/proxy de Next: la protección real está en la API.
**Consecuencias.** Una llamada interna extra por navegación; simple y sin duplicar lógica de auth
en el frontend.

## ADR-015 — Membresía usuario ↔ empresa (Fase 1, corrige ADR-008 para usuarios)

**Contexto.** En Fase 0 `users.company_id` ataba cada usuario a una sola empresa y `user_roles`
se acotaba a la empresa solo de forma implícita. La Fase 1 exige que un mismo usuario pueda tener
roles distintos en empresas distintas.
**Decisión.** `users` pasa a ser identidad global. La pertenencia vive en `company_memberships`
(empresa, usuario, empleado opcional, estado) y los roles en `membership_roles`, con `company_id`
redundante y FKs compuestas `(company_id, id)` hacia roles, empleados y membresías. Cada sesión
guarda la empresa en la que trabaja (`sessions.company_id`). Migración 0002 traslada los datos;
0003 borra las columnas viejas. 0000 y 0001 no se tocan.
**Consecuencias.** La autorización sigue siendo por permiso (ADR-007 intacto). "Desactivar
usuario" desactiva la membresía en esa empresa y revoca sus sesiones; el bloqueo global de la
identidad queda disponible (`users.status`). En el MVP la sesión toma la primera membresía activa
y no hay selector de empresa; un email ya registrado no puede sumarse a otra empresa desde la UI
(se hará cuando exista el selector). La migración cierra las sesiones abiertas una vez.

## ADR-016 — Tenancy reforzada por la base con FKs compuestas

**Decisión.** Toda tabla de negocio tiene `UNIQUE (company_id, id)` y las referencias entre
maestros usan `FOREIGN KEY (company_id, x_id) REFERENCES x (company_id, id)`. La empresa de cada
operación sale de la sesión (`operationContext`), nunca del request.
**Consecuencias.** Aunque un bug de aplicación dejara pasar un id ajeno, la base rechaza la fila.
La API igual valida antes para responder 422 `INVALID_REFERENCE` sin revelar si el id existe en
otra empresa. Costo: un índice único extra por tabla.

## ADR-017 — decimal.js para aritmética de dominio (adelantado de Fase 2)

**Decisión.** `packages/domain` nace en Fase 1 con la conversión de unidades, que ya necesita
multiplicar y dividir cantidades. Se elige `decimal.js` (precisión arbitraria, API madura, sin
dependencias). Dinero y cantidades viajan como strings decimales entre base, API y web; nunca como
`number`.
**Consecuencias.** Recetas y costos (Fase 2) usarán la misma librería.

## ADR-018 — Unidades por empresa con conversión inmutable

**Decisión.** Las unidades son datos por empresa (las estándar se crean al aprovisionar). Una
unidad raíz no tiene base; una derivada declara `1 u = factor × base` con base raíz de la misma
dimensión (un solo nivel). Solo se convierte entre unidades con la misma raíz, así masa ↔ volumen
es imposible sin densidad (que el MVP no modela). Dimensión, base y factor no se editan tras
crearse; nombre, símbolo, decimales y estado sí. La unidad base de una materia prima debe ser raíz.
**Consecuencias.** Cambiar la definición de una unidad exige crear otra: se evita reinterpretar
cantidades ya cargadas. "Bolsa de 25 kg" se modela como unidad derivada de masa, no como envase
genérico.

## ADR-019 — Códigos internos por empresa con tabla de secuencias

**Decisión.** `code_sequences (company_id, entity, next_value)` entrega el próximo número con un
`INSERT … ON CONFLICT DO UPDATE` dentro de la transacción del alta (la fila queda bloqueada hasta
el commit). Formato `PREFIJO-0001` (`CLI`, `PROV`, `MP`, `PROD`, `EMP`, `DEP`). Si el usuario carga
un código manual, se respeta; si el automático ya está tomado, se salta al siguiente. Unicidad final
por `UNIQUE (company_id, código)`.
**Consecuencias.** Sin carreras entre altas concurrentes; puede haber huecos si una transacción se
revierte (aceptable: el código no es numeración fiscal).

## ADR-020 — Categorías en una sola tabla; lista de precios diferida

**Decisión.** Una tabla `categories` con `type` (`RAW_MATERIAL`/`PRODUCT`) en lugar de dos tablas
iguales; la API valida que una materia prima use una categoría de su tipo. `customers.price_list_id`
no se crea en Fase 1: llega en Fase 5 junto con `price_lists`, con su FK real, en vez de dejar una
columna huérfana.
**Consecuencias.** Menos código duplicado; la restricción de tipo vive en la aplicación (probada
por tests).

## ADR-021 — Versiones de receta inmutables, garantizadas por la base

**Decisión.** Una receta cambia sólo por versiones `DRAFT → ACTIVE → ARCHIVED`. Un borrador se
edita o descarta; una versión publicada no se modifica ni se borra. Además de la validación del
servicio, la base lo impone: el trigger `recipe_versions_guard` sólo deja pasar `ACTIVE → ARCHIVED`
(comparando la fila completa salvo estado, `archived_at` y `updated_at`) y falla con SQLSTATE
23001 ante cualquier otro cambio; `recipe_ingredients_guard` rechaza tocar ingredientes de una
versión no `DRAFT`; índices únicos parciales garantizan una `ACTIVE` y un `DRAFT` por receta. Los
números de versión salen de `recipes.last_version_number` (no se reutilizan tras descartar).
Publicar (validar, calcular costo, guardar snapshot, archivar la anterior, activar, auditar) es una
sola transacción con la receta bloqueada.
**Consecuencias.** Producción (Fase 4) puede referenciar una versión con la certeza de que no
cambió. Corregir una versión publicada exige una nueva versión. Un script o una migración futura
que quiera alterar versiones publicadas deberá deshabilitar el trigger explícitamente.

## ADR-022 — Costo teórico calculado al pedirlo; snapshot congelado al publicar

**Decisión.** El costo teórico de una versión no se guarda como columna: se calcula con los costos
de referencia actuales cada vez que se pide (`currentTheoreticalCost`). Al publicar se guarda un
snapshot append-only (`recipe_cost_snapshots` + líneas) con el costo de referencia usado, su origen,
las unidades y nombres copiados y el precio de venta de ese momento (`snapshotCost`). La UI muestra
ambos y la variación. Si falta un costo, el estado es `INCOMPLETE` y totales, unitario y margen son
`null`: nunca 0. Publicar con costo incompleto se permite sólo con confirmación explícita
(`acknowledgeIncompleteCost`), porque la receta sigue siendo válida como receta aunque falte un
precio. La merma teórica es informativa: el rendimiento ya es producción útil.
**Consecuencias.** El costo actual siempre refleja los costos de hoy sin jobs de recálculo; el
histórico es reproducible sin depender de que la materia prima siga existiendo igual.

## ADR-023 — Política decimal

**Decisión.** Toda aritmética de costos usa `decimal.js` con precisión 40 y `ROUND_HALF_UP`, sin
redondeos intermedios (ni por ingrediente ni por conversión). Se redondea una sola vez, al persistir
o enviar: dinero/costos 6 decimales, cantidades de receta 6, cantidades normalizadas 10,
porcentajes 4. La presentación redondea dinero a 2 decimales (HALF_UP); costos por unidad menores a
un centavo y costos de referencia se muestran con hasta 6 decimales. Los valores viajan como string.
**Consecuencias.** API y editor web (que usa las mismas funciones) dan exactamente el mismo número;
`0,1 + 0,2 = 0,3`. Los totales mostrados pueden diferir en un centavo de la suma de los renglones
mostrados, porque se suman los valores exactos.

## ADR-024 — Costo de referencia manual con permiso y origen propios

**Decisión.** `raw_materials.current_cost` pasa a `reference_cost` (por unidad base) con
`reference_cost_source` (hoy siempre `MANUAL_REFERENCE`; el enum ya prevé
`PURCHASE_MOVING_AVERAGE`, `SUPPLIER_QUOTE`, `OTHER`) y `reference_cost_updated_at`. Se cambia sólo
con `PUT /raw-materials/:id/reference-cost` y el permiso `raw_materials.update_cost` (Administración,
Compras, Admin, Dueño); cargarlo en el alta exige el mismo permiso. Cada cambio se audita
(`RAW_MATERIAL_REFERENCE_COST_CHANGED`, valor anterior y nuevo). Mientras una materia prima esté en
recetas no se cambia su unidad base, y la unidad de venta de un producto no puede pasar a una
incompatible con sus recetas.
**Consecuencias.** Queda claro que el costo es una referencia, no el costo real. En Fase 3 el
promedio ponderado de compras (`futureMovingAverageCost`) podrá convivir o reemplazar la
referencia indicando su origen, sin migrar el significado de la columna.

## ADR-025 — Packaging específico por artículo, diferido

**Decisión.** Una unidad de dimensión `PACKAGING` (bolsa, caja) no se convierte a masa ni volumen:
no se puede usar como unidad de un ingrediente cuya materia prima está en kg. Lo que "bolsa"
significa depende del artículo (25 kg de harina, 1 kg de azúcar) y eso no se modela todavía. Hoy,
quien necesite "bolsa de 25 kg" la define como unidad derivada de masa (ADR-018).
**Consecuencias.** Sin conversiones engañosas. Cuando compras lo requiera (Fase 3), se evaluará una
conversión por artículo (`raw_material_units`) con su propia migración.
