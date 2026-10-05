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
import { useEffect, useState } from "react";
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
  Details,
  ErrorState,
  Loading,
  PageHeader,
  useResource,
} from "../masters/ui";
import { useCan, useCurrentUser } from "../user-context";

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

export function PurchaseList() {
  const can = useCan();
  const [suppliers, setSuppliers] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    fetchOptions<SupplierDto>("/api/suppliers")
      .then((items) => setSuppliers(items.map((s) => ({ value: s.id, label: s.legalName }))))
      .catch(() => setSuppliers([]));
  }, []);
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
      emptyText="Todavía no hay compras cargadas."
      defaultStatus="all"
      statusOptions={[
        { value: "all", label: "Todos los estados" },
        { value: "open", label: "Pendientes de recibir" },
        ...PURCHASE_STATUSES.map((s) => ({ value: s, label: PURCHASE_STATUS_LABELS[s] })),
      ]}
      extraFilters={[
        {
          name: "supplierId",
          label: "Proveedor",
          allLabel: "Todos los proveedores",
          options: suppliers,
        },
      ]}
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
        { header: "Fecha", cell: (p) => formatDate(p.purchaseDate), className: "hide-sm" },
        { header: "Estado", cell: (p) => <PurchaseStatusBadge status={p.status} /> },
        { header: "Total", cell: (p) => formatMoney(p.total, p.currency), className: "num" },
        {
          header: "Recibido",
          cell: (p) => formatMoney(p.receivedAmount, p.currency),
          className: "num hide-sm",
        },
        {
          header: "Pendiente",
          cell: (p) => (p.status === "CANCELLED" ? "—" : formatMoney(p.pendingAmount, p.currency)),
          className: "num hide-sm",
        },
      ]}
    />
  );
}

