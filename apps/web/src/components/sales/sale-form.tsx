"use client";

import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  PERMISSIONS as P,
  PRICE_SOURCE_LABELS,
  type CustomerDto,
  type OrderDetailDto,
  type PaymentMethodDto,
  type ProductDto,
  type ResolvedPriceDto,
  type SaleDetailDto,
  type SaleLineInput,
  type SaleOperationResultDto,
  type SalePreviewDto,
  type WarehouseDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { isDecimal, isPositive, parseDecimal, toDecimal } from "@/lib/decimal-input";
import { describeError } from "@/lib/errors";
import { formatMoney, formatQuantity } from "@/lib/format";
import { EmptyState, ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { ORDERS_BASE } from "../orders/order-shared";
import { Combobox, type ComboOption } from "../ui/combobox";
import { useFlash } from "../ui/flash";
import { LineField, LineList, LineRow } from "../ui/lines";
import { Icon } from "../ui/icons";
import { useCan, useCurrentUser } from "../user-context";
import { SALES_BASE, useOperationId } from "./sale-shared";

/*
 * Venta (Fase 5B, optimizada en el sprint UX).
 *
 * Venta de mostrador (directa): cliente (Consumidor Final por defecto), buscar
 * producto, cantidad, repetir; el total está siempre a la vista; se elige si se
 * cobra en el momento y con qué medio, y «Confirmar venta» la registra en un
 * solo paso. El sistema elige los lotes (primero los que vencen antes): el
 * vendedor no tiene que entender lotes, costos ni imputaciones.
 * Por dentro son las mismas operaciones de siempre: se guarda el borrador, se
 * pide la vista previa y, si no hay avisos, se confirma con el cobro inicial.
 * Si la vista previa trae avisos (stock insuficiente, precio bajo el costo,
 * límite de crédito) la venta queda en borrador y se muestran para decidir.
 *
 * Entrega de un pedido (?orderId=) y edición de un borrador: se guarda y se
 * revisa la entrega en el detalle, como antes.
 * Cambiar el precio exige permiso y un motivo (queda auditado).
 */

interface LineDraft {
  key: string;
  orderLineId: string | null;
  productId: string;
  quantity: string;
  /** Pendiente de entrega (venta desde pedido). */
  pending: string | null;
  /** Precio vigente / acordado (referencia). */
  basePrice: string | null;
  baseSource: string | null;
  baseDiscount: string;
  unitPrice: string;
  discount: string;
  reason: string;
}

let keySeq = 0;
const blankLine = (): LineDraft => ({
  key: `s${++keySeq}`,
  orderLineId: null,
  productId: "",
  quantity: "",
  pending: null,
  basePrice: null,
  baseSource: null,
  baseDiscount: "0",
  unitPrice: "",
  discount: "",
  reason: "",
});

const plain = (v: string) => v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
const WAREHOUSE_KEY = "venta.deposito";

/** ¿El usuario cambió el precio o el descuento respecto de lo vigente / acordado? */
function overridden(l: LineDraft): boolean {
  if (l.basePrice === null) return false;
  const price = parseDecimal(l.unitPrice);
  const discount = l.discount.trim() === "" ? new D(0) : parseDecimal(l.discount);
  if (!price || !discount) return l.unitPrice.trim() !== "" || l.discount.trim() !== "";
  // Venta de pedido: el descuento acordado se prorratea en la API; sólo el precio cuenta.
  return !price.eq(l.basePrice) || (!l.orderLineId && !discount.eq(l.baseDiscount));
}

function lineNet(l: LineDraft): InstanceType<typeof D> | null {
  const qty = parseDecimal(l.quantity);
  const price = parseDecimal(l.unitPrice) ?? (l.basePrice ? new D(l.basePrice) : null);
  if (!qty || !price) return null;
  const discount = parseDecimal(l.discount) ?? new D(0);
  return qty.times(price).minus(discount);
}

function payload(lines: LineDraft[]): SaleLineInput[] {
  return lines
    .filter((l) => l.productId && isPositive(l.quantity))
    .map((l) => {
      const changed = overridden(l);
      return {
        orderLineId: l.orderLineId,
        productId: l.productId,
        quantity: toDecimal(l.quantity),
        unitId: null,
        requestedConservation: "ANY",
        ...(changed
          ? {
              unitPrice: toDecimal(l.unitPrice),
              ...(l.discount.trim() ? { discountAmount: toDecimal(l.discount) } : {}),
            }
          : {}),
        priceOverrideReason: changed ? l.reason.trim() || null : null,
        notes: null,
      };
    });
}

interface Catalog {
  customers: CustomerDto[];
  products: ProductDto[];
  warehouses: WarehouseDto[];
}

function useCatalog(): { catalog: Catalog | null; error: string | null } {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([
      fetchOptions<CustomerDto>("/api/customers").catch(() => []),
      fetchOptions<ProductDto>("/api/products"),
      fetchOptions<WarehouseDto>("/api/warehouses"),
    ])
      .then(([customers, products, warehouses]) => setCatalog({ customers, products, warehouses }))
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError ? describeError(err) : "No se pudieron cargar los productos.",
        );
        setCatalog({ customers: [], products: [], warehouses: [] });
      });
  }, []);
  return { catalog, error };
}

