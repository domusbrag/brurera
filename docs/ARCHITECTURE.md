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
                         └──▶ packages/shared (permisos, roles, esquemas zod)
```

## Componentes

### apps/api — backend

- **Fastify 5** + TypeScript estricto. `src/app.ts` arma la aplicación a partir de dependencias
  explícitas (`config`, `db`), lo que permite tests de integración con `app.inject()` sin red.
- **Módulos** en `src/modules/<módulo>/`: rutas (`*.routes.ts`), servicios de aplicación
  (`*.service.ts`) y plugins. En Fase 0: `health`, `auth`, `audit`. Los módulos futuros siguen la
  lista de la especificación (§30): `users`, `employees`, `customers`, `suppliers`, `catalog`,
  `products`, `raw-materials`, `units`, `recipes`, `inventory`, `purchases`, `production`, `sales`,
  `billing`, `customer-accounts`, `supplier-accounts`, `cash`, `expenses`, `reports`, `settings`.
- **Regla de dependencias:** rutas → servicios → base de datos. Un módulo solo usa otro a través
  de su servicio exportado; nunca importa sus rutas. `audit` es un módulo hoja que cualquiera
  puede usar. Sin dependencias circulares.
- **Lógica de dominio** (costeo, conversiones, máquinas de estado) irá en funciones puras dentro
  del módulo correspondiente (o en `packages/domain` cuando sea compartida), testeadas en unit
  tests. Nunca en rutas ni en componentes visuales.
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

### packages/shared

Contratos entre API y web sin dependencias de servidor: catálogo de permisos, roles de sistema,
esquema de login, tipos de usuario actual y paginación. Es la fuente de verdad de los códigos de
permiso.

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
- Dinero, costos y cantidades comerciales: `numeric(p, s)` en PostgreSQL; en TypeScript se
  manejarán como string/decimal (librería decimal a elegir en Fase 2/3 junto con el primer cálculo
  de costos). Hay un test que falla si aparece una columna `real`/`double precision`.

## Qué NO se hace (deliberadamente)

Microservicios, event sourcing, CQRS, Kubernetes, colas, cachés distribuidas, BI avanzado, IA.
