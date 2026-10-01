# FASE_2_IMPLEMENTATION_PLAN — Recetas + costo teórico

Base: rama `fase-2-recetas-costos`, creada desde `26f25ce` (= commit aceptado de Fase 1 `48a105e`
más el cierre documental del reporte de Fase 1; sin cambios de código). CI de Fase 1 verde
(run 36790720062).

## Inspección (estado de partida)

- `raw_materials.current_cost numeric(18,6)` opcional: costo por unidad base, sin procedencia ni
  permiso propio; se edita junto con el resto de la materia prima. La unidad base se puede cambiar.
- `products.sale_price numeric(14,2)`, `sale_unit_id`; sin costo (correcto). La unidad de venta se
  puede cambiar.
- `units_of_measure`: raíz + derivadas de un nivel; dimensión/base/factor inmutables (ADR-018).
  `PACKAGING` sin conversión global. `packages/domain` ya tiene `convertQuantity` (decimal.js).
- Tenancy: FKs compuestas `(company_id, id)` (ADR-016). `products` y `raw_materials` todavía no
  tienen `UNIQUE (company_id, id)`: hay que agregarlo para poder referenciarlos así.
- Auditoría append-only por trigger (0001), en la misma transacción que el cambio.
- Permisos: catálogo en `@bakery/shared`, roles de sistema como datos, matriz probada contra la API.
- Menú: "Recetas" ya figura como módulo de Fase 2 (placeholder).

## Modelo

