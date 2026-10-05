"use client";

import {
  PERMISSIONS as P,
  PURCHASE_STATUSES,
  PURCHASE_STATUS_LABELS,
  RECEIPT_STATUS_LABELS,
  type PurchaseDto,
  type PurchaseLineDto,
  type PurchaseListItemDto,
  type PurchaseStatus,
  type ReceiptDto,
  type ReceiptStatus,
  type SupplierDto,
} from "@bakery/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { apiFetch, fetchOptions } from "@/lib/api-client";
import { PURCHASE_STATUS_TONE, RECEIPT_STATUS_TONE } from "@/lib/status";
import { StatusBadge } from "../ui/status";
import {
  formatDate,
  formatDateTime,
  formatDecimal,
  formatMoney,
  formatQuantity,
  formatUnitCost,
} from "@/lib/format";
import { MasterList } from "../masters/master-list";
import {
  AuditHistory,
  ConfirmAction,
  CopyableCode,
  Details,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  useResource,
} from "../masters/ui";
import { useCan, useCurrentUser } from "../user-context";
import { STOCK_BASE } from "../inventory/inventory-pages";

/*
 * Compras (Fase 3): listado, detalle con líneas y recepciones, y el detalle de
 * una recepción. Pedir una compra no mueve stock: sólo una recepción confirmada.
 */

export const PURCHASES_BASE = "/compras";

export function PurchaseStatusBadge({ status }: { status: PurchaseStatus }) {
  return (
    <StatusBadge tone={PURCHASE_STATUS_TONE[status]}>{PURCHASE_STATUS_LABELS[status]}</StatusBadge>
  );
}

export function ReceiptStatusBadge({ status }: { status: ReceiptStatus }) {
  return (
    <StatusBadge tone={RECEIPT_STATUS_TONE[status]}>{RECEIPT_STATUS_LABELS[status]}</StatusBadge>
  );
}

/** "4 × Bolsa 25 kg" o "20 kg" (sin presentación). */
export function commercialQuantity(
  line: Pick<PurchaseLineDto, "presentation" | "purchaseUnit">,
  quantity: string,
): string {
  return line.presentation
    ? `${formatDecimal(quantity, 0, 4)} × ${line.presentation.name}`
    : formatQuantity(quantity, line.purchaseUnit.symbol);
}

/** Precio por unidad comercial: "$20.000,00 / bolsa". */
export function commercialPrice(line: PurchaseLineDto, currency: string): string {
  return formatUnitCost(line.unitPrice, currency, line.purchaseUnit.symbol);
}

/** Nombre de un proveedor como se muestra en toda la app: fantasía si tiene, si no razón social. */
export const supplierLabel = (s: Pick<SupplierDto, "legalName" | "tradeName">) =>
  s.tradeName || s.legalName;