export function NewSale() {
  return (
    <Suspense fallback={<Loading />}>
      <NewSaleInner />
    </Suspense>
  );
}

function NewSaleInner() {
  const params = useSearchParams();
  const orderId = params.get("orderId");
  const can = useCan();
  const { catalog, error: catalogError } = useCatalog();
  const { data: order, error } = useResource<OrderDetailDto>(
    orderId ? `/api/orders/${orderId}` : null,
  );
  if (!can(P.SALES_CREATE)) return <NoPermission />;
  if (error) return <ErrorState error={error} />;
  if (!catalog || (orderId && !order)) return <Loading label="Preparando la venta…" />;
  return (
    <SaleForm
      catalog={catalog}
      catalogError={catalogError}
      order={order ?? null}
      initialCustomerId={params.get("clienteId")}
    />
  );
}

function NoPermission() {
  return (
    <section className="panel">
      <EmptyState
        title="No tenés permiso para registrar ventas"
        description="Pedile a un administrador que te asigne el rol de Ventas."
        action={
          <Link className="button" href={SALES_BASE}>
            Ver ventas
          </Link>
        }
      />
    </section>
  );
}

export function EditSale({ id }: { id: string }) {
  const { catalog, error: catalogError } = useCatalog();
  const { data: sale, error } = useResource<SaleDetailDto>(`/api/sales/${id}`);
  const { data: order, error: orderError } = useResource<OrderDetailDto>(
    sale?.order ? `/api/orders/${sale.order.id}` : null,
  );
  if (error ?? orderError) return <ErrorState error={(error ?? orderError)!} />;
  if (!catalog || !sale || (sale.order && !order)) return <Loading />;
  if (sale.status !== "DRAFT") {
    return (
      <section className="panel">
        <EmptyState
          title={`La venta ${sale.code} ya no es un borrador`}
          description="Una venta entregada o descartada no se modifica."
          action={
            <Link className="button" href={`${SALES_BASE}/${id}`}>
              Volver a la venta
            </Link>
          }
        />
      </section>
    );
  }
  return (
    <SaleForm catalog={catalog} catalogError={catalogError} order={order ?? null} sale={sale} />
  );
}

function linesFromOrder(order: OrderDetailDto): LineDraft[] {
  return order.lines
    .filter((l) => new D(l.pendingDelivery).gt(0))
    .map((l) => ({
      ...blankLine(),
      orderLineId: l.id,
      productId: l.product.id,
      quantity: plain(l.pendingDelivery),
      pending: l.pendingDelivery,
      basePrice: l.price?.unitPrice ?? null,
      baseSource: l.price ? "ORDER_QUOTE" : null,
      baseDiscount: l.price?.discountAmount ?? "0",
    }));
}

