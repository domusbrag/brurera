# Arquitectura

## Resumen

**Monolito modular** en TypeScript dentro de un monorepo pnpm. Un solo backend (API HTTP), una
aplicación web y una base PostgreSQL. Sin microservicios, sin colas, sin event sourcing.

```
 Navegador ──HTTP──▶ apps/web (Next.js :3000)
                         │  páginas server-side: GET /api/auth/me con la cookie
                         │  rewrite /api/* ─────────────────────────┐
                         ▼                                          ▼
                    apps/api (Fastify :4000) ──▶ packages/database (Drizzle) ──▶ PostgreSQL 16
                         │
                         ├──▶ packages/shared (permisos, roles, esquemas zod, DTOs)
                         └──▶ packages/domain (reglas puras: unidades, códigos; decimal.js)
```

## Componentes

### apps/api — backend

- **Fastify 5** + TypeScript estricto. `src/app.ts` arma la aplicación a partir de dependencias
  explícitas (`config`, `db`), lo que permite tests de integración con `app.inject()` sin red.
- **Módulos** en `src/modules/<módulo>/`: rutas (`*.routes.ts`), servicios de aplicación
  (`*.service.ts`) y plugins. Fase 0: `health`, `auth`, `audit`. Fase 1: `company-settings`,
  `employees`, `users`, `roles`, `customers`, `suppliers`, `units`, `categories`, `raw-materials`,
  `products`, `warehouses`. Fase 2: `recipes` (recetas, versiones, costo teórico, snapshots) y
  `PUT /api/raw-materials/:id/reference-cost`. Los módulos futuros siguen la lista de la especificación (§30).
- **Patrón de maestros:** `GET /api/x?search&status&page&pageSize` (paginado en el servidor,
  `status` = active/inactive/all), `GET /api/x/:id`, `POST /api/x` (201), `PATCH /api/x/:id`,
  `POST /api/x/:id/deactivate` y `/activate`. No hay `DELETE`. Un id de otra empresa responde 404
  como si no existiera; una referencia a otra empresa en un alta, 422 `INVALID_REFERENCE`.
- **Empresa de la operación:** `operationContext(request)` (`src/lib/context.ts`) la toma de la
  sesión (membresía autorizada). Ningún endpoint acepta `companyId` del cliente; si llega, zod lo
  descarta.
- **Códigos de error estables** de Fase 1: `VALIDATION_ERROR`, `NOT_FOUND`, `CODE_TAKEN`,
  `EMAIL_TAKEN`, `DOCUMENT_TAKEN`, `INVALID_REFERENCE`, `INVALID_UNIT_DEFINITION`,
  `INCOMPATIBLE_UNITS`, `EMPLOYEE_ALREADY_LINKED`, `EMPLOYEE_INACTIVE`, `CANNOT_MODIFY_SELF`.
  Fase 2: `RECIPE_ALREADY_EXISTS`, `DRAFT_ALREADY_EXISTS`, `RECIPE_VERSION_IMMUTABLE`,
  `RECIPE_VERSION_NOT_ACTIVE`, `RECIPE_INACTIVE`, `RECIPE_INVALID` (422 con los problemas),
  `COST_INCOMPLETE_CONFIRMATION_REQUIRED`, `PRODUCT_INACTIVE`, `NO_ACTIVE_VERSION`,
  `NO_EFFECTIVE_VERSION`, `RAW_MATERIAL_IN_USE`, `SALE_UNIT_INCOMPATIBLE_WITH_RECIPE`.
  Las violaciones de unicidad de la base se traducen por nombre de constraint
  (`mapUniqueViolations`).
- **Regla de dependencias:** rutas → servicios → base de datos. Un módulo solo usa otro a través
  de su servicio exportado; nunca importa sus rutas. `audit` es un módulo hoja que cualquiera
  puede usar. Sin dependencias circulares.
- **Lógica de dominio** (costeo, conversiones, máquinas de estado) va en funciones puras dentro
  del módulo correspondiente (o en `packages/domain` cuando sea compartida), testeadas en unit
  tests. Nunca en rutas ni en componentes visuales. El costo teórico de recetas vive en
  `packages/domain/src/costing.ts`; la API lo usa para calcular y guardar snapshots y el editor
  web lo usa para la vista previa en vivo, así que ambos dan exactamente el mismo resultado.
- **Transacciones:** las operaciones de negocio reciben/abren una transacción Drizzle
  (`db.transaction`) y la auditoría se escribe con la misma transacción (ver `recordAudit`).
- **Validación:** toda entrada externa se valida con zod mediante `parseInput()`, que responde
  `400 VALIDATION_ERROR` con el detalle de campos.
- **Errores:** `AppError(status, code, message)` para errores esperados. El error handler central
  traduce a `{ error: { code, message, requestId } }`, registra los 5xx con contexto (ruta,
  usuario, request id) y nunca expone detalles internos.
- **Logs estructurados:** pino (logger de Fastify) en JSON. Redacción de `cookie`,
  `authorization`, `set-cookie` y campos `password`.
- **Correlation id:** cada request tiene `request.id` (se respeta `x-request-id` entrante si es
  válido) y se devuelve en el header `x-request-id`; se persiste en `audit_logs.request_id`.

### apps/web — frontend

- **Next.js 16 (App Router)** + React 19. Desktop-first, responsive (menú lateral colapsable
  bajo 900 px para tablet).
- El navegador **solo habla con el origen web**. `next.config.ts` reescribe `/api/*` hacia la API,
  así la cookie de sesión es same-origin y no hace falta CORS.
- Las páginas autenticadas viven en el grupo `src/app/(app)/`. Su layout consulta
  `GET /api/auth/me` en el servidor en cada request; sin sesión válida redirige a `/login`.
  Esto es solo UX: **la autorización real siempre se valida en la API**.
