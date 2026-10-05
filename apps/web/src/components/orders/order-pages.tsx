"use client";

import {
  COVERAGE_STATUSES,
  COVERAGE_STATUS_LABELS,
  FULFILLMENT_TYPE_LABELS,
  ORDER_PRICING_STATUS_LABELS,
  ORDER_PRIORITIES,
  ORDER_PRIORITY_LABELS,
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  PERMISSIONS as P,
  PRICE_SOURCE_LABELS,
  REQUESTED_CONSERVATION_LABELS,
  REQUIREMENT_PROBLEM_LABELS,
  REQUIREMENT_STATUS_LABELS,
  RESERVATION_RELEASE_REASON_LABELS,
  RESERVATION_STATUS_LABELS,
  type CoveragePreviewDto,
  type CustomerDto,
  type OrderDetailDto,
  type OrderListItemDto,
  type OrderOperationResultDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch, fetchOptions } from "@/lib/api-client";
import { formatDateTime, formatMoney, formatQuantity } from "@/lib/format";
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
import { useCan, useCurrentUser } from "../user-context";
import {
  PaymentDialog,
  PaymentStatusBadge,
  SALES_BASE,
  SaleStatusBadge,
  Warnings,
} from "../sales/sale-shared";
import { CoveragePreview } from "./order-form";
import {
  CoverageBadge,
  MaterialProjection,
  ORDERS_BASE,
  OrderStatusBadge,
  formatWallClock,
} from "./order-shared";

/*
 * Pedidos (Fase 5A): listado y detalle. Confirmar reserva lotes (FEFO) y
 * registra lo que falta producir; nada de esto mueve stock. Las acciones que
 * cambian el plan llevan un `operationId` por intento: reintentar no duplica.
 */

const gt0 = (v: string | null | undefined) => v !== null && v !== undefined && new D(v).gt(0);

const summary = (items: { name: string; quantity: string; unit: string }[]) =>
  items.map((p) => `${formatQuantity(p.quantity, p.unit)} ${p.name}`).join(" · ");

/* ---------- Listado ---------- */

