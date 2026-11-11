"use client";

import {
  APPLICATION_ORIGIN_LABELS,
  FEFO_SALE_HINT,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_KIND_LABELS,
  PERMISSIONS as P,
  PRICE_SOURCE_LABELS,
  SALE_PAYMENT_STATUSES,
  SALE_PAYMENT_STATUS_LABELS,
  SALE_STATUSES,
  SALE_STATUS_LABELS,
  type CustomerDto,
  type PaymentMethodDto,
  type SaleDetailDto,
  type SaleListItemDto,
  type SaleLotDto,
  type SaleOperationResultDto,
  type SalePreviewDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { isPositive, toDecimal } from "@/lib/decimal-input";
import { describeError, localizeNumbers } from "@/lib/errors";
import { formatDateTime, formatMoney, formatQuantity, formatUnitCost } from "@/lib/format";
import { MasterList } from "../masters/master-list";
import {
  AuditHistory,
  ConfirmAction,
  Details,
  ErrorState,
  Loading,
  PageHeader,
  useResource,
} from "../masters/ui";
import { ConservationBadge, LOTS_BASE } from "../lots/lot-shared";
import { ORDERS_BASE, formatWallClock } from "../orders/order-shared";
import { useCan, useCurrentUser } from "../user-context";
import {
  MarginText,
  NegativeMarginNotice,
  PaymentDialog,
  PaymentStatusBadge,
  RECEIVABLES_BASE,
  SALES_BASE,
  SaleStatusBadge,
  Warnings,
  useOperationId,
} from "./sale-shared";

/*
 * Ventas (Fase 5B): listado y detalle. Una venta en borrador no mueve nada;
 * «Confirmar entrega y venta» descuenta los lotes (primero las reservas del
 * pedido, después stock libre por vencimiento), registra el costo material
 * real de esos lotes y la deuda del cliente, y aplica las señas del pedido.
 * Una venta entregada no se modifica.
 */

/* ---------- Listado ---------- */

export function SaleList() {
  const can = useCan();
  const currency = useCurrentUser().company.currencyCode;
  const [customers, setCustomers] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    if (!can(P.CUSTOMERS_READ)) return;
    fetchOptions<CustomerDto>("/api/customers")
      .then((items) =>
        setCustomers(items.map((c) => ({ value: c.id, label: c.tradeName ?? c.legalName }))),
      )
      .catch(() => setCustomers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const seePrices = can(P.PRICE_LISTS_READ);
  const seeMargin = can(P.SALES_MARGIN_READ);
  return (
    <MasterList<SaleListItemDto>
      title="Ventas"
      subtitle="Entregas a clientes: desde un pedido o directas (mostrador)."
      endpoint="/api/sales"
      basePath={SALES_BASE}
      searchPlaceholder="Buscar por venta, pedido o cliente"
      createLabel="Nueva venta"
      createHref={`${SALES_BASE}/nueva`}
      canCreate={can(P.SALES_CREATE)}
      emptyText="Todavía no hay ventas."
      defaultStatus="all"
      statusOptions={[
        { value: "all", label: "Todos los estados" },
        ...SALE_STATUSES.map((s) => ({ value: s, label: SALE_STATUS_LABELS[s] })),
      ]}
      extraFilters={[
        {
          name: "paymentStatus",
          label: "Cobro",
          allLabel: "Cualquier estado de cobro",
          options: SALE_PAYMENT_STATUSES.map((s) => ({
            value: s,
            label: SALE_PAYMENT_STATUS_LABELS[s],
          })),
        },
        {
          name: "origin",
          label: "Origen",
          allLabel: "Con o sin pedido",
          options: [
            { value: "order", label: "Desde pedido" },
            { value: "direct", label: "Venta directa" },
          ],
        },
        ...(customers.length > 0
          ? [
              {
                name: "customerId",
                label: "Cliente",
                allLabel: "Todos los clientes",
                options: customers,
              },
            ]
          : []),
      ]}
      dateFilters={[
        { name: "from", label: "Desde" },
        { name: "to", label: "Hasta" },
      ]}
      columns={[
        {
          header: "Venta",
          cell: (s) => (
            <Link href={`${SALES_BASE}/${s.id}`} className="code">
              {s.code}
            </Link>
          ),
        },
        { header: "Fecha", cell: (s) => formatWallClock(s.dateLocal) },
        {
          header: "Cliente",
          cell: (s) => (
            <>
              {s.customer.name}
              {s.order && <span className="muted small"> · {s.order.code}</span>}
            </>
          ),
        },
        { header: "Estado", cell: (s) => <SaleStatusBadge status={s.status} /> },
        {
          header: "Cobro",
          cell: (s) =>
            s.status === "POSTED" ? <PaymentStatusBadge status={s.paymentStatus} /> : "—",
        },
        ...(seePrices
          ? [
              {
                header: "Total",
                cell: (s: SaleListItemDto) => formatMoney(s.total, s.currency),
                className: "num",
              },
              {
                header: "Pendiente",
                cell: (s: SaleListItemDto) =>
                  s.status === "POSTED" && s.pending && new D(s.pending).gt(0)
                    ? formatMoney(s.pending, s.currency)
                    : "—",
                className: "num hide-sm",
              },
            ]
          : []),
        ...(seeMargin
          ? [
              {
                header: "Margen sobre materiales",
                cell: (s: SaleListItemDto) => <MarginText margin={s.margin} currency={currency} />,
                className: "num hide-md",
              },
            ]
          : []),
      ]}
    />
  );
}

/* ---------- Detalle ---------- */

function who(at: string | null, by: { displayName: string } | null, tz: string): string | null {
  if (!at) return null;
  return `${formatDateTime(at, tz)}${by ? ` · ${by.displayName}` : ""}`;
}

export function SaleDetail({ id }: { id: string }) {
  const user = useCurrentUser();
  const can = useCan();
  const { data, error, setData } = useResource<SaleDetailDto>(`/api/sales/${id}`);
  const [version, setVersion] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const replace = (sale: SaleDetailDto, w: string[] = []) => {
    setData(sale);
    setWarnings(w);
    setVersion((v) => v + 1);
  };
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const tz = user.company.timezone;
  const currency = data.currency;
  const a = data.actions;
  const pending = data.amounts?.pending ?? "0";

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: SALES_BASE, label: "Ventas" }}
        title={`Venta ${data.code}`}
        status={
          <>
            <SaleStatusBadge status={data.status} />
            {data.status === "POSTED" && <PaymentStatusBadge status={data.paymentStatus} />}
          </>
        }
        subtitle={`${data.customer.name}${data.order ? ` · Pedido ${data.order.code}` : " · Venta directa"} · ${data.warehouse.name}`}
        actions={
          <>
            {a.canPost && (
              <PostSale sale={data} onDone={(r) => replace(r.sale, r.warnings)} version={version} />
            )}
            {a.canEdit && (
              <Link className="button" href={`${SALES_BASE}/${id}/editar`}>
                Editar
              </Link>
            )}
            {a.canRegisterPayment && new D(pending).gt(0) && (
              <PaymentDialog
                primary
                label="Registrar cobro"
                title={`Cobro de la venta ${data.code}`}
                endpoint={`/api/sales/${id}/payments`}
                currency={currency}
                max={pending}
                maxMessage="Supera el pendiente de la venta. Registrá el excedente como cobro a cuenta desde la cuenta corriente del cliente."
                defaultAmount={pending}
                onDone={async (r) =>
                  replace(await apiFetch<SaleDetailDto>(`/api/sales/${id}`), r.warnings)
                }
              />
            )}
            {a.canCancel && <CancelSale sale={data} onDone={replace} />}
            {data.status === "POSTED" && can(P.SALES_CREATE) && (
              <Link
                className={`button ${new D(pending).gt(0) && a.canRegisterPayment ? "" : "button--primary"}`}
                href={`${SALES_BASE}/nueva`}
              >
                Otra venta
              </Link>
            )}
          </>
        }
      />
      <Warnings warnings={warnings} />
      {data.status === "DRAFT" && (
        <p className="alert alert--info">
          Borrador: todavía no descuenta stock ni genera deuda. Revisá la vista previa y confirmá la
          entrega.
        </p>
      )}
      {data.status === "CANCELLED" && (
        <p className="notice">
          Borrador descartado el {data.cancelledAt ? formatDateTime(data.cancelledAt, tz) : "—"}
          {data.cancelledBy ? ` por ${data.cancelledBy.displayName}` : ""}
          {data.cancelReason ? `: ${data.cancelReason}` : "."}
        </p>
      )}
      {data.creditLimitExceeded && (
        <p className="alert alert--warn" role="status">
          Con esta venta el cliente superó su límite de crédito.
        </p>
      )}

      <section className="panel" aria-labelledby="sale-summary-title">
        <h2 id="sale-summary-title">Datos de la venta</h2>
        <Details
          items={[
            [
              "Cliente",
              can(P.CUSTOMER_ACCOUNTS_READ) && !data.customer.walkIn ? (
                <Link href={`${RECEIVABLES_BASE}/${data.customer.id}`}>{data.customer.name}</Link>
              ) : (
                data.customer.name
              ),
            ],
            [
              "Pedido",
              data.order ? (
                <Link href={`${ORDERS_BASE}/${data.order.id}`}>{data.order.code}</Link>
              ) : null,
            ],
            ["Depósito", data.warehouse.name],
            ["Entregada", who(data.postedAt, data.postedBy, tz)],
            ["Creada", who(data.createdAt, data.createdBy, tz)],
            ["Notas", data.notes],
          ]}
        />
        {data.amounts && (
          <dl className="metrics" aria-label="Totales">
            <div>
              <dt>Total</dt>
              <dd data-testid="sale-total">{formatMoney(data.amounts.total, currency)}</dd>
            </div>
            {new D(data.amounts.discountTotal).gt(0) && (
              <div>
                <dt>Descuentos</dt>
                <dd>{formatMoney(data.amounts.discountTotal, currency)}</dd>
              </div>
            )}
            {data.status === "POSTED" && (
              <>
                <div>
                  <dt>Cobrado</dt>
                  <dd>{formatMoney(data.amounts.paid, currency)}</dd>
                </div>
                <div className={new D(data.amounts.pending).gt(0) ? "metric--warning" : ""}>
                  <dt>Pendiente</dt>
                  <dd data-testid="sale-pending">{formatMoney(data.amounts.pending, currency)}</dd>
                </div>
              </>
            )}
            {data.canSeeCosts && data.status === "POSTED" && (
              <div>
                <dt>Costo material</dt>
                <dd>{formatMoney(data.materialCost, currency)}</dd>
              </div>
            )}
            {data.canSeeMargin && data.status === "POSTED" && (
              <div>
                <dt>Margen sobre materiales</dt>
                <dd data-testid="sale-margin">
                  <MarginText margin={data.margin} currency={currency} />
                </dd>
              </div>
            )}
          </dl>
        )}
        {data.status === "POSTED" && <NegativeMarginNotice margin={data.margin} />}
      </section>

      {data.status === "DRAFT" ? (
        <SalePreview id={id} version={version} sale={data} />
      ) : (
        <SaleLines sale={data} />
      )}
      {data.payments && data.status === "POSTED" && <SalePayments sale={data} tz={tz} />}
      <AuditHistory entityType="sale" entityId={id} version={version} />
    </div>
  );
}

