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

**Actualización (Fase 3).** Resuelto por ADR-030: presentaciones de compra por materia prima
(`raw_material_presentations`) en lugar de `raw_material_units`. Las recetas no cambian.

## ADR-026 — Ledger de stock append-only y autoritativo

**Contexto.** El stock no se edita: se deriva de movimientos (principio 2 de PRODUCT). Sumar el
ledger en cada consulta no escala y no permite bloquear un saldo para validar una salida.
**Decisión.** `stock_movements` es la única fuente de verdad, append-only por trigger: una
corrección es un movimiento nuevo, nunca un UPDATE o DELETE. `stock_balances` (saldo por empresa +
depósito + ítem) y `raw_material_inventory_costs` (cantidad, valor y promedio por materia prima a
nivel empresa) son **proyecciones** materializadas que se actualizan en la misma transacción que
el movimiento, junto con una fila append-only de `inventory_cost_history`. Toda escritura pasa por
`postStockMovement` (`apps/api/src/modules/inventory/ledger.ts`). El movimiento lleva `sequence`
(`bigserial`) para ordenar y referencia de origen (tipo, id y línea).
**Consecuencias.** Consultas de stock baratas y saldos bloqueables. No hace falta un proceso de
reconciliación periódico porque la base impide que una proyección diverja (ADR-027); los tests
verifican además que saldos y costos coinciden con la suma del ledger. Un movimiento mal cargado
se compensa con otro (ajuste), no se borra.

## ADR-027 — Proyecciones de stock custodiadas por triggers

**Decisión.** `stock_balances_guard` y `raw_material_inventory_costs_guard` sólo dejan crear una
fila vacía (cantidad 0, sin movimiento, para poder bloquearla) y sólo dejan cambiarla si apunta a
un movimiento **nuevo** (secuencia mayor que el último aplicado) de la misma empresa, materia prima
(y depósito, para el saldo), con cantidad nueva = anterior + movimiento (y, para el costo, valor
nuevo = anterior + valor del movimiento). Ninguna de las dos se borra. Los saldos y costos tienen
`CHECK ≥ 0`.
**Consecuencias.** Un `UPDATE stock_balances SET quantity = …` "a mano", un script o un bug que
aplique dos veces el mismo movimiento fallan con SQLSTATE 23001. El costo es una lectura extra del
movimiento por actualización, aceptable para el volumen previsto. Una migración que necesite
reconstruir saldos deberá deshabilitar los triggers explícitamente.

## ADR-028 — Cantidades con signo en el movimiento

**Decisión.** Una única convención: el movimiento guarda la cantidad **con signo** en la unidad
base de la materia prima, y el valor también con signo. Ingresos (`INITIAL_STOCK`,
`PURCHASE_RECEIPT`, `ADJUSTMENT_POSITIVE`) > 0; salidas (`ADJUSTMENT_NEGATIVE`, `WASTE`) < 0. El
usuario siempre ingresa cantidades positivas y el tipo pone el signo (`movementSign`,
`signedQuantity` en `@bakery/domain`). Un CHECK exige signo, valor, motivo y referencia
coherentes con el tipo. Los tipos de Fases 4 y 5 (`PRODUCTION_CONSUMPTION`, `PRODUCTION_OUTPUT`,
`SALE`, `RETURN`) no se crean todavía: se agregarán al enum con su flujo.
**Consecuencias.** El stock es `Σ quantity` sin mirar el tipo. El enum de la base sólo contiene
tipos que hoy tienen flujo; agregar uno exige `ALTER TYPE … ADD VALUE` y ampliar el CHECK.

## ADR-029 — Promedio ponderado móvil por empresa y política de redondeo

