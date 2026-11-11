"use client";

import {
  FULFILLMENT_TYPES,
  FULFILLMENT_TYPE_LABELS,
  ORDER_PRIORITIES,
  ORDER_PRIORITY_LABELS,
  PERMISSIONS as P,
  PRICE_SOURCE_LABELS,
  REQUESTED_CONSERVATIONS,
  REQUESTED_CONSERVATION_LABELS,
  type CoveragePreviewDto,
  type CustomerDto,
  type OrderDetailDto,
  type OrderLineInput,
  type ProductDto,
  type RequestedConservationDto,
  type ResolvedPriceDto,
  type UnitDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { isPositive, parseDecimal, toDecimal } from "@/lib/decimal-input";
import { describeError } from "@/lib/errors";
import { formatMoney, formatQuantity } from "@/lib/format";
import { EmptyState, ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { compatibleUnits, useUnits } from "../production/production-shared";
import { Combobox, type ComboOption } from "../ui/combobox";
import { useFlash } from "../ui/flash";
import { Icon } from "../ui/icons";
import { LineField, LineList, LineRow } from "../ui/lines";
import { useCan, useCurrentUser } from "../user-context";
import {
  CoverageBadge,
  LineCoverage,
  MaterialProjection,
  ORDERS_BASE,
  WallClockInput,
  formatWallClock,
  isCompleteWallClock,
  wallClockIn,
} from "./order-shared";

/*
 * Alta y edición de pedidos. Lo obligatorio arriba (cliente, para cuándo,
 * productos); el resto (evento, contacto, prioridad, notas) es opcional.
 * Mientras se carga, la API calcula una vista previa de cobertura (no guarda ni
 * reserva nada): qué hay disponible, qué se reservaría y qué falta producir.
 * El total es estimado con el precio vigente del cliente: el precio queda
 * acordado al CONFIRMAR el pedido, desde el detalle. El borrador no reserva.
 */

export interface LineDraft {
  key: string;
  id?: string;
  productId: string;
  quantity: string;
  unitId: string;
  requestedConservation: RequestedConservationDto;
}

export interface OrderCatalog {
  customers: CustomerDto[];
  products: ProductDto[];
  units: UnitDto[];
  /** No se pudo cargar el catálogo (mensaje para el usuario). */
  error?: string | null;
}

export function useOrderCatalog(): OrderCatalog | null {
  const units = useUnits();
  const [rest, setRest] = useState<Omit<OrderCatalog, "units"> | null>(null);
  useEffect(() => {
    Promise.all([
      fetchOptions<CustomerDto>("/api/customers").catch(() => []),
      fetchOptions<ProductDto>("/api/products"),
    ])
      .then(([customers, products]) => setRest({ customers, products, error: null }))
      .catch((err: unknown) =>
        setRest({
          customers: [],
          products: [],
          error:
            err instanceof ApiError ? describeError(err) : "No se pudieron cargar los productos.",
        }),
      );
  }, []);
  return rest && units ? { ...rest, units } : null;
}

let keySeq = 0;
export const newLine = (): LineDraft => ({
  key: `l${++keySeq}`,
  productId: "",
  quantity: "",
  unitId: "",
  requestedConservation: "ANY",
});

const plain = (v: string) => v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

export const linesFromOrder = (order: OrderDetailDto): LineDraft[] =>
  order.lines.map((l) => ({
    key: `l${++keySeq}`,
    id: l.id,
    productId: l.product.id,
    quantity: plain(l.requestedQuantity),
    unitId: l.unit.id,
    requestedConservation: l.requestedConservation,
  }));

export const lineReady = (l: LineDraft) => l.productId !== "" && isPositive(l.quantity);

export function linePayload(lines: LineDraft[], catalog: OrderCatalog): OrderLineInput[] {
  return lines.map((l) => {
    const product = catalog.products.find((p) => p.id === l.productId);
    return {
      id: l.id ?? null,
      productId: l.productId,
      quantity: toDecimal(l.quantity),
      unitId: l.unitId || product?.saleUnit.id || null,
      requestedConservation: l.requestedConservation,
      priceOverrideReason: null,
      notes: null,
    };
  });
}

/** Precio vigente por producto (lista del cliente, lista general o precio del producto). */
export type PriceMap = Map<string, ResolvedPriceDto>;

/** Importe estimado de una línea: sólo si la cantidad está en la unidad de venta. */
function lineAmount(
  line: LineDraft,
  product: ProductDto | undefined,
  prices: PriceMap | null,
): InstanceType<typeof D> | null {
  if (!product || !prices) return null;
  const price = prices.get(product.id);
  const qty = parseDecimal(line.quantity);
  if (!price || !qty) return null;
  if (line.unitId && line.unitId !== product.saleUnit.id) return null;
  return qty.times(price.unitPrice);
}

/** Editor de productos del pedido (alta, borrador y replanificación). */
export function LinesEditor({
  lines,
  onChange,
  catalog,
  errors,
  lockedProducts = false,
  prices = null,
  currency = "ARS",
}: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  catalog: OrderCatalog;
  errors: Record<string, string>;
  /** Replanificación: una línea existente no cambia de producto. */
  lockedProducts?: boolean;
  /** Precios vigentes (null: no se muestran precios). */
  prices?: PriceMap | null;
  currency?: string;
}) {
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const productOptions = useMemo<ComboOption[]>(
    () =>
      catalog.products.map((p) => ({
        value: p.id,
        label: p.name,
        detail: p.code,
        keywords: p.code,
      })),
    [catalog.products],
  );
  const update = (key: string, patch: Partial<LineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => {
    const line = newLine();
    onChange([...lines, line]);
    setFocusKey(line.key);
  };
  const seePrices = prices !== null;
  const head = ["Producto", "Cantidad", "Conservación", ...(seePrices ? ["Importe"] : [])];

  if (catalog.products.length === 0) {
    return (
      <EmptyState
        compact
        title="No hay productos activos para pedir"
        description="Los productos se dan de alta en Catálogo → Productos."
      />
    );
  }

  return (
    <>
      <div className={seePrices ? undefined : "ped-lines--no-price"}>
        <LineList label="Productos del pedido" head={head} variant="no-discount">
          {lines.map((line, i) => {
            const n = i + 1;
            const product = catalog.products.find((p) => p.id === line.productId);
            const units = product ? compatibleUnits(catalog.units, product.saleUnit.id) : [];
            const err = (field: string) => errors[`lines.${i}.${field}`];
            const locked = lockedProducts && Boolean(line.id);
            const price = product ? prices?.get(product.id) : undefined;
            const amount = lineAmount(line, product, prices);
            const lineError = err("productId") ?? err("quantity") ?? err("unitId");
            return (
              <LineRow
                key={line.key}
                testId={`order-line-${n}`}
                removeLabel={`Quitar producto ${n}`}
                canRemove={lines.length > 1}
                onRemove={() => onChange(lines.filter((l) => l.key !== line.key))}
                meta={
                  (price || locked || lineError) && (
                    <>
                      {price && product && (
                        <span>
                          Precio vigente {formatMoney(price.unitPrice, currency)} /{" "}
                          {product.saleUnit.symbol} · {PRICE_SOURCE_LABELS[price.source]}
                        </span>
                      )}
                      {locked && (
                        <span>
                          El producto de una línea ya confirmada no se cambia: quitala y agregá
                          otra.
                        </span>
                      )}
                      {lineError && (
                        <span className="form__error" id={`order-line-${n}-error`} role="alert">
                          {lineError}
                        </span>
                      )}
                    </>
                  )
                }
              >
                <LineField label="Producto" htmlFor={`order-product-${n}`} product>
                  {locked ? (
                    <span id={`order-product-${n}`} style={{ paddingTop: "0.5rem" }}>
                      {product?.name ?? "—"}
                    </span>
                  ) : (
                    <Combobox
                      id={`order-product-${n}`}
                      ariaLabel={`Producto ${n}`}
                      options={productOptions}
                      value={line.productId}
                      autoFocus={focusKey === line.key}
                      required
                      placeholder="Buscar producto por nombre o código"
                      invalid={Boolean(err("productId"))}
                      describedBy={err("productId") ? `order-line-${n}-error` : undefined}
                      onChange={(v) => update(line.key, { productId: v, unitId: "" })}
                    />
                  )}
                </LineField>
                <LineField label="Cantidad" htmlFor={`order-qty-${n}`}>
                  <div className="input-group">
                    <input
                      id={`order-qty-${n}`}
                      className="control"
                      inputMode="decimal"
                      aria-label={`Cantidad ${n}`}
                      aria-required="true"
                      value={line.quantity}
                      placeholder="0"
                      aria-invalid={err("quantity") ? true : undefined}
                      aria-describedby={err("quantity") ? `order-line-${n}-error` : undefined}
                      onChange={(e) => update(line.key, { quantity: e.target.value })}
                    />
                    <select
                      aria-label={`Unidad ${n}`}
                      value={line.unitId || product?.saleUnit.id || ""}
                      disabled={!product}
                      onChange={(e) => update(line.key, { unitId: e.target.value })}
                    >
                      {units.length === 0 && <option value="">—</option>}
                      {units.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.symbol}
                        </option>
                      ))}
                    </select>
                  </div>
                </LineField>
                <LineField label="Conservación" htmlFor={`order-conservation-${n}`}>
                  <select
                    id={`order-conservation-${n}`}
                    aria-label={`Conservación ${n}`}
                    value={line.requestedConservation}
                    onChange={(e) =>
                      update(line.key, {
                        requestedConservation: e.target.value as RequestedConservationDto,
                      })
                    }
                  >
                    {REQUESTED_CONSERVATIONS.map((c) => (
                      <option key={c} value={c}>
                        {REQUESTED_CONSERVATION_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </LineField>
                {seePrices && (
                  <LineField label="Importe" amount>
                    <span data-testid={`order-line-amount-${n}`}>
                      {amount ? formatMoney(amount.toFixed(2), currency) : "—"}
                    </span>
                  </LineField>
                )}
              </LineRow>
            );
          })}
        </LineList>
      </div>
      <div className="lines__footer">
        <button type="button" className="button button--small" onClick={addLine}>
          <Icon name="plus" size="sm" />
          Agregar producto
        </button>
      </div>
    </>
  );
}

/** Precio vigente de los productos elegidos para el cliente (sólo con permiso de precios). */
function usePrices(
  productIds: string[],
  customerId: string,
  enabled: boolean,
): { prices: PriceMap | null; loading: boolean } {
  const ids = [...new Set(productIds.filter(Boolean))].sort().join(",");
  const key = enabled && ids ? `${ids}|${customerId}` : "";
  const [state, setState] = useState<{ key: string; prices: PriceMap } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const qs = new URLSearchParams({ productIds: ids });
    if (customerId) qs.set("customerId", customerId);
    apiFetch<ResolvedPriceDto[]>(`/api/price-lists/resolve?${qs.toString()}`)
      .then((items) => {
        if (!cancelled) setState({ key, prices: new Map(items.map((p) => [p.productId, p])) });
      })
      .catch(() => {
        if (!cancelled) setState({ key, prices: new Map() });
      });
    return () => {
      cancelled = true;
    };
  }, [key, ids, customerId]);
  if (!enabled) return { prices: null, loading: false };
  // Mientras llegan los precios nuevos se conservan los anteriores (sin parpadeo).
  return { prices: state?.prices ?? new Map(), loading: key !== "" && state?.key !== key };
}

/** Vista previa en vivo: la API calcula y no guarda nada. */
export function useCoveragePreview(
  body: { requestedAt: string; lines: OrderLineInput[] } | null,
  endpoint = "/api/orders/coverage-preview",
) {
  const key = body ? JSON.stringify(body) : "";
  const [state, setState] = useState<{
    key: string;
    data: CoveragePreviewDto | null;
    error: ApiError | null;
  } | null>(null);
  useEffect(() => {
    if (!body) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetch<CoveragePreviewDto>(endpoint, { method: "POST", body })
        .then((data) => !cancelled && setState({ key, data, error: null }))
        .catch(
          (err: unknown) =>
            !cancelled &&
            setState({
              key,
              data: null,
              error:
                err instanceof ApiError
                  ? err
                  : new ApiError(0, "UNKNOWN", "No se pudo calcular la cobertura."),
            }),
        );
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state?.key === key ? state : null;
}

/** Cobertura (vista previa): compacta por producto; la materia prima, plegada. */
export function CoveragePreview({ preview }: { preview: CoveragePreviewDto }) {
  const short = preview.materials.filter((m) => new D(m.projectedShortage).gt(0)).length;
  return (
    <section className="panel" aria-labelledby="preview-title" aria-live="polite">
      <div className="panel__header">
        <h2 id="preview-title">
          Cobertura para el {formatWallClock(preview.requestedAtLocal)}{" "}
          <CoverageBadge coverage={preview.coverageStatus} />
        </h2>
      </div>
      <p className="muted small">
        Vista previa: no reserva nada. Al confirmar se vuelve a calcular con el stock de ese
        momento.
      </p>
      <div className="cards">
        {preview.lines.map((line, i) => (
          <LineCoverage key={`${line.product.id}-${i}`} line={line} />
        ))}
      </div>
      {preview.materials.length > 0 && (
        <details>
          <summary>
            Materia prima para producir lo que falta ({preview.materials.length}
            {short > 0 ? `, ${short} con faltante` : ""})
          </summary>
          <MaterialProjection materials={preview.materials} />
        </details>
      )}
    </section>
  );
}

interface Form {
  customerId: string;
  requestedAt: string;
  fulfillmentType: (typeof FULFILLMENT_TYPES)[number];
  deliveryAddress: string;
  contactName: string;
  contactPhone: string;
  eventName: string;
  priority: (typeof ORDER_PRIORITIES)[number];
  notes: string;
}

export function OrderForm({ id }: { id?: string }) {
  return (
    <Suspense fallback={<Loading label="Preparando el pedido…" />}>
      <OrderFormInner id={id} />
    </Suspense>
  );
}

function OrderFormInner({ id }: { id?: string }) {
  const params = useSearchParams();
  const can = useCan();
  const catalog = useOrderCatalog();
  const { data: existing, error } = useResource<OrderDetailDto>(id ? `/api/orders/${id}` : null);
  const allowed = id ? can(P.ORDERS_UPDATE) : can(P.ORDERS_CREATE);
  if (!allowed) {
    return (
      <section className="panel">
        <EmptyState
          title={
            id ? "No tenés permiso para editar pedidos" : "No tenés permiso para tomar pedidos"
          }
          description="Pedile a un administrador que te asigne el rol de Ventas."
          action={
            <Link className="button" href={id ? `${ORDERS_BASE}/${id}` : ORDERS_BASE}>
              {id ? "Volver al pedido" : "Ver pedidos"}
            </Link>
          }
        />
      </section>
    );
  }
  if (error) return <ErrorState error={error} />;
  if (!catalog || (id && !existing)) return <Loading label="Preparando el pedido…" />;
  if (existing?.status === "CANCELLED" || existing?.status === "DELIVERED") {
    return (
      <section className="panel">
        <EmptyState
          title={`El pedido ${existing.code} está ${existing.status === "CANCELLED" ? "cancelado" : "entregado"}`}
          description="Ya no se modifica."
          action={
            <Link className="button" href={`${ORDERS_BASE}/${existing.id}`}>
              Volver al pedido
            </Link>
          }
        />
      </section>
    );
  }
  return (
    <OrderEditor
      catalog={catalog}
      existing={existing ?? null}
      initialCustomerId={params.get("clienteId")}
    />
  );
}

function Required() {
  return (
    <span className="form__required" aria-hidden="true">
      {" "}
      *
    </span>
  );
}

function OrderEditor({
  catalog,
  existing,
  initialCustomerId,
}: {
  catalog: OrderCatalog;
  existing: OrderDetailDto | null;
  initialCustomerId: string | null;
}) {
  const router = useRouter();
  const flash = useFlash();
  const can = useCan();
  const user = useCurrentUser();
  const tz = user.company.timezone;
  const currency = existing?.currency ?? user.company.currencyCode;
  const seePrices = can(P.PRICE_LISTS_READ);
  const infoOnly = existing !== null && existing.status !== "DRAFT";
  const [form, setForm] = useState<Form>(() => ({
    customerId:
      existing?.customer.id ??
      (initialCustomerId && catalog.customers.some((c) => c.id === initialCustomerId)
        ? initialCustomerId
        : ""),
    requestedAt: existing?.requestedAtLocal ?? wallClockIn(tz, 1),
    fulfillmentType: existing?.fulfillmentType ?? "PICKUP",
    deliveryAddress: existing?.deliveryAddress ?? "",
    contactName: existing?.contactName ?? "",
    contactPhone: existing?.contactPhone ?? "",
    eventName: existing?.eventName ?? "",
    priority: existing?.priority ?? "NORMAL",
    notes: existing?.notes ?? "",
  }));
  const [lines, setLines] = useState<LineDraft[]>(() =>
    existing ? linesFromOrder(existing) : [newLine()],
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const customerOptions = useMemo<ComboOption[]>(
    () =>
      catalog.customers.map((c) => ({
        value: c.id,
        label: c.tradeName ?? c.legalName,
        detail: c.walkIn ? "Mostrador" : (c.taxId ?? c.code),
        keywords: `${c.code} ${c.legalName} ${c.taxId ?? ""}`,
      })),
    [catalog.customers],
  );

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((e) => {
      const { [key]: _removed, ...rest } = e;
      return rest;
    });
  };

  const { prices, loading: pricesLoading } = usePrices(
    lines.map((l) => l.productId),
    form.customerId,
    seePrices && !infoOnly,
  );
  const filled = lines.filter(lineReady);
  const total = filled.reduce<InstanceType<typeof D> | null>((sum, l) => {
    const amount = lineAmount(
      l,
      catalog.products.find((p) => p.id === l.productId),
      prices,
    );
    return sum && amount ? sum.plus(amount) : null;
  }, new D(0));

  const previewReady =
    !infoOnly &&
    isCompleteWallClock(form.requestedAt) &&
    lines.length > 0 &&
    lines.every(lineReady);
  const preview = useCoveragePreview(
    previewReady ? { requestedAt: form.requestedAt, lines: linePayload(lines, catalog) } : null,
  );

  const info = () => ({
    fulfillmentType: form.fulfillmentType,
    deliveryAddress:
      form.fulfillmentType === "DELIVERY" ? form.deliveryAddress.trim() || null : null,
    contactName: form.contactName.trim() || null,
    contactPhone: form.contactPhone.trim() || null,
    eventName: form.eventName.trim() || null,
    priority: form.priority,
    notes: form.notes.trim() || null,
  });

  function validate() {
    const errors: Record<string, string> = {};
    if (infoOnly) return errors;
    if (!form.customerId) errors.customerId = "Elegí el cliente";
    if (!isCompleteWallClock(form.requestedAt)) errors.requestedAt = "Indicá fecha y hora";
    lines.forEach((l, i) => {
      if (!l.productId) errors[`lines.${i}.productId`] = "Elegí el producto";
      else if (!isPositive(l.quantity)) errors[`lines.${i}.quantity`] = "Cantidad mayor que cero";
    });
    return errors;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) {
      setFormError("Revisá los campos marcados.");
      return;
    }
    setPending(true);
    try {
      const body = infoOnly
        ? info()
        : {
            customerId: form.customerId,
            requestedAt: form.requestedAt,
            ...info(),
            lines: linePayload(lines, catalog),
          };
      const saved = await apiFetch<OrderDetailDto>(
        existing ? `/api/orders/${existing.id}` : "/api/orders",
        { method: existing ? "PATCH" : "POST", body },
      );
      if (!existing)
        flash(`Pedido ${saved.code} guardado como borrador. Confirmalo para reservar el stock.`, {
          afterNavigation: true,
        });
      router.push(`${ORDERS_BASE}/${saved.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setFormError(describeError(err));
      } else setFormError("No se pudo guardar el pedido.");
      setPending(false);
    }
  }

  const err = (name: string) =>
    fieldErrors[name] ? (
      <span className="form__error" id={`f-${name}-error`}>
        {fieldErrors[name]}
      </span>
    ) : null;
  const describedBy = (name: string) => (fieldErrors[name] ? `f-${name}-error` : undefined);
  const title = existing ? `Editar pedido ${existing.code}` : "Nuevo pedido";
  const cancelHref = existing ? `${ORDERS_BASE}/${existing.id}` : ORDERS_BASE;
  const agreedTotal = existing?.commercial.quotedTotal ?? null;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={
          existing
            ? [
                { href: ORDERS_BASE, label: "Pedidos" },
                { href: `${ORDERS_BASE}/${existing.id}`, label: existing.code },
              ]
            : { href: ORDERS_BASE, label: "Pedidos" }
        }
        title={title}
        subtitle={
          infoOnly
            ? "El pedido está confirmado: acá se cambian entrega, contacto, prioridad y notas. La fecha y los productos se cambian con «Modificar pedido»."
            : "Se guarda como borrador: no reserva stock hasta que lo confirmes."
        }
      />
      {catalog.error && (
        <p className="alert" role="alert">
          {catalog.error}
        </p>
      )}
      <form className="form" onSubmit={submit} noValidate aria-label={title}>
        <section className="panel" aria-labelledby="order-main-title">
          <h2 id="order-main-title" className="sr-only">
            Cliente y entrega
          </h2>
          <div className="form-grid">
            <div className="form__field">
              {infoOnly && existing ? (
                <>
                  <span className="form__label">Cliente</span>
                  <p>{existing.customer.name}</p>
                </>
              ) : (
                <>
                  <label htmlFor="f-customerId">
                    Cliente
                    <Required />
                  </label>
                  <Combobox
                    id="f-customerId"
                    options={customerOptions}
                    value={form.customerId}
                    onChange={(v) => set("customerId", v)}
                    placeholder="Buscar cliente por nombre o CUIT"
                    required
                    invalid={Boolean(fieldErrors.customerId)}
                    describedBy={describedBy("customerId")}
                    emptyText="Ningún cliente coincide"
                  />
                  {can(P.CUSTOMERS_CREATE) && !fieldErrors.customerId && (
                    <span className="form__hint">
                      ¿Cliente nuevo? <Link href="/clientes/nuevo">Dalo de alta</Link> y volvé a
                      cargar el pedido.
                    </span>
                  )}
                </>
              )}
              {err("customerId")}
            </div>
            <div className="form__field">
              {infoOnly && existing ? (
                <>
                  <span className="form__label">Para cuándo</span>
                  <p>{formatWallClock(existing.requestedAtLocal)}</p>
                </>
              ) : (
                <>
                  <label htmlFor="f-requestedAt">
                    Entrega o retiro
                    <Required />
                  </label>
                  <WallClockInput
                    id="f-requestedAt"
                    value={form.requestedAt}
                    timeZone={tz}
                    invalid={!!fieldErrors.requestedAt}
                    describedBy={describedBy("requestedAt")}
                    onChange={(v) => set("requestedAt", v)}
                  />
                </>
              )}
              {err("requestedAt")}
            </div>
            <div className="form__field">
              <label htmlFor="f-fulfillmentType">Modalidad</label>
              <select
                id="f-fulfillmentType"
                value={form.fulfillmentType}
                onChange={(e) => set("fulfillmentType", e.target.value as Form["fulfillmentType"])}
              >
                {FULFILLMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t === "PICKUP" ? "Retira el cliente" : "Se entrega"}
                  </option>
                ))}
              </select>
            </div>
            {form.fulfillmentType === "DELIVERY" && (
              <div className="form__field">
                <label htmlFor="f-deliveryAddress">Dirección de entrega</label>
                <input
                  id="f-deliveryAddress"
                  value={form.deliveryAddress}
                  aria-invalid={fieldErrors.deliveryAddress ? true : undefined}
                  aria-describedby={describedBy("deliveryAddress")}
                  onChange={(e) => set("deliveryAddress", e.target.value)}
                />
                {err("deliveryAddress")}
              </div>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="lines-title">
          <div className="panel__header">
            <h2 id="lines-title">
              Productos
              {!infoOnly && <Required />}
            </h2>
          </div>
          {infoOnly && existing ? (
            <>
              <ul className="plain-list">
                {existing.lines.map((l) => (
                  <li key={l.id}>
                    {formatQuantity(l.requestedQuantity, l.unit.symbol)} de {l.product.name}
                  </li>
                ))}
              </ul>
              {existing.actions.canReplan && (
                <p className="muted small">
                  ¿Cambió la fecha o lo que pidió?{" "}
                  <Link href={`${ORDERS_BASE}/${existing.id}/modificar`}>
                    Modificar fecha o productos
                  </Link>
                </p>
              )}
            </>
          ) : (
            <LinesEditor
              lines={lines}
              onChange={setLines}
              catalog={catalog}
              errors={fieldErrors}
              prices={prices}
              currency={currency}
            />
          )}
        </section>

        {!infoOnly &&
          (preview?.data ? (
            <CoveragePreview preview={preview.data} />
          ) : preview?.error ? (
            <p className="alert alert--warn" role="status">
              No se pudo calcular la cobertura: {describeError(preview.error)}
            </p>
          ) : previewReady ? (
            <Loading label="Calculando la cobertura…" />
          ) : (
            <p className="muted small">
              Completá fecha y productos para ver qué hay disponible, qué se reservaría y qué falta
              producir.
            </p>
          ))}

        <section className="panel" aria-labelledby="order-extra-title">
          <h2 id="order-extra-title">Evento y contacto</h2>
          <p className="muted small">Opcional.</p>
          <div className="form-grid">
            <div className="form__field">
              <label htmlFor="f-eventName">Evento</label>
              <input
                id="f-eventName"
                value={form.eventName}
                placeholder="Ej.: Casamiento García"
                onChange={(e) => set("eventName", e.target.value)}
              />
            </div>
            <div className="form__field">
              <label htmlFor="f-contactName">Contacto</label>
              <input
                id="f-contactName"
                value={form.contactName}
                onChange={(e) => set("contactName", e.target.value)}
              />
            </div>
            <div className="form__field">
              <label htmlFor="f-contactPhone">Teléfono de contacto</label>
              <input
                id="f-contactPhone"
                inputMode="tel"
                value={form.contactPhone}
                onChange={(e) => set("contactPhone", e.target.value)}
              />
            </div>
            <div className="form__field">
              <label htmlFor="f-priority">Prioridad</label>
              <select
                id="f-priority"
                value={form.priority}
                onChange={(e) => set("priority", e.target.value as Form["priority"])}
              >
                {ORDER_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {ORDER_PRIORITY_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="form__field">
            <label htmlFor="f-notes">Notas</label>
            <textarea
              id="f-notes"
              rows={2}
              value={form.notes}
              maxLength={2000}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>
        </section>

        {formError && (
          <p className="alert" role="alert">
            {formError}
          </p>
        )}
        <div className="total-bar">
          <div>
            {seePrices ? (
              <>
                <div className="total-bar__label">
                  {infoOnly
                    ? agreedTotal
                      ? "Total acordado"
                      : "Sin precio acordado"
                    : "Total estimado (precio vigente; se acuerda al confirmar)"}
                </div>
                <div className="total-bar__amount" data-testid="order-total" aria-live="polite">
                  {infoOnly
                    ? formatMoney(agreedTotal, currency)
                    : total
                      ? formatMoney(total.toFixed(2), currency)
                      : filled.length === 0
                        ? formatMoney("0", currency)
                        : pricesLoading
                          ? "Calculando…"
                          : "Se calcula al confirmar"}
                </div>
              </>
            ) : (
              <div className="total-bar__label">
                {FULFILLMENT_TYPE_LABELS[form.fulfillmentType]}
                {isCompleteWallClock(form.requestedAt)
                  ? ` el ${formatWallClock(form.requestedAt)}`
                  : ""}{" "}
                · {filled.length} {filled.length === 1 ? "producto" : "productos"}
              </div>
            )}
          </div>
          <div className="actions">
            <Link href={cancelHref} className="button button--tertiary">
              Cancelar
            </Link>
            <button
              type="submit"
              className="button button--primary"
              disabled={pending}
              aria-busy={pending || undefined}
            >
              {pending ? "Guardando…" : existing ? "Guardar cambios" : "Guardar borrador"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
