# Bakery ERP

ERP vertical para panificadoras: proveedores → compras → materias primas → stock → recetas →
producción → productos → ventas → clientes → cobros. Monolito modular en TypeScript.

> Estado: **Fase 1 (maestros)**, pendiente de aceptación. Además de la fundación (autenticación,
> roles y permisos, auditoría, shell), existen empresa, empleados, usuarios con membresía por
> empresa, clientes, proveedores, unidades de medida, categorías, materias primas, productos y
> depósitos. Recetas, compras, stock, producción y ventas llegan en fases siguientes (ver
> [docs/ROADMAP.md](docs/ROADMAP.md)).

## Requisitos

- Node.js 22.12 o superior (`.nvmrc`)
- pnpm 10 (`corepack enable` lo activa según `packageManager`)
- Docker con Docker Compose v2 (para PostgreSQL 16)

## Arranque desde cero

```bash
pnpm install
pnpm dev
```

`pnpm dev` hace todo lo necesario y es idempotente:

1. crea `.env` desde `.env.example` si no existe;
2. levanta PostgreSQL con Docker Compose y espera a que esté sano;
3. aplica las migraciones versionadas;
4. ejecuta el seed de desarrollo (empresa demo con roles, unidades y depósito, usuario admin y
   maestros de ejemplo);
5. inicia la API (http://127.0.0.1:4000) y la web (http://localhost:3000).

Ingresar en http://localhost:3000 con:

| Email                      | Contraseña  |
| -------------------------- | ----------- |
| `admin@panificadora.local` | `admin1234` |

Credenciales **solo de desarrollo** (configurables en `.env` con `SEED_ADMIN_EMAIL` /
`SEED_ADMIN_PASSWORD`). El seed se niega a correr con `NODE_ENV=production`.

## Comandos

| Comando                                    | Qué hace                                                             |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `pnpm install`                             | Instala dependencias del monorepo                                    |
| `pnpm dev`                                 | Setup completo + API y web en modo desarrollo                        |
| `pnpm bootstrap`                           | Solo preparación: `.env`, base, migraciones y seed                   |
| `pnpm test`                                | Tests unitarios e integración (crea y migra `bakery_erp_test`)       |
| `pnpm test:e2e`                            | Build + smoke E2E con Playwright (requiere `pnpm bootstrap` previo)  |
| `pnpm lint`                                | ESLint + Prettier (check)                                            |
| `pnpm typecheck`                           | TypeScript estricto en todos los paquetes                            |
| `pnpm build`                               | Build de producción de API y web                                     |
| `pnpm format`                              | Aplica Prettier                                                      |
| `pnpm db:up` / `db:down`                   | Levanta / detiene PostgreSQL                                         |
| `pnpm db:reset`                            | **Borra el volumen** y recrea la base desde migraciones + seed       |
| `pnpm db:migrate`                          | Aplica migraciones pendientes                                        |
| `pnpm db:generate`                         | Genera una nueva migración a partir de cambios en el esquema         |
| `pnpm db:seed`                             | Seed de desarrollo (idempotente)                                     |
| `pnpm db:sync-reference`                   | Sincroniza permisos y roles de sistema (válido en cualquier entorno) |
| `pnpm docs:permissions`                    | Regenera la matriz de `docs/PERMISSIONS.md` desde el código          |
| `pnpm --filter @bakery/api company:create` | Alta de empresa + primer admin (producción; ver abajo)               |

## Alta de una empresa real

No hay registro público de empresas. El primer administrador se crea por línea de comandos (la
contraseña va por variable de entorno para no quedar en el historial y nunca se imprime):

```bash
COMPANY_LEGAL_NAME="Panadería Ejemplo S.R.L." COMPANY_TRADE_NAME="Panadería Ejemplo" \
ADMIN_EMAIL="duenio@ejemplo.com" ADMIN_NAME="Nombre Apellido" ADMIN_PASSWORD="…" \
pnpm --filter @bakery/api company:create
```

La empresa nace con los 7 roles de sistema, las unidades estándar y el Depósito Principal. El resto
de los usuarios se crea desde **Equipo → Usuarios**.

## Estructura

```
bakery-erp/
├── apps/
│   ├── api/            API HTTP (Fastify) — monolito modular
│   └── web/            Aplicación web (Next.js, App Router)
├── packages/
│   ├── shared/         Contratos compartidos: permisos, roles, esquemas zod, DTOs
│   ├── domain/         Reglas puras de dominio (conversión de unidades, códigos) con decimal.js
│   └── database/       Esquema Drizzle, migraciones SQL versionadas, datos de referencia
├── e2e/                Tests Playwright (smoke + flujo de maestros)
├── infra/              docker-compose de desarrollo
├── scripts/            Utilidades del repo
└── docs/               Producto, arquitectura, dominio, base, roadmap, testing, decisiones
```

## Documentación

- [PRODUCT](docs/PRODUCT.md) — visión y alcance
- [ARCHITECTURE](docs/ARCHITECTURE.md) — cómo está construido
- [DOMAIN_MODEL](docs/DOMAIN_MODEL.md) — entidades y relaciones (actuales y previstas)
- [DATABASE](docs/DATABASE.md) — esquema y migraciones
- [ROADMAP](docs/ROADMAP.md) — Fase 0 → Fase 9
- [TESTING](docs/TESTING.md) — estrategia y cómo correr los tests
- [DECISIONS](docs/DECISIONS.md) — registro de decisiones de arquitectura
- [PERMISSIONS](docs/PERMISSIONS.md) — matriz permiso → rol y endpoints por permiso
- Reportes de fase: [docs/reports/](docs/reports/)

## Puertos

| Servicio   | Puerto | Nota                                                   |
| ---------- | ------ | ------------------------------------------------------ |
| Web        | 3000   | Reenvía `/api/*` a la API (misma cookie, mismo origen) |
| API        | 4000   | Escucha en 127.0.0.1                                   |
| PostgreSQL | 5433   | 5433 en el host para no chocar con un Postgres local   |