**Decisión.** El costo de inventario de una materia prima es un promedio ponderado móvil a nivel
**empresa** (no por depósito), calculado en `@bakery/domain` (`applyInbound`, `applyOutbound`).
Ingreso: si la existencia era 0, el promedio nuevo es el costo del ingreso (no se arrastra un
promedio sin existencia); si no, `(valor anterior + cantidad × costo) ÷ cantidad nueva`. Salida:
el promedio no cambia y sale `cantidad × promedio`; si la existencia queda en 0, el valor queda en 0
(la salida absorbe el residuo de redondeo). Escalas: cantidades 10 decimales, costo unitario y
valor del movimiento 6, promedio 6 (HALF_UP). El valor de inventario se guarda como valor anterior
más valor del movimiento, sin recalcularlo desde el promedio redondeado.
**Consecuencias.** Mover stock entre depósitos no cambiaría el costo (cuando existan
transferencias). El valor no acumula errores del promedio; `valor ÷ cantidad` puede diferir del
promedio guardado en el sexto decimal. Cada cambio de promedio queda en `inventory_cost_history` y
en la auditoría (`MOVING_AVERAGE_COST_CHANGED`).

## ADR-030 — Presentaciones de compra por materia prima (resuelve ADR-025)

**Decisión.** `raw_material_presentations`: una presentación pertenece a **una** materia prima
("Bolsa 25 kg" de esta harina) y declara unidad de compra, cantidad contenida y unidad de esa
cantidad, compatible con la unidad base. Como las unidades (ADR-018), la conversión es inmutable:
sólo se renombra o se desactiva/activa; cambiarla exige otra presentación. Sin presentación, una
línea de compra sólo acepta unidades de la misma raíz que la base (bolsa → kg sin presentación se
rechaza con `INCOMPATIBLE_PURCHASE_UNIT`). La línea de compra **congela** el factor
(`base_quantity_per_unit`) y la cantidad base pedida al guardarse. Una FK compuesta
`(company_id, raw_material_id, presentation_id)` impide usar la presentación de otra materia prima.
**Consecuencias.** No hay conversiones universales engañosas de "bolsa". Las presentaciones sólo
se usan en compras: recetas y stock siguen en la unidad base. El nombre es único por materia
prima.

## ADR-031 — Costo efectivo para recetas

**Decisión.** Las recetas usan un costo efectivo elegido por una función de dominio explícita,
`selectEffectiveCost`: (1) promedio ponderado de inventario si existe (`PURCHASE_MOVING_AVERAGE`);
(2) si no, costo de referencia manual (`MANUAL_REFERENCE`); (3) si no, ninguno (`INCOMPLETE`). La
API lo aplica al cargar materias primas (`withEffectiveCost` / `toCostInputs` en
`recipes.data.ts`) y lo envía en los DTO para que el editor web calcule lo mismo. El costo de
referencia se conserva y sigue editable (ADR-024). Reemplaza el `futureMovingAverageCost` previsto
en ADR-024.
**Consecuencias.** El costo teórico actual de las recetas cambia solo al confirmar compras. Los
snapshots publicados no cambian (append-only); los nuevos guardan el origen
`PURCHASE_MOVING_AVERAGE` cuando corresponde. **Deuda de nombre:** en
`recipe_cost_snapshot_lines` la columna `reference_cost` ahora significa "costo usado" (sea
referencia o promedio); se renombrará cuando haga falta tocar esa tabla, sin reinterpretar datos
porque cada línea guarda su `cost_source`.

## ADR-032 — Impuestos informativos; inventario valorizado al neto

**Decisión.** Bruto = cantidad × precio; neto = bruto − descuento (≤ bruto). El total de la compra
suma impuestos, pero estos son informativos (se asumen recuperables) y **no** entran al costo. El
costo de adquisición por unidad base es `neto de la línea ÷ cantidad base pedida`; una recepción
parcial se valoriza al mismo costo unitario.
**Consecuencias.** Simplificación documentada: si la empresa no recupera un impuesto, hoy no se
puede capitalizar en el costo. Los gastos de flete o percepciones no se prorratean.

## ADR-033 — Recepciones con estado e idempotencia doble

**Decisión.** Crear una compra no mueve stock; sólo la confirmación de una recepción
(`DRAFT → POSTED`, o `DRAFT → CANCELLED` si se descarta) lo hace. Confirmar es una sola
transacción: revalida cada línea contra lo pendiente **al momento de confirmar** (otra recepción
pudo confirmarse después de cargar el borrador), recalcula y congela las líneas, genera los
movimientos, actualiza `received_quantity` y el estado de la compra, marca la recepción y audita.
Idempotencia en dos capas: estado verificado con la recepción bloqueada (`409 ALREADY_POSTED`) e
índice único `(company_id, source_line_id)` en `stock_movements`. Recepciones `POSTED` y
`CANCELLED` y sus líneas son inmutables por trigger; `received_quantity ≤ ordered_quantity` por
CHECK.
**Consecuencias.** Un doble click, un reintento de red o dos usuarios confirmando a la vez no
duplican stock. Una recepción confirmada con un error se corrige con un ajuste (no hay reversión
de recepciones ni devoluciones todavía).

