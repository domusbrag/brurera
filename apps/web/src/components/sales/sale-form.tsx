"use client";

import {
  PERMISSIONS as P,
  PRICE_SOURCE_LABELS,
  type CustomerDto,
  type OrderDetailDto,
  type ProductDto,
  type ResolvedPriceDto,
  type SaleDetailDto,
  type SaleLineInput,
  type WarehouseDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { isDecimal, isPositive, parseDecimal, toDecimal } from "@/lib/decimal-input";
import { formatMoney, formatQuantity } from "@/lib/format";
import { ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { ORDERS_BASE } from "../orders/order-shared";
import { useCan, useCurrentUser } from "../user-context";
import { SALES_BASE } from "./sale-shared";

/*
 * Alta y edición de ventas en borrador (Fase 5B).
 * - Desde un pedido (?orderId=): una línea por producto pendiente de entrega,
 *   al precio acordado del pedido; se puede entregar menos que lo pendiente.
 * - Directa: cliente (Consumidor Final por defecto), productos y precio
 *   vigente (lista del cliente → lista general → precio del producto).
 * Cambiar el precio exige permiso y un motivo (queda auditado).
 * Guardar no mueve stock: la entrega se confirma desde el detalle.
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
    .filter((l) => isPositive(l.quantity))
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

function useCatalog(): Catalog | null {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    Promise.all([
      fetchOptions<CustomerDto>("/api/customers").catch(() => []),
      fetchOptions<ProductDto>("/api/products"),
      fetchOptions<WarehouseDto>("/api/warehouses"),
    ])
      .then(([customers, products, warehouses]) => setCatalog({ customers, products, warehouses }))
      .catch(() => setCatalog({ customers: [], products: [], warehouses: [] }));
  }, []);
  return catalog;
}

export function NewSale() {
  return (
    <Suspense fallback={<Loading />}>
      <NewSaleInner />
    </Suspense>
  );
}

function NewSaleInner() {
  const orderId = useSearchParams().get("orderId");
  const catalog = useCatalog();
  const { data: order, error } = useResource<OrderDetailDto>(
    orderId ? `/api/orders/${orderId}` : null,
  );
  if (error) return <ErrorState error={error} />;
  if (!catalog || (orderId && !order)) return <Loading />;
  return <SaleForm catalog={catalog} order={order ?? null} />;
}

export function EditSale({ id }: { id: string }) {
  const catalog = useCatalog();
  const { data: sale, error } = useResource<SaleDetailDto>(`/api/sales/${id}`);
  const { data: order, error: orderError } = useResource<OrderDetailDto>(
    sale?.order ? `/api/orders/${sale.order.id}` : null,
  );
  if (error ?? orderError) return <ErrorState error={(error ?? orderError)!} />;
  if (!catalog || !sale || (sale.order && !order)) return <Loading />;
  if (sale.status !== "DRAFT") {
    return (
      <section className="panel panel--empty">
        <p className="upcoming">La venta ya no es un borrador</p>
        <Link href={`${SALES_BASE}/${id}`}>Volver a la venta</Link>
      </section>
    );
  }
  return <SaleForm catalog={catalog} order={order ?? null} sale={sale} />;
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

function SaleForm({
  catalog,
  order,
  sale,
}: {
  catalog: Catalog;
  order: OrderDetailDto | null;
  sale?: SaleDetailDto;
}) {
  const router = useRouter();
  const can = useCan();
  const currency = useCurrentUser().company.currencyCode;
  const seePrices = can(P.PRICE_LISTS_READ);
  const canOverride = can(P.SALES_PRICE_OVERRIDE) && seePrices;
  const walkIn = catalog.customers.find((c) => c.walkIn);
  const [customerId, setCustomerId] = useState(
    sale?.customer.id ?? order?.customer.id ?? walkIn?.id ?? "",
  );
  const reservedWarehouse = order?.reservations.find((r) => r.status === "ACTIVE")?.lot.warehouse
    .id;
  const [warehouseId, setWarehouseId] = useState(
    sale?.warehouse.id ?? reservedWarehouse ?? catalog.warehouses[0]?.id ?? "",
  );
  const [notes, setNotes] = useState(sale?.notes ?? "");
  const [lines, setLines] = useState<LineDraft[]>(() =>
    sale ? linesFromSale(sale, order) : order ? linesFromOrder(order) : [blankLine()],
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const fromOrder = order !== null;

  // Precio vigente para la venta directa (según cliente y producto).
  const productIds = useMemo(
    () => [...new Set(lines.map((l) => l.productId).filter(Boolean))].sort().join(","),
    [lines],
  );
  useEffect(() => {
    if (fromOrder || !seePrices || !productIds) return;
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
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fromOrder, seePrices, productIds, customerId]);

  const update = (key: string, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const total = lines.reduce<InstanceType<typeof D> | null>((sum, l) => {
    if (!isPositive(l.quantity)) return sum;
    const net = lineNet(l);
    return sum && net ? sum.plus(net) : null;
  }, new D(0));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    const body = payload(lines);
    if (body.length === 0) {
      setError("Indicá al menos un producto con cantidad.");
      return;
    }
    const tooMuch = lines.find(
      (l) => l.pending && isPositive(l.quantity) && new D(toDecimal(l.quantity)).gt(l.pending),
    );
    if (tooMuch) {
      setError("No se puede entregar más que lo pendiente del pedido.");
      return;
    }
    const missingReason = lines.find((l) => overridden(l) && !l.reason.trim());
    if (missingReason) {
      setError("Indicá el motivo del cambio de precio.");
      return;
    }
    setPending(true);
    try {
      const result = sale
        ? await apiFetch<SaleDetailDto>(`/api/sales/${sale.id}`, {
            method: "PATCH",
            body: {
              ...(fromOrder ? {} : { customerId }),
              warehouseId,
              notes: notes.trim() || null,
              lines: body,
            },
          })
        : await apiFetch<SaleDetailDto>("/api/sales", {
            method: "POST",
            body: {
              ...(fromOrder ? { sourceOrderId: order.id } : { customerId: customerId || null }),
              warehouseId,
              notes: notes.trim() || null,
              lines: body,
            },
          });
      router.push(`${SALES_BASE}/${result.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else setError("No se pudo guardar la venta.");
      setPending(false);
    }
  }

  const title = sale
    ? `Editar venta ${sale.code}`
    : fromOrder
      ? `Entregar pedido ${order.code}`
      : "Nueva venta directa";

  return (
    <div className="page">
      <PageHeader
        breadcrumb={
          fromOrder
            ? { href: `${ORDERS_BASE}/${order.id}`, label: `Pedido ${order.code}` }
            : { href: SALES_BASE, label: "Ventas" }
        }
        title={title}
        subtitle={
          fromOrder
            ? `${order.customer.name} · al precio acordado del pedido. Guardar no descuenta stock: después revisás la vista previa y confirmás la entrega.`
            : "Guardar no descuenta stock: después revisás la vista previa y confirmás la entrega."
        }
      />
      <form className="form panel" onSubmit={submit} noValidate>
        <div className="form-grid">
          <div className="form__field">
            <label htmlFor="sale-customer">Cliente</label>
            {fromOrder ? (
              <input id="sale-customer" value={order.customer.name} disabled />
            ) : (
              <select
                id="sale-customer"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                {catalog.customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.tradeName ?? c.legalName}
                  </option>
                ))}
              </select>
            )}
            {fieldErrors.customerId && (
              <span className="form__error">{fieldErrors.customerId}</span>
            )}
          </div>
          <div className="form__field">
            <label htmlFor="sale-warehouse">Depósito</label>
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
            <span className="form__hint">
              {fromOrder
                ? "Las reservas del pedido se usan estén donde estén; lo que falte sale de este depósito."
                : "De acá sale el stock libre."}
            </span>
          </div>
        </div>

        <h2 className="section-title">Productos</h2>
        <div className="table-wrap">
          <table className="table" aria-label="Productos de la venta">
            <thead>
              <tr>
                <th scope="col">Producto</th>
                <th scope="col">Cantidad</th>
                {seePrices && <th scope="col">Precio</th>}
                {seePrices && (
                  <th scope="col" className="num">
                    Importe
                  </th>
                )}
                {!fromOrder && (
                  <th scope="col">
                    <span className="sr-only">Quitar</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const product = catalog.products.find((p) => p.id === l.productId);
                const unit = product?.saleUnit.symbol ?? "";
                const err = (f: string) => fieldErrors[`lines.${i}.${f}`];
                const changed = overridden(l);
                const net = isPositive(l.quantity) ? lineNet(l) : null;
                return (
                  <tr key={l.key}>
                    <td>
                      {fromOrder ? (
                        <>
                          {product?.name ?? "—"}
                          {l.pending && (
                            <span className="muted small">
                              <br />
                              Pendiente: {formatQuantity(l.pending, unit)}
                            </span>
                          )}
                        </>
                      ) : (
                        <select
                          aria-label={`Producto ${i + 1}`}
                          value={l.productId}
                          onChange={(e) =>
                            update(l.key, {
                              productId: e.target.value,
                              basePrice: null,
                              baseSource: null,
                              unitPrice: "",
                              discount: "",
                            })
                          }
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
                          value={l.quantity}
                          placeholder={fromOrder ? "0" : "Ej.: 10"}
                          aria-invalid={err("quantity") ? true : undefined}
                          onChange={(e) => update(l.key, { quantity: e.target.value })}
                        />
                        <span className="muted">{unit}</span>
                      </div>
                      {err("quantity") && <span className="form__error">{err("quantity")}</span>}
                    </td>
                    {seePrices && (
                      <td>
                        {canOverride ? (
                          <>
                            <div className="inline-fields">
                              <input
                                inputMode="decimal"
                                aria-label={`Precio ${i + 1}`}
                                value={l.unitPrice}
                                placeholder={l.basePrice ? plain(l.basePrice) : "Precio"}
                                onChange={(e) => update(l.key, { unitPrice: e.target.value })}
                              />
                              {!fromOrder && (
                                <input
                                  inputMode="decimal"
                                  aria-label={`Descuento ${i + 1}`}
                                  value={l.discount}
                                  placeholder="Desc. $"
                                  onChange={(e) => update(l.key, { discount: e.target.value })}
                                />
                              )}
                            </div>
                            {changed && (
                              <input
                                aria-label={`Motivo del cambio de precio ${i + 1}`}
                                value={l.reason}
                                maxLength={500}
                                placeholder="Motivo del cambio de precio (obligatorio)"
                                onChange={(e) => update(l.key, { reason: e.target.value })}
                              />
                            )}
                          </>
                        ) : (
                          formatMoney(l.basePrice, currency)
                        )}
                        <span className="muted small">
                          <br />
                          {l.basePrice
                            ? `${changed ? "Vigente " + formatMoney(l.basePrice, currency) + " · " : ""}${l.baseSource ? (PRICE_SOURCE_LABELS[l.baseSource as keyof typeof PRICE_SOURCE_LABELS] ?? "") : ""}`
                            : ""}
                        </span>
                        {(err("unitPrice") || err("priceOverrideReason")) && (
                          <span className="form__error">
                            {err("unitPrice") ?? err("priceOverrideReason")}
                          </span>
                        )}
                      </td>
                    )}
                    {seePrices && (
                      <td className="num">{net ? formatMoney(net.toFixed(2), currency) : "—"}</td>
                    )}
                    {!fromOrder && (
                      <td>
                        {lines.length > 1 && (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                          >
                            Quitar
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!fromOrder && (
          <button
            type="button"
            className="button button--small"
            onClick={() => setLines((ls) => [...ls, blankLine()])}
          >
            Agregar producto
          </button>
        )}
        {seePrices && total && (
          <p className="section-title" data-testid="draft-total">
            Total estimado: {formatMoney(total.toFixed(2), currency)}
            {fromOrder && (
              <span className="muted small"> (con el descuento acordado prorrateado)</span>
            )}
          </p>
        )}

        <div className="form__field">
          <label htmlFor="sale-notes">Notas</label>
          <textarea
            id="sale-notes"
            value={notes}
            rows={2}
            maxLength={2000}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        {lines.some((l) => !isDecimal(l.quantity) && l.quantity.trim() !== "") && (
          <p className="form__error">Revisá las cantidades.</p>
        )}
        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="form__footer">
          <button type="submit" className="button button--primary" disabled={pending}>
            {pending ? "Guardando…" : "Guardar y ver la entrega"}
          </button>
          <Link
            className="button"
            href={
              sale
                ? `${SALES_BASE}/${sale.id}`
                : fromOrder
                  ? `${ORDERS_BASE}/${order.id}`
                  : SALES_BASE
            }
          >
            Cancelar
          </Link>
        </div>
      </form>
    </div>
  );
}
