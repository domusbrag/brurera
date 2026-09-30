# Bakery ERP

ERP vertical para panificadoras: proveedores → compras → materias primas → stock → recetas →
producción → productos → ventas → clientes → cobros. Monolito modular en TypeScript.

> Estado: **Fase 0 (fundación)**. Solo existen autenticación, roles/permisos, auditoría, health y
> el shell de la aplicación. Los módulos de negocio se agregan por fases (ver
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
4. ejecuta el seed de desarrollo (empresa demo, permisos, roles y usuario admin);
5. inicia la API (http://127.0.0.1:4000) y la web (http://localhost:3000).

Ingresar en http://localhost:3000 con:

| Email                      | Contraseña  |
| -------------------------- | ----------- |
| `admin@panificadora.local` | `admin1234` |

Credenciales **solo de desarrollo** (configurables en `.env` con `SEED_ADMIN_EMAIL` /
`SEED_ADMIN_PASSWORD`). El seed se niega a correr con `NODE_ENV=production`.

## Comandos

| Comando                  | Qué hace                                                             |
| ------------------------ | -------------------------------------------------------------------- |
| `pnpm install`           | Instala dependencias del monorepo                                    |
| `pnpm dev`               | Setup completo + API y web en modo desarrollo                        |
| `pnpm bootstrap`         | Solo preparación: `.env`, base, migraciones y seed                   |
| `pnpm test`              | Tests unitarios e integración (crea y migra `bakery_erp_test`)       |
| `pnpm test:e2e`          | Build + smoke E2E con Playwright (requiere `pnpm bootstrap` previo)  |
| `pnpm lint`              | ESLint + Prettier (check)                                            |
| `pnpm typecheck`         | TypeScript estricto en todos los paquetes                            |
| `pnpm build`             | Build de producción de API y web                                     |
| `pnpm format`            | Aplica Prettier                                                      |
| `pnpm db:up` / `db:down` | Levanta / detiene PostgreSQL                                         |
| `pnpm db:reset`          | **Borra el volumen** y recrea la base desde migraciones + seed       |
| `pnpm db:migrate`        | Aplica migraciones pendientes                                        |
| `pnpm db:generate`       | Genera una nueva migración a partir de cambios en el esquema         |
| `pnpm db:seed`           | Seed de desarrollo (idempotente)                                     |
| `pnpm db:sync-reference` | Sincroniza permisos y roles de sistema (válido en cualquier entorno) |

## Estructura

```
bakery-erp/
├── apps/
│   ├── api/            API HTTP (Fastify) — monolito modular
│   └── web/            Aplicación web (Next.js, App Router)
├── packages/
│   ├── shared/         Contratos compartidos: permisos, roles, esquemas de validación
│   └── database/       Esquema Drizzle, migraciones SQL versionadas, datos de referencia
├── e2e/                Smoke tests Playwright
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

## Puertos

| Servicio   | Puerto | Nota                                                   |
| ---------- | ------ | ------------------------------------------------------ |
| Web        | 3000   | Reenvía `/api/*` a la API (misma cookie, mismo origen) |
| API        | 4000   | Escucha en 127.0.0.1                                   |
| PostgreSQL | 5433   | 5433 en el host para no chocar con un Postgres local   |