function linesFromSale(sale: SaleDetailDto, order: OrderDetailDto | null): LineDraft[] {
  return sale.lines.map((l) => {
    const ol = order?.lines.find((o) => o.id === l.orderLineId);
    const manual = l.price?.priceSource === "MANUAL";
    return {
      ...blankLine(),
      orderLineId: l.orderLineId,
      productId: l.product.id,
      quantity: plain(l.normalizedQuantity),
      pending: ol ? ol.pendingDelivery : null,
      basePrice: l.price?.agreedUnitPrice ?? l.price?.unitPrice ?? null,
      baseSource: l.price?.priceSource ?? null,
      baseDiscount: l.price?.agreedDiscountAmount ?? "0",
      unitPrice: manual && l.price ? plain(l.price.unitPrice) : "",
      discount:
        manual && l.price && new D(l.price.discountAmount).gt(0)
          ? plain(l.price.discountAmount)
          : "",
      reason: l.price?.overrideReason ?? "",
    };
  });
}

function readStoredWarehouse(): string | null {
  try {
    return window.localStorage.getItem(WAREHOUSE_KEY);
  } catch {
    return null;
  }
}

function SaleForm({
  catalog,
  catalogError,
  order,
  sale,
  initialCustomerId,
}: {
  catalog: Catalog;
  catalogError: string | null;
  order: OrderDetailDto | null;
  sale?: SaleDetailDto;
  initialCustomerId?: string | null;
}) {
  const router = useRouter();
  const flash = useFlash();
  const can = useCan();
  const currency = useCurrentUser().company.currencyCode;
  const seePrices = can(P.PRICE_LISTS_READ);
  const canOverride = can(P.SALES_PRICE_OVERRIDE) && seePrices;
  const fromOrder = order !== null;
  const counter = !fromOrder && !sale;
  const canPostNow = counter && can(P.SALES_POST);
  const canCollect = canPostNow && can(P.PAYMENTS_CREATE, P.PAYMENTS_POST) && seePrices;
  const walkIn = catalog.customers.find((c) => c.walkIn);
  const [customerId, setCustomerId] = useState(
    sale?.customer.id ??
      order?.customer.id ??
      (initialCustomerId && catalog.customers.some((c) => c.id === initialCustomerId)
        ? initialCustomerId
        : (walkIn?.id ?? "")),
  );
  const reservedWarehouse = order?.reservations.find((r) => r.status === "ACTIVE")?.lot.warehouse
    .id;
  const [warehouseId, setWarehouseId] = useState(() => {
    if (sale) return sale.warehouse.id;
    if (reservedWarehouse) return reservedWarehouse;
    const stored = readStoredWarehouse();
    if (stored && catalog.warehouses.some((w) => w.id === stored)) return stored;
    return catalog.warehouses[0]?.id ?? "";
  });
  const [notes, setNotes] = useState(sale?.notes ?? "");
  const [showNotes, setShowNotes] = useState(Boolean(sale?.notes));
  const [lines, setLines] = useState<LineDraft[]>(() =>
    sale ? linesFromSale(sale, order) : order ? linesFromOrder(order) : [blankLine()],
  );
  const customer = catalog.customers.find((c) => c.id === customerId);
  // En mostrador se cobra en el momento salvo que sea un cliente con cuenta corriente.
  const [collect, setCollect] = useState(customer?.walkIn ?? true);
  const [collectTouched, setCollectTouched] = useState(false);
  const [method, setMethod] = useState<PaymentMethodDto>("CASH");
  const [paysWith, setPaysWith] = useState("");
  const [reference, setReference] = useState("");
  const [operationId, renewOperation] = useOperationId();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<null | "draft" | "post">(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // Precio vigente para la venta directa (según cliente y producto).
  const productIds = useMemo(
    () => [...new Set(lines.map((l) => l.productId).filter(Boolean))].sort().join(","),
    [lines],
  );
  const priceKey = fromOrder || !seePrices || !productIds ? "" : `${productIds}|${customerId}`;
  const [resolvedKey, setResolvedKey] = useState("");
  const resolving = priceKey !== "" && priceKey !== resolvedKey;
  useEffect(() => {
    if (!priceKey) return;
    let cancelled = false;
    const qs = new URLSearchParams({ productIds });
    if (customerId) qs.set("customerId", customerId);
    apiFetch<ResolvedPriceDto[]>(`/api/price-lists/resolve?${qs.toString()}`)
      .then((prices) => {
        if (cancelled) return;
        const byProduct = new Map(prices.map((p) => [p.productId, p]));
        setLines((current) =>
          current.map((l) => {
            const p = byProduct.get(l.productId);
            return p
              ? { ...l, basePrice: p.unitPrice, baseSource: p.source, baseDiscount: "0" }
              : l;
          }),
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setResolvedKey(priceKey);
      });
    return () => {
      cancelled = true;
    };
  }, [priceKey, productIds, customerId]);

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

  const update = (key: string, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => {
    const line = blankLine();
    setLines((ls) => [...ls, line]);
    setFocusKey(line.key);
  };

  const filled = lines.filter((l) => l.productId && isPositive(l.quantity));
  const total = filled.reduce<InstanceType<typeof D> | null>((sum, l) => {
    const net = lineNet(l);
    return sum && net ? sum.plus(net) : null;
  }, new D(0));
  const totalText = total ? formatMoney(total.toFixed(2), currency) : null;
  const change =
    collect && method === "CASH" && total && isPositive(paysWith)
      ? new D(toDecimal(paysWith)).minus(total.toFixed(2))
      : null;

  function validate(): SaleLineInput[] | null {
    setError(null);
    setFieldErrors({});
    const body = payload(lines);
    if (body.length === 0) {
      setError("Agregá al menos un producto con cantidad.");
      return null;
    }
    const badQty = lines.findIndex((l) => l.quantity.trim() !== "" && !isDecimal(l.quantity));
    if (badQty >= 0) {
      setFieldErrors({ [`lines.${badQty}.quantity`]: "Cantidad inválida" });
      setError(`Revisá la cantidad de la línea ${badQty + 1}.`);
      return null;
    }
    const tooMuch = lines.find(
      (l) => l.pending && isPositive(l.quantity) && new D(toDecimal(l.quantity)).gt(l.pending),
    );
    if (tooMuch) {
      setError("No se puede entregar más que lo pendiente del pedido.");
      return null;
    }
    const missingReason = lines.findIndex((l) => overridden(l) && !l.reason.trim());
    if (missingReason >= 0) {
      setFieldErrors({
        [`lines.${missingReason}.priceOverrideReason`]: "Indicá el motivo",
      });
      setError("Indicá el motivo del cambio de precio.");
      return null;
    }
    if (change && change.lt(0)) {
      setError("El monto con el que paga es menor que el total.");
      return null;
    }
    return body;
  }

  async function saveDraft(body: SaleLineInput[]): Promise<SaleDetailDto> {
    try {
      window.localStorage.setItem(WAREHOUSE_KEY, warehouseId);
    } catch {
      /* sin almacenamiento local: se vuelve a elegir */
    }
    return sale
      ? apiFetch<SaleDetailDto>(`/api/sales/${sale.id}`, {
          method: "PATCH",
          body: {
            ...(fromOrder ? {} : { customerId }),
            warehouseId,
            notes: notes.trim() || null,
            lines: body,
          },
        })
      : apiFetch<SaleDetailDto>("/api/sales", {
          method: "POST",
          body: {
            ...(fromOrder ? { sourceOrderId: order.id } : { customerId: customerId || null }),
            warehouseId,
            notes: notes.trim() || null,
            lines: body,
          },
        });
  }

  function showApiError(err: unknown, fallback: string) {
    if (err instanceof ApiError) {
      setError(describeError(err));
      setFieldErrors(err.fieldErrors);
    } else setError(fallback);
  }

  /** Guardar como borrador y revisar la entrega en el detalle. */
  async function submitDraft() {
    const body = validate();
    if (!body) return;
    setPending("draft");
    try {
      const result = await saveDraft(body);
      router.push(`${SALES_BASE}/${result.id}`);
    } catch (err) {
      showApiError(err, "No se pudo guardar la venta.");
      setPending(null);
    }
  }

  /** Mostrador: guardar, verificar la entrega y confirmar con el cobro en un solo paso. */
  async function confirmSale() {
    const body = validate();
    if (!body) return;
    setPending("post");
    let draft: SaleDetailDto;
    try {
      draft = await saveDraft(body);
    } catch (err) {
      showApiError(err, "No se pudo registrar la venta.");
      setPending(null);
      return;
    }
    try {
      const preview = await apiFetch<SalePreviewDto>(`/api/sales/${draft.id}/preview`);
      if (!preview.canPost || preview.issues.length > 0) {
        flash(
          preview.canPost
            ? `La venta ${draft.code} quedó en borrador: revisá los avisos y confirmala.`
            : `La venta ${draft.code} no se pudo confirmar todavía: revisá los avisos.`,
          { afterNavigation: true },
        );
        router.push(`${SALES_BASE}/${draft.id}`);
        return;
      }
      const due = preview.total ?? "0";
      const result = await apiFetch<SaleOperationResultDto>(`/api/sales/${draft.id}/post`, {
        method: "POST",
        body:
          collect && canCollect && new D(due).gt(0)
            ? {
                initialPayment: {
                  amount: due,
                  paymentMethod: method,
                  reference: reference.trim() || null,
                  operationId,
                },
              }
            : {},
      });
      renewOperation();
      const paid = collect && canCollect && new D(due).gt(0);
      flash(
        [
          `Venta ${result.sale.code} registrada`,
          paid
            ? `cobrada ${formatMoney(due, currency)} en ${PAYMENT_METHOD_LABELS[method].toLowerCase()}`
            : "queda pendiente de cobro",
          change && change.gt(0) ? `vuelto ${formatMoney(change.toFixed(2), currency)}` : null,
          ...result.warnings,
        ]
          .filter(Boolean)
          .join(" · "),
        { afterNavigation: true },
      );
      router.push(`${SALES_BASE}/${result.sale.id}`);
    } catch (err) {
      // El borrador existe: se sigue desde su detalle, donde se ve qué pasó.
      flash(
        `La venta ${draft.code} quedó en borrador: ${err instanceof ApiError ? describeError(err) : "no se pudo confirmar"}.`,
        { afterNavigation: true },
      );
      router.push(`${SALES_BASE}/${draft.id}`);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (counter && canPostNow) await confirmSale();
    else await submitDraft();
  }

  const title = sale
    ? `Editar venta ${sale.code}`
    : fromOrder
      ? `Entregar pedido ${order.code}`
      : "Nueva venta";
  const cancelHref = sale
    ? `${SALES_BASE}/${sale.id}`
    : fromOrder
      ? `${ORDERS_BASE}/${order.id}`
      : SALES_BASE;
  const variant = !seePrices ? "no-price" : canOverride && !fromOrder ? "full" : "no-discount";
  const head = [
    "Producto",
    "Cantidad",
    ...(seePrices ? ["Precio"] : []),
    ...(variant === "full" ? ["Descuento $"] : []),
    ...(seePrices ? ["Importe"] : []),
  ];

  return (
    <div className="page">
      <PageHeader
        breadcrumb={
          fromOrder
            ? [
                { href: ORDERS_BASE, label: "Pedidos" },
                { href: `${ORDERS_BASE}/${order.id}`, label: order.code },
              ]
            : { href: SALES_BASE, label: "Ventas" }
        }
        title={title}
        subtitle={
          fromOrder
            ? `${order.customer.name} · al precio acordado del pedido`
            : counter
              ? "Buscá el producto, indicá la cantidad y confirmá. Los lotes se eligen solos: primero los que vencen antes."
              : undefined
        }
      />
      {catalogError && (
        <p className="alert" role="alert">
          {catalogError}
        </p>
      )}
      <form className="form" onSubmit={submit} noValidate aria-label={title}>
        <section className="panel">
          <div className="form-grid">
            <div className="form__field">
              <label htmlFor="sale-customer">Cliente</label>
              {fromOrder ? (
                <input id="sale-customer" value={order.customer.name} disabled />
              ) : (
                <Combobox
                  id="sale-customer"
                  options={customerOptions}
                  value={customerId}
                  onChange={(v) => {
                    setCustomerId(v);
                    if (!collectTouched)
                      setCollect(catalog.customers.find((c) => c.id === v)?.walkIn ?? false);
                  }}
                  placeholder="Buscar cliente por nombre o CUIT"
                  invalid={Boolean(fieldErrors.customerId)}
                />
              )}
              {fieldErrors.customerId && (
                <span className="form__error">{fieldErrors.customerId}</span>
              )}
            </div>
            <div className="form__field">
              <label htmlFor="sale-warehouse">Sale del depósito</label>
              <select
                id="sale-warehouse"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
              >
                {catalog.warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              {fromOrder && (
                <span className="form__hint">
                  Se entrega lo reservado para el pedido; lo que falte sale de este depósito.
                </span>
              )}
            </div>
          </div>
        </section>

        <section className="panel" aria-labelledby="sale-lines-title">
          <div className="panel__header">
            <h2 id="sale-lines-title">Productos</h2>
            {resolving && (
              <span className="muted small" role="status">
                Buscando precios…
              </span>
            )}
          </div>
          {catalog.products.length === 0 ? (
            <EmptyState
              compact
              title="No hay productos activos para vender"
              description="Los productos se dan de alta en Catálogo → Productos."
            />
          ) : (
            <LineList label="Productos de la venta" head={head} variant={variant}>
              {lines.map((l, i) => {
                const product = catalog.products.find((p) => p.id === l.productId);
                const unit = product?.saleUnit.symbol ?? "";
                const err = (f: string) => fieldErrors[`lines.${i}.${f}`];
                const changed = overridden(l);
                const net = isPositive(l.quantity) ? lineNet(l) : null;
                const n = i + 1;
                const source = l.baseSource
                  ? (PRICE_SOURCE_LABELS[l.baseSource as keyof typeof PRICE_SOURCE_LABELS] ?? "")
                  : "";
                return (
                  <LineRow
                    key={l.key}
                    testId={`sale-line-${n}`}
                    removeLabel={`Quitar producto ${n}`}
                    canRemove={lines.length > 1}
                    onRemove={
                      fromOrder
                        ? undefined
                        : () => setLines((ls) => ls.filter((x) => x.key !== l.key))
                    }
                    meta={
                      <>
                        {l.pending && (
                          <span>Pendiente del pedido: {formatQuantity(l.pending, unit)}</span>
                        )}
                        {seePrices && l.basePrice && (
                          <span>
                            {changed
                              ? `Precio vigente ${formatMoney(l.basePrice, currency)} · `
                              : ""}
                            {source}
                          </span>
                        )}
                        {canOverride && changed && (
                          <span className="form__field" style={{ flex: "1 1 100%" }}>
                            <input
                              className="control"
                              aria-label={`Motivo del cambio de precio ${n}`}
                              aria-invalid={err("priceOverrideReason") ? true : undefined}
                              value={l.reason}
                              maxLength={500}
                              placeholder="Motivo del cambio de precio (obligatorio)"
                              onChange={(e) => update(l.key, { reason: e.target.value })}
                            />
                          </span>
                        )}
                        {(err("productId") ||
                          err("quantity") ||
                          err("unitPrice") ||
                          err("priceOverrideReason")) && (
                          <span className="form__error" role="alert">
                            {err("productId") ??
                              err("quantity") ??
                              err("unitPrice") ??
                              err("priceOverrideReason")}
                          </span>
                        )}
                      </>
                    }
                  >
                    <LineField label="Producto" htmlFor={`sale-product-${n}`} product>
                      {fromOrder ? (
                        <span id={`sale-product-${n}`} style={{ paddingTop: "0.5rem" }}>
                          {product?.name ?? "—"}
                        </span>
                      ) : (
                        <Combobox
                          id={`sale-product-${n}`}
                          ariaLabel={`Producto ${n}`}
                          options={productOptions}
                          value={l.productId}
                          autoFocus={focusKey === l.key}
                          placeholder="Buscar producto por nombre o código"
                          invalid={Boolean(err("productId"))}
                          onChange={(v) =>
                            update(l.key, {
                              productId: v,
                              basePrice: null,
                              baseSource: null,
                              unitPrice: "",
                              discount: "",
                              quantity: l.quantity || (counter ? "1" : ""),
                            })
                          }
                        />
                      )}
                    </LineField>
                    <LineField label="Cantidad" htmlFor={`sale-qty-${n}`}>
                      <div className="input-group">
                        <input
                          id={`sale-qty-${n}`}
                          className="control"
                          inputMode="decimal"
                          aria-label={`Cantidad ${n}`}
                          value={l.quantity}
                          placeholder="0"
                          aria-invalid={err("quantity") ? true : undefined}
                          onChange={(e) => update(l.key, { quantity: e.target.value })}
                          onKeyDown={(e) => {
                            // Enter en la última cantidad agrega otro producto (carga por teclado).
                            if (e.key === "Enter" && counter && i === lines.length - 1) {
                              e.preventDefault();
                              if (l.productId && isPositive(l.quantity)) addLine();
                            }
                          }}
                        />
                        <span className="muted">{unit}</span>
                      </div>
                    </LineField>
                    {seePrices && (
                      <LineField label="Precio" htmlFor={`sale-price-${n}`}>
                        {canOverride ? (
                          <input
                            id={`sale-price-${n}`}
                            className="control"
                            inputMode="decimal"
                            aria-label={`Precio ${n}`}
                            value={l.unitPrice}
                            placeholder={l.basePrice ? plain(l.basePrice) : "Precio"}
                            aria-invalid={err("unitPrice") ? true : undefined}
                            onChange={(e) => update(l.key, { unitPrice: e.target.value })}
                          />
                        ) : (
                          <span className="num" style={{ paddingTop: "0.55rem" }}>
                            {l.basePrice
                              ? formatMoney(l.basePrice, currency)
                              : l.productId
                                ? "…"
                                : "—"}
                          </span>
                        )}
                      </LineField>
                    )}
                    {variant === "full" && (
                      <LineField label="Descuento $" htmlFor={`sale-discount-${n}`}>
                        <input
                          id={`sale-discount-${n}`}
                          className="control"
                          inputMode="decimal"
                          aria-label={`Descuento ${n}`}
                          value={l.discount}
                          placeholder="0"
                          onChange={(e) => update(l.key, { discount: e.target.value })}
                        />
                      </LineField>
                    )}
                    {seePrices && (
                      <LineField label="Importe" amount>
                        <span data-testid={`sale-line-amount-${n}`}>
                          {net ? formatMoney(net.toFixed(2), currency) : "—"}
                        </span>
                      </LineField>
                    )}
                  </LineRow>
                );
              })}
            </LineList>
          )}
          {!fromOrder && (
            <div className="lines__footer">
              <button type="button" className="button button--small" onClick={addLine}>
                <Icon name="plus" size="sm" />
                Agregar producto
              </button>
              {counter && (
                <span className="muted small">
                  Atajo: Enter en la cantidad agrega otro producto.
                </span>
              )}
            </div>
          )}
          {!showNotes ? (
            <button type="button" className="link-button small" onClick={() => setShowNotes(true)}>
              Agregar una nota
            </button>
          ) : (
            <div className="form__field" style={{ marginTop: "0.75rem" }}>
              <label htmlFor="sale-notes">Notas</label>
              <textarea
                id="sale-notes"
                value={notes}
                rows={2}
                maxLength={2000}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          )}
        </section>

        {canCollect && (
          <section className="panel" aria-labelledby="sale-payment-title">
            <div className="panel__header">
              <h2 id="sale-payment-title">Cobro</h2>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={collect}
                  onChange={(e) => {
                    setCollect(e.target.checked);
                    setCollectTouched(true);
                  }}
                />
                Cobrar ahora
              </label>
            </div>
            {collect ? (
              <div className="form-grid">
                <fieldset className="form__field form__field--full">
                  <legend className="form__label">Medio de pago</legend>
                  <div className="segmented">
                    {PAYMENT_METHODS.map((m) => (
                      <label key={m}>
                        <input
                          type="radio"
                          name="sale-method"
                          value={m}
                          checked={method === m}
                          onChange={() => setMethod(m)}
                        />
                        <span>{PAYMENT_METHOD_LABELS[m]}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {method === "CASH" ? (
                  <div className="form__field">
                    <label htmlFor="sale-pays-with">Paga con (opcional)</label>
                    <input
                      id="sale-pays-with"
                      inputMode="decimal"
                      value={paysWith}
                      placeholder={total ? plain(total.toFixed(2)) : ""}
                      onChange={(e) => setPaysWith(e.target.value)}
                    />
                    {change && (
                      <span
                        className={change.lt(0) ? "form__error" : "form__hint"}
                        data-testid="sale-change"
                      >
                        {change.lt(0)
                          ? `Faltan ${formatMoney(change.abs().toFixed(2), currency)}`
                          : `Vuelto: ${formatMoney(change.toFixed(2), currency)}`}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="form__field">
                    <label htmlFor="sale-reference">Referencia (opcional)</label>
                    <input
                      id="sale-reference"
                      value={reference}
                      maxLength={120}
                      placeholder="N.º de operación o cupón"
                      onChange={(e) => setReference(e.target.value)}
                    />
                  </div>
                )}
              </div>
            ) : (
              <p className="muted">
                {customer?.walkIn
                  ? "Sin cobrar, la venta queda como deuda de Consumidor Final."
                  : `Queda en la cuenta corriente de ${customer?.tradeName ?? customer?.legalName ?? "el cliente"}.`}
              </p>
            )}
          </section>
        )}

        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}

        <div className="total-bar">
          <div>
            <div className="total-bar__label">
              {fromOrder ? "Total (con el descuento acordado prorrateado)" : "Total"}
            </div>
            <div className="total-bar__amount" data-testid="draft-total" aria-live="polite">
              {!seePrices
                ? "—"
                : (totalText ?? (filled.length > 0 ? "Calculando…" : formatMoney("0", currency)))}
            </div>
          </div>
          <div className="actions">
            <Link className="button button--tertiary" href={cancelHref}>
              Cancelar
            </Link>
            {counter && canPostNow ? (
              <>
                <button
                  type="button"
                  className="button"
                  onClick={submitDraft}
                  disabled={pending !== null}
                >
                  {pending === "draft" ? "Guardando…" : "Guardar borrador"}
                </button>
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={pending !== null}
                  aria-busy={pending === "post" || undefined}
                >
                  {pending === "post"
                    ? "Registrando…"
                    : collect && canCollect
                      ? "Confirmar venta y cobrar"
                      : "Confirmar venta"}
                </button>
              </>
            ) : (
              <button type="submit" className="button button--primary" disabled={pending !== null}>
                {pending ? "Guardando…" : "Guardar y ver la entrega"}
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
