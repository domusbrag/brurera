# Fase 2 — Recetas + costo teórico · Reporte

## Estado

```
FASE_2_STATUS = COMPLETE_PENDING_HUMAN_ACCEPTANCE
```

Todos los gates A–N pasaron en local, y el CI remoto pasó en el PR de Fase 2 (ver "Gates" y "CI"). **Fase 3 no se empezó**: espera la aceptación humana.

## Base commit

- Rama: `fase-2-recetas-costos`. Sale de `26f25ce`, que es el commit aceptado de Fase 1 (`48a105e`) más el cierre formal del reporte de Fase 1 (sólo documentación).
- PR: domusbrag/brurera#2, con base `fase-1-maestros`, porque el PR #1 todavía no está mergeado.
- Fase 1 quedó cerrada con `CI_REMOTE_STATUS = PASS` (run 36790720062 sobre `48a105e`).

## Arquitectura

No hay piezas nuevas en el stack. Se sigue el patrón de Fase 1:

| Capa                | Fase 2                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`   | `costing.ts` con funciones puras de costo, validación, diff y vigencia. `decimal.ts` con la política decimal.                                                                         |
| `packages/database` | Esquema `recipes.ts` y la migración `0005_recipes.sql`, que incluye triggers.                                                                                                         |
| `packages/shared`   | Esquemas zod y DTOs de recetas, permisos nuevos, etiquetas de auditoría.                                                                                                              |
| `apps/api`          | Módulo `recipes` (rutas, servicio y lectura de datos para el costo) y el endpoint de costo de referencia en `raw-materials`.                                                          |
| `apps/web`          | Producción → Recetas: listado, editor con costo en vivo, detalle, versión en sólo lectura y diff. Materias primas muestran el costo de referencia y tienen la acción "Cambiar costo". |

El editor web y la API usan **las mismas funciones** de `@bakery/domain`. Por eso el costo que se ve mientras se edita es exactamente el que la API calcula y guarda.

## Modelo de recetas

- **`Recipe`**: pertenece a un producto (una receta activa por producto) y tiene nombre, descripción, si está activa, y `lastVersionNumber`.
- **`RecipeVersion`**: tiene número, estado, rendimiento y su unidad, y merma teórica en %. También guarda instrucciones, vigencia desde/hasta, quién la publicó y cuándo, cuándo se archivó y quién la creó.
- **`RecipeIngredient`**: materia prima, cantidad, unidad, orden y notas. Cada materia prima aparece una sola vez por versión.
- **`RecipeCostSnapshot`** y **`RecipeCostSnapshotLine`**: guardan el costo congelado al publicar, con su desglose por ingrediente.

El detalle de cada tabla está en [DOMAIN_MODEL](../DOMAIN_MODEL.md#recetas-fase-2-implementado) y [DATABASE](../DATABASE.md).

## Versionado

- **Estados.** `DRAFT → ACTIVE → ARCHIVED`. Una receta tiene como máximo una versión vigente (`ACTIVE`) y un borrador (`DRAFT`), y lo aseguran índices únicos parciales en la base.
- **Publicar.** En una sola transacción, con la receta bloqueada, se hacen estos pasos:
  1. validar la versión;
  2. calcular el costo;
  3. guardar el snapshot y sus líneas;
  4. archivar la versión vigente anterior (auditado);
  5. activar la nueva versión;
  6. auditar la publicación.

  Si algo falla, no queda nada de la publicación. Esto está probado provocando una falla en la auditoría.

- **Nueva versión.** Duplica una versión existente (la vigente u otra) en un nuevo `DRAFT`, con ids nuevos y sin snapshot.
- **Números de versión.** Salen de `recipes.last_version_number`, así que no se reutilizan aunque se descarte un borrador.
- **Inmutabilidad.** Una versión `ACTIVE` o `ARCHIVED` no se edita, no se descarta y no se borra. La API responde 409 `RECIPE_VERSION_IMMUTABLE`, y la base lo impide con triggers: `recipe_versions_guard`, `recipe_ingredients_guard` y snapshots append-only (ADR-021).
- **Otras operaciones.**
  - Archivar la versión vigente sin reemplazo deja la receta sin versión vigente.
  - Desactivar la receta la congela; se puede reactivar.
  - `GET /recipes/:id/effective-version?at=` devuelve la versión vigente en un momento dado.
- **Diferencias entre versiones.** Se muestran ingredientes agregados y quitados, cantidades modificadas, cambios de rendimiento y de merma, y si cambiaron las instrucciones. Las cantidades se comparan normalizadas, así que 0,8 kg y 800 g no cuentan como cambio.

## Unidades

- **Ingredientes.** La unidad de cada ingrediente debe tener la misma raíz que la unidad base de su materia prima. Por ejemplo, gramos para una harina que se maneja en kg; litros para esa harina se rechaza.
- **Rendimiento.** La unidad del rendimiento debe tener la misma raíz que la unidad de venta. Un producto vendido por unidad no puede rendir "kg".
- **Envases.** `PACKAGING` (bolsa, caja) nunca se convierte a masa ni a volumen (ADR-025).
- **Protección de recetas existentes.**
  - No se puede cambiar la unidad base de una materia prima que se usa en recetas: responde 409 `RAW_MATERIAL_IN_USE`.
  - No se puede cambiar la unidad de venta de un producto a una incompatible con el rendimiento de sus recetas: responde 409 `SALE_UNIT_INCOMPATIBLE_WITH_RECIPE`.

## Estrategia de costos

Hay cuatro conceptos de costo distintos, y el sistema no los mezcla:

| Concepto                      | Qué es                                                                                                                                                                | Dónde vive / cómo se obtiene                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **`referenceCost`**           | Costo por **unidad base** de una materia prima, cargado a mano. Origen `MANUAL_REFERENCE`. Es una referencia, no el costo real de compra.                             | `raw_materials.reference_cost`. Se cambia con un permiso propio y cada cambio se audita.        |
| **`snapshotCost`**            | Costo de una versión **calculado y congelado al publicarla**, con los `referenceCost` de ese momento. Guarda costo por ingrediente, lote, unitario y precio de venta. | `recipe_cost_snapshots` + líneas. Append-only: no cambia aunque cambien los costos.             |
| **`currentTheoreticalCost`**  | Costo de la misma composición (inmutable) **recalculado ahora** con los `referenceCost` actuales.                                                                     | Se calcula al pedirlo y no se guarda. La UI lo muestra junto al snapshot con la variación en %. |
| **`futureMovingAverageCost`** | Costo promedio ponderado móvil que saldrá de **compras reales** (origen `PURCHASE_MOVING_AVERAGE`).                                                                   | **No existe todavía.** Llega en Fase 3. El enum de origen ya lo prevé (ADR-024).                |

Ejemplo, recorrido en E2E e integración:

1. Harina a $800/kg. Se publica la v1: 75 kg de harina más 800 g de sal (a $500/kg), con rendimiento de 100 kg. El snapshot queda en **$604/kg**.
2. La harina pasa a $1.000/kg. El snapshot de la v1 sigue en $604/kg. El costo actual es **$754/kg**, una variación de +24,83 %.

**Costo incompleto.** Si a un ingrediente le falta el `referenceCost`:

- el estado es `INCOMPLETE`;
- costo del lote, costo unitario y margen quedan en `null`, nunca en 0;
- la UI dice "Costo teórico incompleto." y lista qué materias primas no tienen costo;
- el listado muestra "Costo incompleto".

Publicar así exige la confirmación explícita `acknowledgeIncompleteCost`. Sin ella, la API responde 409 `COST_INCOMPLETE_CONFIRMATION_REQUIRED`, y la UI pide marcar "Publicar igual, con el costo incompleto".

## Fórmulas

```
cantidad normalizada = cantidad × factor(unidad → unidad base)      (sin redondeo)
costo ingrediente    = cantidad normalizada × referenceCost
costo del lote       = Σ costo ingrediente                          (null si falta alguno)
rendimiento normal.  = rendimiento × factor(unidad rendimiento → unidad de venta)
costo unitario       = costo del lote ÷ rendimiento normalizado
MARGEN BRUTO TEÓRICO = precio de venta − costo unitario
margen %             = margen ÷ precio de venta × 100               (null si el precio es 0)
variación            = (actual − snapshot); % = variación ÷ snapshot × 100 (null si snapshot = 0)
```

La **merma teórica** (0 ≤ x < 100) es informativa. El rendimiento ya es la producción útil, así que la merma no se descuenta otra vez; hay un test que lo verifica.

El "margen bruto teórico" no incluye mano de obra, energía, alquiler, impuestos, merma real ni costos indirectos. La UI lo aclara debajo del resumen.

## Política decimal

- **Cálculo.** `decimal.js` con precisión 40 y `ROUND_HALF_UP` (ADR-023). No hay redondeos intermedios, ni por ingrediente ni por conversión.
- **Persistencia y envío.** Se redondea una sola vez:
  - dinero y costos: 6 decimales, `numeric(20,6)`;
  - cantidades de receta: 6 decimales, `numeric(18,6)`;
  - cantidades normalizadas: 10 decimales, `numeric(28,10)`;
  - porcentajes: 4 decimales, `numeric(7,4)`.

  Los valores viajan como string.

- **Pantalla.**
  - Dinero: 2 decimales, HALF_UP (por ejemplo, $1.111,11).
  - Costos por unidad menores a un centavo: hasta 6 decimales, para no mostrar un engañoso "$0,00".
  - Costos de referencia: se muestran tal como se cargaron (por ejemplo, $850,125 / kg).
  - Porcentajes: 2 decimales (31,67 %).
- **Sin float.** No hay `float` en la base (lo verifica un test del esquema) ni en el dominio.

## Migraciones

| Archivo            | Contenido                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0005_recipes.sql` | Renombra `raw_materials.current_cost` → `reference_cost` y agrega `reference_cost_source` y `reference_cost_updated_at`. Agrega `UNIQUE (company_id, id)` a productos y materias primas. Crea los enums y las 5 tablas de recetas, con FKs compuestas, checks e índices únicos parciales. Crea los triggers de inmutabilidad y append-only. |