- La web no contiene lógica de negocio ni secretos; solo presenta datos de la API.
- Las secciones futuras del menú muestran "Disponible en próxima etapa" (sin funcionalidad falsa).
- **Maestros (Fase 1):** componentes cliente genéricos en `src/components/masters/`: `MasterList`
  (búsqueda con demora, filtro de estado y filtros extra sincronizados con la URL, paginación del
  servidor), `EntityForm` (campos declarativos, errores por campo que devuelve la API) y piezas de
  detalle (`Details`, `ActiveToggle` con diálogo de confirmación, `AuditHistory`). Cada maestro
  define sus columnas, campos y detalle en su archivo; las rutas de `src/app/(app)/` solo los montan.
- La validación real la hace la API con los esquemas zod de `@bakery/shared`; la web muestra los
  errores por campo que recibe. Los permisos del usuario (`useCan`) solo ocultan acciones.
- **Recetas (Fase 2):** `src/components/recipes/` — listado, editor (`recipe-editor.tsx`, con
  costo calculado en vivo por `@bakery/domain`), detalle, versión en sólo lectura y piezas de costo
  (`cost-views.tsx`). Navegación: **Producción → Recetas**.
- La interfaz nunca muestra UUIDs ni `companyId` (hay un E2E que lo verifica).

### packages/shared

Contratos entre API y web sin dependencias de servidor: catálogo de permisos, roles de sistema,
esquemas zod de alta/edición de cada maestro, DTOs de respuesta, etiquetas de auditoría y la matriz
de permisos que genera `docs/PERMISSIONS.md`. Es la fuente de verdad de los códigos de permiso.

### packages/domain

Reglas de negocio puras, sin base ni HTTP: conversión de unidades (`convertQuantity`,
`validateDerivedUnit`, unidades estándar), formato de códigos internos y costeo de recetas
(`calculateIngredientCost`, `normalizeRecipeYield`, `calculateUnitCost`, `calculateGrossMargin`,
`calculateCostVariation`, `calculateRecipeCost`, `validateRecipeVersion`, `diffRecipeVersions`,
`findEffectiveVersion`). Usa `decimal.js` para toda aritmética (ADR-017, política en ADR-023).

### packages/database

Esquema Drizzle (`src/schema/`), migraciones SQL versionadas (`migrations/`), cliente
(`createDatabase`), runner de migraciones y sincronización de datos de referencia (permisos y
roles de sistema). Los paquetes internos se consumen como código fuente TypeScript; la API se
empaqueta con tsup para producción.

## Autenticación y seguridad

| Aspecto       | Implementación                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Contraseñas   | Argon2id con `@node-rs/argon2` (parámetros por defecto de la librería). Nunca texto plano.                                          |
| Sesión        | Token aleatorio de 256 bits (`crypto.randomBytes`) en cookie `bakery_session`. En la tabla `sessions` se guarda solo su SHA-256.    |
| Cookie        | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` en producción, expiración = TTL de sesión (12 h por defecto).                        |
| Logout        | Revoca la sesión en el servidor (`revoked_at`); una cookie robada deja de servir.                                                   |
| CSRF          | SameSite=Lax + las requests que modifican estado deben ser JSON (`415` si no) + validación de `Origin` contra `WEB_ORIGIN` (`403`). |
| Enumeración   | Mismo error y tiempo similar (hash dummy) para usuario inexistente, deshabilitado o contraseña incorrecta.                          |
| Rate limiting | `@fastify/rate-limit` en `POST /api/auth/login` (10/min por IP por defecto).                                                        |
| Headers       | `@fastify/helmet` en la API; `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` en la web.                       |
| Autorización  | `requirePermission(...)` por ruta en la API. Permisos efectivos = unión de permisos de los roles del usuario.                       |
| Open redirect | `safeNextPath()` solo acepta rutas internas tras el login.                                                                          |
| Secretos      | Variables de entorno (`.env`, no versionado). El frontend no recibe secretos.                                                       |
| Auditoría     | Login exitoso/fallido y logout quedan en `audit_logs`; la tabla rechaza UPDATE/DELETE por trigger.                                  |

## Configuración

Variables de entorno validadas con zod al arrancar (`apps/api/src/config.ts`); configuración
inválida detiene el proceso con un mensaje claro. Ver `.env.example`.

## Fechas, dinero y cantidades

- Todas las marcas de tiempo son `timestamptz` (UTC). La zona horaria de presentación es la de la
  empresa (`companies.timezone`, por defecto `America/Argentina/Buenos_Aires`).
- Fechas de calendario sin hora (p. ej. fecha de ingreso) usan `date`.
- Dinero, costos y cantidades comerciales: `numeric(p, s)` en PostgreSQL; en TypeScript viajan como
  strings decimales y se operan con `decimal.js` (nunca `number`). Hay un test que falla si
  aparece una columna `real`/`double precision`.
- **Política decimal (Fase 2, ADR-023):** el dominio calcula con precisión 40 y redondeo
  `ROUND_HALF_UP`, **sin redondeos intermedios**. Sólo se redondea al persistir o enviar: dinero y
  costos a 6 decimales (`numeric(20,6)`), cantidades de receta a 6 (`numeric(18,6)`), cantidades
  normalizadas a 10 (`numeric(28,10)`), porcentajes a 4 (`numeric(7,4)`). La UI redondea a 2
  decimales para mostrar dinero (HALF_UP), salvo costos por unidad menores a un centavo y costos de
  referencia, que se muestran tal como se cargaron (hasta 6).

## Qué NO se hace (deliberadamente)

Microservicios, event sourcing, CQRS, Kubernetes, colas, cachés distribuidas, BI avanzado, IA.