## ADR-034 — Concurrencia por locks de fila en orden fijo

**Decisión.** Las operaciones de inventario bloquean filas (`SELECT … FOR UPDATE`) siempre en el
mismo orden: compra → recepción → líneas de compra → filas de costo de empresa de las materias
primas **ordenadas por id** → saldo del depósito. Las filas de costo y saldo que no existen se
crean vacías con `INSERT … ON CONFLICT DO NOTHING` antes de bloquearlas. Stock inicial, ajustes y
mermas toman el mismo lock de costo antes de leer el promedio.
**Consecuencias.** Toda operación sobre una materia prima se serializa sobre su fila de costo: no
hay actualizaciones perdidas ni cálculos sobre un promedio viejo, y como el orden es fijo no hay
deadlocks. Operaciones sobre materias primas distintas corren en paralelo. Sin colas ni locks de
aplicación (se probó con confirmaciones y mermas simultáneas).

## ADR-035 — Sin stock negativo (política del MVP)

**Decisión.** Ninguna salida puede dejar negativo el saldo del depósito ni el total de la empresa:
la API responde `409 INSUFFICIENT_STOCK` y la base lo respalda con `CHECK (quantity >= 0)` en
saldos, costo de empresa y `balance_after` del movimiento.
**Consecuencias.** El promedio siempre se calcula sobre existencias reales. Si en producción
(Fase 4) se necesitara consumir antes de registrar la compra, se revisará con un ADR nuevo; hoy se
corrige primero con un ajuste o una recepción.

## ADR-036 — Visibilidad de la valorización del inventario

**Decisión.** El permiso `inventory.cost.read` controla la valorización en las rutas de
inventario: sin él, promedio, valor de inventario, costo y valor de los movimientos y costo de la
última compra vienen en `null` (el cálculo de visibilidad está en la ruta, no en la UI), y el
historial de costos (`GET /api/inventory/costs/:id`) responde 403. Depósito y Producción ven el
stock sin costos; Compras, Administración, Admin y Dueño, con costos. El costo efectivo por unidad que usan las
recetas sigue visible donde ya lo era en Fase 2 (materias primas y recetas, con sus permisos).
**Consecuencias.** Quien cuenta y mueve mercadería no ve cuánto vale el inventario. El costo
unitario no es secreto para quien ya ve recetas; si hiciera falta ocultarlo, será otro permiso.

## ADR-037 — Operaciones manuales sin tabla de documento

**Decisión.** Stock inicial, ajustes y mermas no tienen tabla propia: el movimiento **es** el
documento (tipo, motivo, observación, fecha, actor) y se audita (`INITIAL_STOCK_POSTED`,
`INVENTORY_ADJUSTED`, `INVENTORY_WASTE_RECORDED`). Motivos de ajuste: `PHYSICAL_COUNT`,
`DATA_CORRECTION`, `BREAKAGE`, `OTHER`; de merma: `EXPIRED`, `DAMAGED`, `PRODUCTION_LOSS`,
`QUALITY`, `OTHER` (columna `reason` con CHECK por tipo). El stock inicial exige costo y se carga
una sola vez por materia prima y depósito (si ya hay movimientos ahí,
`409 INITIAL_STOCK_ALREADY_LOADED`); un ajuste positivo sin costo entra al promedio vigente y, sin
promedio, lo exige (`VALUATION_COST_REQUIRED`); las salidas no aceptan costo.
**Consecuencias.** Una sola fuente, sin tablas vacías de semántica. Si más adelante hace falta un
documento con varias líneas (inventario físico completo), se agregará una tabla que genere
movimientos como hoy lo hacen las recepciones.

## ADR-038 — Cancelación de compras sólo sin mercadería recibida