**0000–0004 no se modificaron.** La migración se aplicó desde una base vacía (gate A). El cambio de nombre de la columna es un `RENAME` (no se borra y se recrea), así que conserva los costos ya cargados.

## API

Todos los endpoints toman la empresa de la sesión.

| Método y ruta                                                                   | Permiso                     |
| ------------------------------------------------------------------------------- | --------------------------- |
| `GET /api/recipes` (búsqueda, estado, producto, paginado; incluye costo actual) | `recipes.read`              |
| `POST /api/recipes` (receta + borrador v1)                                      | `recipes.create`            |
| `GET /api/recipes/:id`                                                          | `recipes.read`              |
| `PATCH /api/recipes/:id`                                                        | `recipes.update`            |
| `POST /api/recipes/:id/deactivate` · `/activate`                                | `recipes.archive`           |
| `GET /api/recipes/:id/versions`                                                 | `recipes.read`              |
| `POST /api/recipes/:id/versions` (nuevo borrador, opcionalmente copia)          | `recipes.create`            |
| `GET /api/recipes/:id/current-cost`                                             | `recipes.read`              |
| `GET /api/recipes/:id/effective-version?at=`                                    | `recipes.read`              |
| `GET /api/recipe-versions/:id`                                                  | `recipes.read`              |
| `PATCH /api/recipe-versions/:id` (sólo DRAFT)                                   | `recipes.update`            |
| `POST /api/recipe-versions/:id/publish`                                         | `recipes.publish`           |
| `POST /api/recipe-versions/:id/duplicate`                                       | `recipes.create`            |
| `POST /api/recipe-versions/:id/discard` (sólo DRAFT)                            | `recipes.update`            |
| `POST /api/recipe-versions/:id/archive` (sólo ACTIVE)                           | `recipes.archive`           |
| `GET /api/recipe-versions/:id/cost` (snapshot + actual + variación)             | `recipes.read`              |
| `GET /api/recipe-versions/:id/diff?against=`                                    | `recipes.read`              |
| `PUT /api/raw-materials/:id/reference-cost`                                     | `raw_materials.update_cost` |

