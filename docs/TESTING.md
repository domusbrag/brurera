# Estrategia de testing

## Niveles

| Nivel       | Herramienta                 | Dónde                                       | Base de datos                     |
| ----------- | --------------------------- | ------------------------------------------- | --------------------------------- |
| Unitario    | Vitest                      | `*/test/**/*.test.ts`, `apps/api/test/unit` | No                                |
| Integración | Vitest + `fastify.inject()` | `apps/api/test/integration`                 | PostgreSQL real `bakery_erp_test` |
| E2E / smoke | Playwright (Chromium)       | `e2e/`                                      | Base de desarrollo migrada + seed |

Principios:

- **Lógica de negocio → unit tests** (conversiones, costos, promedio ponderado, recetas, máquinas
  de estado). Funciones puras sin base.
- **Transacciones críticas → integración contra PostgreSQL real**, nunca mocks de base: compras,
  producción (incluido rollback provocado), ventas, cuentas corrientes, caja.
- **Flujos de negocio completos → E2E.**
- **Regresión:** cada bug corregido agrega un test cuando es razonable.
- No se usan mocks como comportamiento productivo.

## Cómo correr

```bash
pnpm db:up          # PostgreSQL debe estar arriba
pnpm test           # unit + integración de todos los paquetes
pnpm test:e2e       # build + Playwright (requiere `pnpm bootstrap` previo: migraciones + seed)
```

Por paquete: `pnpm --filter @bakery/api test:unit`, `pnpm --filter @bakery/api test:integration`.

La base de test se crea y migra automáticamente (`apps/api/test/integration/global-setup.ts`).
Cada archivo de integración trunca las tablas y carga una fixture mínima (empresa, permisos, roles
de sistema, un ADMIN y un usuario de VENTAS). Los archivos corren en serie. Protección: los tests se
niegan a correr si `DATABASE_URL_TEST` no apunta a una base terminada en `_test`.

Playwright usa el Chromium del sistema si `PLAYWRIGHT_CHROMIUM_EXECUTABLE` está definido; si no,
el de `playwright install chromium`. Corre en dos viewports: desktop y tablet (820×1180).

## Cobertura de Fase 0

### packages/shared (unit)

- Catálogo de permisos sin duplicados y con formato `modulo.accion`.
- `hasPermissions` exige todos los requeridos.
- Roles de sistema: exactamente los 7 iniciales, solo referencian permisos existentes; ADMIN/DUEÑO
  tienen todos; VENTAS no tiene `audit.read`.

### packages/database (unit)

- El esquema expone exactamente las 9 tablas fundacionales.
- Ninguna columna usa `real`/`double precision`.
- Todas las marcas de tiempo son `timestamptz`.

### apps/api (unit)

- Tokens de sesión: 256 bits, únicos; hash SHA-256 determinístico.
- Contraseñas: Argon2id, salt distinto por hash, verificación correcta/incorrecta.
- Configuración: rechaza `DATABASE_URL` inválida; múltiples orígenes web.

### apps/api (integración)

- **Health:** 200 con API y DB ok; propagación de `x-request-id`; 503 si la DB no es accesible.
- **DB:** existen exactamente las tablas fundacionales; migraciones registradas; email único sin
  distinguir mayúsculas; empleado sin usuario; FK restrict impide borrar empresa con usuarios;
  `audit_logs` rechaza UPDATE/DELETE.
- **Login válido:** 200, cookie `HttpOnly` + `SameSite=Lax`, respuesta sin secretos, solo el hash
  del token en base, normalización de email.
- **Login inválido:** contraseña incorrecta (401 + auditoría sin la contraseña), usuario
  inexistente (mismo error), payload inválido (400), usuario deshabilitado (401).
- **CSRF:** origen no permitido (403), cuerpo no JSON (415).
- **Rate limit:** 429 al superar el límite.
- **Ruta protegida:** `/api/auth/me` sin sesión (401), cookie inventada (401), con sesión (200),
  logout revoca en servidor y audita, sesión expirada (401).
- **Permisos básicos:** `/api/audit-logs` sin sesión (401), VENTAS (403), ADMIN (200 paginado con
  actor), validación de `pageSize`.

### apps/web (unit)

- Slugs de menú únicos; `findNavItem`; `safeNextPath` contra open redirect.

### E2E smoke (desktop y tablet)

- Health a través del proxy web.
- Ruta protegida sin sesión → `/login`.
- Login inválido muestra error.
- Admin ingresa, ve shell con usuario y roles, actividad reciente real, navega a una sección futura
  ("Disponible en próxima etapa"), sale, y la ruta protegida vuelve a exigir login. **Sin errores de
  consola.**
- Sección inexistente → 404.