function LotsCell({
  lots,
  unit,
  currency,
  showCost,
}: {
  lots: SaleLotDto[];
  unit: string;
  currency: string;
  showCost: boolean;
}) {
  const can = useCan();
  const links = can(P.PRODUCT_LOTS_READ);
  if (lots.length === 0) return <span className="muted">—</span>;
  return (
    <ul className="plain-list">
      {lots.map((l) => (
        <li key={l.lot.id}>
          {links ? <Link href={`${LOTS_BASE}/${l.lot.id}`}>{l.lot.code}</Link> : l.lot.code}{" "}
          <ConservationBadge state={l.lot.conservationState} /> {formatQuantity(l.quantity, unit)}
          <span className="muted small">
            {l.fromReservation ? " · reservado" : " · stock libre"}
            {showCost && l.unitCost && ` · ${formatUnitCost(l.unitCost, currency, unit)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SaleLines({ sale }: { sale: SaleDetailDto }) {
  const currency = sale.currency;
  return (
    <section className="panel" aria-labelledby="sale-lines-title">
      <h2 id="sale-lines-title">Productos entregados</h2>
      <div className="table-wrap">
        <table className="table" aria-label="Productos de la venta">
          <thead>
            <tr>
              <th scope="col">Producto</th>
              <th scope="col" className="num">
                Cantidad
              </th>
              {sale.canSeePrices && (
                <>
                  <th scope="col" className="num">
                    Precio
                  </th>
                  <th scope="col" className="num">
                    Importe
                  </th>
                </>
              )}
              <th scope="col">Lotes</th>
              {sale.canSeeCosts && (
                <th scope="col" className="num hide-sm">
                  Costo material
                </th>
              )}
              {sale.canSeeMargin && (
                <th scope="col" className="num hide-md">
                  Margen
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {sale.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.product.name}</td>
                <td className="num">{formatQuantity(l.quantity, l.unit.symbol)}</td>
                {sale.canSeePrices && (
                  <>
                    <td className="num">
                      {l.price && formatMoney(l.price.unitPrice, currency)}
                      {l.price && (
                        <span className="muted small">
                          <br />
                          {PRICE_SOURCE_LABELS[l.price.priceSource]}
                          {l.price.overrideReason && ` · ${l.price.overrideReason}`}
                        </span>
                      )}
                    </td>
                    <td className="num">
                      {l.price && formatMoney(l.price.netAmount, currency)}
                      {l.price && new D(l.price.discountAmount).gt(0) && (
                        <span className="muted small">
                          <br />
                          Desc. {formatMoney(l.price.discountAmount, currency)}
                        </span>
                      )}
                    </td>
                  </>
                )}
                <td>
                  <LotsCell
                    lots={l.lots}
                    unit={l.saleUnit.symbol}
                    currency={currency}
                    showCost={sale.canSeeCosts}
                  />
                </td>
                {sale.canSeeCosts && (
                  <td className="num hide-sm">{formatMoney(l.materialCost, currency)}</td>
                )}
                {sale.canSeeMargin && (
                  <td className="num hide-md">
                    <MarginText margin={l.margin} currency={currency} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SalePayments({ sale, tz }: { sale: SaleDetailDto; tz: string }) {
  const payments = sale.payments ?? [];
  return (
    <section className="panel" aria-labelledby="sale-payments-title">
      <h2 id="sale-payments-title">Cobros aplicados</h2>
      {payments.length === 0 ? (
        <p className="muted">Todavía no tiene cobros.</p>
      ) : (
        <div className="table-wrap">
          <table className="table" aria-label="Cobros de la venta">
            <thead>
              <tr>
                <th scope="col">Cobro</th>
                <th scope="col">Fecha</th>
                <th scope="col">Origen</th>
                <th scope="col" className="hide-sm">
                  Medio
                </th>
                <th scope="col" className="num">
                  Aplicado
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={`${p.paymentId}-${p.appliedAt}`}>
                  <td>
                    <span className="code">{p.code}</span>
                  </td>
                  <td>{formatDateTime(p.appliedAt, tz)}</td>
                  <td>
                    {APPLICATION_ORIGIN_LABELS[p.origin]}
                    <span className="muted small"> · {PAYMENT_KIND_LABELS[p.kind]}</span>
                  </td>
                  <td className="hide-sm">{PAYMENT_METHOD_LABELS[p.method]}</td>
                  <td className="num">{formatMoney(p.amount, sale.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Vista previa de la entrega: qué lotes salen, costo y margen, señas, crédito y avisos. */
function SalePreview({ id, version, sale }: { id: string; version: number; sale: SaleDetailDto }) {
  const { data, error } = useResource<SalePreviewDto>(`/api/sales/${id}/preview?v=${version}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  return <PreviewView preview={data} sale={sale} />;
}

export function PreviewView({ preview, sale }: { preview: SalePreviewDto; sale: SaleDetailDto }) {
  const currency = sale.currency;
  const blocking = preview.issues.filter((i) => i.blocking);
  const warnings = preview.issues.filter((i) => !i.blocking);
  return (
    <section className="panel" aria-labelledby="preview-title" data-testid="sale-preview">
      <h2 id="preview-title">Vista previa de la entrega</h2>
      <p className="muted small">
        {sale.order
          ? "Primero se usan los lotes reservados para el pedido; lo que falte sale del stock libre. "
          : ""}
        {FEFO_SALE_HINT}.
      </p>
      {blocking.length > 0 && (
        <div className="alert alert--warn" role="alert" data-testid="preview-blocking">
          <strong>No se puede confirmar</strong>
          <ul>
            {blocking.map((i) => (
              <li key={`${i.code}-${i.message}`}>{localizeNumbers(i.message)}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="alert alert--warn" role="status" data-testid="preview-warnings">
          <ul>
            {warnings.map((i) => (
              <li key={`${i.code}-${i.message}`}>{localizeNumbers(i.message)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="table-wrap">
        <table className="table" aria-label="Lotes a entregar">
          <thead>
            <tr>
              <th scope="col">Producto</th>
              <th scope="col" className="num">
                Cantidad
              </th>
              <th scope="col">Lotes que salen</th>
              <th scope="col" className="num">
                Falta
              </th>
              {preview.total !== null && (
                <th scope="col" className="num">
                  Importe
                </th>
              )}
              {preview.materialCost !== null && (
                <th scope="col" className="num hide-sm">
                  Costo material
                </th>
              )}
              {preview.margin !== null && (
                <th scope="col" className="num hide-md">
                  Margen
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {preview.lines.map((l) => (
              <tr key={l.lineId}>
                <td>{l.product.name}</td>
                <td className="num">{formatQuantity(l.quantity, l.saleUnit.symbol)}</td>
                <td>
                  <LotsCell
                    lots={l.lots}
                    unit={l.saleUnit.symbol}
                    currency={currency}
                    showCost={preview.materialCost !== null}
                  />
                </td>
                <td className={`num ${new D(l.missing).gt(0) ? "text-negative" : ""}`}>
                  {new D(l.missing).gt(0) ? formatQuantity(l.missing, l.saleUnit.symbol) : "—"}
                </td>
                {preview.total !== null && (
                  <td className="num">{formatMoney(l.netAmount, currency)}</td>
                )}
                {preview.materialCost !== null && (
                  <td className="num hide-sm">{formatMoney(l.materialCost, currency)}</td>
                )}
                {preview.margin !== null && (
                  <td className="num hide-md">
                    <MarginText margin={l.margin} currency={currency} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="metrics" aria-label="Resumen de la entrega">
        {preview.total !== null && (
          <div>
            <dt>Total de la venta</dt>
            <dd>{formatMoney(preview.total, currency)}</dd>
          </div>
        )}
        {preview.materialCost !== null && (
          <div>
            <dt>Costo material</dt>
            <dd>{formatMoney(preview.materialCost, currency)}</dd>
          </div>
        )}
        {preview.margin !== null && (
          <div>
            <dt>Margen sobre materiales</dt>
            <dd data-testid="preview-margin">
              <MarginText margin={preview.margin} currency={currency} />
            </dd>
          </div>
        )}
        {preview.advances && new D(preview.advances.toApply).gt(0) && (
          <div>
            <dt>Seña que se aplica</dt>
            <dd>{formatMoney(preview.advances.toApply, currency)}</dd>
          </div>
        )}
        {preview.advances && new D(preview.advances.remainingCredit).gt(0) && (
          <div>
            <dt>Queda a favor del cliente</dt>
            <dd>{formatMoney(preview.advances.remainingCredit, currency)}</dd>
          </div>
        )}
        {preview.credit && (
          <div>
            <dt>Saldo del cliente después</dt>
            <dd className={preview.credit.exceeded ? "text-negative" : ""}>
              {formatMoney(preview.credit.projectedBalance, currency)}
              {preview.credit.limit && (
                <span className="cost-summary__note">
                  {" "}
                  Límite {formatMoney(preview.credit.limit, currency)}
                </span>
              )}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/* ---------- Acciones ---------- */

function PostSale({
  sale,
  onDone,
  version,
}: {
  sale: SaleDetailDto;
  onDone: (r: SaleOperationResultDto) => void;
  version: number;
}) {
  const can = useCan();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [operationId, renew] = useOperationId();
  // Consumidor final paga en el momento; un cliente con cuenta, en general, no.
  const [collect, setCollect] = useState(sale.customer.walkIn);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethodDto>("CASH");
  const [reference, setReference] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: preview } = useResource<SalePreviewDto>(
    `/api/sales/${sale.id}/preview?v=${version}`,
  );
  const canCollect = can(P.PAYMENTS_CREATE, P.PAYMENTS_POST) && sale.canSeePrices;
  const due =
    preview?.total && preview.advances
      ? D.max(new D(preview.total).minus(preview.advances.toApply), 0).toFixed(2)
      : (preview?.total ?? null);

  async function confirm() {
    setError(null);
    if (collect && !isPositive(amount)) {
      setError("Ingresá el monto cobrado.");
      return;
    }
    setPending(true);
    try {
      const result = await apiFetch<SaleOperationResultDto>(`/api/sales/${sale.id}/post`, {
        method: "POST",
        body: collect
          ? {
              initialPayment: {
                amount: toDecimal(amount),
                paymentMethod: method,
                reference: reference.trim() || null,
                operationId,
              },
            }
          : {},
      });
      renew();
      dialogRef.current?.close();
      onDone(result);
    } catch (err) {
      setError(err instanceof ApiError ? describeError(err) : "No se pudo confirmar la venta.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        ref={openerRef}
        className="button button--primary"
        disabled={preview ? !preview.canPost : false}
        title={preview && !preview.canPost ? "Revisá los avisos de la vista previa" : undefined}
        onClick={() => {
          setError(null);
          if (due && !amount) setAmount(due);
          dialogRef.current?.showModal();
        }}
      >
        Confirmar entrega y venta
      </button>
      <dialog
        ref={dialogRef}
        className="dialog"
        aria-labelledby={titleId}
        onClose={() => openerRef.current?.focus()}
      >
        <h2 id={titleId}>¿Confirmar la entrega y la venta {sale.code}?</h2>
        <div className="muted">
          Se descuentan del stock los lotes de la vista previa, se registra su costo material real y
          la deuda del cliente
          {preview?.advances && new D(preview.advances.toApply).gt(0)
            ? `, y se aplica la seña de ${formatMoney(preview.advances.toApply, sale.currency)}`
            : ""}
          . Una venta entregada no se puede modificar.
        </div>
        {preview?.issues
          .filter((i) => !i.blocking)
          .map((i) => (
            <p key={i.code} className="alert alert--warn">
              {localizeNumbers(i.message)}
            </p>
          ))}
        {canCollect && due && new D(due).gt(0) && (
          <>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={collect}
                onChange={(e) => setCollect(e.target.checked)}
              />{" "}
              Cobrar ahora
            </label>
            {collect && (
              <div className="form-grid">
                <div className="form__field">
                  <label htmlFor="post-amount">Monto cobrado</label>
                  <input
                    id="post-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <span className="form__hint">A cobrar: {formatMoney(due, sale.currency)}</span>
                </div>
                <div className="form__field">
                  <label htmlFor="post-method">Medio de pago</label>
                  <select
                    id="post-method"
                    value={method}
                    onChange={(e) => setMethod(e.target.value as PaymentMethodDto)}
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {PAYMENT_METHOD_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form__field">
                  <label htmlFor="post-reference">Referencia</label>
                  <input
                    id="post-reference"
                    value={reference}
                    maxLength={120}
                    onChange={(e) => setReference(e.target.value)}
                  />
                </div>
              </div>
            )}
          </>
        )}
        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="form__footer">
          <button
            type="button"
            className="button"
            onClick={() => dialogRef.current?.close()}
            disabled={pending}
          >
            Volver
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={confirm}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? "Confirmando…" : "Confirmar entrega y venta"}
          </button>
        </div>
      </dialog>
    </>
  );
}

function CancelSale({ sale, onDone }: { sale: SaleDetailDto; onDone: (s: SaleDetailDto) => void }) {
  const [reason, setReason] = useState("");
  return (
    <ConfirmAction
      label="Descartar borrador"
      title={`¿Descartar el borrador ${sale.code}?`}
      message="No se movió stock ni se generó deuda. El borrador descartado no se puede recuperar."
      confirmLabel="Descartar"
      danger
      onConfirm={async () => {
        onDone(
          await apiFetch<SaleDetailDto>(`/api/sales/${sale.id}/cancel`, {
            method: "POST",
            body: { reason: reason.trim() },
          }),
        );
      }}
    >
      <div className="form__field">
        <label htmlFor="sale-cancel-reason">Motivo</label>
        <textarea
          id="sale-cancel-reason"
          value={reason}
          maxLength={500}
          rows={2}
          required
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
    </ConfirmAction>
  );
}