| Tabla                        | Rol                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recipes`                    | Identidad de la receta de un producto. `active`; índice único parcial: una receta activa por producto.                                                                                                          |
| `recipe_versions`            | Formulación: `version_number`, `status` (`DRAFT`/`ACTIVE`/`ARCHIVED`), rendimiento + unidad, merma % opcional, instrucciones, `effective_from` (= publicación), `published_at/by`, `archived_at`, `created_by`. |
| `recipe_ingredients`         | Materia prima, cantidad (`numeric(18,6)`, > 0), unidad, orden, notas.                                                                                                                                           |
| `recipe_cost_snapshots`      | Uno por versión publicada: moneda, estado `COMPLETE`/`INCOMPLETE`, total, rendimiento normalizado a la unidad de venta, costo unitario (null si incompleto).                                                    |
| `recipe_cost_snapshot_lines` | Desglose congelado por ingrediente: nombre/código de MP, cantidad + unidad original, cantidad normalizada + unidad base, costo de referencia, costo del ingrediente, procedencia.                               |

`raw_materials`: `current_cost` → `reference_cost` (renombre), más `reference_cost_source`
(`MANUAL_REFERENCE` | `PURCHASE_MOVING_AVERAGE` | `SUPPLIER_QUOTE` | `OTHER`) y
`reference_cost_updated_at`.

## Migraciones

Una nueva, `0005_recipes`. No se tocan 0000–0004. Incluye:

- renombre de columna + enums + columnas de procedencia;
- `UNIQUE (company_id, id)` en `products` y `raw_materials`;
- tablas nuevas con FKs compuestas por empresa (receta→producto, versión→receta, versión→unidad,
  ingrediente→versión/MP/unidad, snapshot→versión);
- `UNIQUE (recipe_id, version_number)`, índice parcial "una ACTIVE por receta", índice parcial
  "un DRAFT por receta", `UNIQUE (recipe_version_id, raw_material_id)`;
- CHECKs: rendimiento > 0, cantidad > 0, `0 <= merma < 100`, coherencia estado ↔ fechas;
- triggers de inmutabilidad: una versión no-DRAFT sólo admite la transición ACTIVE → ARCHIVED;
  ingredientes de versiones no-DRAFT no se insertan, cambian ni borran; versiones publicadas no se
  borran; snapshots y sus líneas son append-only.

## Invariantes (servicio + base)

ACTIVE/ARCHIVED inmutables · una ACTIVE por receta · todo pertenece a la empresa de la sesión ·
unidad del ingrediente compatible con la unidad base de la MP · unidad del rendimiento compatible
con la unidad de venta · cantidad, rendimiento > 0 · merma en [0,100) · snapshot inmutable ·
publicación en una transacción · costo faltante ≠ 0 · decimales siempre string/Decimal.
Además: no se puede cambiar la unidad base de una MP usada en recetas, ni la unidad de venta de un
producto con receta a una unidad de otra dimensión.

## Versionado

v1 DRAFT → publicar → ACTIVE. "Nueva versión" copia la versión indicada (ingredientes, cantidades,
unidades, rendimiento, merma, instrucciones) a un DRAFT con ids nuevos y sin snapshot. Publicar
v2 archiva v1 y activa v2 en la misma transacción. Un solo DRAFT por receta a la vez. El DRAFT se
edita en el lugar (sin versiones por cada cambio) y se puede descartar. "Vigente en un momento" =
versión con `effective_from <= t < archived_at`.

## Unidades

Sólo conversiones dentro de la misma raíz (ADR-018): kg↔g, l↔ml, unidad↔docena y unidades
derivadas que la empresa definió dentro de una dimensión. `PACKAGING` nunca se convierte a masa,
volumen o cantidad. El packaging por artículo queda diferido.

## Costo

Dominio puro en `packages/domain/src/costing.ts`: `convertQuantity`, `calculateIngredientCost`,
`calculateRecipeCost`, `normalizeRecipeYield`, `calculateUnitCost`, `calculateGrossMargin`,
`diffRecipeVersions`. Sin acceso a DB. Resultado: `status`, `currency`, `totalCost`,
`normalizedYield`, `unitCost`, `ingredients[]`, `missingCosts[]`. Si falta un costo: `INCOMPLETE`,
`totalCost`/`unitCost`/margen = null (nunca 0). El rendimiento declarado es producción útil final:
la merma es informativa y no se aplica al costo.

Precisión: cálculo en decimal.js (40 dígitos significativos), sin redondeos intermedios;
persistencia a 6 decimales (dinero y cantidades de receta), 10 decimales para cantidades
normalizadas; display a 2 decimales para dinero y porcentajes.

Costo del snapshot (al publicar, inmutable) vs costo teórico actual (recalculado con los costos de
referencia de hoy) con variación %.

## API (módulo `recipes`)

`GET/POST /api/recipes`, `GET/PATCH /api/recipes/:id`, `POST /api/recipes/:id/(de)activate`,
`GET/POST /api/recipes/:id/versions`, `GET /api/recipes/:id/current-cost`,
`GET /api/recipes/:id/effective-version?at=`, `GET/PATCH /api/recipe-versions/:id`,
`POST /api/recipe-versions/:id/(publish|duplicate|discard|archive)`,
`GET /api/recipe-versions/:id/cost`, `GET /api/recipe-versions/:id/diff`.
Materias primas: `PUT /api/raw-materials/:id/reference-cost` (permiso propio).

## Permisos

`recipes.read`, `recipes.create`, `recipes.update`, `recipes.publish`, `recipes.archive`,
`raw_materials.update_cost`. ADMIN/OWNER: todos. PRODUCTION: read/create/update (no publica).
ADMINISTRATION: read + update_cost. PURCHASING: update_cost. Publicar y archivar: sólo
ADMIN/OWNER. Documentado en `docs/PERMISSIONS.md` (generado).

## Auditoría

`RECIPE_CREATED`, `RECIPE_UPDATED`, `RECIPE_DEACTIVATED`, `RECIPE_REACTIVATED`,
`RECIPE_VERSION_CREATED`, `RECIPE_VERSION_UPDATED`, `RECIPE_VERSION_PUBLISHED`,
`RECIPE_VERSION_ARCHIVED`, `RECIPE_VERSION_DISCARDED`, `RAW_MATERIAL_REFERENCE_COST_CHANGED`.
Todos con `entityType = recipe` (o `raw_material`) para ver el historial completo de una receta.

## UI

Menú: grupo **Producción → Recetas**. Listado (producto, receta, versión activa, rendimiento, costo
actual, estado de costo, actualización). Alta/edición de borrador con selector de producto,
rendimiento, merma, tabla de ingredientes y costo en vivo (mismas funciones de dominio). Detalle
con costo del lote, costo por unidad de venta, precio, margen bruto teórico, costo al publicar vs
actual, historial de versiones y auditoría. Versión histórica en sólo lectura con diferencias
contra la anterior. Materia prima: "Costo de referencia $850 / kg" y acción para cambiarlo.
Producto: costo teórico y margen desde la receta.

## Pruebas

Unit (dominio: conversiones, costos, rendimiento, margen, faltantes, diff, decimales), integración
(publicación, snapshot vs actual, versionado, rollback forzado con un trigger de test,
inmutabilidad por API y por SQL directo, tenancy A/B con API y base, matriz de autorización),
E2E (flujo principal de 23 pasos y costo incompleto, desktop y tablet, sin errores de consola).

## Riesgos

- Renombrar `current_cost` rompe el contrato de API de Fase 1 (`currentCost` → `referenceCost`):
  aceptable porque no hay clientes externos; se actualizan web, tests y docs.
- Triggers de inmutabilidad: protegen contra bugs, pero cualquier corrección de datos publicados
  exigirá una migración explícita.
- Unidades "bolsa 25 kg" definidas por la empresa como masa sí convierten (son una definición
  explícita de la empresa, ADR-018); el packaging genérico no.
- Costo del listado calculado al vuelo: suficiente para cientos de recetas, no para miles.
