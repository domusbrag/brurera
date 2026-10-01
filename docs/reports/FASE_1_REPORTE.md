# Reporte Fase 1 — Maestros

## Estado

**FASE_1_STATUS = COMPLETE_PENDING_HUMAN_ACCEPTANCE**

**Cierre (2026-10-01):** FASE_1_TECHNICAL_REVIEW = PASS · FASE_1_HUMAN_GATE = ACCEPTED (maxi) ·
NEXT_ALLOWED_PHASE = FASE_2_RECETAS_Y_COSTO_TEORICO. Commit aceptado: `48a105e`.

Rama `fase-1-maestros`, PR [domusbrag/brurera#1](https://github.com/domusbrag/brurera/pull/1)
contra `main`. **CI_REMOTE_STATUS = PASS** (GitHub Actions, job `verify`, run
[36790720062](https://github.com/domusbrag/brurera/actions/runs/36790720062) sobre `48a105e`, 2026-09-30 23:24 UTC).

No se empezó Fase 2 (recetas, costos), ni compras, inventario, producción o ventas.

## Resumen funcional

Una persona con rol Administrador puede hacer todo lo siguiente desde la web:

- configurar la empresa: datos fiscales, contacto, moneda y zona horaria;
- dar de alta empleados y darles acceso al sistema como usuarios con uno o más roles;
- cargar clientes, proveedores, unidades de medida con conversiones, categorías, materias primas, productos y depósitos;
- buscar, filtrar por estado, editar, desactivar y reactivar cualquiera de esos datos (nunca se borran);
- ver el historial de auditoría de cada registro y el log general en **Sistema → Auditoría**.

Cada rol ve sólo los menús y las acciones que su permiso habilita, y la API aplica los mismos
permisos. Los datos de otra empresa no son accesibles: la API responde 404 como si no existieran.

## Arquitectura

Se mantiene la arquitectura de Fase 0: un monolito modular con Fastify y Next.js, pnpm workspaces y
PostgreSQL. Sobre esa base se agregó:

- **apps/api**: un módulo por maestro (`company`, `employees`, `users`, `roles`, `customers`,
  `suppliers`, `units`, `categories`, `raw-materials`, `products`, `warehouses`). Todos siguen el
  mismo patrón de listado, detalle, alta, edición y activar/desactivar.
  - Hay helpers comunes en `lib/` (listing, context, db-errors).
  - `AuthContext` ahora se resuelve desde la membresía activa.
- **packages/domain** (nuevo): lógica pura con `decimal.js` para conversiones de unidades y códigos.
- **packages/shared**: esquemas zod de los maestros, etiquetas, catálogo de permisos y generador de la matriz de `docs/PERMISSIONS.md`.
- **apps/web**: componentes de maestros reutilizables (`master-list`, `entity-form`, `ui`),
  `UserProvider` con `useCan`, menú filtrado por permisos y 41 pantallas nuevas.

## Modelo de datos

Hay 18 tablas. Las nuevas son `company_memberships`, `membership_roles`, `employees`, `customers`,
`suppliers`, `units`, `categories`, `raw_materials`, `products`, `warehouses` y `code_sequences`.

- Toda tabla de negocio tiene `company_id` y FKs compuestas `(company_id, id)`, así que la propia
  base impide referencias cruzadas entre empresas.
- Materias primas y productos **no tienen campo de stock**. Tampoco hay costo en productos: la UI
  muestra "Costo disponible desde Fase 2".
- El diagrama ER completo, con las entidades implementadas y las futuras, está en `docs/DOMAIN_MODEL.md`.

## Migraciones

| Migración                           | Contenido                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `0000_foundation.sql`               | Sin cambios (Fase 0)                                                          |
| `0001_audit_logs_append_only.sql`   | Sin cambios (Fase 0)                                                          |
| `0002_company_membership.sql`       | Crea membresías y roles por membresía; migra los datos de usuarios existentes |
| `0003_drop_single_company_user.sql` | Quita `users.company_id` y la tabla `user_roles`                              |
| `0004_masters.sql`                  | Crea las tablas de maestros, las secuencias de códigos y las FKs compuestas   |

`git diff main -- 0000_foundation.sql 0001_audit_logs_append_only.sql` sale vacío.

## Maestros implementados

| Maestro         | Código            | Particularidades                                                                                    |
| --------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| Empresa         | —                 | Única por sesión; valida moneda ISO 4217 y zona horaria IANA                                        |
| Empleados       | `EMP-0001`        | Documento único por empresa; baja con fecha de egreso; panel "Acceso al sistema"                    |
| Usuarios        | —                 | Email único; se vinculan opcionalmente a un empleado; roles múltiples; nadie se modifica a sí mismo |
| Roles           | código de sistema | 7 roles de sistema con una matriz de permisos visible                                               |
| Clientes        | `CLI-0001`        | Tipo, condición comercial y límite de crédito (sin cuenta corriente todavía)                        |
| Proveedores     | `PRV-0001`        | Contacto y condiciones de pago                                                                      |
| Unidades        | código libre      | Dimensión, base y factor inmutables; probador de conversión                                         |
| Categorías      | —                 | Una sola tabla con tipo (materia prima o producto)                                                  |
| Materias primas | `MP-0001`         | Categoría, unidad base, stock mínimo, proveedor preferido y costo de referencia opcional            |
| Productos       | `PRD-0001`        | Categoría, unidad de venta, precio y la marca "controla stock"                                      |
| Depósitos       | `DEP-0001`        | Cada empresa nueva nace con "Depósito Principal"                                                    |

Los códigos se generan por empresa (`code_sequences`) o se cargan a mano. Si el código ya existe,
la API devuelve `409 CODE_TAKEN`.

## Roles y permisos

- Hay 37 permisos con formato `modulo.accion` y 7 roles de sistema: ADMIN, OWNER, ADMINISTRATION,
  SALES, PURCHASING, PRODUCTION y WAREHOUSE.
- La matriz completa está en `docs/PERMISSIONS.md`. Se genera desde el código con
  `pnpm docs:permissions`, y un test falla si el documento queda desactualizado.
- El código nunca pregunta "¿es ADMIN?". Cada endpoint declara el permiso que exige
  (`requirePermission`), y la web decide qué mostrar con `useCan`.

## Company Membership: User → Company → Role → Permission

1. Un **User** es una identidad global: email, contraseña Argon2id y nombre.
   - No pertenece a ninguna empresa por sí mismo.
2. Una **CompanyMembership** une un usuario con una **Company**.
   - Tiene su propio estado (activa o inactiva) y, opcionalmente, el empleado que representa en esa empresa.
3. Cada membresía tiene uno o más **Roles** de esa empresa (`membership_roles`).
   - La FK compuesta garantiza que el rol sea de la misma empresa.
4. Cada **Role** tiene **Permissions** (`role_permissions`).
   - Los permisos efectivos son la unión de los permisos de todos los roles de la membresía.
5. Al iniciar sesión se elige la membresía activa y la sesión guarda `company_id`.
   - Todo request toma `companyId` **sólo de la sesión**. Un `companyId` enviado en el body o en la
     query se ignora, y hay tests que lo verifican.
   - Desactivar un usuario o su membresía corta sus sesiones.

Hoy hay un solo selector implícito: cada usuario tiene una membresía. El modelo ya soporta varias
empresas por usuario, pero falta el selector en la UI (ver Deuda).

## Aislamiento

`apps/api/test/integration/tenancy.test.ts` tiene 26 tests con Empresa A ("Panadería Test") y
Empresa B ("Panadería Otra"). Todos están en verde y verifican que:

- los listados de A nunca muestran filas de B, en todos los maestros;
- GET, PATCH, activar y desactivar con un id de B devuelven 404 y no modifican nada;
- referenciar una categoría, unidad o proveedor de B al crear o editar en A devuelve `422 INVALID_REFERENCE`;
- un `companyId` en el body o en la query se ignora;
- la auditoría de A no incluye eventos de B, y los códigos se numeran por separado en cada empresa;
- la base rechaza las referencias cruzadas aunque se salteara la API (FKs compuestas).

## API

Todos los endpoints están bajo `/api` y exigen sesión, un Origin válido y un permiso.

- **Maestros** (`customers`, `suppliers`, `employees`, `users`, `units`, `categories`, `raw-materials`, `products`, `warehouses`):
  - `GET /x` lista con `search`, `status` (active, inactive o all) y paginación (`pageSize` ≤ 100).
  - `GET /x/:id`, `POST /x` y `PATCH /x/:id`.
  - `POST /x/:id/deactivate` y `/activate`.
- **Empresa:** `GET/PATCH /company`.
- **Roles:**
  - `GET /roles`, `GET /roles/:id` y `GET /permissions`.
  - `PUT /users/:id/roles` asigna los roles de un usuario.
- **Unidades:** `GET /units/convert?from&to&quantity`.
- **Auditoría:** `GET /audit-logs`, con filtros `entityType` y `entityId` para ver el historial de un registro.

Los códigos de error son estables:

- `VALIDATION_ERROR` (con errores por campo) y `NOT_FOUND`;
- `CODE_TAKEN`, `EMAIL_TAKEN` y `DOCUMENT_TAKEN`;
- `INVALID_REFERENCE`, `INVALID_UNIT_DEFINITION` e `INCOMPATIBLE_UNITS`;
- `EMPLOYEE_ALREADY_LINKED`, `EMPLOYEE_INACTIVE` y `CANNOT_MODIFY_SELF`.

## UI

- **Comercial:** Clientes y Proveedores.
- **Producción:** Materias primas y Productos.
- **Equipo:** Empleados y Usuarios.
- **Configuración:** Empresa, Unidades, Categorías, Depósitos y Roles (matriz de sólo lectura).
- **Sistema:** Auditoría.
- **Inicio:** actividad reciente.

Cada maestro tiene listado con búsqueda y filtros sincronizados en la URL, alta, detalle con
historial de auditoría, edición y activar/desactivar con confirmación. Los errores de la API se
muestran junto al campo que los causó.

En la revisión manual se recorrieron todas las pantallas a 1440×900, 1366×768 y 768×1024. Se
corrigieron estos problemas:

- desbordes horizontales en Usuarios y en la matriz de Roles a 768 px;
- campos de formulario desalineados en altura;
- enlaces azules en los detalles;
- falta de favicon (daba un 404 en consola).

La verificación final dio sin desbordes y sin errores ni warnings de consola en las tres resoluciones.

## Auditoría

Cada alta, edición, desactivación y reactivación escribe su evento **en la misma transacción**. Las
ediciones guardan un diff de los campos cambiados, y los datos sensibles nunca se registran.

Eventos nuevos:

- `COMPANY_UPDATED`;
- `EMPLOYEE_*`, `USER_*` y `USER_ROLE_CHANGED`;
- `CUSTOMER_*`, `SUPPLIER_*`, `RAW_MATERIAL_*`, `PRODUCT_*` y `WAREHOUSE_*`;
- `UNIT_CREATED/UPDATED` y `CATEGORY_CREATED/UPDATED`.

Las acciones terminadas en `*` incluyen CREATED, UPDATED, DEACTIVATED y REACTIVATED.

`audit_logs` sigue siendo append-only (trigger de Fase 0).

## Tests

| Suite                                | Archivos | Tests                                |
| ------------------------------------ | -------- | ------------------------------------ |
| Unit — packages/domain               | 2        | 16                                   |
| Unit — packages/shared               | 3        | 21                                   |
| Unit — packages/database (schema)    | 1        | 5                                    |
| Unit — apps/web                      | 1        | 11                                   |
| Unit — apps/api                      | 4        | 12                                   |
| Integración — auth                   | 1        | 15                                   |
| Integración — autorización           | 1        | 9 (matriz de 7 roles × 51 endpoints) |
| Integración — maestros               | 1        | 25                                   |
| Integración — personas/empresa/roles | 1        | 22                                   |
| Integración — tenancy A/B            | 1        | 26                                   |
| Integración — unidades               | 1        | 8                                    |
| Integración — base/permisos/health   | 3        | 14                                   |
| E2E (Playwright, desktop + tablet)   | 2        | 14 (7 × 2)                           |

El total es de 184 tests de unit e integración y 14 E2E, todos en verde.

El E2E `fase1-maestros.spec.ts` recorre los 19 pasos del flujo:

1. Configura la empresa.
2. Crea un empleado y le da acceso con un rol.
3. Crea un cliente, un proveedor, una unidad con conversión, categorías, una materia prima, un producto y un depósito.
4. Busca, edita, desactiva y reactiva.
5. Revisa la auditoría.
6. Inicia sesión con el usuario nuevo y comprueba que su menú y sus accesos respetan el rol.

Además falla si aparece cualquier error de consola; sólo se permiten el 422 buscado de
conversión inválida y el 403 buscado del rol sin permiso. Un segundo test verifica que no se
ve ningún UUID en pantalla.

## Gates

Todos se corrieron en un **clon limpio** de la rama, con base vacía.

| Gate              | Resultado                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| A — Database      | ✅ `db:reset` desde cero, migraciones 0000–0004 y seed; 18 tablas; el test de schema está en verde |
| B — Unit          | ✅ 65/65                                                                                           |
| C — Integration   | ✅ 119/119                                                                                         |
| D — Tenancy       | ✅ 26/26 (Empresa A / Empresa B)                                                                   |
| E — Authorization | ✅ Matriz de 7 roles × 51 endpoints más la cobertura del catálogo                                  |
| F — E2E           | ✅ 14/14 (flujo de 19 pasos y smoke, en desktop y tablet), build de producción                     |
| G — UI manual     | ✅ 1440×900, 1366×768 y 768; sin desbordes ni errores de consola                                   |
| H — Static        | ✅ lint (ESLint + Prettier) y typecheck con 0 errores                                              |
| I — Build         | ✅ `pnpm build` (web y api)                                                                        |
| J — Worktree      | ✅ limpio                                                                                          |
| CI remoto         | ✅ job `verify` en verde sobre `48a105e` (run 36790720062)                                         |

Hallazgo en los gates: el E2E en modo CI chocaba con el **rate limit de login** (10 por minuto,
control de seguridad de Fase 0), porque la suite ahora inicia sesión muchas más veces. El límite
de producción no cambió. Sólo el servidor que levanta Playwright usa
`LOGIN_RATE_LIMIT_PER_MINUTE=200`, y el test de integración de auth sigue probando el bloqueo.

## Riesgos

- **Migración 0002/0003 sobre datos reales:** convierte los usuarios de Fase 0 en membresías. Está
  probada sobre la base con seed, pero conviene hacer un backup antes de aplicarla en un entorno
  con datos.
- **Búsqueda con `ILIKE`** sin índice trigram: alcanza para miles de filas, pero no para cientos de miles.
- **Selectores de la UI limitados a 100 opciones** (por ejemplo, categorías o proveedores en el
  formulario de materias primas). Con más datos va a hacer falta un combo con búsqueda.

## Deuda

- No hay cambio ni recuperación de contraseña. Un administrador crea la contraseña inicial.
- No hay selector de empresa: un email que ya existe no puede sumarse a otra empresa desde la UI.
- La edición de roles personalizados está diferida. Por ahora sólo existen los 7 roles de sistema.
- La lista de precios está diferida a Fase 5. Hoy cada producto tiene un único precio.
- La base de desarrollo acumula los datos de cada corrida del E2E (usan sufijos únicos). Se limpia con `pnpm db:reset`.
- `next dev` regenera `apps/web/AGENTS.md` y `CLAUDE.md`. Quedan versionados para no ensuciar el worktree.

## Decisiones

Las nuevas ADR están en `docs/DECISIONS.md`:

- **ADR-015:** membresía usuario ↔ empresa. Corrige ADR-008, que ataba el usuario a una sola empresa.
- **ADR-016:** tenancy reforzada por la base con FKs compuestas `(company_id, id)`.
- **ADR-017:** `decimal.js` para la aritmética de dominio. Se adelantó de Fase 2 por las conversiones.
- **ADR-018:** unidades por empresa, con dimensión, base y factor inmutables.
- **ADR-019:** códigos internos por empresa con una tabla de secuencias.
- **ADR-020:** categorías en una sola tabla y lista de precios diferida.

## Cambios respecto del plan

- El plan preveía las migraciones 0002 y 0003. Quedaron en tres (0002, 0003 y 0004) para separar
  la membresía, la eliminación del modelo viejo y los maestros.
- Se agregó la pantalla **Sistema → Auditoría**, que no estaba en el plan. Hacía falta para cumplir
  "ver evidencia de auditoría".
- Se sumaron el script `pnpm company:create` (alta de una empresa real con su administrador) y
  `pnpm docs:permissions`.
- Se ajustó el límite de login del servidor de E2E (ver Gates).

## Próximo paso

**FASE 2 — RECETAS + COSTO TEÓRICO.** No se comenzó. Espera la aceptación humana de esta fase.
