"use client";

import {
  areUnitsCompatible,
  calculateRecipeCost,
  recipeCostToWire,
  type IngredientCostInput,
} from "@bakery/domain";
import {
  PERMISSIONS as P,
  type ProductDto,
  type RawMaterialDto,
  type RecipeDto,
  type RecipeListItemDto,
  type RecipeVersionDto,
  type TheoreticalCostDto,
  type UnitDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { formatMoney, formatReferenceCost } from "@/lib/format";
import { describeError } from "@/lib/errors";
import { useCan, useCurrentUser } from "../user-context";
import { EmptyState, ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { CostSummary, IncompleteCostAlert, toCostingUnit } from "./cost-views";

/*
 * Alta de receta y edición de borradores. El costo se calcula EN VIVO con las
 * mismas funciones puras de @bakery/domain que usa la API; al guardar, la API
 * vuelve a validar todo (unidades, empresa, rangos).
 */

interface Line {
  key: number;
  rawMaterialId: string;
  quantity: string;
  unitId: string;
}

interface Form {
  productId: string;
  name: string;
  yieldQuantity: string;
  yieldUnitId: string;
  wastePercentage: string;
  instructions: string;
  lines: Line[];
}

const DECIMAL = /^\d{1,12}([.,]\d{1,6})?$/;
const toDecimal = (value: string) => value.trim().replace(",", ".");
const isPositive = (value: string) => DECIMAL.test(value.trim()) && Number(toDecimal(value)) > 0;

let nextKey = 1;
const emptyLine = (): Line => ({ key: nextKey++, rawMaterialId: "", quantity: "", unitId: "" });

interface Catalog {
  products: ProductDto[];
  materials: RawMaterialDto[];
  units: UnitDto[];
  /** Productos que ya tienen receta activa (no se ofrecen al crear). */
  withRecipe: Set<string>;
}

function useCatalog(): { catalog: Catalog | null; error: ApiError | null; retry: () => void } {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchOptions<ProductDto>("/api/products"),
      fetchOptions<RawMaterialDto>("/api/raw-materials"),
      fetchOptions<UnitDto>("/api/units"),
      fetchOptions<RecipeListItemDto>("/api/recipes", { status: "active" }),
    ])
      .then(([products, materials, units, recipes]) => {
        if (cancelled) return;
        setError(null);
        setCatalog({
          products,
          materials,
          units,
          withRecipe: new Set(recipes.map((r) => r.product.id)),
        });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Error"));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  return {
    catalog,
    error,
    retry: () => {
      setError(null);
      setAttempt((a) => a + 1);
    },
  };
}

/** Pantalla de "no se puede" con su encabezado (sin permiso, versión no editable). */
function Blocked({
  title,
  crumbs,
  message,
  back,
}: {
  title: string;
  crumbs: { href: string; label: string }[];
  message: string;
  back: { href: string; label: string };
}) {
  return (
    <div className="page">
      <PageHeader title={title} breadcrumb={crumbs} />
      <EmptyState
        title={message}
        action={
          <Link className="button" href={back.href}>
            {back.label}
          </Link>
        }
      />
    </div>
  );
}

export function RecipeCreate() {
  return (
    <Suspense fallback={<Loading />}>
      <RecipeCreateInner />
    </Suspense>
  );
}

function RecipeCreateInner() {
  const params = useSearchParams();
  const can = useCan();
  const { catalog, error, retry } = useCatalog();
  if (!can(P.RECIPES_CREATE))
    return (
      <Blocked
        title="Nueva receta"
        crumbs={[{ href: "/recetas", label: "Recetas" }]}
        message="No tenés permiso para crear recetas."
        back={{ href: "/recetas", label: "Ver recetas" }}
      />
    );
  if (error) return <ErrorState error={error} onRetry={retry} />;
  if (!catalog) return <Loading />;
  const preset = params.get("producto") ?? "";
  return (
    <RecipeEditor
      catalog={catalog}
      initial={{
        productId: catalog.withRecipe.has(preset) ? "" : preset,
        name: "",
        yieldQuantity: "",
        yieldUnitId: "",
        wastePercentage: "",
        instructions: "",
        lines: [emptyLine()],
      }}
    />
  );
}

export function DraftEdit({ recipeId, versionId }: { recipeId: string; versionId: string }) {
  const can = useCan();
  const { catalog, error: catalogError, retry } = useCatalog();
  const { data, error } = useResource<RecipeVersionDto>(`/api/recipe-versions/${versionId}`);
  if (!can(P.RECIPES_UPDATE))
    return (
      <Blocked
        title="Editar borrador"
        crumbs={[
          { href: "/recetas", label: "Recetas" },
          { href: `/recetas/${recipeId}`, label: data?.recipe.name ?? "Receta" },
        ]}
        message="No tenés permiso para editar recetas."
        back={{ href: `/recetas/${recipeId}`, label: "Ver la receta" }}
      />
    );
  if (error) return <ErrorState error={error} />;
  if (catalogError) return <ErrorState error={catalogError} onRetry={retry} />;
  if (!data || !catalog) return <Loading />;
  if (data.status !== "DRAFT" || data.recipe.id !== recipeId) {
    return (
      <Blocked
        title="Editar borrador"
        crumbs={[
          { href: "/recetas", label: "Recetas" },
          { href: `/recetas/${recipeId}`, label: data.recipe.name },
        ]}
        message="Esta versión no es un borrador: las versiones publicadas no se modifican."
        back={{ href: `/recetas/${recipeId}`, label: "Ver la receta" }}
      />
    );
  }
  // Una materia prima ya desactivada sigue visible en el borrador para poder quitarla.
  const known = new Set(catalog.materials.map((m) => m.id));
  const extra: RawMaterialDto[] = data.ingredients
    .filter((i) => !known.has(i.rawMaterial.id))
    .map((i) => ({
      id: i.rawMaterial.id,
      code: i.rawMaterial.code,
      name: `${i.rawMaterial.name} (inactiva)`,
      description: null,
      category: { id: "", name: "" },
      baseUnit: i.rawMaterial.baseUnit,
      minimumStock: "0",
      preferredSupplier: null,
      referenceCost: i.rawMaterial.referenceCost,
      referenceCostSource: i.rawMaterial.referenceCostSource,
      referenceCostUpdatedAt: null,
      movingAverageCost: null,
      effectiveCost: i.rawMaterial.effectiveCost,
      effectiveCostSource: i.rawMaterial.effectiveCostSource,
      active: false,
      createdAt: "",
      updatedAt: "",
    }));
  return (
    <RecipeEditor
      catalog={{ ...catalog, materials: [...catalog.materials, ...extra] }}
      version={data}
      initial={{
        productId: data.product.id,
        name: data.recipe.name,
        yieldQuantity: trim(data.yieldQuantity),
        yieldUnitId: data.yieldUnit.id,
        wastePercentage: data.wastePercentage === null ? "" : trim(data.wastePercentage),
        instructions: data.instructions ?? "",
        lines:
          data.ingredients.length > 0
            ? data.ingredients.map((i) => ({
                key: nextKey++,
                rawMaterialId: i.rawMaterial.id,
                quantity: trim(i.quantity),
                unitId: i.unit.id,
              }))
            : [emptyLine()],
      }}
    />
  );
}

/** "75.000000" → "75" para editar cómodo. */
function trim(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

function RecipeEditor({
  catalog,
  initial,
  version,
}: {
  catalog: Catalog;
  initial: Form;
  version?: RecipeVersionDto;
}) {
  const router = useRouter();
  const user = useCurrentUser();
  const currency = user.company.currencyCode;
  const [form, setForm] = useState<Form>(initial);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // Al fallar, el error aparece junto al botón de guardar y recibe el foco.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const units = useMemo(() => catalog.units.filter((u) => u.active), [catalog.units]);
  const unitById = useMemo(() => new Map(catalog.units.map((u) => [u.id, u])), [catalog.units]);
  const materialById = useMemo(
    () => new Map(catalog.materials.map((m) => [m.id, m])),
    [catalog.materials],
  );
  const product: Pick<ProductDto, "id" | "name" | "saleUnit" | "salePrice"> | undefined = useMemo(
    () => version?.product ?? catalog.products.find((p) => p.id === form.productId),
    [version, catalog.products, form.productId],
  );
  const saleUnit = product ? unitById.get(product.saleUnit.id) : undefined;

  /** Unidades en que se puede expresar algo medido en `base` (misma raíz). */
  const compatibleUnits = (base: UnitDto | undefined) =>
    base ? units.filter((u) => areUnitsCompatible(toCostingUnit(u), toCostingUnit(base))) : [];

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setLine = (key: number, change: Partial<Line>) =>
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l) => (l.key === key ? { ...l, ...change } : l)),
    }));

  function chooseProduct(productId: string) {
    const p = catalog.products.find((x) => x.id === productId);
    setForm((f) => ({
      ...f,
      productId,
      // Por defecto el rendimiento se expresa en la unidad de venta.
      yieldUnitId: p ? p.saleUnit.id : "",
    }));
  }

  function chooseMaterial(key: number, rawMaterialId: string) {
    const m = materialById.get(rawMaterialId);
    setLine(key, { rawMaterialId, unitId: m ? m.baseUnit.id : "" });
  }

  /* ---- Costo en vivo (dominio puro) ---- */
  const live = useMemo((): { cost: TheoreticalCostDto | null; pendingLines: number } => {
    const yieldUnit = unitById.get(form.yieldUnitId);
    if (!saleUnit || !yieldUnit || !isPositive(form.yieldQuantity))
      return { cost: null, pendingLines: 0 };
    if (!areUnitsCompatible(toCostingUnit(yieldUnit), toCostingUnit(saleUnit)))
      return { cost: null, pendingLines: 0 };
    const inputs: IngredientCostInput[] = [];
    let pendingLines = 0;
    for (const line of form.lines) {
      const m = materialById.get(line.rawMaterialId);
      const unit = unitById.get(line.unitId);
      const base = m ? unitById.get(m.baseUnit.id) : undefined;
      if (!m || !unit || !base || !isPositive(line.quantity)) {
        if (line.rawMaterialId || line.quantity) pendingLines++;
        continue;
      }
      if (!areUnitsCompatible(toCostingUnit(unit), toCostingUnit(base))) {
        pendingLines++;
        continue;
      }
      inputs.push({
        rawMaterialId: m.id,
        rawMaterialCode: m.code,
        rawMaterialName: m.name,
        quantity: toDecimal(line.quantity),
        unit: toCostingUnit(unit),
        baseUnit: toCostingUnit(base),
        // Mismo costo que usa la API: promedio móvil de inventario o referencia manual.
        referenceCost: m.effectiveCost,
        costSource: m.effectiveCostSource,
      });
    }
    try {
      const result = calculateRecipeCost({
        currency,
        yieldQuantity: toDecimal(form.yieldQuantity),
        yieldUnit: toCostingUnit(yieldUnit),
        saleUnit: toCostingUnit(saleUnit),
        salePrice: product?.salePrice ?? null,
        ingredients: inputs,
      });
      return { cost: recipeCostToWire(result), pendingLines };
    } catch {
      return { cost: null, pendingLines };
    }
  }, [form, unitById, materialById, saleUnit, product, currency]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const local: Record<string, string> = {};
    if (!version && !form.productId) local.productId = "Elegí el producto";
    if (!isPositive(form.yieldQuantity))
      local.yieldQuantity = "Indicá un rendimiento mayor que cero";
    if (!form.yieldUnitId) local.yieldUnitId = "Obligatorio";
    const lines = form.lines.filter((l) => l.rawMaterialId || l.quantity);
    lines.forEach((l, index) => {
      if (!l.rawMaterialId) local[`ingredients.${index}.rawMaterialId`] = "Elegí la materia prima";
      if (!isPositive(l.quantity)) local[`ingredients.${index}.quantity`] = "Mayor que cero";
      if (!l.unitId) local[`ingredients.${index}.unitId`] = "Obligatorio";
    });
    if (Object.keys(local).length > 0) {
      setFieldErrors(remapLineErrors(local, form.lines, lines));
      setError("Revisá los datos marcados.");
      return;
    }
    const versionBody = {
      yieldQuantity: toDecimal(form.yieldQuantity),
      yieldUnitId: form.yieldUnitId,
      wastePercentage: form.wastePercentage.trim() === "" ? null : toDecimal(form.wastePercentage),
      instructions: form.instructions.trim() === "" ? null : form.instructions,
      ingredients: lines.map((l) => ({
        rawMaterialId: l.rawMaterialId,
        quantity: toDecimal(l.quantity),
        unitId: l.unitId,
      })),
    };
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      if (version) {
        await apiFetch(`/api/recipe-versions/${version.id}`, {
          method: "PATCH",
          body: versionBody,
        });
        router.push(`/recetas/${version.recipe.id}`);
      } else {
        const recipe = await apiFetch<RecipeDto>("/api/recipes", {
          method: "POST",
          body: {
            productId: form.productId,
            name: form.name.trim() === "" ? null : form.name,
            version: versionBody,
          },
        });
        router.push(`/recetas/${recipe.id}`);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(remapLineErrors(err.fieldErrors, form.lines, lines));
        setError(
          err.code === "RECIPE_INVALID" || err.status === 422 ? describe(err) : describeError(err),
        );
      } else {
        setError("No se pudo guardar el borrador.");
      }
      setPending(false);
    }
  }

  const availableProducts = catalog.products.filter(
    (p) => p.active && !catalog.withRecipe.has(p.id),
  );
  const yieldUnits = saleUnit ? compatibleUnits(saleUnit) : [];
  const title = version
    ? `Editar borrador · ${version.recipe.name} (versión ${version.versionNumber})`
    : "Nueva receta";

  return (
    <div className="page">
      <PageHeader
        title={title}
        breadcrumb={
          version
            ? [
                { href: "/recetas", label: "Recetas" },
                { href: `/recetas/${version.recipe.id}`, label: version.recipe.name },
              ]
            : { href: "/recetas", label: "Recetas" }
        }
        subtitle="Los cambios se guardan como borrador. La receta se vuelve vigente recién al publicarla."
      />
      <form className="page" onSubmit={submit} noValidate aria-label={title}>
        <section className="panel" aria-labelledby="step-product">
          <h2 id="step-product">1. Producto y rendimiento</h2>
          <div className="form-grid">
            {version ? (
              <div className="form__field">
                <span className="form__label">Producto</span>
                <strong>{version.product.name}</strong>
              </div>
            ) : (
              <div className="form__field">
                <label htmlFor="productId">
                  Producto{" "}
                  <span className="form__required" aria-hidden="true">
                    *
                  </span>
                </label>
                <select
                  id="productId"
                  value={form.productId}
                  aria-required
                  aria-invalid={fieldErrors.productId ? true : undefined}
                  aria-describedby={fieldErrors.productId ? "productId-error" : undefined}
                  onChange={(e) => chooseProduct(e.target.value)}
                >
                  <option value="">Elegí un producto</option>
                  {availableProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.saleUnit.symbol})
                    </option>
                  ))}
                </select>
                {fieldErrors.productId && (
                  <span className="form__error" id="productId-error">
                    {fieldErrors.productId}
                  </span>
                )}
                {availableProducts.length === 0 && (
                  <span className="form__hint">Todos los productos activos ya tienen receta.</span>
                )}
              </div>
            )}
            {!version && (
              <div className="form__field">
                <label htmlFor="recipeName">Nombre de la receta</label>
                <input
                  id="recipeName"
                  autoComplete="off"
                  placeholder={product ? product.name : "Igual que el producto"}
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              </div>
            )}
            <div className="form__field">
              <label htmlFor="yieldQuantity">
                Rendimiento{" "}
                <span className="form__required" aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id="yieldQuantity"
                inputMode="decimal"
                autoComplete="off"
                placeholder="Ej.: 100"
                value={form.yieldQuantity}
                aria-required
                aria-invalid={fieldErrors.yieldQuantity ? true : undefined}
                aria-describedby={`yieldQuantity-hint${fieldErrors.yieldQuantity ? " yieldQuantity-error" : ""}`}
                onChange={(e) => set("yieldQuantity", e.target.value)}
              />
              <span className="form__hint" id="yieldQuantity-hint">
                Producción útil final que se espera de una tanda.
              </span>
              {fieldErrors.yieldQuantity && (
                <span className="form__error" id="yieldQuantity-error">
                  {fieldErrors.yieldQuantity}
                </span>
              )}
            </div>
            <div className="form__field">
              <label htmlFor="yieldUnitId">
                Unidad del rendimiento{" "}
                <span className="form__required" aria-hidden="true">
                  *
                </span>
              </label>
              <select
                id="yieldUnitId"
                value={form.yieldUnitId}
                disabled={!saleUnit}
                aria-required
                aria-invalid={fieldErrors.yieldUnitId ? true : undefined}
                aria-describedby={fieldErrors.yieldUnitId ? "yieldUnitId-error" : undefined}
                onChange={(e) => set("yieldUnitId", e.target.value)}
              >
                <option value="">
                  {saleUnit ? "Elegí una unidad" : "Primero elegí el producto"}
                </option>
                {yieldUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.symbol})
                  </option>
                ))}
              </select>
              {saleUnit && (
                <span className="form__hint">
                  El producto se vende por {saleUnit.symbol}: sólo unidades convertibles a{" "}
                  {saleUnit.symbol}.
                </span>
              )}
              {fieldErrors.yieldUnitId && (
                <span className="form__error" id="yieldUnitId-error">
                  {fieldErrors.yieldUnitId}
                </span>
              )}
            </div>
            <div className="form__field">
              <label htmlFor="wastePercentage">Merma teórica (%)</label>
              <input
                id="wastePercentage"
                inputMode="decimal"
                autoComplete="off"
                placeholder="Opcional"
                value={form.wastePercentage}
                aria-invalid={fieldErrors.wastePercentage ? true : undefined}
                aria-describedby={`waste-hint${fieldErrors.wastePercentage ? " waste-error" : ""}`}
                onChange={(e) => set("wastePercentage", e.target.value)}
              />
              <span className="form__hint" id="waste-hint">
                Informativa: el rendimiento ya es la producción útil, la merma no se descuenta otra
                vez del costo.
              </span>
              {fieldErrors.wastePercentage && (
                <span className="form__error" id="waste-error">
                  {fieldErrors.wastePercentage}
                </span>
              )}
            </div>
          </div>
        </section>

        <section className="panel" aria-labelledby="step-ingredients">
          <h2 id="step-ingredients">2. Ingredientes</h2>
          <div className="table-wrap">
            <table className="table ingredients-editor">
              <thead>
                <tr>
                  <th scope="col" className="col-material">
                    Materia prima
                  </th>
                  <th scope="col" className="col-qty">
                    Cantidad
                  </th>
                  <th scope="col" className="col-unit">
                    Unidad
                  </th>
                  <th scope="col" className="num hide-sm">
                    Costo usado
                  </th>
                  <th scope="col" className="num">
                    Costo del ingrediente
                  </th>
                  <th scope="col">
                    <span className="sr-only">Quitar</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {form.lines.map((line, index) => {
                  const m = materialById.get(line.rawMaterialId);
                  const base = m ? unitById.get(m.baseUnit.id) : undefined;
                  const costLine = live.cost?.ingredients.find(
                    (i) => i.rawMaterialId === line.rawMaterialId,
                  );
                  const used = new Set(
                    form.lines.filter((l) => l.key !== line.key).map((l) => l.rawMaterialId),
                  );
                  const err = (f: string) => fieldErrors[`ingredients.${index}.${f}`];
                  return (
                    <tr key={line.key}>
                      <td className="col-material">
                        <select
                          aria-label={`Materia prima ${index + 1}`}
                          value={line.rawMaterialId}
                          aria-invalid={err("rawMaterialId") ? true : undefined}
                          aria-describedby={
                            err("rawMaterialId") ? `line-${line.key}-material-error` : undefined
                          }
                          onChange={(e) => chooseMaterial(line.key, e.target.value)}
                        >
                          <option value="">Elegí…</option>
                          {catalog.materials
                            .filter(
                              (x) => x.id === line.rawMaterialId || (x.active && !used.has(x.id)),
                            )
                            .map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.name}
                              </option>
                            ))}
                        </select>
                        {err("rawMaterialId") && (
                          <span className="form__error" id={`line-${line.key}-material-error`}>
                            {err("rawMaterialId")}
                          </span>
                        )}
                      </td>
                      <td className="col-qty">
                        <input
                          aria-label={`Cantidad ${index + 1}`}
                          inputMode="decimal"
                          autoComplete="off"
                          value={line.quantity}
                          aria-invalid={err("quantity") ? true : undefined}
                          aria-describedby={
                            err("quantity") ? `line-${line.key}-qty-error` : undefined
                          }
                          onChange={(e) => setLine(line.key, { quantity: e.target.value })}
                        />
                        {err("quantity") && (
                          <span className="form__error" id={`line-${line.key}-qty-error`}>
                            {err("quantity")}
                          </span>
                        )}
                      </td>
                      <td className="col-unit">
                        <select
                          aria-label={`Unidad ${index + 1}`}
                          value={line.unitId}
                          disabled={!m}
                          aria-invalid={err("unitId") ? true : undefined}
                          aria-describedby={
                            err("unitId") ? `line-${line.key}-unit-error` : undefined
                          }
                          onChange={(e) => setLine(line.key, { unitId: e.target.value })}
                        >
                          <option value="">—</option>
                          {compatibleUnits(base).map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.symbol}
                            </option>
                          ))}
                        </select>
                        {err("unitId") && (
                          <span className="form__error" id={`line-${line.key}-unit-error`}>
                            {err("unitId")}
                          </span>
                        )}
                      </td>
                      <td className="num hide-sm">
                        {!m ? null : m.effectiveCost === null ? (
                          <span className="badge badge--warn">Sin costo</span>
                        ) : (
                          formatReferenceCost(m.effectiveCost, currency, m.baseUnit.symbol)
                        )}
                      </td>
                      <td className="num">
                        {costLine?.cost ? formatMoney(costLine.cost, currency) : null}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button button--small"
                          aria-label={`Quitar ingrediente ${index + 1}${m ? ` (${m.name})` : ""}`}
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              lines:
                                f.lines.length > 1
                                  ? f.lines.filter((l) => l.key !== line.key)
                                  : [emptyLine()],
                            }))
                          }
                        >
                          Quitar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="form__footer">
            <button
              type="button"
              className="button"
              onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
            >
              Agregar ingrediente
            </button>
          </div>
        </section>

        <section className="panel" aria-labelledby="step-cost" aria-live="polite">
          <h2 id="step-cost">3. Costo teórico</h2>
          {live.cost ? (
            <>
              {live.pendingLines > 0 && (
                <p className="muted">
                  {live.pendingLines === 1
                    ? "Hay un ingrediente incompleto que todavía no se suma."
                    : `Hay ${live.pendingLines} ingredientes incompletos que todavía no se suman.`}
                </p>
              )}
              {live.cost.ingredients.length === 0 ? (
                <IncompleteCostAlert missing={[]} />
              ) : (
                <CostSummary cost={live.cost} currentLabel="con costos de hoy" />
              )}
            </>
          ) : (
            <p className="muted">
              Elegí el producto e indicá el rendimiento para ver el costo calculado.
            </p>
          )}
        </section>

        <section className="panel" aria-labelledby="step-instructions">
          <h2 id="step-instructions">4. Instrucciones</h2>
          <div className="form__field form__field--full">
            <label htmlFor="instructions">Instrucciones de elaboración</label>
            <textarea
              id="instructions"
              value={form.instructions}
              onChange={(e) => set("instructions", e.target.value)}
            />
          </div>
          {error && (
            <p className="alert" role="alert" ref={errorRef} tabIndex={-1}>
              {error}
            </p>
          )}
          <p className="muted small">
            <span aria-hidden="true">*</span> Obligatorio.
          </p>
          <div className="form__footer">
            <button type="submit" className="button button--primary" disabled={pending}>
              {pending ? "Guardando…" : "Guardar borrador"}
            </button>
            <Link className="button" href={version ? `/recetas/${version.recipe.id}` : "/recetas"}>
              Cancelar
            </Link>
          </div>
        </section>
      </form>
    </div>
  );
}

/** Mensaje legible de un 422 de la API (unidad incompatible, materia prima inexistente…). */
function describe(err: ApiError): string {
  const messages = Object.values(err.fieldErrors);
  return messages.length > 0 ? messages.join(". ") : err.message;
}

/**
 * Los errores de la API vienen por índice de la lista enviada (sin filas vacías);
 * se traducen al índice de la fila visible.
 */
function remapLineErrors(
  errors: Record<string, string>,
  all: Line[],
  sent: Line[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(errors)) {
    const match = /^ingredients\.(\d+)\.(.+)$/.exec(path);
    if (!match) {
      out[path] = message;
      continue;
    }
    const line = sent[Number(match[1])];
    const visible = line ? all.findIndex((l) => l.key === line.key) : -1;
    out[visible >= 0 ? `ingredients.${visible}.${match[2]}` : path] = message;
  }
  return out;
}