**Decisión.** Una compra se cancela desde `DRAFT` u `ORDERED` y sólo si no tiene recepciones
confirmadas (`409 PURCHASE_HAS_RECEIPTS`); las recepciones en borrador se descartan con ella.
Después de pedida, sólo se editan notas, fecha esperada y documento del proveedor (trigger sobre
las líneas). No hay "cerrar con faltante" ni devoluciones a proveedor en esta fase. Estado de pago
y cuenta del proveedor quedan para Fase 6.
**Consecuencias.** Una compra que el proveedor nunca completa queda `PARTIALLY_RECEIVED`
indefinidamente (deuda registrada). Las diferencias de mercadería ya recibida se corrigen con
ajustes explícitos.

## ADR-039 — La orden de producción es también el lote

**Contexto.** Fase 4 necesita registrar qué se iba a producir, con qué receta, qué se consumió y
qué salió. Un modelo separado de "lote" (con stock, vencimiento y FIFO) excede el MVP.
**Decisión.** `production_orders` es a la vez el documento y el lote: guarda el plan (cantidad,
versión de receta, depósitos), lo real (salida, consumos por línea en
`production_material_lines`, con líneas `RECIPE` y `EXTRA`) y el snapshot de costos como columnas
`planned_*` / `actual_*` (equivalente a un `ProductionCostSnapshot`). `batch_code` es opcional y
se genera al planificar (`LOT-AAAAMMDD-NNN`, único por empresa) sólo como trazabilidad. Los
consumos extra son líneas de la orden con motivo obligatorio: nunca modifican la receta.
**Consecuencias.** Una sola entidad responde "qué, con qué receta, cuánto, cuánto costó". No hay
stock por lote, vencimientos ni FIFO (roadmap); si se necesitan, el lote pasará a tabla propia y la
orden lo referenciará. _(Fase 4.5: el lote pasó a tabla propia, ver ADR-043; la orden sigue
siendo el documento de producción y el origen de su lote raíz.)_

## ADR-040 — Versión de receta fijada al planificar

**Contexto.** Las recetas se versionan (Fase 2) y una versión nueva puede publicarse mientras hay
órdenes en curso.
**Decisión.** Al crear la orden se sugiere la versión vigente para la fecha programada
(`findEffectiveVersion`); en `DRAFT` puede cambiarse por otra versión publicada de la misma
receta. Al pasar a `PLANNED` se guardan `recipe_version_id`, las cantidades escaladas y el costo
esperado, y quedan inmutables (API `409 PRODUCTION_PLAN_LOCKED` y trigger
`production_orders_guard`). Publicar una versión nueva no toca órdenes existentes.
**Consecuencias.** El plan y su costo esperado son reproducibles; el "plan vs real" compara contra
lo que efectivamente se planificó. Para producir con la receta nueva se crea otra orden.

## ADR-041 — Movimientos productivos sólo al completar, valorizados al costo material real

**Contexto.** Planificar e iniciar no deberían mover stock (una orden puede cancelarse), y el
costo del producto terminado debe salir del inventario real, no de la receta.
**Decisión.** `DRAFT`, `PLANNED` e `IN_PROGRESS` no generan movimientos: cancelar no deja nada que
revertir. Al completar, en una transacción, cada línea genera `PRODUCTION_CONSUMPTION` al costo
promedio vigente de la materia prima (sin tocar su promedio) y la orden genera un único
`PRODUCTION_OUTPUT`. El costo material real es la suma de `total_value` de los consumos; el valor
de la salida es exactamente ese total y su unitario es total / cantidad real. El promedio del
producto usa `applyInbound` (el mismo cálculo que compras) y queda en `product_inventory_costs` con
historial append-only. No se genera `WASTE` por rendimiento: un rendimiento menor sube el costo
unitario. Iniciar revalida stock (`409 INSUFFICIENT_MATERIALS_FOR_PRODUCTION`) pero **no reserva**
(deuda `INVENTORY_RESERVATIONS`); completar revalida todo (`409 INSUFFICIENT_STOCK`, nunca
negativo, ADR-035). Una producción completada es inmutable y **no se revierte** (deuda
`PRODUCTION_REVERSAL`).
**Consecuencias.** El costo material del producto es el que Fase 5 usará como costo de venta. Es
sólo costo de materias primas: no incluye mano de obra, energía ni indirectos. Entre iniciar y
completar otra operación puede consumir el stock; el usuario lo ve como faltante al confirmar. Los
errores de una producción completada se corrigen con ajustes explícitos.

