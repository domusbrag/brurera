# Bakery ERP

ERP vertical para panificadoras: proveedores → compras → materias primas → stock → recetas →
producción → productos → ventas → clientes → cobros. Monolito modular en TypeScript.

> Estado: **Fase 5A (pedidos, demanda comprometida y necesidades)**, pendiente de aceptación.
> Sobre la fundación, los maestros, las recetas con costo teórico, las compras e inventario, la
> producción y los lotes con conservación y vida útil (Fases 0 a 4.5), existen pedidos de
> clientes para una fecha y hora: muestran qué stock sirve para esa fecha, qué ya está
> comprometido y qué falta producir; al confirmarse reservan lotes por FEFO (sin mover stock),
> registran la producción necesaria con la receta fijada y proyectan la materia prima. Necesidades
> agrega la demanda de todos los pedidos. Ventas, cobros y finanzas llegan en fases siguientes (ver
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

### Actualizar una base existente

Cada fase agrega migraciones y permisos nuevos (Fase 3: tablas de compras e inventario y los
permisos `purchases.*`, `inventory.*` y `presentations.*`; Fase 4: migración `0007_production` y
los permisos `production_orders.*` y `production.cost.read`; Fase 4.5: `0008_product_lots` y
`product_lots.*`; Fase 5A: `0009_customer_orders` y los permisos `orders.*`, `order_planning.read`
y `order_production.create`). Después de traer cambios, en una base que ya existía:

```bash
pnpm bootstrap                    # o, con la base ya levantada:
pnpm db:migrate && pnpm db:seed   # migraciones + permisos y roles de sistema de la empresa demo
```

`pnpm dev` hace lo mismo al arrancar. Fuera de desarrollo, `pnpm db:migrate` seguido de
`pnpm db:sync-reference` actualiza estructura, permisos y roles de sistema de todas las empresas,
sin datos demo. Sin este paso, los roles existentes no reciben los permisos nuevos y los módulos
de la fase no aparecen en el menú.

## Comandos

| Comando                                    | Qué hace                                                             |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `pnpm install`                             | Instala dependencias del monorepo                                    |
| `pnpm dev`                                 | Setup completo + API y web en modo desarrollo                        |
| `pnpm bootstrap`                           | Solo preparación: `.env`, base, migraciones y seed                   |
| `pnpm test`                                | Tests unitarios e integración (crea y migra `bakery_erp_test`)       |
| `pnpm test:e2e`                            | Build + E2E con Playwright (requiere `pnpm bootstrap` previo)        |
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
│   ├── domain/         Reglas puras de dominio (unidades, costos, inventario, producción, lotes, pedidos) con decimal.js
│   └── database/       Esquema Drizzle, migraciones SQL versionadas, datos de referencia
├── e2e/                Tests Playwright (smoke, maestros, recetas, compras e inventario, producción, lotes, pedidos)
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
- [UX_BACKLOG](docs/UX_BACKLOG.md) — hallazgos de diseño para el sprint UX/DESIGN OPTIMIZATION
- Reportes de fase: [docs/reports/](docs/reports/)

## Puertos

| Servicio   | Puerto | Nota                                                   |
| ---------- | ------ | ------------------------------------------------------ |
| Web        | 3000   | Reenvía `/api/*` a la API (misma cookie, mismo origen) |
| API        | 4000   | Escucha en 127.0.0.1                                   |
| PostgreSQL | 5433   | 5433 en el host para no chocar con un Postgres local   |