export function PurchaseList() {
  const can = useCan();
  const canSeeSuppliers = can(P.SUPPLIERS_READ);
  const [suppliers, setSuppliers] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    if (!canSeeSuppliers) return;
    fetchOptions<SupplierDto>("/api/suppliers")
      .then((items) => setSuppliers(items.map((s) => ({ value: s.id, label: supplierLabel(s) }))))
      .catch(() => setSuppliers([]));
  }, [canSeeSuppliers]);
  return (
    <MasterList<PurchaseListItemDto>
      title="Compras"
      subtitle="Pedidos a proveedores. El stock y el costo cambian recién al confirmar una recepción."
      endpoint="/api/purchases"
      basePath={PURCHASES_BASE}
      searchPlaceholder="Buscar por número, proveedor o documento"
      createLabel="Nueva compra"
      createHref={`${PURCHASES_BASE}/nueva`}
      canCreate={can(P.PURCHASES_CREATE)}
      emptyText="Todavía no hay compras cargadas. Una compra registra el pedido al proveedor; el stock entra al confirmar su recepción."
      defaultStatus="all"
      statusOptions={[
        { value: "all", label: "Todos los estados" },
        { value: "open", label: "Pendientes de recibir" },
        ...PURCHASE_STATUSES.map((s) => ({ value: s, label: PURCHASE_STATUS_LABELS[s] })),
      ]}
      // Sin permiso para ver proveedores no hay lista que ofrecer: el filtro no se muestra.
      extraFilters={
        canSeeSuppliers
          ? [
              {
                name: "supplierId",
                label: "Proveedor",
                allLabel: "Todos los proveedores",
                options: suppliers,
              },
            ]
          : []
      }
      columns={[
        {
          header: "Número",
          cell: (p) => (
            <Link href={`${PURCHASES_BASE}/${p.id}`} className="code">
              {p.number}
            </Link>
          ),
        },
        { header: "Proveedor", cell: (p) => p.supplier.name },
        { header: "Fecha", cell: (p) => formatDate(p.purchaseDate), className: "hide-md" },
        {
          header: "Entrega esperada",
          cell: (p) =>
            p.expectedDate ? formatDate(p.expectedDate) : <span className="muted">Sin fecha</span>,
        },
        { header: "Estado", cell: (p) => <PurchaseStatusBadge status={p.status} /> },
        { header: "Total", cell: (p) => formatMoney(p.total, p.currency), className: "num" },
        {
          header: "Recibido ($)",
          cell: (p) => formatMoney(p.receivedAmount, p.currency),
          className: "num hide-md",
        },
        {
          header: "Pendiente de recibir ($)",
          cell: (p) =>
            p.status === "CANCELLED" ? (
              <span className="muted">Cancelada</span>
            ) : (
              formatMoney(p.pendingAmount, p.currency)
            ),
          className: "num",
        },
      ]}
    />
  );
}

/** Aviso con el que el formulario llega al borrador cuando se guardó pero no se pudo pedir. */
export const ORDER_FAILED_PARAM = "pedido";

export function PurchaseDetail({ id }: { id: string }) {
  return (
    <Suspense fallback={<Loading />}>
      <PurchaseDetailInner id={id} />
    </Suspense>
  );
}

/** Recibido / pendiente con la unidad de compra de la línea: "2 bolsa", "40 kg". */
function lineQuantity(line: PurchaseLineDto, quantity: string): string {
  return formatQuantity(quantity, line.purchaseUnit.symbol);
}

