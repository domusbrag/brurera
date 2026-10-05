"use client";

import {
  PERMISSIONS as P,
  formatLocalDateTime,
  instantToZonedLocal,
  type CreateProductionOrderInput,
  type OrderRequirementDto,
  type Page,
  type ProductDto,
  type ProductionOrderDto,
  type RecipeDto,
  type RecipeListItemDto,
  type ResponsibleOptionDto,
  type UnitDto,
  type WarehouseDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions, listPath } from "@/lib/api-client";
import { isPositive, toDecimal } from "@/lib/decimal-input";
import { formatDate, formatQuantity } from "@/lib/format";
import { describeError } from "@/lib/errors";
import { EmptyState, ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { Combobox, type ComboOption } from "../ui/combobox";
import { useCan, useCurrentUser } from "../user-context";
import {
  AvailabilityTable,
  PRODUCTION_BASE,
  ProductionCosts,
  compatibleUnits,
  formatFactor,
  useUnits,
} from "./production-shared";

/*
 * Alta y edición de una orden de producción. Mientras se completa el formulario
 * se pide a la API una vista previa (no guarda nada) con la receta sugerida, el
 * plan escalado, la disponibilidad y el costo esperado. En borrador se edita
 * todo; planificada o en curso sólo responsable, lote y notas.
 */

interface Form {
  productId: string;
  scheduledFor: string;
  plannedOutputQuantity: string;
  plannedOutputUnitId: string;
  /** "" = la versión vigente para la fecha. */
  recipeVersionId: string;
  sourceWarehouseId: string;
  outputWarehouseId: string;
  responsibleEmployeeId: string;
  batchCode: string;
  notes: string;
}

/** Hoy en el calendario de la EMPRESA (no del navegador). */
const todayIn = (timeZone: string) => instantToZonedLocal(new Date(), timeZone).slice(0, 10);

interface Catalog {
  products: ProductDto[];
  warehouses: WarehouseDto[];
  responsibles: ResponsibleOptionDto[];
  units: UnitDto[];
}

function useCatalog(): { catalog: Catalog | null; error: ApiError | null; retry: () => void } {
  const units = useUnits();
  const [rest, setRest] = useState<Omit<Catalog, "units"> | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchOptions<ProductDto>("/api/products"),
      fetchOptions<WarehouseDto>("/api/warehouses"),
      apiFetch<ResponsibleOptionDto[]>("/api/production/responsibles"),
    ])
      .then(([products, warehouses, responsibles]) => {
        if (cancelled) return;
        setError(null);
        setRest({
          products: products.filter((p) => p.controlsStock),
          warehouses,
          responsibles,
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
    catalog: rest && units ? { ...rest, units } : null,
    error,
    retry: () => {
      setError(null);
      setAttempt((a) => a + 1);
    },
  };
}

/** Versiones publicadas de la receta del producto (para elegir otra que la vigente). */
function usePublishedVersions(productId: string) {
  const [loaded, setLoaded] = useState<{
    productId: string;
    versions: { id: string; label: string }[];
  } | null>(null);
  useEffect(() => {
    if (!productId) return;
    let cancelled = false;
    apiFetch<Page<RecipeListItemDto>>(listPath("/api/recipes", { productId, status: "all" }))
      .then((page) =>
        page.items[0] ? apiFetch<RecipeDto>(`/api/recipes/${page.items[0].id}`) : null,
      )
      .then((recipe) => {
        if (cancelled) return;
        setLoaded({
          productId,
          versions: (recipe?.versions ?? [])
            .filter((v) => v.publishedAt !== null)
            .map((v) => ({
              id: v.id,
              label: `Versión ${v.versionNumber}${v.status === "ACTIVE" ? " (vigente)" : ""}${
                v.effectiveFrom ? ` · desde ${formatDate(v.effectiveFrom.slice(0, 10))}` : ""
              }`,
            })),
        });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ productId, versions: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);
  return productId && loaded?.productId === productId ? loaded.versions : [];
}

export function ProductionForm({ id }: { id?: string }) {
  return (
    <Suspense fallback={<Loading />}>
      <ProductionFormInner id={id} />
    </Suspense>
  );
}

function ProductionFormInner({ id }: { id?: string }) {
  const { catalog, error: catalogError, retry } = useCatalog();
  const params = useSearchParams();
  const requirementId = id ? null : params.get("requirementId");
  const { data: existing, error } = useResource<ProductionOrderDto>(
    id ? `/api/production-orders/${id}` : null,
  );
  // Fase 5A: orden prellenada desde la necesidad de un pedido.
  const { data: requirement, error: requirementError } = useResource<OrderRequirementDto>(
    requirementId ? `/api/planning/requirements/${requirementId}` : null,
  );
  if (error) return <ErrorState error={error} />;
  if (requirementError) return <ErrorState error={requirementError} />;
  if (catalogError) return <ErrorState error={catalogError} onRetry={retry} />;
  if (!catalog || (id && !existing) || (requirementId && !requirement)) return <Loading />;
  if (existing && (existing.status === "COMPLETED" || existing.status === "CANCELLED")) {
    return (
      <div className="page">
        <PageHeader
          breadcrumb={[
            { href: PRODUCTION_BASE, label: "Órdenes de producción" },
            { href: `${PRODUCTION_BASE}/${existing.id}`, label: `Orden ${existing.code}` },
          ]}
          title={`Editar orden ${existing.code}`}
        />
        <EmptyState
          title="Esta orden ya no se puede editar"
          description="Una orden completada o cancelada queda cerrada."
          action={
            <Link className="button" href={`${PRODUCTION_BASE}/${existing.id}`}>
              Ver la orden
            </Link>
          }
        />
      </div>
    );
  }
  if (requirement?.blockedReason) {
    return (
      <div className="page">
        <PageHeader
          breadcrumb={{ href: PRODUCTION_BASE, label: "Órdenes de producción" }}
          title="Nueva orden de producción"
        />
        <EmptyState
          title="No se puede crear la orden desde este pedido"
          description={requirement.blockedReason}
          action={
            <Link className="button" href={`/pedidos/${requirement.order.id}`}>
              Ver pedido {requirement.order.code}
            </Link>
          }
        />
      </div>
    );
  }
  return (
    <ProductionEditor
      catalog={catalog}
      existing={existing ?? null}
      requirement={requirement ?? null}
    />
  );
}

/** Campos con error propio en pantalla. */
const VISIBLE_FIELDS = new Set<string>([
  "productId",
  "scheduledFor",
  "plannedOutputQuantity",
  "plannedOutputUnitId",
  "recipeVersionId",
  "sourceWarehouseId",
  "outputWarehouseId",
  "responsibleEmployeeId",
  "batchCode",
  "notes",
]);

const plain = (v: string | null | undefined) =>
  v ? v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : "";

function ProductionEditor({
  catalog,
  existing,
  requirement,
}: {
  catalog: Catalog;
  existing: ProductionOrderDto | null;
  requirement: OrderRequirementDto | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const can = useCan();
  const today = todayIn(useCurrentUser().company.timezone);
  const operationalOnly = existing !== null && existing.status !== "DRAFT";
  const defaultWarehouse = catalog.warehouses[0]?.id ?? "";
  const [form, setForm] = useState<Form>(() =>
    existing
      ? {
          productId: existing.product.id,
          scheduledFor: existing.scheduledFor,
          plannedOutputQuantity: plain(existing.plannedOutputQuantity),
          plannedOutputUnitId: existing.plannedOutputUnit.id,
          recipeVersionId: existing.suggestedVersion ? existing.recipeVersion.id : "",
          sourceWarehouseId: existing.sourceWarehouse.id,
          outputWarehouseId: existing.outputWarehouse.id,
          responsibleEmployeeId: existing.responsible?.id ?? "",
          batchCode: existing.batchCode ?? "",
          notes: existing.notes ?? "",
        }
      : requirement
        ? {
            productId: requirement.product.id,
            // Se produce antes de la entrega: hoy por defecto (la fecha requerida se muestra arriba).
            scheduledFor: today <= requirement.requiredBy ? today : requirement.requiredBy,
            plannedOutputQuantity: plain(requirement.quantity),
            plannedOutputUnitId: requirement.unit.id,
            recipeVersionId: requirement.recipe?.versionId ?? "",
            sourceWarehouseId: requirement.suggestedSourceWarehouseId ?? defaultWarehouse,
            outputWarehouseId: requirement.suggestedOutputWarehouseId ?? defaultWarehouse,
            responsibleEmployeeId: "",
            batchCode: "",
            notes: `Para el pedido ${requirement.order.code}`,
          }
        : {
            productId: params.get("productId") ?? "",
            scheduledFor: today,
            plannedOutputQuantity: "",
            plannedOutputUnitId: "",
            recipeVersionId: "",
            sourceWarehouseId: defaultWarehouse,
            outputWarehouseId: defaultWarehouse,
            responsibleEmployeeId: "",
            batchCode: "",
            notes: "",
          },
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [previewState, setPreviewState] = useState<{
    key: string;
    preview: ProductionOrderDto | null;
    error: ApiError | null;
  } | null>(null);
  const product = catalog.products.find((p) => p.id === form.productId) ?? null;
  const versions = usePublishedVersions(operationalOnly ? "" : form.productId);
  const outputUnits = useMemo(
    () => (product ? compatibleUnits(catalog.units, product.saleUnit.id) : []),
    [catalog.units, product],
  );
  const outputUnitId = form.plannedOutputUnitId || product?.saleUnit.id || "";

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((e) => {
      const { [key]: _removed, ...rest } = e;
      return rest;
    });
  };

  const payload = (): CreateProductionOrderInput => ({
    productId: form.productId,
    scheduledFor: form.scheduledFor,
    plannedOutputQuantity: toDecimal(form.plannedOutputQuantity),
    plannedOutputUnitId: outputUnitId || null,
    recipeVersionId: form.recipeVersionId || null,
    sourceWarehouseId: form.sourceWarehouseId,
    outputWarehouseId: form.outputWarehouseId,
    responsibleEmployeeId: form.responsibleEmployeeId || null,
    batchCode: form.batchCode.trim() || null,
    notes: form.notes.trim() || null,
    sourceOrderRequirementId: requirement?.id ?? null,
  });

  // Vista previa en vivo (con demora) cuando los datos que definen el plan están completos.
  const previewKey = operationalOnly
    ? ""
    : [
        form.productId,
        form.scheduledFor,
        form.plannedOutputQuantity,
        outputUnitId,
        form.recipeVersionId,
        form.sourceWarehouseId,
        form.outputWarehouseId,
      ].join("|");
  const ready =
    !operationalOnly &&
    form.productId !== "" &&
    form.scheduledFor !== "" &&
    isPositive(form.plannedOutputQuantity) &&
    form.sourceWarehouseId !== "" &&
    form.outputWarehouseId !== "";
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetch<ProductionOrderDto>("/api/production-orders/preview", {
        method: "POST",
        // La vista previa no reclama la necesidad del pedido (sólo el alta la vincula).
        body: { ...payload(), batchCode: null, notes: null, sourceOrderRequirementId: null },
      })
        .then((result) => {
          if (!cancelled) setPreviewState({ key: previewKey, preview: result, error: null });
        })
        .catch((err: unknown) => {
          if (!cancelled)
            setPreviewState({
              key: previewKey,
              preview: null,
              error: err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Sin vista previa"),
            });
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, ready]);
  const current = ready && previewState?.key === previewKey ? previewState : null;
  const preview = current?.preview ?? null;
  const previewError = current?.error ?? null;

  function validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (operationalOnly) return errors;
    if (!form.productId) errors.productId = "Elegí el producto";
    if (!form.scheduledFor) errors.scheduledFor = "Indicá la fecha";
    if (!isPositive(form.plannedOutputQuantity))
      errors.plannedOutputQuantity = "Indicá una cantidad mayor que cero";
    if (!form.sourceWarehouseId) errors.sourceWarehouseId = "Elegí el depósito";
    if (!form.outputWarehouseId) errors.outputWarehouseId = "Elegí el depósito";
    return errors;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;
    setPending(true);
    try {
      let saved: ProductionOrderDto;
      if (!existing) {
        saved = await apiFetch<ProductionOrderDto>("/api/production-orders", {
          method: "POST",
          body: payload(),
        });
      } else {
        const body = operationalOnly
          ? {
              responsibleEmployeeId: form.responsibleEmployeeId || null,
              batchCode: form.batchCode.trim() || null,
              notes: form.notes.trim() || null,
            }
          : payload();
        saved = await apiFetch<ProductionOrderDto>(`/api/production-orders/${existing.id}`, {
          method: "PATCH",
          body,
        });
      }
      router.push(`${PRODUCTION_BASE}/${saved.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        // Errores de campos que no están en pantalla (p. ej. la necesidad del pedido): se dicen acá.
        const hidden = Object.entries(err.fieldErrors)
          .filter(([key]) => !VISIBLE_FIELDS.has(key))
          .map(([, text]) => text);
        setFormError([describeError(err), ...hidden].join(" "));
      } else {
        setFormError("No se pudo guardar la orden.");
      }
      setPending(false);
    }
  }

  const allowed = existing
    ? can(P.PRODUCTION_ORDERS_UPDATE)
    : can(P.PRODUCTION_ORDERS_CREATE) && (!requirement || can(P.ORDER_PRODUCTION_CREATE));
  const field = (name: keyof Form, hint?: boolean) => ({
    id: `f-${name}`,
    "aria-invalid": fieldErrors[name] ? true : undefined,
    "aria-describedby":
      [fieldErrors[name] ? `f-${name}-error` : null, hint ? `f-${name}-hint` : null]
        .filter(Boolean)
        .join(" ") || undefined,
  });
  const required = (
    <span className="form__required" aria-hidden="true">
      *
    </span>
  );
  const productOptions = useMemo<ComboOption[]>(
    () =>
      catalog.products.map((p) => ({
        value: p.id,
        label: p.name,
        detail: p.saleUnit.symbol,
        keywords: p.code,
      })),
    [catalog.products],
  );
  const err = (name: keyof Form) =>
    fieldErrors[name] ? (
      <span className="form__error" id={`f-${name}-error`}>
        {fieldErrors[name]}
      </span>
    ) : null;

  const title = existing ? `Editar orden ${existing.code}` : "Nueva orden de producción";
  return (
    <div className="page">
      <PageHeader
        breadcrumb={
          existing
            ? { href: `${PRODUCTION_BASE}/${existing.id}`, label: `Orden ${existing.code}` }
            : { href: PRODUCTION_BASE, label: "Órdenes de producción" }
        }
        title={title}
        subtitle={
          operationalOnly
            ? "La orden ya está planificada: producto, cantidad, receta y depósitos quedan fijos."
            : "Elegí qué producir, cuánto y desde qué depósito. Se guarda como borrador."
        }
      />
      {!allowed ? (
        <p className="notice">No tenés permiso para esta operación.</p>
      ) : (
        <form className="form" onSubmit={submit} noValidate>
          {requirement && (
            <p className="notice" data-testid="from-order">
              Orden para el pedido{" "}
              <Link href={`/pedidos/${requirement.order.id}`}>{requirement.order.code}</Link>:
              faltan {formatQuantity(requirement.quantity, requirement.unit.symbol)} de{" "}
              {requirement.product.name} para la entrega del{" "}
              {formatLocalDateTime(requirement.order.requestedAtLocal)}. Podés ajustar cantidad y
              fecha; la orden queda vinculada al pedido.
            </p>
          )}
          <section className="panel">
            <div className="form-grid">
              <div className="form__field">
                <label htmlFor="f-productId">Producto {!operationalOnly && required}</label>
                {operationalOnly ? (
                  <p>{existing?.product.name}</p>
                ) : (
                  <Combobox
                    id="f-productId"
                    options={productOptions}
                    value={form.productId}
                    placeholder="Buscar producto por nombre"
                    required
                    invalid={Boolean(fieldErrors.productId)}
                    describedBy={fieldErrors.productId ? "f-productId-error" : undefined}
                    emptyText="Ningún producto con stock coincide"
                    onChange={(value) => {
                      set("productId", value);
                      set("plannedOutputUnitId", "");
                      set("recipeVersionId", "");
                    }}
                  />
                )}
                {err("productId")}
              </div>
              <div className="form__field">
                <label htmlFor="f-scheduledFor">
                  Fecha programada {!operationalOnly && required}
                </label>
                {operationalOnly ? (
                  <p>{formatDate(form.scheduledFor)}</p>
                ) : (
                  <input
                    type="date"
                    aria-required
                    {...field("scheduledFor")}
                    value={form.scheduledFor}
                    onChange={(e) => set("scheduledFor", e.target.value)}
                  />
                )}
                {err("scheduledFor")}
              </div>
              <div className="form__field">
                <label htmlFor="f-plannedOutputQuantity">
                  Cantidad a producir {!operationalOnly && required}
                </label>
                {operationalOnly && existing ? (
                  <p>
                    {formatQuantity(
                      existing.plannedOutputQuantity,
                      existing.plannedOutputUnit.symbol,
                    )}
                  </p>
                ) : (
                  <div className="input-group">
                    <input
                      inputMode="decimal"
                      autoComplete="off"
                      aria-required
                      {...field("plannedOutputQuantity")}
                      value={form.plannedOutputQuantity}
                      onChange={(e) => set("plannedOutputQuantity", e.target.value)}
                      placeholder="Ej.: 100"
                    />
                    <select
                      aria-label="Unidad de la cantidad"
                      value={outputUnitId}
                      onChange={(e) => set("plannedOutputUnitId", e.target.value)}
                      disabled={!product}
                    >
                      {outputUnits.length === 0 && <option value="">—</option>}
                      {outputUnits.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.symbol}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {err("plannedOutputQuantity")}
                {err("plannedOutputUnitId")}
              </div>
              <div className="form__field">
                <label htmlFor="f-recipeVersionId">Receta</label>
                {operationalOnly && existing ? (
                  <p>
                    {existing.recipe.name} · versión {existing.recipeVersion.versionNumber}
                  </p>
                ) : (
                  <select
                    {...field("recipeVersionId", true)}
                    value={form.recipeVersionId}
                    onChange={(e) => set("recipeVersionId", e.target.value)}
                    disabled={!product}
                  >
                    <option value="">Vigente para la fecha (sugerida)</option>
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                )}
                {!operationalOnly && (
                  <span className="form__hint" id="f-recipeVersionId-hint">
                    {product
                      ? "Cambiala sólo si hay que producir con otra versión."
                      : "Primero elegí el producto."}
                  </span>
                )}
                {err("recipeVersionId")}
              </div>
              <div className="form__field">
                <label htmlFor="f-sourceWarehouseId">
                  Depósito de materias primas {!operationalOnly && required}
                </label>
                {operationalOnly ? (
                  <p>{existing?.sourceWarehouse.name}</p>
                ) : (
                  <select
                    aria-required
                    {...field("sourceWarehouseId", true)}
                    value={form.sourceWarehouseId}
                    onChange={(e) => set("sourceWarehouseId", e.target.value)}
                  >
                    <option value="">Elegí un depósito</option>
                    {catalog.warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                )}
                {!operationalOnly && (
                  <span className="form__hint" id="f-sourceWarehouseId-hint">
                    De acá se descuentan los ingredientes al completar.
                  </span>
                )}
                {err("sourceWarehouseId")}
              </div>
              <div className="form__field">
                <label htmlFor="f-outputWarehouseId">
                  Depósito de producto terminado {!operationalOnly && required}
                </label>
                {operationalOnly ? (
                  <p>{existing?.outputWarehouse.name}</p>
                ) : (
                  <select
                    aria-required
                    {...field("outputWarehouseId", true)}
                    value={form.outputWarehouseId}
                    onChange={(e) => set("outputWarehouseId", e.target.value)}
                  >
                    <option value="">Elegí un depósito</option>
                    {catalog.warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                )}
                {!operationalOnly && (
                  <span className="form__hint" id="f-outputWarehouseId-hint">
                    Acá entra el lote producido.
                  </span>
                )}
                {err("outputWarehouseId")}
              </div>
              <div className="form__field">
                <label htmlFor="f-responsibleEmployeeId">Responsable</label>
                <select
                  {...field("responsibleEmployeeId")}
                  value={form.responsibleEmployeeId}
                  onChange={(e) => set("responsibleEmployeeId", e.target.value)}
                >
                  <option value="">Sin asignar</option>
                  {catalog.responsibles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                {err("responsibleEmployeeId")}
              </div>
              <div className="form__field">
                <label htmlFor="f-batchCode">Lote</label>
                <input
                  {...field("batchCode", true)}
                  value={form.batchCode}
                  autoComplete="off"
                  onChange={(e) => set("batchCode", e.target.value)}
                  maxLength={40}
                />
                <span className="form__hint" id="f-batchCode-hint">
                  Opcional. Si lo dejás vacío se genera al planificar.
                </span>
                {err("batchCode")}
              </div>
              <div className="form__field form__field--full">
                <label htmlFor="f-notes">Notas</label>
                <textarea
                  {...field("notes")}
                  value={form.notes}
                  onChange={(e) => set("notes", e.target.value)}
                  rows={2}
                  maxLength={1000}
                />
                {err("notes")}
              </div>
            </div>
          </section>

          {!operationalOnly && <PlanSummary preview={preview} error={previewError} ready={ready} />}
          {!operationalOnly && (
            <p className="muted small">
              <span aria-hidden="true">*</span> Obligatorio. Se guarda como borrador: la receta, las
              cantidades y el lote se fijan al planificar.
            </p>
          )}

          {formError && (
            <p className="form__error" role="alert">
              {formError}
            </p>
          )}
          <div className="form__footer">
            <button type="submit" className="button button--primary" disabled={pending}>
              {pending ? "Guardando…" : existing ? "Guardar cambios" : "Crear borrador"}
            </button>
            <Link
              className="button"
              href={existing ? `${PRODUCTION_BASE}/${existing.id}` : PRODUCTION_BASE}
            >
              Cancelar
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}

/** Resumen del plan calculado por la API para los datos del formulario. */
function PlanSummary({
  preview,
  error,
  ready,
}: {
  preview: ProductionOrderDto | null;
  error: ApiError | null;
  ready: boolean;
}) {
  return (
    <section className="panel" aria-labelledby="plan-title" aria-live="polite">
      <h2 id="plan-title">Resumen del plan</h2>
      {!ready ? (
        <p className="muted">
          Completá producto, fecha, cantidad y depósitos para ver la receta, los ingredientes y la
          disponibilidad.
        </p>
      ) : error ? (
        <div className="alert alert--warn" role="status">
          {Object.values(error.fieldErrors)[0] ?? describeError(error)}
        </div>
      ) : !preview ? (
        <Loading />
      ) : (
        <>
          <dl className="cost-summary">
            <div>
              <dt>Receta</dt>
              <dd>
                {preview.recipe.name} · versión {preview.recipeVersion.versionNumber}
              </dd>
            </div>
            <div>
              <dt>Rinde por tanda</dt>
              <dd>
                {formatQuantity(
                  preview.recipeVersion.yieldQuantity,
                  preview.recipeVersion.yieldUnit.symbol,
                )}
              </dd>
            </div>
            <div>
              <dt>Escala</dt>
              <dd>{formatFactor(preview.scaleFactor)}</dd>
            </div>
          </dl>
          {preview.issues.length > 0 && (
            <div className="alert alert--warn" role="status">
              <ul>
                {preview.issues.map((i) => (
                  <li key={i.code}>{i.message}</li>
                ))}
              </ul>
            </div>
          )}
          {preview.availability && (
            <AvailabilityTable availability={preview.availability} buyInNewTab />
          )}
          <ProductionCosts order={preview} embedded />
        </>
      )}
    </section>
  );
}