export function PurchaseDetail({ id }: { id: string }) {
  const can = useCan();
  const user = useCurrentUser();
  const { data, error, reload } = useResource<PurchaseDto>(`/api/purchases/${id}`);
  const [version, setVersion] = useState(0);
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const tz = user.company.timezone;
  const receivable = data.status === "ORDERED" || data.status === "PARTIALLY_RECEIVED";
  const hasPosted = data.receipts.some((r) => r.status === "POSTED");
  const cancellable = (data.status === "DRAFT" || data.status === "ORDERED") && !hasPosted;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: PURCHASES_BASE, label: "Compras" }}
        title={
          <>
            Compra {data.number} <PurchaseStatusBadge status={data.status} />
          </>
        }
        subtitle={`${data.supplier.name} · ${formatDate(data.purchaseDate)}`}
        actions={
          <>
            {receivable && can(P.PURCHASES_RECEIVE) && (
              <Link className="button button--primary" href={`${PURCHASES_BASE}/${id}/recepcion`}>
                Registrar recepción
              </Link>
            )}
            {data.status === "DRAFT" && can(P.PURCHASES_UPDATE) && (
              <Link className="button" href={`${PURCHASES_BASE}/${id}/editar`}>
                Editar
              </Link>
            )}
            {data.status === "DRAFT" && can(P.PURCHASES_ORDER) && (
              <ConfirmAction
                label="Confirmar pedido"
                title={`¿Confirmar el pedido ${data.number}?`}
                message="Queda pedida al proveedor y lista para recibir. Las líneas y los precios ya no se editan."
                confirmLabel="Confirmar pedido"
                onConfirm={async () => {
                  await apiFetch(`/api/purchases/${id}/order`, { method: "POST" });
                  refresh();
                }}
              />
            )}
            {cancellable && can(P.PURCHASES_CANCEL) && (
              <CancelPurchase purchase={data} onDone={refresh} />
            )}
          </>
        }
      />

      {data.status === "CANCELLED" && (
        <p className="notice">
          Cancelada el {data.cancelledAt ? formatDateTime(data.cancelledAt, tz) : "—"}
          {data.cancelledBy ? ` por ${data.cancelledBy.displayName}` : ""}
          {data.cancelReason ? `: ${data.cancelReason}` : "."}
        </p>
      )}

      <section className="panel">
        <dl className="cost-summary">
          <div>
            <dt>Total</dt>
            <dd>{formatMoney(data.total, data.currency)}</dd>
          </div>
          <div>
            <dt>Recibido</dt>
            <dd>{formatMoney(data.receivedAmount, data.currency)}</dd>
          </div>
          <div>
            <dt>Pendiente</dt>
            <dd>
              {data.status === "CANCELLED" ? "—" : formatMoney(data.pendingAmount, data.currency)}
            </dd>
          </div>
        </dl>
        <Details
          items={[
            ["Proveedor", data.supplier.name],
            ["Fecha", formatDate(data.purchaseDate)],
            ["Fecha esperada", data.expectedDate ? formatDate(data.expectedDate) : null],
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
          <p className="muted">Sin líneas. Editá el borrador para agregar materias primas.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Materia prima</th>
                  <th scope="col">Pedido</th>
                  <th scope="col" className="num hide-sm">
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
                      {line.rawMaterial.name}
                      <span className="cost-source">
                        Equivale a{" "}
                        {formatQuantity(line.orderedBaseQuantity, line.rawMaterial.baseUnit.symbol)}{" "}
                        ·{" "}
                        {formatUnitCost(
                          line.acquisitionUnitCost,
                          data.currency,
                          line.rawMaterial.baseUnit.symbol,
                        )}
                      </span>
                    </td>
                    <td>{commercialQuantity(line, line.orderedQuantity)}</td>
                    <td className="num hide-sm">
                      {commercialPrice(line, data.currency)}
                      {line.discountAmount !== "0" && Number(line.discountAmount) !== 0 && (
                        <span className="cost-source">
                          Descuento {formatMoney(line.discountAmount, data.currency)}
                        </span>
                      )}
                    </td>
                    <td className="num">{formatMoney(line.netAmount, data.currency)}</td>
                    <td className="num">{formatDecimal(line.receivedQuantity, 0, 4)}</td>
                    <td className="num">{formatDecimal(line.pendingQuantity, 0, 4)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3} className="hide-sm">
                    Subtotal {formatMoney(data.subtotal, data.currency)} · Descuentos{" "}
                    {formatMoney(data.discountTotal, data.currency)} · Impuestos (informativos){" "}
                    {formatMoney(data.taxTotal, data.currency)}
                  </th>
                  <td className="num">
                    <strong>{formatMoney(data.total, data.currency)}</strong>
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="muted small">
          El costo que entra al inventario es el neto de cada línea (sin impuestos) dividido por la
          cantidad en la unidad base.
        </p>
      </section>

      <section className="panel" aria-labelledby="receipts-title">
        <h2 id="receipts-title">Recepciones</h2>
        {data.receipts.length === 0 ? (
          <p className="muted">
            {receivable
              ? "Todavía no llegó mercadería. Usá “Registrar recepción” cuando llegue."
              : "Sin recepciones."}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Recepción</th>
                  <th scope="col">Fecha</th>
                  <th scope="col" className="hide-sm">
                    Depósito
                  </th>
                  <th scope="col">Estado</th>
                  <th scope="col" className="num">
                    Valor ingresado
                  </th>
                  <th scope="col" className="hide-sm">
                    Confirmó
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.receipts.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`${PURCHASES_BASE}/${id}/recepciones/${r.id}`} className="code">
                        {r.number}
                      </Link>
                    </td>
                    <td>{formatDateTime(r.receivedAt, tz)}</td>
                    <td className="hide-sm">{r.warehouse.name}</td>
                    <td>
                      <ReceiptStatusBadge status={r.status} />
                    </td>
                    <td className="num">
                      {r.status === "CANCELLED"
                        ? "—"
                        : formatMoney(r.inventoryValue, data.currency)}
                    </td>
                    <td className="hide-sm">{r.postedBy?.displayName ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
  const { data, error } = useResource<ReceiptDto>(`/api/purchase-receipts/${receiptId}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  if (data.purchase.id !== purchaseId) return <Loading />;
  const tz = user.company.timezone;
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{
          href: `${PURCHASES_BASE}/${purchaseId}`,
          label: `Compra ${data.purchase.number}`,
        }}
        title={
          <>
            Recepción {data.number} <ReceiptStatusBadge status={data.status} />
          </>
        }
        subtitle={`${data.purchase.supplierName} · ${data.warehouse.name}`}
      />
      {data.status === "POSTED" && (
        <p className="notice">
          Confirmada: ingresó al stock y ya no se modifica. Una corrección se hace con un ajuste de
          inventario.
        </p>
      )}
      <section className="panel">
        <Details
          items={[
            ["Fecha de recepción", formatDateTime(data.receivedAt, tz)],
            ["Depósito", data.warehouse.name],
            ["Remito / documento", data.documentNumber],
            ["Valor ingresado al inventario", formatMoney(data.inventoryValue, data.currency)],
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
                  En stock
                </th>
                <th scope="col" className="num hide-sm">
                  Costo de adquisición
                </th>
                <th scope="col" className="num">
                  Valor
                </th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.rawMaterial.name}</td>
                  <td>
                    {l.presentation
                      ? `${formatDecimal(l.receivedQuantity, 0, 4)} × ${l.presentation.name}`
                      : formatQuantity(l.receivedQuantity, l.purchaseUnit.symbol)}
                    <span className="cost-source">
                      Pedido {formatDecimal(l.orderedQuantity, 0, 4)} · antes{" "}
                      {formatDecimal(l.previouslyReceivedQuantity, 0, 4)}
                    </span>
                  </td>
                  <td className="num">
                    {formatQuantity(l.normalizedBaseQuantity, l.baseUnit.symbol)}
                  </td>
                  <td className="num hide-sm">
                    {formatUnitCost(l.acquisitionUnitCost, data.currency, l.baseUnit.symbol)}
                  </td>
                  <td className="num">{formatMoney(l.lineInventoryValue, data.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
