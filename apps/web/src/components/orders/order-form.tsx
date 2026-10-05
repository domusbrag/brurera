"use client";

import {
  FULFILLMENT_TYPES,
  FULFILLMENT_TYPE_LABELS,
  ORDER_PRIORITIES,
  ORDER_PRIORITY_LABELS,
  PERMISSIONS as P,
  REQUESTED_CONSERVATIONS,
  REQUESTED_CONSERVATION_LABELS,
  type CoveragePreviewDto,
  type CustomerDto,
  type OrderDetailDto,
  type OrderLineInput,
  type ProductDto,
  type RequestedConservationDto,
  type UnitDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { isPositive, toDecimal } from "@/lib/decimal-input";
import { formatMoney, formatQuantity } from "@/lib/format";
import { ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { compatibleUnits, useUnits } from "../production/production-shared";
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
 * Alta y edición de pedidos (Fase 5A). Mientras se carga, la API calcula una
 * vista previa de cobertura (no guarda ni reserva nada): qué hay, qué sirve
 * para la fecha, qué está comprometido, qué se reservaría y qué falta producir.
 * El borrador no reserva: reservar es CONFIRMAR, desde el detalle.
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
}

export function useOrderCatalog(): OrderCatalog | null {
  const units = useUnits();
  const [rest, setRest] = useState<Omit<OrderCatalog, "units"> | null>(null);
  useEffect(() => {
    Promise.all([
      fetchOptions<CustomerDto>("/api/customers").catch(() => []),
      fetchOptions<ProductDto>("/api/products"),
    ])
      .then(([customers, products]) => setRest({ customers, products }))
      .catch(() => setRest({ customers: [], products: [] }));
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

/** Editor de productos del pedido (alta, borrador y replanificación). */
export function LinesEditor({
  lines,
  onChange,
  catalog,
  errors,
  lockedProducts = false,
}: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  catalog: OrderCatalog;
  errors: Record<string, string>;
  /** Replanificación: una línea existente no cambia de producto. */
  lockedProducts?: boolean;
}) {
  const update = (key: string, patch: Partial<LineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  return (
    <div className="table-wrap">
      <table className="table" aria-label="Productos del pedido">
        <thead>
          <tr>
            <th scope="col">Producto</th>
            <th scope="col">Cantidad</th>
            <th scope="col">Conservación</th>
            <th scope="col" className="hide-sm">
              Precio actual
            </th>
            <th scope="col">
              <span className="sr-only">Quitar</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => {
            const product = catalog.products.find((p) => p.id === line.productId);
            const units = product ? compatibleUnits(catalog.units, product.saleUnit.id) : [];
            const err = (field: string) => errors[`lines.${i}.${field}`];
            return (
              <tr key={line.key}>
                <td>
                  {lockedProducts && line.id ? (
                    product?.name
                  ) : (
                    <select
                      aria-label={`Producto ${i + 1}`}
                      value={line.productId}
                      aria-invalid={err("productId") ? true : undefined}
                      onChange={(e) => update(line.key, { productId: e.target.value, unitId: "" })}
                    >
                      <option value="">Elegí un producto</option>
                      {catalog.products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {err("productId") && <span className="form__error">{err("productId")}</span>}
                </td>
                <td>
                  <div className="input-group">
                    <input
                      inputMode="decimal"
                      aria-label={`Cantidad ${i + 1}`}
                      value={line.quantity}
                      placeholder="Ej.: 500"
                      aria-invalid={err("quantity") ? true : undefined}
                      onChange={(e) => update(line.key, { quantity: e.target.value })}
                    />
                    <select
                      aria-label={`Unidad ${i + 1}`}
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
                  {(err("quantity") || err("unitId")) && (
                    <span className="form__error">{err("quantity") ?? err("unitId")}</span>
                  )}
                </td>
                <td>
                  <select
                    aria-label={`Conservación ${i + 1}`}
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
                </td>
                <td className="hide-sm muted">
                  {product ? `${formatMoney(product.salePrice)} / ${product.saleUnit.symbol}` : "—"}
                </td>
                <td>
                  <button
                    type="button"
                    className="button button--small"
                    onClick={() => onChange(lines.filter((l) => l.key !== line.key))}
                    disabled={lines.length === 1}
                    aria-label={`Quitar producto ${i + 1}`}
                  >
                    Quitar
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" className="button" onClick={() => onChange([...lines, newLine()])}>
        Agregar producto
      </button>
      <p className="muted small">
        El precio es informativo (precio actual del producto): el precio final se define al vender.
      </p>
    </div>
  );
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
              error: err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Sin vista previa"),
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

export function CoveragePreview({ preview }: { preview: CoveragePreviewDto }) {
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
      <h3 className="section-title">Materias primas</h3>
      <MaterialProjection materials={preview.materials} />
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
  const catalog = useOrderCatalog();
  const { data: existing, error } = useResource<OrderDetailDto>(id ? `/api/orders/${id}` : null);
  if (error) return <ErrorState error={error} />;
  if (!catalog || (id && !existing)) return <Loading />;
  if (existing?.status === "CANCELLED") {
    return (
      <section className="panel panel--empty">
        <p className="upcoming">Este pedido está cancelado</p>
        <p className="muted">
          No se modifica. <Link href={`${ORDERS_BASE}/${existing.id}`}>Volver</Link>
        </p>
      </section>
    );
  }
  return <OrderEditor catalog={catalog} existing={existing ?? null} />;
}

function OrderEditor({
  catalog,
  existing,
}: {
  catalog: OrderCatalog;
  existing: OrderDetailDto | null;
}) {
  const router = useRouter();
  const can = useCan();
  const user = useCurrentUser();
  const tz = user.company.timezone;
  const infoOnly = existing !== null && existing.status !== "DRAFT";
  const [form, setForm] = useState<Form>(() => ({
    customerId: existing?.customer.id ?? "",
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

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((e) => {
      const { [key]: _removed, ...rest } = e;
      return rest;
    });
  };

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
      if (!isPositive(l.quantity)) errors[`lines.${i}.quantity`] = "Cantidad mayor que cero";
    });
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
      router.push(`${ORDERS_BASE}/${saved.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setFormError(err.message);
      } else setFormError("No se pudo guardar el pedido.");
      setPending(false);
    }
  }

  const allowed = existing ? can(P.ORDERS_UPDATE) : can(P.ORDERS_CREATE);
  const err = (name: string) =>
    fieldErrors[name] ? (
      <span className="form__error" id={`f-${name}-error`}>
        {fieldErrors[name]}
      </span>
    ) : null;
  const customers = catalog.customers;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={
          existing
            ? { href: `${ORDERS_BASE}/${existing.id}`, label: `Pedido ${existing.code}` }
            : { href: ORDERS_BASE, label: "Pedidos" }
        }
        title={existing ? `Editar pedido ${existing.code}` : "Nuevo pedido"}
        subtitle={
          infoOnly
            ? "El pedido está confirmado: acá se cambian contacto, entrega, prioridad y notas. Fecha y productos se cambian con «Modificar pedido»."
            : "Se guarda como borrador: no reserva stock hasta confirmarlo."
        }
      />
      {!allowed ? (
        <p className="notice">No tenés permiso para esta operación.</p>
      ) : (
        <form className="form" onSubmit={submit} noValidate>
          <section className="panel">
            <div className="form-grid">
              <div className="form__field">
                <label htmlFor="f-customerId">Cliente</label>
                {infoOnly ? (
                  <p>{existing?.customer.name}</p>
                ) : (
                  <select
                    id="f-customerId"
                    value={form.customerId}
                    aria-invalid={fieldErrors.customerId ? true : undefined}
                    onChange={(e) => set("customerId", e.target.value)}
                  >
                    <option value="">Elegí un cliente</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.tradeName ?? c.legalName}
                      </option>
                    ))}
                  </select>
                )}
                {err("customerId")}
              </div>
              <div className="form__field">
                <label htmlFor="f-requestedAt">Entrega o retiro</label>
                {infoOnly && existing ? (
                  <p>{formatWallClock(existing.requestedAtLocal)}</p>
                ) : (
                  <WallClockInput
                    id="f-requestedAt"
                    value={form.requestedAt}
                    timeZone={tz}
                    invalid={!!fieldErrors.requestedAt}
                    describedBy={fieldErrors.requestedAt ? "f-requestedAt-error" : undefined}
                    onChange={(v) => set("requestedAt", v)}
                  />
                )}
                {err("requestedAt")}
              </div>
              <div className="form__field">
                <label htmlFor="f-fulfillmentType">Modalidad</label>
                <select
                  id="f-fulfillmentType"
                  value={form.fulfillmentType}
                  onChange={(e) =>
                    set("fulfillmentType", e.target.value as Form["fulfillmentType"])
                  }
                >
                  {FULFILLMENT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {FULFILLMENT_TYPE_LABELS[t]}
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
                    onChange={(e) => set("deliveryAddress", e.target.value)}
                  />
                  {err("deliveryAddress")}
                </div>
              )}
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
            </div>
            <div className="form__field">
              <label htmlFor="f-notes">Notas</label>
              <textarea
                id="f-notes"
                rows={2}
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </div>
          </section>

          <section className="panel" aria-labelledby="lines-title">
            <h2 id="lines-title">Productos</h2>
            {infoOnly && existing ? (
              <>
                <ul>
                  {existing.lines.map((l) => (
                    <li key={l.id}>
                      {formatQuantity(l.requestedQuantity, l.unit.symbol)} de {l.product.name}
                    </li>
                  ))}
                </ul>
                {existing.actions.canReplan && (
                  <Link href={`${ORDERS_BASE}/${existing.id}/modificar`} className="button">
                    Modificar fecha o productos
                  </Link>
                )}
              </>
            ) : (
              <LinesEditor
                lines={lines}
                onChange={setLines}
                catalog={catalog}
                errors={fieldErrors}
              />
            )}
          </section>

          {!infoOnly &&
            (preview?.data ? (
              <CoveragePreview preview={preview.data} />
            ) : preview?.error ? (
              <p className="notice">{preview.error.message}</p>
            ) : previewReady ? (
              <Loading />
            ) : (
              <p className="muted">
                Completá fecha y productos para ver qué hay, qué se reservaría y qué falta producir.
              </p>
            ))}

          {formError && (
            <p className="form__error" role="alert">
              {formError}
            </p>
          )}
          <div className="form__footer">
            <button type="submit" className="button button--primary" disabled={pending}>
              {pending ? "Guardando…" : existing ? "Guardar cambios" : "Guardar borrador"}
            </button>
            <Link
              href={existing ? `${ORDERS_BASE}/${existing.id}` : ORDERS_BASE}
              className="button"
            >
              Cancelar
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}