Los códigos de error nuevos están listados en [ARCHITECTURE](../ARCHITECTURE.md).

## UI

Producción → **Recetas**.

- **Listado.** Columnas: producto, receta, versión vigente, rendimiento, costo teórico actual, estado del costo, actualización y borrador pendiente. En tablet se ocultan las columnas secundarias.
- **Editor.** Tiene cuatro pasos: producto y rendimiento, ingredientes, costo teórico en vivo e instrucciones.
  - La unidad del rendimiento se propone igual a la de venta.
  - Al elegir una materia prima se propone su unidad base, y sólo se ofrecen unidades compatibles.
  - Muestra los errores de cada campo.
- **Detalle de la receta.**
  - Borrador con su costo de hoy.
  - Versión vigente con sus ingredientes valorizados hoy, el costo por unidad actual, el costo al publicar y la variación, el precio, el margen bruto teórico y una aclaración de que no es ganancia neta.
  - Historial de versiones con el costo al publicar de cada una.
  - Historial de auditoría.
  - Acciones: Editar borrador, Publicar, Nueva versión, Desactivar.
- **Versión (sólo lectura).** Datos de la versión, "Costo al publicar" con el desglose congelado, costo teórico actual, cambios respecto de la versión anterior e instrucciones. Si la versión es un borrador, tiene acciones para editar, publicar o descartar; si es la vigente, para archivarla.
- **Materias primas.**
  - Columna y panel "Costo de referencia", con un badge "Sin costo" cuando falta.
  - Diálogo "Cambiar costo".
  - El campo de costo en el alta sólo aparece con permiso.
  - El historial muestra "Costo de referencia: $800,00 / kg → $1.000,00 / kg".