## ADR-042 — Orden global de locks e idempotencia de producción

**Contexto.** Completar toca muchas filas (varias materias primas, el producto, sus saldos) y puede
correr en paralelo con compras, mermas u otras órdenes; un doble click no puede duplicar nada.
**Decisión.** Orden fijo de locks: orden de producción → sus líneas → costos de materias primas
(por id) → saldos de materias primas (por id) → costo del producto → saldo del producto. Compras,
ajustes y mermas toman el mismo prefijo costo → saldo (ADR-034), así no hay ciclos. La
idempotencia tiene dos capas: el estado se verifica con la orden bloqueada (`409
PRODUCTION_ALREADY_COMPLETED`) y el único `(company_id, source_line_id)` del ledger (la línea para
cada consumo, la orden para la salida).
**Consecuencias.** Dos órdenes que compiten por la misma harina se serializan y una recibe `409
INSUFFICIENT_STOCK`; tres "Completar" simultáneos dan `[200, 409, 409]` con un único juego de
movimientos; cuatro órdenes con las mismas materias primas completan sin deadlocks (tests de
concurrencia).

## ADR-043 — El lote de producto nace de la orden de producción y se transforma en lotes hijos

**Contexto.** Fase 4.5 necesita stock por lote con conservación y vencimiento (ADR-039 anticipaba
que el lote pasaría a tabla propia).
**Decisión.** `product_lots` es la tabla del lote. Un lote raíz por orden `COMPLETED`, creado en la
misma transacción que el `PRODUCTION_OUTPUT` (que lo referencia) y con el `batch_code` de la orden
como código (si la orden no tenía, se genera al completar). Congelar / descongelar no cambia el
estado del lote: crea un lote hijo (`parent_lot_id`, código `<padre>.<n>`, misma orden de origen)
con su propio vencimiento. Los campos históricos del lote son inmutables por trigger; sólo cambian
calidad y notas.
**Consecuencias.** La procedencia de cualquier kilo se recorre hasta su orden. Un lote puede quedar
repartido en varios estados y vencimientos; cada parte es un lote. No hay lotes de compra ni de
materias primas (fuera de alcance).

## ADR-044 — Valorización por lote sin tocar el costo promedio

**Contexto.** Transformar o descartar parte de un lote no puede cambiar el costo promedio del
producto ni agregar costo, y el valor de inventario debe seguir siendo exacto.
**Decisión.** Cada lote lleva su valor (`product_lot_balances.inventory_value`). Las salidas de
lote (transformación y merma) se valorizan al costo unitario del lote (`lotOutflow`; si se agota,
exactamente su valor restante, sin residuos de redondeo) y se aplican con `applyLotMovement`, que
cambia cantidad y valor del producto pero nunca `moving_average_cost`. La transformación es
`LOT_TRANSFORMATION_OUT` + `IN` por el mismo valor: neto cero. La merma escribe historial de costo
(`product_inventory_cost_history`) porque cambia el valor de inventario; la transformación no.
**Consecuencias.** Σ valores de lote = valor de inventario del producto en todo momento (test de
reconciliación). El promedio sólo cambia con producciones. Fase 5 decidirá si la venta sale al
costo del lote (FEFO) o al promedio.

## ADR-045 — Transiciones de conservación permitidas

**Contexto.** Una panadería congela lo fresco o refrigerado y descongela lo congelado; recongelar
lo descongelado es un riesgo sanitario.
**Decisión.** Transiciones: `FRESH → FROZEN`, `REFRIGERATED → FROZEN`, `FROZEN → THAWED`
(`CONSERVATION_TRANSITIONS` en `@bakery/domain`), sólo si el estado destino está habilitado en el
perfil del producto. `THAWED → FROZEN` nunca. Fresco → refrigerado y refrigerado → fresco quedan
fuera del MVP (pendiente de definición de negocio). Un lote vencido, bloqueado o agotado no se
transforma (409 `LOT_EXPIRED` / `LOT_BLOCKED` / `LOT_DEPLETED`).
**Consecuencias.** El formulario de descongelar advierte que no se puede volver a congelar y la
ficha de un lote descongelado no ofrece congelar.

