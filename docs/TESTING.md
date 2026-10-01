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
pnpm docs:permissions  # regenera la matriz de docs/PERMISSIONS.md si cambian roles o permisos
```

Por paquete: `pnpm --filter @bakery/api test:unit`, `pnpm --filter @bakery/api test:integration`.

La base de test se crea y migra automáticamente (`apps/api/test/integration/global-setup.ts`).
Cada archivo de integración trunca las tablas y carga una fixture propia: Empresa A ("Panadería
Test", aprovisionada con roles, unidades y depósito) con un ADMIN y un usuario de VENTAS, y
Empresa B ("Panadería Otra") con su ADMIN para las pruebas de aislamiento. Los archivos corren en serie. Protección: los tests se
niegan a correr si `DATABASE_URL_TEST` no apunta a una base terminada en `_test`.

Playwright usa el Chromium del sistema si `PLAYWRIGHT_CHROMIUM_EXECUTABLE` está definido; si no,
el de `playwright install chromium`. Corre en dos viewports: desktop y tablet (820×1180).

## Cobertura de Fase 2

| Suite             | Archivo(s)                                  | Tests | Qué cubre                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain (unit)     | `packages/domain/test/costing.test.ts`      |    36 | Ejemplos de la especificación (750 g → 0,750 kg; $8.200 / 10 kg = $820/kg; margen $380 = 31,666…%), costo incompleto sin cero implícito, merma no aplicada dos veces, sin redondeo por ingrediente, PACKAGING no convertible, validación, diff, vigencia, escalas |
| shared (unit)     | `packages/shared/test/recipes.test.ts`      |     7 | Esquemas zod: cantidad > 0 con hasta 6 decimales, rendimiento > 0, merma 0 ≤ x < 100, confirmación de costo incompleto, costo de referencia                                                                                                                       |
| shared (unit)     | `packages/shared/test/permissions.test.ts`  |    11 | Incluye la matriz de Fase 2 (quién publica, quién cambia costos)                                                                                                                                                                                                  |
| web (unit)        | `apps/web/test/{format,navigation}.test.ts` |    17 | Formato de dinero HALF_UP, costo por unidad, costo de referencia sin redondear, porcentajes, cantidades; Producción → Recetas en el menú                                                                                                                          |
| api (integración) | `recipes.test.ts`                           |    41 | Publicación con snapshot, cambio de costo sin tocar el snapshot, versionado (duplicar, un borrador, diff, archivar), rollback de la publicación, inmutabilidad por API y por triggers, unidades, costo incompleto, borradores, permisos de Producción             |
| api (integración) | `recipes-invariants.test.ts`                |    10 | Cantidad > 0, rendimiento > 0 y merma válida, en la API (400) y en la base (CHECK)                                                                                                                                                                                |
| api (integración) | `recipes-tenancy.test.ts`                   |     7 | Empresa A/B: materia prima, unidad o producto ajenos (422), lectura y modificación ajenas (404), copia de versión ajena, FKs compuestas en la base                                                                                                                |
| api (integración) | `authorization.test.ts`, `masters.test.ts`  |       | Endpoints de recetas y `PUT /raw-materials/:id/reference-cost` en la matriz rol × endpoint; costo de referencia auditado                                                                                                                                          |
| E2E               | `e2e/fase2-recetas.spec.ts`                 |     2 | Flujo de 23 pasos (materias primas y costos → producto → receta → costo → borrador → publicar → cambiar costo → snapshot intacto y costo actual → v2 → v1 archivada → auditoría) y costo incompleto (sin $0, sin margen, publicación con confirmación explícita)  |

### Invariantes de Fase 2 → tests

| #   | Invariante                                              | Dónde                                                                                 |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | ACTIVE es inmutable                                     | `recipes.test.ts` › inmutabilidad por API y en la base (triggers)                     |
| 2   | ARCHIVED es inmutable                                   | ídem                                                                                  |
| 3   | Una sola versión ACTIVE por receta                      | `recipes.test.ts` › publicar v2 archiva v1; la base impide dos ACTIVE                 |
| 4–6 | Ingrediente, materia prima y unidad de la misma empresa | `recipes-tenancy.test.ts` (API 422 y FKs compuestas en la base)                       |
| 7   | Unidad compatible con la unidad base                    | `costing.test.ts`, `recipes.test.ts` › unidades y rendimiento                         |
| 8   | Rendimiento compatible con unidad de venta              | ídem                                                                                  |
| 9   | Cantidad > 0                                            | `recipes-invariants.test.ts`, `costing.test.ts`, `shared/recipes.test.ts`             |
| 10  | Rendimiento > 0                                         | ídem                                                                                  |
| 11  | Merma válida                                            | ídem                                                                                  |
| 12  | El snapshot no cambia con el costo                      | `recipes.test.ts` › cambiar la harina a $1.000/kg; E2E pasos 15–17                    |
| 13  | Publicar es transaccional                               | `recipes.test.ts` › rollback de la publicación                                        |
| 14  | Costo incompleto sin cero implícito                     | `costing.test.ts`, `recipes.test.ts` › costo incompleto, E2E de costo incompleto      |
| 15  | Dinero y cantidades sin float                           | `database/schema.test.ts` (sin `real`/`double`), `costing.test.ts` › política decimal |
| 16  | Aislamiento por empresa                                 | `recipes-tenancy.test.ts`                                                             |

## Cobertura de Fase 1

| Suite             | Archivo(s)                                     | Qué cubre                                                                                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| domain (unit)     | `packages/domain/test/{units,codes}.test.ts`   | Conversión exacta con decimal.js, masa↔volumen rechazado, definición de unidades derivadas, formato y normalización de códigos                                                                                                                                                                                     |
| shared (unit)     | `packages/shared/test/masters.test.ts`         | Validaciones zod (decimales, códigos, fechas, zona horaria, contraseña, edición sin cambios), permisos efectivos                                                                                                                                                                                                   |
| shared (doc)      | `packages/shared/test/permissions-doc.test.ts` | `docs/PERMISSIONS.md` coincide con `SYSTEM_ROLES`                                                                                                                                                                                                                                                                  |
| database (unit)   | `packages/database/test/schema.test.ts`        | Tablas esperadas, sin float, sin columna de stock, `company_id` en toda tabla de negocio, `timestamptz`                                                                                                                                                                                                            |
| api (unit)        | `apps/api/test/unit/audit-diff.test.ts`        | Diff de auditoría sin secretos, "hoy" en la zona de la empresa, escape de LIKE                                                                                                                                                                                                                                     |
| api (integración) | `masters.test.ts`                              | Clientes, proveedores, depósitos, categorías, materias primas y productos: códigos automáticos/manuales, duplicados, búsqueda, paginación, edición, desactivación sin borrado, referencias inválidas, auditoría                                                                                                    |
| api (integración) | `people.test.ts`                               | Empresa; empleados (legajo, documento único, baja con fecha); usuarios (alta con empleado, roles, permisos efectivos, login rechazado tras desactivar, baja de empleado desactiva su acceso, no auto-modificación); roles                                                                                          |
| api (integración) | `units.test.ts`                                | Unidades estándar, conversiones válidas e incompatibles, unidades derivadas, inmutabilidad de la conversión                                                                                                                                                                                                        |
| api (integración) | `tenancy.test.ts`                              | Empresa A/B: leer, modificar, desactivar, inferir por búsqueda y referenciar datos ajenos (9 entidades), `companyId` enviado se ignora, auditoría separada, FK compuesta en la base                                                                                                                                |
| api (integración) | `authorization.test.ts`                        | Matriz rol × endpoint contra la API real (7 roles × 51 endpoints) y ausencia de chequeos por código de rol                                                                                                                                                                                                         |
| E2E               | `e2e/fase1-maestros.spec.ts`                   | Flujo de 19 pasos (login → empresa → empleado → acceso → rol → cliente → proveedor → unidad → categorías → materia prima → producto → depósito → buscar → editar → desactivar → auditoría → logout), login del usuario creado con menú según sus roles, sin errores de consola; ningún UUID visible en la interfaz |

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