- **Productos.** El aviso dice "El costo no se carga a mano: se calcula desde la receta del producto.", y el detalle muestra el costo teórico de la receta.

## Permisos

Se agregaron estos permisos: `recipes.read`, `recipes.create`, `recipes.update`, `recipes.publish`, `recipes.archive` y `raw_materials.update_cost`. La matriz completa está en [PERMISSIONS](../PERMISSIONS.md), regenerada desde el código.

| Rol            | Fase 2                                                                         |
| -------------- | ------------------------------------------------------------------------------ |
| Admin, Dueño   | Todos.                                                                         |
| Producción     | Ver, crear y editar borradores. **No publica, no archiva y no cambia costos.** |
| Administración | Ver recetas y cambiar costos de referencia.                                    |
| Compras        | Cambiar costos de referencia.                                                  |
| Ventas, otros  | Sin acceso a recetas.                                                          |

Dar de alta una materia prima **con** costo también exige `raw_materials.update_cost`. Sin ese permiso responde 403; esto está probado con un rol propio.

## Auditoría

Todas las acciones se registran en la misma transacción que el cambio, con `entityType = recipe`:

- `RECIPE_CREATED`, `RECIPE_UPDATED`, `RECIPE_DEACTIVATED`, `RECIPE_REACTIVATED`;
- `RECIPE_VERSION_CREATED`, que indica si es copia de otra versión;
- `RECIPE_VERSION_UPDATED`, que indica qué cambió;
- `RECIPE_VERSION_PUBLISHED`, con número de versión, costo y estado del costo;
- `RECIPE_VERSION_ARCHIVED`, que indica qué versión la reemplazó;
- `RECIPE_VERSION_DISCARDED`.

Además se agregó `RAW_MATERIAL_REFERENCE_COST_CHANGED` sobre la materia prima, con el valor anterior y el nuevo, la moneda y la unidad.

## Tests

Todos pasaron sobre una base recién recreada (`pnpm db:reset`):

| Suite                             | Archivos |                                                      Tests |
| --------------------------------- | -------: | ---------------------------------------------------------: |
| `packages/domain` (unit)          |        3 |                                      **52** (36 de costos) |
| `packages/shared` (unit + doc)    |        4 |                                      **31** (7 de recetas) |
| `apps/web` (unit)                 |        2 |                                                     **17** |
| `packages/database` (unit)        |        1 |                                                      **5** |
| `apps/api` unit                   |        4 |                                                     **12** |
| `apps/api` integración            |       12 | **177** (recetas 41, invariantes 10, tenancy de recetas 7) |
| **Total unit + integración**      |   **26** |                                                    **294** |
| E2E Playwright (desktop + tablet) |        3 |                       **18** (9 por viewport; 4 de Fase 2) |