## ADR-046 — Vencimiento derivado, sin jobs; vida útil desconocida cuenta como utilizable

**Contexto.** "Vencido" depende del momento de la consulta; un job que cambie estados agrega
fallas y desfases.
**Decisión.** `usable_until` se calcula una sola vez al nacer el lote (estado + vida útil del
perfil vigente) y no cambia. "Vencido", "próximo a vencer" y "agotado" se derivan en cada consulta
(`lotEligibilityAt`, `at > usable_until` = vencido). Un lote sin vida útil (producto sin perfil o
lote migrado) es utilizable y se informa como "vida útil sin configurar" (`shelfLifeUnknown`).
Cambiar el perfil no recalcula lotes existentes.
**Consecuencias.** La disponibilidad a una fecha es una consulta pura y reproducible. Los lotes
migrados no vencen hasta que se registren manualmente (merma) o se agoten.

## ADR-047 — Migración de Fase 4 a lotes: backfill del ledger con BLOCKER

**Contexto.** Los datos de Fase 4 tienen stock de producto sin lote; inventar procedencia
falsearía la trazabilidad.
**Decisión.** 0008 crea un lote raíz por orden `COMPLETED` desde su `PRODUCTION_OUTPUT`
(`FRESH`, sin vencimiento, nota "migrado"). Si existe un movimiento de producto que no sea la
salida de una orden completada, o si al final Σ lotes ≠ saldo agregado o ≠ costo del producto
(cantidad o valor), la migración aborta con `FASE_4_5_MIGRATION_BLOCKER` y, por correr en una
transacción, no aplica nada. Completar `product_lot_id` en el ledger es la única escritura sobre
`stock_movements`: el trigger append-only se suspende sólo para esa sentencia; cantidades, valores
y referencias no cambian (verificado antes/después).
**Consecuencias.** Una base inconsistente no se migra en silencio: hay que corregirla primero. El
check `stock_movements_product_lot` se agrega al final, ya con los datos completos.

## ADR-048 — Calidad separada de conservación; permiso propio

**Contexto.** Un lote puede estar en buen estado de conservación pero retenido por calidad.
**Decisión.** `quality_status` (`AVAILABLE` / `BLOCKED` con motivo) es independiente del estado de
conservación. Bloquear y desbloquear son operaciones auditadas (`PRODUCT_LOT_BLOCKED` /
`UNBLOCKED`) con el permiso `product_lots.quality` (agregado a los pedidos por la especificación;
Depósito, Administrador y Dueño). Un lote bloqueado no cuenta como disponible ni se transforma,
pero admite merma.
**Consecuencias.** Producción puede congelar pero no bloquear ni registrar merma de producto
terminado.

## ADR-049 — Idempotencia de operaciones sobre lotes con operationId del cliente

**Contexto.** Congelar o descartar con doble click o reintento de red no puede duplicar
movimientos ni lotes.
**Decisión.** Cada operación lleva un `operationId` (UUID generado por la UI una vez por intento).
Transformación: único `(company_id, operation_id)` en `product_lots` y `source_line_id =
operationId` en el `OUT`. Merma: `source_line_id = operationId` (único del ledger). Se verifica
antes y después de bloquear el lote: un reintento devuelve `200` con el mismo resultado y
`replayed: true`; el mismo id en otra operación o lote, `409 OPERATION_ID_REUSED`.
**Consecuencias.** Dos pedidos simultáneos con el mismo id producen un solo hijo; dos con ids
distintos se serializan por el lock del lote y el segundo puede recibir `409
INSUFFICIENT_LOT_QUANTITY` (300 + 300 sobre 500).

## ADR-050 — Reserva dura por lote de producto terminado, sin movimiento de stock