function PurchaseDetailInner({ id }: { id: string }) {
  const can = useCan();
  const user = useCurrentUser();
  const params = useSearchParams();
  const { data, error, reload } = useResource<PurchaseDto>(`/api/purchases/${id}`);
  const [version, setVersion] = useState(0);
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const tz = user.company.timezone;
  const showCosts = can(P.INVENTORY_COST_READ);
  const receivable = data.status === "ORDERED" || data.status === "PARTIALLY_RECEIVED";
  const hasPosted = data.receipts.some((r) => r.status === "POSTED");
  const cancellable = (data.status === "DRAFT" || data.status === "ORDERED") && !hasPosted;
  const orderFailed = data.status === "DRAFT" && params.get(ORDER_FAILED_PARAM) !== null;
  // Las recepciones descartadas (intentos que no se confirmaron) no son mercadería: se cuentan aparte.
  const receipts = data.receipts.filter((r) => r.status !== "CANCELLED");
  const discarded = data.receipts.length - receipts.length;
  const materialLink = (line: PurchaseLineDto) =>
    can(P.INVENTORY_READ) ? (
      <Link href={`${STOCK_BASE}/${line.rawMaterial.id}`}>{line.rawMaterial.name}</Link>
    ) : (
      line.rawMaterial.name
    );

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: PURCHASES_BASE, label: "Compras" }}
        title={
          <>
            Compra <CopyableCode code={data.number} />
          </>
        }
        status={<PurchaseStatusBadge status={data.status} />}
        subtitle={`${data.supplier.name} · ${formatDate(data.purchaseDate)}`}
        actions={
          <>
            {data.status === "DRAFT" && can(P.PURCHASES_UPDATE) && (
              <Link className="button" href={`${PURCHASES_BASE}/${id}/editar`}>
                Editar
              </Link>
            )}
            {cancellable && can(P.PURCHASES_CANCEL) && (
              <CancelPurchase purchase={data} onDone={refresh} />
            )}
            {data.status === "DRAFT" && can(P.PURCHASES_ORDER) && (
              <ConfirmAction
                label="Confirmar pedido"
                variant="primary"
                title={`¿Confirmar el pedido ${data.number}?`}
                message="Queda pedida al proveedor y lista para recibir. Las líneas y los precios ya no se editan. El stock no cambia hasta registrar la recepción."
                confirmLabel="Confirmar pedido"
                disabled={data.lines.length === 0}
                disabledReason="Agregá al menos una materia prima"
                onConfirm={async () => {
                  await apiFetch(`/api/purchases/${id}/order`, { method: "POST" });
                  refresh();
                }}
              />
            )}
            {receivable && can(P.PURCHASES_RECEIVE) && (
              <Link className="button button--primary" href={`${PURCHASES_BASE}/${id}/recepcion`}>
                Registrar recepción
              </Link>
            )}
          </>
        }
      />

      {orderFailed && (
        <p className="alert" role="alert">
          La compra se guardó como borrador, pero no se pudo confirmar el pedido
          {params.get(ORDER_FAILED_PARAM) ? `: ${params.get(ORDER_FAILED_PARAM)}` : "."} Revisala y
          usá “Confirmar pedido” para reintentar (no hace falta cargarla de nuevo).
        </p>
      )}
      {data.status === "DRAFT" && data.lines.length === 0 && (
        <p className="muted">
          Para confirmar el pedido, agregá al menos una materia prima desde “Editar”.
        </p>
      )}
      {data.status === "CANCELLED" && (
        <p className="notice">
          Cancelada el {data.cancelledAt ? formatDateTime(data.cancelledAt, tz) : "—"}
          {data.cancelledBy ? ` por ${data.cancelledBy.displayName}` : ""}
          {data.cancelReason ? `: ${data.cancelReason}` : "."}
        </p>
      )}

      <section className="panel" aria-label="Resumen de la compra">
        <dl className="cost-summary">
          <div className="metric">
            <dt>Proveedor</dt>
            <dd className="metric__value">{data.supplier.name}</dd>
          </div>
          <div className="metric">
            <dt>Fecha</dt>
            <dd className="metric__value">{formatDate(data.purchaseDate)}</dd>
          </div>
          <div className="metric metric--emphasis">
            <dt>Total</dt>
            <dd className="metric__value">{formatMoney(data.total, data.currency)}</dd>
          </div>
          <div className={`metric ${data.status === "RECEIVED" ? "metric--success" : ""}`}>
            <dt>Recibido</dt>
            <dd className="metric__value">{formatMoney(data.receivedAmount, data.currency)}</dd>
          </div>
          <div
            className={`metric ${data.status === "PARTIALLY_RECEIVED" ? "metric--warning" : ""}`}
          >
            <dt>Pendiente</dt>
            <dd className="metric__value">
              {data.status === "CANCELLED" ? "—" : formatMoney(data.pendingAmount, data.currency)}
            </dd>
          </div>
        </dl>
        <Details
          hideEmpty
          items={[
            ["Fecha esperada de entrega", data.expectedDate ? formatDate(data.expectedDate) : null],
            ["Documento del proveedor", data.supplierDocumentNumber],
            ["Creada por", data.createdBy?.displayName],
            [
              "Pedida",
              data.orderedAt
                ? `${formatDateTime(data.orderedAt, tz)}${data.orderedBy ? ` · ${data.orderedBy.displayName}` : ""}`
                : null,
            ],
            ["Observaciones", data.notes],
          ]}
        />
      </section>

      <section className="panel" aria-labelledby="lines-title">
        <h2 id="lines-title">Líneas</h2>
        {data.lines.length === 0 ? (
          <EmptyState
            compact
            title="Sin líneas."
            description="Editá el borrador para agregar materias primas."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Materia prima</th>
                  <th scope="col">Pedido</th>
                  <th scope="col" className="num hide-md">
                    Precio
                  </th>
                  <th scope="col" className="num">
                    Neto
                  </th>
                  <th scope="col" className="num">
                    Recibido
                  </th>
                  <th scope="col" className="num">
                    Pendiente
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((line) => (
                  <tr key={line.id}>
                    <td>
                      {materialLink(line)}
                      <span className="cost-source">
                        Equivale a{" "}
                        {formatQuantity(line.orderedBaseQuantity, line.rawMaterial.baseUnit.symbol)}
                        {showCosts &&
                          ` · ${formatUnitCost(
                            line.acquisitionUnitCost,
                            data.currency,
                            line.rawMaterial.baseUnit.symbol,
                          )}`}
                      </span>
                    </td>
                    <td>{commercialQuantity(line, line.orderedQuantity)}</td>
                    <td className="num hide-md">
                      {commercialPrice(line, data.currency)}
                      {Number(line.discountAmount) !== 0 && (
                        <span className="cost-source">
                          Descuento {formatMoney(line.discountAmount, data.currency)}
                        </span>
                      )}
                    </td>
                    <td className="num">{formatMoney(line.netAmount, data.currency)}</td>
                    <td className="num">{lineQuantity(line, line.receivedQuantity)}</td>
                    <td className="num">
                      {Number(line.pendingQuantity) === 0 ? (
                        <span className="muted">Nada</span>
                      ) : (
                        lineQuantity(line, line.pendingQuantity)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <dl className="details">
          <div>
            <dt>Subtotal</dt>
            <dd>{formatMoney(data.subtotal, data.currency)}</dd>
          </div>
          <div>
            <dt>Descuentos</dt>
            <dd>{formatMoney(data.discountTotal, data.currency)}</dd>
          </div>
          <div>
            <dt>Impuestos (informativos)</dt>
            <dd>{formatMoney(data.taxTotal, data.currency)}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>
              <strong>{formatMoney(data.total, data.currency)}</strong>
            </dd>
          </div>
        </dl>
        {showCosts && (
          <p className="muted small">
            El costo que entra al inventario es el neto de cada línea (sin impuestos) dividido por
            la cantidad en la unidad base.
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby="receipts-title">
        <h2 id="receipts-title">Recepciones</h2>
        {receipts.length === 0 ? (
          <EmptyState
            compact
            title={receivable ? "Todavía no llegó mercadería." : "Sin recepciones."}
            description={
              receivable
                ? "Cuando llegue, usá “Registrar recepción”: el stock y el costo promedio se actualizan al confirmarla."
                : data.status === "DRAFT"
                  ? "Primero confirmá el pedido; después se registra lo que llega."
                  : undefined
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Recepción</th>
                  <th scope="col">Fecha</th>
                  <th scope="col" className="hide-md">
                    Depósito
                  </th>
                  <th scope="col">Estado</th>
                  {showCosts && (
                    <th scope="col" className="num">
                      Valor ingresado
                    </th>
                  )}
                  <th scope="col" className="hide-md">
                    Confirmó
                  </th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`${PURCHASES_BASE}/${id}/recepciones/${r.id}`} className="code">
                        {r.number}
                      </Link>
                    </td>
                    <td>{formatDateTime(r.receivedAt, tz)}</td>
                    <td className="hide-md">{r.warehouse.name}</td>
                    <td>
                      <ReceiptStatusBadge status={r.status} />
                    </td>
                    {showCosts && (
                      <td className="num">{formatMoney(r.inventoryValue, data.currency)}</td>
                    )}
                    <td className="hide-md">{r.postedBy?.displayName ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {discarded > 0 && (
          <p className="muted small">
            {discarded === 1
              ? "1 intento de recepción no se confirmó y quedó descartado (no movió stock)."
              : `${discarded} intentos de recepción no se confirmaron y quedaron descartados (no movieron stock).`}
          </p>
        )}
        {hasPosted && can(P.INVENTORY_READ) && (
          <p className="muted small">
            Lo recibido ya está en el stock: abrí cada materia prima desde la tabla de líneas para
            ver su existencia y su costo promedio.
          </p>
        )}
      </section>

      <AuditHistory entityType="purchase" entityId={id} version={version} />
    </div>
  );
}

function CancelPurchase({ purchase, onDone }: { purchase: PurchaseDto; onDone: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <ConfirmAction
      label="Cancelar compra"
      title={`¿Cancelar la compra ${purchase.number}?`}
      message="La compra queda cancelada y no podrá recibir mercadería. No se borra: queda en el historial."
      confirmLabel="Cancelar compra"
      danger
      onConfirm={async () => {
        await apiFetch(`/api/purchases/${purchase.id}/cancel`, {
          method: "POST",
          body: { reason: reason.trim() || null },
        });
        onDone();
      }}
    >
      <div className="form__field" style={{ marginTop: "0.8rem" }}>
        <label htmlFor="cancel-reason">Motivo (opcional)</label>
        <input
          id="cancel-reason"
          autoComplete="off"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
    </ConfirmAction>
  );
}

export function ReceiptDetail({
  purchaseId,
  receiptId,
}: {
  purchaseId: string;
  receiptId: string;
}) {
  const user = useCurrentUser();
  const can = useCan();
  const { data, error, reload } = useResource<ReceiptDto>(`/api/purchase-receipts/${receiptId}`);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (data.purchase.id !== purchaseId)
    return (
      <EmptyState
        title="Esta recepción no pertenece a la compra indicada."
        action={
          <Link className="button" href={`${PURCHASES_BASE}/${data.purchase.id}`}>
            Ir a la compra {data.purchase.number}
          </Link>
        }
      />
    );
  const tz = user.company.timezone;
  const showCosts = can(P.INVENTORY_COST_READ);
  const purchaseQty = (l: ReceiptDto["lines"][number], q: string) =>
    l.presentation
      ? `${formatDecimal(q, 0, 4)} × ${l.presentation.name}`
      : formatQuantity(q, l.purchaseUnit.symbol);
  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { href: PURCHASES_BASE, label: "Compras" },
          { href: `${PURCHASES_BASE}/${purchaseId}`, label: `Compra ${data.purchase.number}` },
        ]}
        title={
          <>
            Recepción <CopyableCode code={data.number} />
          </>
        }
        status={<ReceiptStatusBadge status={data.status} />}
        subtitle={`${data.purchase.supplierName} · ${formatDateTime(data.receivedAt, tz)}`}
      />
      {data.status === "POSTED" && (
        <p className="muted">
          Ingresó al stock de {data.warehouse.name} y ya no se modifica. Una corrección se hace con
          un ajuste de inventario.
        </p>
      )}
      <section className="panel" aria-label="Datos de la recepción">
        <Details
          hideEmpty
          items={[
            ["Fecha de recepción", formatDateTime(data.receivedAt, tz)],
            ["Depósito", data.warehouse.name],
            ["Remito / documento", data.documentNumber],
            [
              "Valor ingresado al inventario",
              showCosts ? formatMoney(data.inventoryValue, data.currency) : null,
            ],
            [
              "Confirmada",
              data.postedAt
                ? `${formatDateTime(data.postedAt, tz)}${data.postedBy ? ` · ${data.postedBy.displayName}` : ""}`
                : null,
            ],
            ["Observaciones", data.notes],
          ]}
        />
      </section>
      <section className="panel" aria-labelledby="receipt-lines">
        <h2 id="receipt-lines">Mercadería recibida</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Materia prima</th>
                <th scope="col">Recibido</th>
                <th scope="col" className="num">
                  Ingresó al stock
                </th>
                {showCosts && (
                  <>
                    <th scope="col" className="num hide-md">
                      Costo de adquisición
                    </th>
                    <th scope="col" className="num">
                      Valor
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {can(P.INVENTORY_READ) ? (
                      <Link href={`${STOCK_BASE}/${l.rawMaterial.id}`}>{l.rawMaterial.name}</Link>
                    ) : (
                      l.rawMaterial.name
                    )}
                  </td>
                  <td>
                    {purchaseQty(l, l.receivedQuantity)}
                    <span className="cost-source">
                      Pedido {purchaseQty(l, l.orderedQuantity)} · recibido antes{" "}
                      {purchaseQty(l, l.previouslyReceivedQuantity)}
                    </span>
                  </td>
                  <td className="num">
                    {formatQuantity(l.normalizedBaseQuantity, l.baseUnit.symbol)}
                  </td>
                  {showCosts && (
                    <>
                      <td className="num hide-md">
                        {formatUnitCost(l.acquisitionUnitCost, data.currency, l.baseUnit.symbol)}
                      </td>
                      <td className="num">{formatMoney(l.lineInventoryValue, data.currency)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