La tabla que relaciona las invariantes 1–16 con sus tests está en [TESTING](../TESTING.md#invariantes-de-fase-2--tests).

## E2E

- **Flujo principal de 23 pasos** (`e2e/fase2-recetas.spec.ts`, desktop y tablet), sin errores de consola:
  1. Login.
  2. Crear Harina sin costo.
  3. Cargarle $800/kg con "Cambiar costo".
  4. Crear Sal.
  5. Cargarle $500/kg en el alta.
  6. Crear Pan francés a $1.200/kg.
  7. Abrir Recetas.
  8. Crear una receta nueva.
  9. Rendimiento de 100 kg.
  10. Ingredientes: 75 kg de harina y 800 g de sal.
  11. El costo en vivo da lote $60.400, **$604,00 / kg** y margen $596,00 (49,67 %).
  12. Guardar el borrador.
  13. Publicar.
  14. La v1 queda vigente.
  15. La harina pasa a $1.000/kg, con la auditoría visible en la materia prima.
  16. El costo al publicar sigue en $604,00 / kg.
  17. El costo actual es $754,00 / kg (+24,83 %).
  18. Crear una nueva versión.
  19. Cambiar la harina a 80 kg; el editor muestra $804,00 / kg.
  20. Publicar la v2.
  21. La v1 queda archivada con $604,00 / kg.
  22. La v2 queda vigente con $804,00 / kg. La v1 se consulta en sólo lectura y la v2 muestra el cambio "75 kg → 80 kg".
  23. La auditoría de la receta y la del costo de referencia muestran las acciones.
- **Costo incompleto.**
  - Se crea un ingrediente sin costo y un producto vendido por unidad.
  - El editor muestra "Costo teórico incompleto.", lista el ingrediente, muestra "Incompleto" en lote y unitario y "—" en margen, y no muestra "$0".
  - Publicar sin confirmar devuelve un error que el diálogo muestra. Con la casilla marcada, publica.
  - El historial y el listado muestran "Incompleto" y "Costo incompleto".
- **Fase 1 adaptada.** El E2E de Fase 1 se actualizó al nuevo rótulo del costo de referencia y al aviso de producto. El chequeo de que no aparezcan UUIDs ahora también recorre el listado de recetas, el editor, el detalle y una versión.

## Tenancy

- Una materia prima, unidad o producto de otra empresa en una receta responde 422 `INVALID_REFERENCE`, sin revelar si el id existe.
- Recetas y versiones de otra empresa responden 404, tanto para leer como para modificar.
- No se puede copiar una versión de otra empresa.
- La base rechaza referencias cruzadas por FKs compuestas `(company_id, id)` en recetas, versiones, ingredientes y snapshots. Está probado escribiendo directo en la base.

## Gates

| Gate | Qué                       | Resultado | Evidencia                                                                                                        |
| ---- | ------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| A    | DB limpia + migraciones   | PASS      | `pnpm db:reset`: volumen borrado, 0000–0005 aplicadas, seed OK                                                   |
| B    | Unit                      | PASS      | domain 52, shared 31, web 17, database 5, api unit 12                                                            |
| C    | Integración               | PASS      | api 177 tests en 12 archivos (`pnpm test`, salida 0)                                                             |
| D    | Invariantes de versionado | PASS      | `recipes.test.ts` (inmutabilidad por API y triggers, una ACTIVE, rollback) + `recipes-invariants.test.ts`        |
| E    | Cálculos de costo         | PASS      | `costing.test.ts` (ejemplos de la especificación) + integración §43                                              |
| F    | Tenancy                   | PASS      | `recipes-tenancy.test.ts` + `tenancy.test.ts`                                                                    |
| G    | Autorización              | PASS      | `authorization.test.ts`: matriz rol × endpoint con los 19 endpoints nuevos (18 de recetas + costo de referencia) |
| H    | E2E                       | PASS      | 18/18 (desktop + tablet)                                                                                         |
| I    | E2E de costo incompleto   | PASS      | Incluido en H                                                                                                    |
| J    | Revisión manual           | PASS      | 1440×900, 1366×768, 768×1024: sin overflow, sin IDs, sin $0, sin errores ni warnings de consola                  |
| K    | Lint                      | PASS      | ESLint (`--max-warnings 0`) + Prettier                                                                           |
| L    | Typecheck                 | PASS      | `tsc` estricto en los 5 paquetes                                                                                 |
| M    | Build                     | PASS      | API (tsup) y web (Next.js); las 5 rutas de recetas compilan                                                      |
| N    | Worktree limpio           | PASS      | `git status` vacío tras el commit                                                                                |

## CI

El workflow `CI` (job `verify`) corre lint, typecheck, migraciones, seed, test, build y Playwright. Corrió en el PR #2: el primer push (`30149a7`) dio **success**, en el run 36799309673. El resultado del commit final queda en el PR y se informa en el hilo.

## Hallazgos UX (revisión manual)

| Hallazgo                                                                                                   | Resolución                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A 768 px, el listado de recetas necesitaba scroll horizontal y "Estado del costo" quedaba cortado.         | Columnas "Receta" y "Rendimiento" ocultas debajo de 1024 px (`hide-md`).                              |
| Un costo de referencia cargado como 850,125 se mostraba redondeado ($850,13), distinto de lo que se cargó. | `formatReferenceCost` muestra el dato tal como se cargó; los costos calculados siguen a 2 decimales.  |
| Con costo incompleto, "Precio de venta" aparecía como "—" aunque el producto tiene precio.                 | El costo expone `salePrice` aparte del margen: el precio se ve siempre y el margen queda en "—".      |
| Texto del aviso en el alta de producto ("Costo disponible desde Fase 2") quedó viejo.                      | Ahora dice que el costo se calcula desde la receta. El detalle del producto muestra el costo teórico. |

Lo que se revisó en las tres resoluciones: tabla de ingredientes, editor (con un error de cantidad y una materia prima sin costo), historial de versiones, cálculos, mensajes de costo incompleto, errores de unidad (sólo se ofrecen unidades compatibles; la API rechaza el resto) y versiones.

## Riesgos

- **El costo de referencia es manual.** Si no se mantiene actualizado, el costo teórico se desactualiza sin avisar. Lo mitigan la columna "Actualización", la variación contra el snapshot y la auditoría. La solución de fondo llega con Fase 3.
- **Publicar con costo incompleto está permitido** (con confirmación). Una versión vigente puede quedar sin costo unitario; el listado lo marca como "Costo incompleto".
- **Los triggers de inmutabilidad** obligan a que cualquier migración de datos futura sobre versiones publicadas los deshabilite de forma explícita.
- **Redondeo en pantalla.** Los totales se calculan con los valores exactos; pueden diferir en un centavo de la suma de los renglones redondeados.

## Deuda

- **Versión vigente a una fecha.** Sólo existe por API (`effective-version`); no tiene pantalla porque todavía no hay quien la consuma. La usará Producción (Fase 4).
- **Packaging por artículo** (bolsa de 25 kg de un molino determinado): diferido (ADR-025).
- **Diff.** Es una lista de cambios, sin vista lado a lado. La especificación lo admite.
- **Comparaciones.** No hay comparación de costo entre versiones no consecutivas en la UI. La API lo permite con `?against=`.
- **Rendimiento con varias unidades.** Una receta no puede producir varios productos ni expresar el rendimiento en varias unidades a la vez.

## ADR

ADRs nuevos en [DECISIONS](../DECISIONS.md):

- **ADR-021**: versiones inmutables garantizadas por la base.
- **ADR-022**: costo teórico calculado al pedirlo y snapshot al publicar.
- **ADR-023**: política decimal.
- **ADR-024**: costo de referencia manual con permiso y origen propios.
- **ADR-025**: packaging por artículo diferido.

## Próximo paso

**FASE 3 — COMPRAS + INVENTARIO**: compras, recepción, `StockMovement`, costo promedio ponderado móvil (`futureMovingAverageCost`), stock, ajustes, alertas de mínimo y mermas.

**No se comenzó.** Requiere la aceptación humana de Fase 2.