**Contexto.** Un pedido confirmado tiene que apartar stock concreto para su fecha (vencimientos,
FEFO, trazabilidad y, en Fase 5B, la venta y su costo real), sin que el stock físico cambie hasta
que ocurra algo físico.
**Decisión.** Confirmar crea `product_lot_reservations` por lote (no "400 medialunas" sino "150 de
LOT-A + 250 de LOT-B"), elegidas por FEFO entre lotes **elegibles para `requestedAt`**
(`calculateProductAvailabilityAt` de Fase 4.5, misma regla: vencido = `at > usable_until`, vida
útil desconocida cuenta como utilizable y se advierte) que respeten la conservación pedida
(`ANY` acepta cualquiera). Nunca se crea un `StockMovement`. Cantidades: `PHYSICAL` (saldo),
`ELIGIBLE` (físico utilizable en la fecha), `COMMITTED` (Σ reservas `ACTIVE` sobre lotes
elegibles), `AVAILABLE = ELIGIBLE − COMMITTED`. La base garantiza Σ reservas activas ≤ saldo del
lote (trigger al reservar y al bajar el saldo) y que un lote bloqueado no tenga reservas activas.
Las reservas no se borran: pasan a `RELEASED`, `INVALIDATED` o (Fase 5B) `FULFILLED`.
**Consecuencias.** Un segundo pedido para la misma fecha no reutiliza lo comprometido: produce.
Stock → Productos terminados muestra Comprometido y Disponible ahora; el lote, comprometido, libre
y quién lo reserva.

## ADR-051 — Materia prima: demanda proyectada, no reserva

**Contexto.** Reservar harina para pedidos lejanos bloquearía la producción normal de hoy.
**Decisión.** Lo que falta producir genera `order_production_requirements` (producto, cantidad,
receta y versión fijadas) y su explosión en `order_material_requirements` (snapshot por materia
prima, con la fórmula de escalado de Producción). No se reserva materia prima ni se mueve stock.
`calculateMaterialDemand` agrega en el servidor la demanda de los pedidos `CONFIRMED`,
`IN_PREPARATION` y `READY` (con horizonte `until` en hora de la empresa) contra el stock actual de
toda la empresa: `openOrderDemand`, `availableAfterDemand`, `shortage`, proveedor preferido y los
pedidos que la componen.
**Consecuencias.** Dos pedidos que "alcanzan" por separado muestran faltante juntos (7 + 5 contra
10 → faltan 2). La materia prima se compra con la información de Necesidades; reservarla
físicamente queda fuera de la fase.

## ADR-052 — REPLAN explícito con `planRevision`; ninguna consulta reescribe un plan

**Contexto.** Cambiar fecha o cantidades de un pedido confirmado, o aprovechar stock nuevo, no
puede reescribir silenciosamente lo prometido ni borrar historia.
**Decisión.** Un pedido confirmado sólo edita datos informativos (contacto, entrega, prioridad,
notas); fecha y productos cambian con `POST /orders/:id/replan` (con `replan-preview` que muestra
antes y después). El replan, en una transacción: libera las reservas activas (`ORDER_REPLANNED`),
cierra las necesidades (las cumplidas por una producción completada quedan `SATISFIED`; las que ya
tienen una orden en curso en una línea que sigue se conservan y se descuentan de lo que falta; el
resto `CANCELLED`), incrementa `planRevision`, aplica los cambios y crea reservas y necesidades
nuevas con la revisión nueva. Un pedido `READY` que deja de estar cubierto vuelve a
`IN_PREPARATION`. Sin cambios, el replan es "Actualizar cobertura" con el stock de hoy. Ningún GET
escribe: si un pedido cancelado o una producción liberan stock, los demás pedidos muestran "Hay
nuevo stock disponible — recalcular cobertura" y no cambian hasta que alguien lo pide.
**Consecuencias.** La historia de reservas y necesidades se conserva por revisión. Cancelar libera
reservas y cancela necesidades abiertas; las órdenes de producción ya creadas no se cancelan solas.

## ADR-053 — Orden global de locks de pedidos y lotes

**Contexto.** Confirmar/replanificar/cancelar un pedido toca pedido, líneas, necesidades, lotes,
saldos y reservas; congelar, mermar o bloquear un lote toca lote, saldo y reservas. Sin un orden
común hay deadlocks y sobre-reserva.
**Decisión.** Operaciones de pedido: pedido (`FOR UPDATE`) → líneas → necesidades → lotes
candidatos (`FOR UPDATE`, ordenados por id) → saldos → reservas. Operaciones de lote: lote → saldo →
reservas, nunca el pedido (marcar `NEEDS_REPLAN` no escribe el pedido: la cobertura efectiva se
deriva de reservas `INVALIDATED` de la revisión vigente). Marcar listo toma las reservas `FOR
SHARE`. Crear una orden de producción desde una necesidad: pedido `FOR SHARE` → necesidad `FOR
UPDATE`. Los triggers de capacidad no son diferibles, por eso merma y bloqueo **invalidan antes**
de bajar el saldo o cambiar la calidad.
**Consecuencias.** Dos confirmaciones simultáneas de 70 sobre 100 reservan 70 + 30 (y 40 a
producir), nunca 140; merma y confirmación concurrentes nunca dejan una reserva activa sobre
cantidad inexistente.

## ADR-054 — Calidad y merma tienen prioridad sobre la reserva; lo comprometido no se transforma

**Contexto.** No se puede impedir bloquear producto potencialmente no apto, ni registrar una merma
real, sólo porque estaba reservado; tampoco congelar mercadería prometida fresca.
**Decisión.** Bloquear por calidad invalida todas las reservas activas del lote
(`LOT_RESERVATION_INVALIDATED`, motivo `LOT_BLOCKED`). La merma que deja el saldo por debajo de lo
comprometido invalida reservas (primero las de menor prioridad y entrega más lejana) y, para la
reserva parcialmente afectada, re-reserva lo que queda en el lote; motivo `LOT_WASTE`. Los pedidos
afectados quedan `NEEDS_REPLAN` hasta un replan. Transformar (congelar/descongelar) sólo puede
tomar `saldo − comprometido`: si no, `409 LOT_QUANTITY_COMMITTED`.
**Consecuencias.** Un pedido nunca afirma estar cubierto por un lote bloqueado o mermado. Para
congelar lo reservado hay que replanificar primero.

## ADR-055 — Fecha y hora del pedido en la zona de la empresa

**Contexto.** En Fase 4.5 el selector de disponibilidad usaba `datetime-local` y `new Date()`, es
decir, la zona del navegador.
**Decisión.** `requestedAt` viaja entre UI y API como hora de pared de la empresa
(`"AAAA-MM-DDTHH:mm"`, `localDateTimeSchema`) y la API la convierte con `Company.timezone`
(`zonedLocalToInstant`); se guarda `timestamptz` y se devuelve también `requestedAtLocal`. La UI usa
`WallClockInput` (fecha + hora por separado, rotulado "hora de <zona>") y nunca interpreta la hora
con la zona del navegador. Los filtros `from`/`to` son fechas del calendario de la empresa. La
disponibilidad a una fecha de Fase 4.5 y el "hoy" del formulario de producción pasan a la misma
regla.
**Consecuencias.** Probado con la empresa en Buenos Aires y el navegador en Tokio (E2E) y con una
empresa en Tokio (integración): 10/10/2026 10:00 se guarda y se muestra 10:00 hora de la empresa.
Quedan con `datetime-local` las fechas de recepción de compras y de operaciones de stock (deuda en
UX_BACKLOG).

## ADR-056 — Necesidad de producción → orden de producción, 1:1 en el MVP; idempotencia de pedidos

**Contexto.** Lo que falta producir debe poder convertirse en una orden de producción sabiendo
para qué pedido es, sin atar Producción a Pedidos.
**Decisión.** `production_orders.source_order_requirement_id` (opcional). "Crear orden de
producción" prellena producto, cantidad, receta, fecha requerida y depósitos sugeridos; al crearla
la necesidad pasa `OPEN → PRODUCTION_CREATED` (una sola orden por necesidad: la segunda recibe
`409 REQUIREMENT_NOT_OPEN`). Cancelar la orden la devuelve a `OPEN`; completarla, a `SATISFIED`
(el pedido avisa stock nuevo y se actualiza con un replan). Requiere `order_production.create`
además de `production_orders.create`. Confirmar, replanificar y cancelar llevan un `operationId`
registrado en `customer_order_operations`: un reintento devuelve el mismo resultado
(`replayed: true`); el mismo id en otra acción u otro pedido, `409 OPERATION_ID_REUSED`.
**Consecuencias.** No hay consolidación de varios pedidos en una producción (deuda
`PRODUCTION_CONSOLIDATION`). Las producciones normales siguen existiendo sin pedido.