export function OrderList() {
  const can = useCan();
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
  return (
    <MasterList<OrderListItemDto>
      title="Pedidos"
      subtitle="Lo que pidieron los clientes, para cuándo y si está cubierto con stock o hay que producirlo."
      endpoint="/api/orders"
      basePath={ORDERS_BASE}
      searchPlaceholder="Buscar por pedido, cliente o evento"
      createLabel="Nuevo pedido"
      createHref={`${ORDERS_BASE}/nuevo`}
      canCreate={can(P.ORDERS_CREATE)}
      emptyText="Todavía no hay pedidos."
      defaultStatus="active"
      statusOptions={[
        { value: "active", label: "Abiertos (sin cancelar)" },
        { value: "all", label: "Todos los estados" },
        ...ORDER_STATUSES.map((s) => ({ value: s, label: ORDER_STATUS_LABELS[s] })),
      ]}
      extraFilters={[
        {
          name: "coverage",
          label: "Cobertura",
          allLabel: "Cualquier cobertura",
          options: COVERAGE_STATUSES.map((c) => ({ value: c, label: COVERAGE_STATUS_LABELS[c] })),
        },
        {
          name: "priority",
          label: "Prioridad",
          allLabel: "Cualquier prioridad",
          options: ORDER_PRIORITIES.map((p) => ({ value: p, label: ORDER_PRIORITY_LABELS[p] })),
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
        {
          name: "upcoming",
          label: "Entrega",
          allLabel: "Cualquier fecha de entrega",
          options: [{ value: "true", label: "Sólo próximas entregas" }],
        },
        {
          name: "withShortage",
          label: "Faltantes",
          allLabel: "Con o sin faltantes",
          options: [{ value: "true", label: "Sólo con producto sin reservar" }],
        },
      ]}
      dateFilters={[
        { name: "from", label: "Entrega desde" },
        { name: "to", label: "Entrega hasta" },
      ]}
      columns={[
        {
          header: "Pedido",
          cell: (o) => (
            <Link href={`${ORDERS_BASE}/${o.id}`} className="code">
              {o.code}
            </Link>
          ),
        },
        {
          header: "Cliente",
          cell: (o) => (
            <>
              {o.customer.name}
              {o.eventName && <span className="muted small"> · {o.eventName}</span>}
            </>
          ),
        },
        { header: "Entrega", cell: (o) => formatWallClock(o.requestedAtLocal) },
        {
          header: "Productos",
          cell: (o) => summary(o.products),
          className: "hide-md",
        },
        { header: "Estado", cell: (o) => <OrderStatusBadge status={o.status} /> },
        {
          header: "Cobertura",
          cell: (o) =>
            o.status === "DRAFT" ? (
              <span className="muted">Sin reservar</span>
            ) : o.status === "CANCELLED" ? (
              "—"
            ) : (
              <CoverageBadge coverage={o.coverageStatus} />
            ),
        },
        {
          header: "Falta producir",
          cell: (o) =>
            o.shortages.length > 0 ? (
              <span className="text-negative">{summary(o.shortages)}</span>
            ) : (
              "—"
            ),
          className: "hide-sm",
        },
        {
          header: "Prioridad",
          cell: (o) =>
            o.priority === "NORMAL" ? (
              <span className="muted">Normal</span>
            ) : (
              <span
                className={`badge ${o.priority === "URGENT" ? "badge--danger" : "badge--warn"}`}
              >
                {ORDER_PRIORITY_LABELS[o.priority]}
              </span>
            ),
          className: "hide-md",
        },
      ]}
    />
  );
}

/* ---------- Detalle ---------- */

function who(at: string | null, by: { displayName: string } | null, tz: string): string | null {
  if (!at) return null;
  return `${formatDateTime(at, tz)}${by ? ` · ${by.displayName}` : ""}`;
}

/** Un `operationId` por intento: el reintento del mismo diálogo no duplica la acción. */
function useOperationId(): [string, () => void] {
  const [id, setId] = useState(() => crypto.randomUUID());
  return [id, () => setId(crypto.randomUUID())];
}

export function OrderDetail({ id }: { id: string }) {
  const can = useCan();
  const user = useCurrentUser();
  const { data, error, setData } = useResource<OrderDetailDto>(`/api/orders/${id}`);
  const [version, setVersion] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const replace = (order: OrderDetailDto, w: string[] = []) => {
    setData(order);
    setWarnings(w);
    setVersion((v) => v + 1);
  };
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const tz = user.company.timezone;
  const a = data.actions;
  const planned = data.status !== "DRAFT" && data.status !== "CANCELLED";

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: ORDERS_BASE, label: "Pedidos" }}
        title={
          <>
            Pedido {data.code} <OrderStatusBadge status={data.status} />{" "}
            {planned && <CoverageBadge coverage={data.coverageStatus} />}
          </>
        }
        subtitle={`${data.customer.name} · ${FULFILLMENT_TYPE_LABELS[data.fulfillmentType]} el ${formatWallClock(data.requestedAtLocal)}${data.eventName ? ` · ${data.eventName}` : ""}`}
        actions={
          <>
            {a.canDeliver && (
              <Link className="button button--primary" href={`${SALES_BASE}/nueva?orderId=${id}`}>
                {data.status === "PARTIALLY_DELIVERED" ? "Entregar el resto" : "Entregar y vender"}
              </Link>
            )}
            {a.canQuote && <QuoteOrder order={data} onDone={replace} />}
            {a.canRegisterAdvance && (
              <PaymentDialog
                label="Registrar seña"
                title={`Seña del pedido ${data.code}`}
                description="Queda como crédito del cliente y se aplica sola a la venta cuando se entrega el pedido."
                endpoint={`/api/orders/${id}/advances`}
                currency={user.company.currencyCode}
                onDone={async (r) =>
                  replace(await apiFetch<OrderDetailDto>(`/api/orders/${id}`), r.warnings)
                }
              />
            )}
            {a.canConfirm && <ConfirmOrder order={data} onDone={replace} />}
            {a.canReplan && <RefreshCoverage order={data} onDone={replace} />}
            {a.canReplan && (
              <Link className="button" href={`${ORDERS_BASE}/${id}/modificar`}>
                Modificar pedido
              </Link>
            )}
            {a.canStartPreparation && (
              <ConfirmAction
                label={data.status === "READY" ? "Volver a preparación" : "Empezar preparación"}
                title={`¿Pasar el pedido ${data.code} a preparación?`}
                message="Las reservas se mantienen. No se mueve stock."
                confirmLabel="Pasar a preparación"
                onConfirm={async () =>
                  replace(
                    await apiFetch<OrderDetailDto>(`/api/orders/${id}/start-preparation`, {
                      method: "POST",
                    }),
                  )
                }
              />
            )}
            {(data.status === "CONFIRMED" || data.status === "IN_PREPARATION") &&
              can(P.ORDERS_READY) &&
              (a.canMarkReady ? (
                <ConfirmAction
                  label="Marcar listo"
                  title={`¿Marcar el pedido ${data.code} como listo?`}
                  message="Todo el pedido está reservado. Queda listo para entregar o retirar; el stock se descuenta al confirmar la entrega y venta."
                  confirmLabel="Marcar listo"
                  onConfirm={async () =>
                    replace(
                      await apiFetch<OrderDetailDto>(`/api/orders/${id}/mark-ready`, {
                        method: "POST",
                      }),
                    )
                  }
                />
              ) : (
                <button
                  type="button"
                  className="button"
                  disabled
                  title={a.readyBlockedReason ?? undefined}
                >
                  Marcar listo
                </button>
              ))}
            {a.canEdit && (
              <Link className="button" href={`${ORDERS_BASE}/${id}/editar`}>
                {data.status === "DRAFT" ? "Editar" : "Editar contacto y notas"}
              </Link>
            )}
            {a.canCancel && <CancelOrder order={data} onDone={replace} />}
          </>
        }
      />

      <Warnings warnings={warnings} />
      {!a.canDeliver &&
        a.deliverBlockedReason &&
        (data.status === "READY" || data.status === "PARTIALLY_DELIVERED") && (
          <p className="alert alert--warn" role="status" data-testid="deliver-blocked">
            {a.deliverBlockedReason}
          </p>
        )}
      {data.status === "CANCELLED" && (
        <p className="notice">
          Cancelado el {data.cancelledAt ? formatDateTime(data.cancelledAt, tz) : "—"}
          {data.cancelledBy ? ` por ${data.cancelledBy.displayName}` : ""}
          {data.cancelReason ? `: ${data.cancelReason}` : "."} Las reservas se liberaron.
        </p>
      )}
      {data.status === "DRAFT" && (
        <p className="notice">
          Borrador: todavía no reserva stock. Al confirmar se reservan los lotes que sirven para la
          fecha (primero los que vencen antes) y se registra lo que falta producir.
        </p>
      )}
      {!a.canMarkReady && a.readyBlockedReason && can(P.ORDERS_READY) && (
        <p className="muted small" data-testid="ready-blocked">
          Para marcarlo listo: {a.readyBlockedReason}
        </p>
      )}
      {data.issues.length > 0 && (
        <div className="alert alert--warn" role="status" data-testid="order-issues">
          <strong>Atención</strong>
          <ul>
            {data.issues.map((i) => (
              <li key={`${i.code}-${i.message}`}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="panel" aria-labelledby="summary-title">
        <h2 id="summary-title">Datos del pedido</h2>
        <Details
          items={[
            ["Cliente", data.customer.name],
            ...(data.canSeeCustomerDetails
              ? ([
                  ["Teléfono del cliente", data.customer.phone],
                  ["Contacto", data.contactName],
                  ["Teléfono de contacto", data.contactPhone],
                  [
                    "Dirección de entrega",
                    data.fulfillmentType === "DELIVERY" ? data.deliveryAddress : null,
                  ],
                ] as [string, string | null][])
              : []),
            [
              FULFILLMENT_TYPE_LABELS[data.fulfillmentType],
              `${formatWallClock(data.requestedAtLocal)} (hora de la empresa)`,
            ],
            ["Prioridad", ORDER_PRIORITY_LABELS[data.priority]],
            ["Evento", data.eventName],
            ["Plan vigente", planned ? `Revisión ${data.planRevision}` : null],
            ["Creado", who(data.createdAt, data.createdBy, tz)],
            ["Confirmado", who(data.confirmedAt, data.confirmedBy, tz)],
            [
              "En preparación",
              data.preparationStartedAt ? formatDateTime(data.preparationStartedAt, tz) : null,
            ],
            ["Listo", data.readyAt ? formatDateTime(data.readyAt, tz) : null],
            ["Notas", data.notes],
          ]}
        />
      </section>

      {data.status === "DRAFT" ? (
        <DraftPreview id={id} version={version} />
      ) : (
        <>
          <OrderLines order={data} />
          <OrderCommercial order={data} tz={tz} />
          <OrderReservations order={data} tz={tz} />
          <OrderRequirements order={data} />
          {data.status !== "CANCELLED" && (
            <section className="panel" aria-labelledby="materials-title">
              <h2 id="materials-title">Materias primas necesarias</h2>
              <p className="muted small">
                Proyección: no reserva materia prima. Se compara con el stock actual y con lo que
                necesitan los demás pedidos confirmados.
              </p>
              <MaterialProjection materials={data.materials} />
            </section>
          )}
        </>
      )}
      <AuditHistory entityType="customer_order" entityId={id} version={version} />
    </div>
  );
}

function DraftPreview({ id, version }: { id: string; version: number }) {
  const { data, error } = useResource<CoveragePreviewDto>(
    `/api/orders/${id}/coverage-preview?v=${version}`,
  );
  if (error) return <p className="notice">{error.message}</p>;
  if (!data) return <Loading />;
  return <CoveragePreview preview={data} />;
}

const DELIVERY_STATUSES = new Set(["READY", "PARTIALLY_DELIVERED", "DELIVERED"]);

function OrderLines({ order }: { order: OrderDetailDto }) {
  const delivering = DELIVERY_STATUSES.has(order.status);
  const priced = order.lines.some((l) => l.price !== null);
  return (
    <section className="panel" aria-labelledby="lines-title">
      <h2 id="lines-title">Productos y cobertura</h2>
      <div className="table-wrap">
        <table className="table" aria-label="Cobertura por producto">
          <thead>
            <tr>
              <th scope="col">Producto</th>
              <th scope="col" className="num">
                Pedido
              </th>
              <th scope="col" className="hide-sm">
                Conservación
              </th>
              <th scope="col" className="num">
                Reservado para este pedido
              </th>
              <th scope="col" className="num">
                Falta producir
              </th>
              <th scope="col" className="num hide-md">
                Sin cubrir
              </th>
              {delivering && (
                <>
                  <th scope="col" className="num">
                    Entregado
                  </th>
                  <th scope="col" className="num">
                    Pendiente
                  </th>
                </>
              )}
              {priced && (
                <th scope="col" className="num hide-sm">
                  Precio acordado
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {order.lines.map((l) => {
              const unit = l.saleUnit.symbol;
              const sameUnit = l.unit.id === l.saleUnit.id;
              return (
                <tr key={l.id}>
                  <td>
                    {l.product.name}
                    {gt0(l.newlyAvailable) && order.status !== "CANCELLED" && (
                      <span
                        className="badge badge--info"
                        title="Actualizá la cobertura para usarlo"
                      >
                        {" "}
                        Hay {formatQuantity(l.newlyAvailable, unit)} nuevos
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {formatQuantity(l.requestedQuantity, l.unit.symbol)}
                    {!sameUnit && (
                      <span className="muted small">
                        {" "}
                        ({formatQuantity(l.normalizedQuantity, unit)})
                      </span>
                    )}
                  </td>
                  <td className="hide-sm">
                    {REQUESTED_CONSERVATION_LABELS[l.requestedConservation]}
                  </td>
                  <td className="num">{formatQuantity(l.reserved, unit)}</td>
                  <td className={`num ${gt0(l.toProduce) ? "text-negative" : ""}`}>
                    {gt0(l.toProduce) ? formatQuantity(l.toProduce, unit) : "—"}
                  </td>
                  <td className={`num hide-md ${gt0(l.uncovered) ? "text-negative" : ""}`}>
                    {gt0(l.uncovered) ? formatQuantity(l.uncovered, unit) : "—"}
                  </td>
                  {delivering && (
                    <>
                      <td className="num">{formatQuantity(l.delivered, unit)}</td>
                      <td className="num">
                        {gt0(l.pendingDelivery) ? formatQuantity(l.pendingDelivery, unit) : "—"}
                      </td>
                    </>
                  )}
                  {priced && (
                    <td className="num hide-sm">
                      {l.price ? (
                        <>
                          {formatMoney(l.price.unitPrice)} / {unit}
                          <span className="muted small">
                            <br />
                            {PRICE_SOURCE_LABELS[l.price.priceSource]}
                            {gt0(l.price.discountAmount) &&
                              ` · desc. ${formatMoney(l.price.discountAmount)}`}
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OrderReservations({ order, tz }: { order: OrderDetailDto; tz: string }) {
  const can = useCan();
  const [showHistory, setShowHistory] = useState(false);
  const active = order.reservations.filter((r) => r.status === "ACTIVE");
  const rows = showHistory ? order.reservations : active;
  const lotLinks = can(P.PRODUCT_LOTS_READ);
  return (
    <section className="panel" aria-labelledby="reservations-title">
      <div className="panel__header">
        <h2 id="reservations-title">Lotes reservados</h2>
        {order.reservations.length > active.length && (
          <button
            type="button"
            className="button button--small"
            onClick={() => setShowHistory((v) => !v)}
          >
            {showHistory ? "Ver sólo vigentes" : "Ver historial de reservas"}
          </button>
        )}
      </div>
      <p className="muted small">
        Reservar no mueve stock: el lote sigue en su depósito, apartado para este pedido.
      </p>
      {rows.length === 0 ? (
        <p className="muted">No hay lotes reservados.</p>
      ) : (
        <div className="table-wrap">
          <table className="table" aria-label="Reservas del pedido">
            <thead>
              <tr>
                <th scope="col">Lote</th>
                <th scope="col">Producto</th>
                <th scope="col" className="hide-sm">
                  Conservación
                </th>
                <th scope="col" className="hide-md">
                  Vence
                </th>
                <th scope="col" className="num">
                  Cantidad
                </th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {lotLinks ? (
                      <Link href={`${LOTS_BASE}/${r.lot.id}`}>{r.lot.code}</Link>
                    ) : (
                      r.lot.code
                    )}
                    <span className="muted small"> · {r.lot.warehouse.name}</span>
                  </td>
                  <td>{r.product.name}</td>
                  <td className="hide-sm">
                    <ConservationBadge state={r.lot.conservationState} />
                  </td>
                  <td className="hide-md">
                    {r.lot.usableUntil ? (
                      formatDateTime(r.lot.usableUntil, tz)
                    ) : (
                      <span className="muted">Sin vida útil configurada</span>
                    )}
                  </td>
                  <td className="num">{formatQuantity(r.quantity, r.unit.symbol)}</td>
                  <td>
                    <span
                      className={`badge ${r.status === "ACTIVE" ? "" : r.status === "INVALIDATED" ? "badge--danger" : "badge--off"}`}
                    >
                      {RESERVATION_STATUS_LABELS[r.status]}
                    </span>
                    {r.releaseReason && (
                      <span className="muted small">
                        {" "}
                        {RESERVATION_RELEASE_REASON_LABELS[r.releaseReason]}
                      </span>
                    )}
                    {showHistory && <span className="muted small"> · rev. {r.planRevision}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function OrderRequirements({ order }: { order: OrderDetailDto }) {
  const can = useCan();
  const canCreate = can(P.ORDER_PRODUCTION_CREATE) && can(P.PRODUCTION_ORDERS_CREATE);
  const canSeeProduction = can(P.PRODUCTION_ORDERS_READ);
  const rows = order.productionRequirements.filter((r) => r.status !== "CANCELLED");
  if (rows.length === 0) {
    return (
      <section className="panel" aria-labelledby="requirements-title">
        <h2 id="requirements-title">Producción necesaria</h2>
        <p className="muted">No hace falta producir: el stock reservado cubre el pedido.</p>
      </section>
    );
  }
  return (
    <section className="panel" aria-labelledby="requirements-title">
      <h2 id="requirements-title">Producción necesaria</h2>
      <p className="muted small">
        Lo que falta se produce con una orden de producción. Crearla desde acá la vincula al pedido.
      </p>
      <div className="table-wrap">
        <table className="table" aria-label="Producción necesaria">
          <thead>
            <tr>
              <th scope="col">Producto</th>
              <th scope="col" className="num">
                Cantidad
              </th>
              <th scope="col" className="hide-md">
                Receta
              </th>
              <th scope="col">Estado</th>
              <th scope="col">
                <span className="sr-only">Acción</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.product.name}</td>
                <td className="num">{formatQuantity(r.quantity, r.unit.symbol)}</td>
                <td className="hide-md">
                  {r.recipe ? (
                    `Versión ${r.recipe.versionNumber}`
                  ) : (
                    <span className="text-negative">
                      {r.problem ? REQUIREMENT_PROBLEM_LABELS[r.problem] : "Sin receta"}
                    </span>
                  )}
                </td>
                <td>
                  {REQUIREMENT_STATUS_LABELS[r.status]}
                  {r.productionOrder && (
                    <>
                      {" "}
                      {canSeeProduction ? (
                        <Link href={`/produccion/${r.productionOrder.id}`}>
                          {r.productionOrder.code}
                        </Link>
                      ) : (
                        r.productionOrder.code
                      )}
                    </>
                  )}
                </td>
                <td>
                  {r.status === "OPEN" &&
                    r.recipe &&
                    canCreate &&
                    order.status !== "CANCELLED" &&
                    order.status !== "READY" && (
                      <Link
                        className="button button--small"
                        href={`/produccion/nueva?requirementId=${r.id}`}
                      >
                        Crear orden de producción
                      </Link>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ---------- Acciones ---------- */

function ConfirmOrder({
  order,
  onDone,
}: {
  order: OrderDetailDto;
  onDone: (o: OrderDetailDto) => void;
}) {
  const [operationId, renew] = useOperationId();
  return (
    <ConfirmAction
      label="Confirmar pedido"
      title={`¿Confirmar el pedido ${order.code}?`}
      message={
        <>
          Se reservan los lotes que sirven para el {formatWallClock(order.requestedAtLocal)}{" "}
          (primero los que vencen antes) y se registra lo que falta producir con la receta vigente.
          No se mueve stock ni se reserva materia prima. La cobertura se recalcula con el stock de
          este momento, que puede diferir de la vista previa.
        </>
      }
      confirmLabel="Confirmar pedido"
      onConfirm={async () => {
        const result = await apiFetch<OrderOperationResultDto>(`/api/orders/${order.id}/confirm`, {
          method: "POST",
          body: { operationId },
        });
        renew();
        onDone(result.order);
      }}
    />
  );
}

function RefreshCoverage({
  order,
  onDone,
}: {
  order: OrderDetailDto;
  onDone: (o: OrderDetailDto) => void;
}) {
  const [operationId, renew] = useOperationId();
  return (
    <ConfirmAction
      label="Actualizar cobertura"
      title={`¿Actualizar la cobertura del pedido ${order.code}?`}
      message={
        <>
          Se liberan las reservas actuales y se vuelve a reservar con el stock de hoy, sin cambiar
          fecha ni productos. Queda una revisión nueva del plan (la anterior se conserva en el
          historial). Para ver antes el resultado, usá «Modificar pedido».
        </>
      }
      confirmLabel="Actualizar cobertura"
      onConfirm={async () => {
        const result = await apiFetch<OrderOperationResultDto>(`/api/orders/${order.id}/replan`, {
          method: "POST",
          body: { operationId },
        });
        renew();
        onDone(result.order);
      }}
    />
  );
}

function CancelOrder({
  order,
  onDone,
}: {
  order: OrderDetailDto;
  onDone: (o: OrderDetailDto, warnings?: string[]) => void;
}) {
  const [operationId, renew] = useOperationId();
  const [reason, setReason] = useState("");
  const [confirmReady, setConfirmReady] = useState(false);
  const ready = order.status === "READY";
  const active = order.reservations.filter((r) => r.status === "ACTIVE");
  return (
    <ConfirmAction
      label="Cancelar pedido"
      title={`¿Cancelar el pedido ${order.code}?`}
      message={
        <>
          {active.length > 0
            ? `Se liberan ${active.length === 1 ? "la reserva" : `las ${active.length} reservas`} de lotes. `
            : ""}
          Las órdenes de producción ya creadas no se cancelan solas. El pedido cancelado no se puede
          reabrir.
          {order.commercial.advances && gt0(order.commercial.advances.available)
            ? ` La seña de ${formatMoney(order.commercial.advances.available)} queda como crédito a favor del cliente.`
            : ""}
        </>
      }
      confirmLabel="Cancelar pedido"
      danger
      onConfirm={async () => {
        const result = await apiFetch<OrderOperationResultDto>(`/api/orders/${order.id}/cancel`, {
          method: "POST",
          body: { reason: reason.trim(), operationId, confirmReady },
        });
        renew();
        onDone(result.order, result.warnings ?? []);
      }}
    >
      {ready && (
        <div className="alert alert--warn" role="alert">
          <strong>El pedido ya está listo.</strong> Cancelarlo libera mercadería ya preparada.
          <label className="inline-check">
            <input
              type="checkbox"
              checked={confirmReady}
              onChange={(e) => setConfirmReady(e.target.checked)}
            />{" "}
            Entiendo: cancelar igual
          </label>
        </div>
      )}
      <div className="form__field">
        <label htmlFor="cancel-reason">Motivo</label>
        <textarea
          id="cancel-reason"
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

/* ---------- Comercial (Fase 5B) ---------- */

function OrderCommercial({ order, tz }: { order: OrderDetailDto; tz: string }) {
  const c = order.commercial;
  return (
    <section className="panel" aria-labelledby="commercial-title" data-testid="order-commercial">
      <h2 id="commercial-title">Precio, señas y ventas</h2>
      <Details
        items={[
          ["Precio", ORDER_PRICING_STATUS_LABELS[c.pricingStatus]],
          ["Lista de precios", c.priceList ? c.priceList.name : null],
          ["Total acordado", c.quotedTotal ? formatMoney(c.quotedTotal) : null],
          [
            "Descuentos",
            c.quotedDiscountTotal && gt0(c.quotedDiscountTotal)
              ? formatMoney(c.quotedDiscountTotal)
              : null,
          ],
          ["Primera entrega", c.firstDeliveredAt ? formatDateTime(c.firstDeliveredAt, tz) : null],
          ["Entregado completo", c.deliveredAt ? formatDateTime(c.deliveredAt, tz) : null],
          [
            "Seña disponible",
            c.advances ? (
              <span data-testid="advance-available">{formatMoney(c.advances.available)}</span>
            ) : null,
          ],
        ]}
      />
      {c.pricingStatus === "UNPRICED" && (
        <p className="alert alert--warn" role="status">
          Pedido cargado antes de las listas de precios: hay que acordar el precio antes de la
          primera entrega.
        </p>
      )}
      {c.advances && c.advances.payments.length > 0 && (
        <>
          <h3 className="section-title">Señas</h3>
          <ul className="plain-list">
            {c.advances.payments.map((p) => (
              <li key={p.id}>
                <span className="code">{p.code}</span> · {formatDateTime(p.paymentDate, tz)} ·{" "}
                {PAYMENT_METHOD_LABELS[p.method]} · {formatMoney(p.amount)}
              </li>
            ))}
          </ul>
        </>
      )}
      {c.sales && c.sales.length > 0 && (
        <>
          <h3 className="section-title">Ventas del pedido</h3>
          <ul className="plain-list">
            {c.sales.map((s) => (
              <li key={s.id}>
                <Link className="code" href={`${SALES_BASE}/${s.id}`}>
                  {s.code}
                </Link>{" "}
                <SaleStatusBadge status={s.status} />{" "}
                {s.status === "POSTED" && <PaymentStatusBadge status={s.paymentStatus} />} ·{" "}
                {formatDateTime(s.date, tz)}
                {s.total !== null && ` · ${formatMoney(s.total)}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function QuoteOrder({
  order,
  onDone,
}: {
  order: OrderDetailDto;
  onDone: (o: OrderDetailDto) => void;
}) {
  return (
    <ConfirmAction
      label="Acordar precio"
      title={`¿Acordar el precio del pedido ${order.code}?`}
      message="Se toma el precio vigente de cada producto (lista del cliente, lista general o precio del producto) y queda como precio acordado del pedido. Las ventas del pedido usan ese precio."
      confirmLabel="Acordar precio"
      onConfirm={async () =>
        onDone(
          await apiFetch<OrderDetailDto>(`/api/orders/${order.id}/quote`, {
            method: "POST",
            body: { lines: [] },
          }),
        )
      }
    />
  );
}
