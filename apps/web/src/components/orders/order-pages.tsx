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
  PRODUCTION_STATUS_LABELS,
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
  type OrderPriorityDto,
  type ProductionStatusDto,
  type RequirementStatusDto,
  type ReservationStatusDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { apiFetch, fetchOptions } from "@/lib/api-client";
import { describeError } from "@/lib/errors";
import { formatDateTime, formatMoney, formatQuantity } from "@/lib/format";
import { PRODUCTION_STATUS_TONE, type Tone } from "@/lib/status";
import { MasterList } from "../masters/master-list";
import {
  AuditHistory,
  ConfirmAction,
  CopyableCode,
  Details,
  ErrorState,
  Loading,
  PageHeader,
  useResource,
} from "../masters/ui";
import { ConservationBadge, LOTS_BASE } from "../lots/lot-shared";
import { StatusBadge } from "../ui/status";
import { useCan, useCurrentUser } from "../user-context";
import {
  PaymentDialog,
  PaymentStatusBadge,
  SALES_BASE,
  SaleStatusBadge,
  Warnings,
  useOperationId,
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
 * Pedidos: listado y detalle. El detalle responde de un vistazo qué se pidió,
 * para cuándo, si está cubierto, qué falta, cuánto vale y cuánto se cobró, y
 * destaca UNA acción: el siguiente paso del pedido según su estado y lo que el
 * usuario puede hacer (si el paso es de otro rol, lo dice).
 * Confirmar reserva lotes (primero los que vencen antes) y registra lo que
 * falta producir; nada de esto mueve stock. Las acciones que cambian el plan
 * llevan un `operationId` por intento: reintentar no duplica.
 */

const gt0 = (v: string | null | undefined) => v !== null && v !== undefined && new D(v).gt(0);

const summary = (items: { name: string; quantity: string; unit: string }[]) =>
  items.map((p) => `${formatQuantity(p.quantity, p.unit)} ${p.name}`).join(" · ");

const CUSTOMERS_BASE = "/clientes";
const PRODUCTION_BASE = "/produccion";

function PriorityBadge({ priority }: { priority: OrderPriorityDto }) {
  if (priority === "NORMAL") return null;
  return (
    <StatusBadge tone={priority === "URGENT" ? "danger" : "warning"}>
      Prioridad {ORDER_PRIORITY_LABELS[priority].toLowerCase()}
    </StatusBadge>
  );
}

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
      subtitle="Qué pidieron los clientes, para cuándo y si está cubierto con stock o falta producir."
      endpoint="/api/orders"
      basePath={ORDERS_BASE}
      searchPlaceholder="Buscar por pedido, cliente o evento"
      createLabel="Nuevo pedido"
      createHref={`${ORDERS_BASE}/nuevo`}
      canCreate={can(P.ORDERS_CREATE)}
      emptyText="Todavía no hay pedidos."
      defaultStatus="active"
      statusOptions={[
        { value: "active", label: "Todos menos cancelados" },
        { value: "all", label: "Todos los estados" },
        ...ORDER_STATUSES.map((s) => ({ value: s, label: ORDER_STATUS_LABELS[s] })),
      ]}
      extraFilters={[
        {
          name: "upcoming",
          label: "Para cuándo",
          allLabel: "Cualquier fecha",
          options: [{ value: "true", label: "Sólo próximas entregas" }],
        },
        {
          name: "coverage",
          label: "Cobertura",
          allLabel: "Cualquier cobertura",
          options: COVERAGE_STATUSES.map((c) => ({ value: c, label: COVERAGE_STATUS_LABELS[c] })),
        },
        {
          name: "withShortage",
          label: "Falta producir",
          allLabel: "Con o sin faltantes",
          options: [{ value: "true", label: "Sólo con producto sin reservar" }],
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
          name: "priority",
          label: "Prioridad",
          allLabel: "Cualquier prioridad",
          options: ORDER_PRIORITIES.map((p) => ({ value: p, label: ORDER_PRIORITY_LABELS[p] })),
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
        {
          header: "Para cuándo",
          cell: (o) => (
            <>
              {formatWallClock(o.requestedAtLocal)}
              <span className="muted small"> · {FULFILLMENT_TYPE_LABELS[o.fulfillmentType]}</span>
              {o.priority !== "NORMAL" && (
                <>
                  {" "}
                  <PriorityBadge priority={o.priority} />
                </>
              )}
            </>
          ),
        },
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
            ) : o.status === "CANCELLED" || o.status === "DELIVERED" ? (
              <span className="muted">—</span>
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
              <span className="muted">—</span>
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

const FLOW_STATUSES = new Set(["CONFIRMED", "IN_PREPARATION"]);
const DELIVERY_STATUSES = new Set(["READY", "PARTIALLY_DELIVERED", "DELIVERED"]);

type Primary =
  "confirm" | "refresh" | "quote" | "produce" | "ready" | "prepare" | "deliver" | "advance" | null;

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
  if (!data) return <Loading label="Cargando el pedido…" />;
  const tz = user.company.timezone;
  const currency = data.currency;
  const a = data.actions;
  const c = data.commercial;
  const st = data.status;
  const planned = st !== "DRAFT" && st !== "CANCELLED";
  const inFlow = FLOW_STATUSES.has(st);
  const canCreateProduction = can(P.ORDER_PRODUCTION_CREATE) && can(P.PRODUCTION_ORDERS_CREATE);
  const openReqs = data.productionRequirements.filter((r) => r.status === "OPEN");
  const creatable = inFlow ? openReqs.filter((r) => r.recipe) : [];
  const inProduction = data.productionRequirements.filter((r) => r.status === "PRODUCTION_CREATED");
  const noAdvanceYet = c.advances !== null && !gt0(c.advances.total);
  const newStock = data.lines.some((l) => gt0(l.newlyAvailable));

  // El siguiente paso del pedido que ESTE usuario puede dar.
  let primary: Primary = null;
  if (st === "DRAFT") primary = a.canConfirm ? "confirm" : null;
  else if (inFlow) {
    if (data.coverageStatus === "NEEDS_REPLAN" && a.canReplan) primary = "refresh";
    else if (a.canQuote) primary = "quote";
    else if (creatable.length > 0 && canCreateProduction) primary = "produce";
    else if (a.canMarkReady) primary = "ready";
    else if (a.canStartPreparation && st === "CONFIRMED") primary = "prepare";
  } else if (st === "READY" || st === "PARTIALLY_DELIVERED") {
    if (a.canDeliver) primary = "deliver";
    else if (a.canQuote) primary = "quote";
  }
  if (primary === null && a.canRegisterAdvance && noAdvanceYet && st !== "DRAFT")
    primary = "advance";

  // Si el paso del flujo lo da otro rol, se dice quién y qué falta.
  let waiting: string | null = null;
  if (primary === null || primary === "advance") {
    if (st === "DRAFT") waiting = "Borrador: falta que Ventas lo confirme para reservar el stock.";
    else if (inFlow) {
      if (openReqs.length > 0)
        waiting = `Esperando producción: falta producir ${openReqs
          .map((r) => `${formatQuantity(r.quantity, r.unit.symbol)} de ${r.product.name}`)
          .join(", ")}.`;
      else if (inProduction.length > 0)
        waiting = "Esperando producción: la orden de producción ya está creada.";
      else if (!a.canMarkReady && !can(P.ORDERS_READY))
        waiting = "Esperando que Depósito lo marque listo para entregar.";
    } else if ((st === "READY" || st === "PARTIALLY_DELIVERED") && !a.canDeliver) {
      waiting = a.deliverBlockedReason ? null : "Listo: esperando que Ventas lo entregue.";
    }
  }

  // Totales: lo acordado; en borrador, una estimación con el precio vigente.
  const estimated =
    st === "DRAFT" && data.lines.every((l) => l.informativePrice !== null)
      ? data.lines
          .reduce(
            (sum, l) => sum.plus(new D(l.normalizedQuantity).times(l.informativePrice!)),
            new D(0),
          )
          .toFixed(2)
      : null;
  const postedSales = (c.sales ?? []).filter((s) => s.status === "POSTED");
  const advanceTotal = c.advances?.total ?? null;
  const pendingToCollect =
    c.quotedTotal && c.advances && postedSales.length === 0
      ? D.max(new D(c.quotedTotal).minus(c.advances.total), new D(0)).toFixed(2)
      : null;

  const reload = async (w: string[] = []) =>
    replace(await apiFetch<OrderDetailDto>(`/api/orders/${id}`), w);

  const advanceDialog = a.canRegisterAdvance && (
    <PaymentDialog
      label="Registrar seña"
      title={`Seña del pedido ${data.code}`}
      primary={primary === "advance"}
      description={
        <>
          <p>
            {c.quotedTotal ? (
              <>
                Total acordado: <strong>{formatMoney(c.quotedTotal, currency)}</strong>
              </>
            ) : estimated ? (
              <>
                Total estimado: {formatMoney(estimated, currency)} (el precio se acuerda al
                confirmar)
              </>
            ) : (
              "Todavía no hay precio acordado"
            )}
            {advanceTotal && gt0(advanceTotal) && (
              <> · Seña ya cobrada: {formatMoney(advanceTotal, currency)}</>
            )}
            {pendingToCollect && (
              <>
                {" "}
                · Pendiente: <strong>{formatMoney(pendingToCollect, currency)}</strong>
              </>
            )}
          </p>
          <p>
            Queda como crédito del cliente y se aplica sola a la venta cuando se entrega el pedido.
          </p>
        </>
      }
      endpoint={`/api/orders/${id}/advances`}
      currency={currency}
      onDone={(r) => void reload(r.warnings)}
    />
  );

  const prepareAction = a.canStartPreparation && (
    <ConfirmAction
      label={st === "READY" ? "Volver a preparación" : "Empezar preparación"}
      variant={primary === "prepare" ? "primary" : undefined}
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
  );

  const readyAction =
    inFlow &&
    can(P.ORDERS_READY) &&
    (a.canMarkReady ? (
      <ConfirmAction
        label="Marcar listo"
        variant={primary === "ready" ? "primary" : undefined}
        title={`¿Marcar el pedido ${data.code} como listo?`}
        message="Todo el pedido está reservado. Queda listo para entregar o retirar; el stock se descuenta al confirmar la entrega y venta."
        confirmLabel="Marcar listo"
        onConfirm={async () =>
          replace(
            await apiFetch<OrderDetailDto>(`/api/orders/${id}/mark-ready`, { method: "POST" }),
          )
        }
      />
    ) : (
      <button
        type="button"
        className="button"
        disabled
        aria-describedby={a.readyBlockedReason ? "ready-blocked" : undefined}
      >
        Marcar listo
      </button>
    ));

  const produceAction =
    primary === "produce" &&
    (creatable.length === 1 ? (
      <Link
        className="button button--primary"
        href={`${PRODUCTION_BASE}/nueva?requirementId=${creatable[0]!.id}`}
      >
        Planificar producción
      </Link>
    ) : (
      <a className="button button--primary" href="#requirements-title">
        Planificar producción ({creatable.length})
      </a>
    ));

  const primaryNode: ReactNode =
    primary === "deliver" ? (
      <Link className="button button--primary" href={`${SALES_BASE}/nueva?orderId=${id}`}>
        {st === "PARTIALLY_DELIVERED" ? "Entregar el resto" : "Entregar y vender"}
      </Link>
    ) : primary === "confirm" ? (
      <ConfirmOrder order={data} onDone={replace} primary />
    ) : primary === "refresh" ? (
      <RefreshCoverage order={data} onDone={replace} primary />
    ) : primary === "quote" ? (
      <QuoteOrder order={data} onDone={replace} primary />
    ) : primary === "produce" ? (
      produceAction
    ) : primary === "ready" ? (
      readyAction
    ) : primary === "prepare" ? (
      prepareAction
    ) : primary === "advance" ? (
      advanceDialog
    ) : null;

  const showRefresh =
    a.canReplan &&
    primary !== "refresh" &&
    (newStock || (data.coverageStatus !== null && data.coverageStatus !== "FULLY_COVERED"));

  const metric = (
    label: string,
    value: ReactNode,
    note?: ReactNode,
    tone?: "success" | "warning" | "danger" | "emphasis",
  ) => (
    <div className={`metric ${tone ? `metric--${tone}` : ""}`} key={label}>
      <dt className="metric__label">{label}</dt>
      <dd className="metric__value">
        {value}
        {note && <span className="metric__note">{note}</span>}
      </dd>
    </div>
  );
  const totalToProduce = data.lines.filter((l) => gt0(l.toProduce) || gt0(l.uncovered));
  const toDeliver = data.lines.filter((l) => gt0(l.pendingDelivery));

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: ORDERS_BASE, label: "Pedidos" }}
        title={<CopyableCode code={data.code} />}
        status={
          <>
            <OrderStatusBadge status={st} />
            {planned && !DELIVERY_STATUSES.has(st) && (
              <CoverageBadge coverage={data.coverageStatus} />
            )}
            {planned && DELIVERY_STATUSES.has(st) && data.coverageStatus === "NEEDS_REPLAN" && (
              <CoverageBadge coverage={data.coverageStatus} />
            )}
            <PriorityBadge priority={data.priority} />
          </>
        }
        subtitle={`${data.customer.name} · ${FULFILLMENT_TYPE_LABELS[data.fulfillmentType]} el ${formatWallClock(data.requestedAtLocal)}${data.eventName ? ` · ${data.eventName}` : ""}`}
        actions={
          <>
            {primaryNode}
            {primary !== "advance" && advanceDialog}
            {primary !== "quote" && a.canQuote && <QuoteOrder order={data} onDone={replace} />}
            {showRefresh && <RefreshCoverage order={data} onDone={replace} />}
            {a.canReplan && (
              <Link className="button" href={`${ORDERS_BASE}/${id}/modificar`}>
                Modificar pedido
              </Link>
            )}
            {primary !== "prepare" && prepareAction}
            {primary !== "ready" && readyAction}
            {a.canEdit && (
              <Link className="button button--tertiary" href={`${ORDERS_BASE}/${id}/editar`}>
                {st === "DRAFT" ? "Editar" : "Editar contacto y notas"}
              </Link>
            )}
            {a.canCancel && <CancelOrder order={data} onDone={replace} />}
          </>
        }
      />

      <Warnings warnings={warnings} />
      {waiting && (
        <p className="alert alert--info" role="status" data-testid="order-next-step">
          {waiting}
        </p>
      )}
      {!a.canDeliver &&
        a.deliverBlockedReason &&
        (st === "READY" || st === "PARTIALLY_DELIVERED") && (
          <p className="alert alert--warn" role="status" data-testid="deliver-blocked">
            Para entregarlo: {a.deliverBlockedReason}
          </p>
        )}
      {!a.canMarkReady && a.readyBlockedReason && can(P.ORDERS_READY) && inFlow && (
        <p className="muted small" id="ready-blocked" data-testid="ready-blocked">
          Para marcarlo listo: {a.readyBlockedReason}
        </p>
      )}
      {st === "CANCELLED" && (
        <p className="notice">
          Cancelado el {data.cancelledAt ? formatDateTime(data.cancelledAt, tz) : "—"}
          {data.cancelledBy ? ` por ${data.cancelledBy.displayName}` : ""}
          {data.cancelReason ? `: ${data.cancelReason}` : "."} Las reservas se liberaron.
        </p>
      )}
      {st === "DRAFT" && (
        <p className="notice">
          Borrador: todavía no reserva stock. Al confirmar se reservan los lotes que sirven para la
          fecha (primero los que vencen antes), se acuerda el precio y se registra lo que falta
          producir.
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

      <section className="panel" aria-labelledby="order-summary-title">
        <h2 id="order-summary-title" className="sr-only">
          Resumen del pedido
        </h2>
        <dl className="metrics" data-testid="order-metrics">
          {metric(
            "Para cuándo",
            formatWallClock(data.requestedAtLocal),
            data.fulfillmentType === "DELIVERY"
              ? `Se entrega${data.canSeeCustomerDetails && data.deliveryAddress ? ` en ${data.deliveryAddress}` : ""}`
              : "Retira el cliente",
            "emphasis",
          )}
          {metric(
            "Cliente",
            can(P.CUSTOMERS_READ) ? (
              <Link href={`${CUSTOMERS_BASE}/${data.customer.id}`}>{data.customer.name}</Link>
            ) : (
              data.customer.name
            ),
            data.eventName ?? undefined,
          )}
          {c.quotedTotal
            ? metric(
                "Total",
                formatMoney(c.quotedTotal, currency),
                ORDER_PRICING_STATUS_LABELS[c.pricingStatus],
              )
            : estimated
              ? metric(
                  "Total estimado",
                  formatMoney(estimated, currency),
                  "Precio vigente; se acuerda al confirmar",
                )
              : planned && c.pricingStatus === "UNPRICED"
                ? metric("Total", "Sin precio", "Hay que acordar el precio", "warning")
                : null}
          {advanceTotal !== null &&
            metric(
              "Seña cobrada",
              formatMoney(advanceTotal, currency),
              c.advances && gt0(c.advances.applied)
                ? `Aplicada a ventas: ${formatMoney(c.advances.applied, currency)}`
                : undefined,
            )}
          {pendingToCollect !== null &&
            metric(
              "Pendiente de cobro",
              formatMoney(pendingToCollect, currency),
              "Se cobra al entregar",
              gt0(pendingToCollect) ? undefined : "success",
            )}
          {planned &&
            !DELIVERY_STATUSES.has(st) &&
            metric(
              "Falta producir",
              totalToProduce.length === 0
                ? "Nada"
                : totalToProduce
                    .map(
                      (l) =>
                        `${formatQuantity(new D(l.toProduce).plus(l.uncovered).toString(), l.saleUnit.symbol)} ${l.product.name}`,
                    )
                    .join(" · "),
              totalToProduce.length === 0 ? "El stock reservado cubre el pedido" : undefined,
              totalToProduce.length === 0 ? "success" : "danger",
            )}
          {DELIVERY_STATUSES.has(st) &&
            metric(
              "Falta entregar",
              toDeliver.length === 0
                ? "Nada"
                : toDeliver
                    .map(
                      (l) =>
                        `${formatQuantity(l.pendingDelivery, l.saleUnit.symbol)} ${l.product.name}`,
                    )
                    .join(" · "),
              undefined,
              toDeliver.length === 0 ? "success" : "warning",
            )}
        </dl>
      </section>

      {st === "DRAFT" ? (
        <DraftPreview id={id} version={version} />
      ) : (
        <>
          <OrderLines order={data} canReplan={a.canReplan} />
          <OrderRequirements order={data} canCreate={canCreateProduction} />
        </>
      )}

      <section className="panel" aria-labelledby="info-title">
        <h2 id="info-title">Entrega, contacto y notas</h2>
        <Details
          hideEmpty
          items={[
            [
              FULFILLMENT_TYPE_LABELS[data.fulfillmentType],
              `${formatWallClock(data.requestedAtLocal)} (hora de la empresa)`,
            ],
            ...(data.canSeeCustomerDetails
              ? ([
                  [
                    "Dirección de entrega",
                    data.fulfillmentType === "DELIVERY" ? data.deliveryAddress : null,
                  ],
                  ["Contacto", data.contactName],
                  ["Teléfono de contacto", data.contactPhone],
                  ["Teléfono del cliente", data.customer.phone],
                ] as [string, string | null][])
              : []),
            ["Evento", data.eventName],
            ["Prioridad", data.priority === "NORMAL" ? null : ORDER_PRIORITY_LABELS[data.priority]],
            ["Notas", data.notes],
            [
              "Cobertura recalculada",
              planned && data.planRevision > 1 ? `Revisión ${data.planRevision}` : null,
            ],
            ["Creado", who(data.createdAt, data.createdBy, tz)],
            ["Confirmado", who(data.confirmedAt, data.confirmedBy, tz)],
            [
              "En preparación",
              data.preparationStartedAt ? formatDateTime(data.preparationStartedAt, tz) : null,
            ],
            ["Listo", data.readyAt ? formatDateTime(data.readyAt, tz) : null],
          ]}
        />
      </section>

      <OrderCommercial order={data} tz={tz} />

      {st !== "DRAFT" && (
        <>
          <OrderReservations order={data} tz={tz} />
          {st !== "CANCELLED" && can(P.ORDER_PLANNING_READ) && (
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
  if (error)
    return (
      <p className="alert alert--warn" role="status">
        No se pudo calcular la cobertura: {describeError(error)}
      </p>
    );
  if (!data) return <Loading label="Calculando la cobertura…" />;
  return <CoveragePreview preview={data} />;
}

function OrderLines({ order, canReplan }: { order: OrderDetailDto; canReplan: boolean }) {
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
              <th scope="col" className="hide-md">
                Conservación
              </th>
              <th scope="col" className="num">
                Reservado
              </th>
              <th scope="col" className="num">
                Falta producir
              </th>
              {delivering && (
                <>
                  <th scope="col" className="num hide-md">
                    Entregado
                  </th>
                  <th scope="col" className="num">
                    Pendiente
                  </th>
                </>
              )}
              {priced && (
                <th scope="col" className="num hide-md">
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
                      <span className="muted small">
                        {" "}
                        <StatusBadge tone="info">
                          Hay {formatQuantity(l.newlyAvailable, unit)} nuevos
                        </StatusBadge>
                        {canReplan && " Actualizá la cobertura para usarlo."}
                      </span>
                    )}
                    {gt0(l.uncovered) && (
                      <span className="text-negative small">
                        {" "}
                        · {formatQuantity(l.uncovered, unit)} sin receta para producir
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
                  <td className="hide-md">
                    {REQUESTED_CONSERVATION_LABELS[l.requestedConservation]}
                  </td>
                  <td className="num">{formatQuantity(l.reserved, unit)}</td>
                  <td className={`num ${gt0(l.toProduce) ? "text-negative" : ""}`}>
                    {gt0(l.toProduce) ? formatQuantity(l.toProduce, unit) : "—"}
                  </td>
                  {delivering && (
                    <>
                      <td className="num hide-md">{formatQuantity(l.delivered, unit)}</td>
                      <td className="num">
                        {gt0(l.pendingDelivery) ? formatQuantity(l.pendingDelivery, unit) : "—"}
                      </td>
                    </>
                  )}
                  {priced && (
                    <td className="num hide-md">
                      {l.price ? (
                        <>
                          {formatMoney(l.price.unitPrice, order.currency)} / {unit}
                          <span className="muted small">
                            <br />
                            {PRICE_SOURCE_LABELS[l.price.priceSource]}
                            {gt0(l.price.discountAmount) &&
                              ` · desc. ${formatMoney(l.price.discountAmount, order.currency)}`}
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

const RESERVATION_TONE: Record<ReservationStatusDto, Tone> = {
  ACTIVE: "info",
  RELEASED: "neutral",
  INVALIDATED: "danger",
  FULFILLED: "success",
};

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
            className="button button--small button--tertiary"
            aria-pressed={showHistory}
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
                <th scope="col" className="hide-md">
                  Conservación
                </th>
                <th scope="col">Vence</th>
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
                      <span className="code">{r.lot.code}</span>
                    )}
                    <span className="muted small"> · {r.lot.warehouse.name}</span>
                  </td>
                  <td>{r.product.name}</td>
                  <td className="hide-md">
                    <ConservationBadge state={r.lot.conservationState} />
                  </td>
                  <td>
                    {r.lot.usableUntil ? (
                      formatDateTime(r.lot.usableUntil, tz)
                    ) : (
                      <span className="muted">Sin vida útil configurada</span>
                    )}
                  </td>
                  <td className="num">{formatQuantity(r.quantity, r.unit.symbol)}</td>
                  <td>
                    <StatusBadge tone={RESERVATION_TONE[r.status]}>
                      {RESERVATION_STATUS_LABELS[r.status]}
                    </StatusBadge>
                    {r.releaseReason && (
                      <span className="muted small">
                        {" "}
                        {RESERVATION_RELEASE_REASON_LABELS[r.releaseReason]}
                      </span>
                    )}
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

const REQUIREMENT_TONE: Record<RequirementStatusDto, Tone> = {
  OPEN: "warning",
  PRODUCTION_CREATED: "info",
  SATISFIED: "success",
  CANCELLED: "neutral",
};

function ProductionOrderStatus({ status }: { status: string }) {
  if (!(status in PRODUCTION_STATUS_TONE)) return null;
  const s = status as ProductionStatusDto;
  return <StatusBadge tone={PRODUCTION_STATUS_TONE[s]}>{PRODUCTION_STATUS_LABELS[s]}</StatusBadge>;
}

function OrderRequirements({ order, canCreate }: { order: OrderDetailDto; canCreate: boolean }) {
  const can = useCan();
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
                Falta producir
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
                  <StatusBadge tone={REQUIREMENT_TONE[r.status]}>
                    {REQUIREMENT_STATUS_LABELS[r.status]}
                  </StatusBadge>
                  {r.productionOrder && (
                    <>
                      {" "}
                      {canSeeProduction ? (
                        <Link href={`${PRODUCTION_BASE}/${r.productionOrder.id}`}>
                          {r.productionOrder.code}
                        </Link>
                      ) : (
                        <span className="code">{r.productionOrder.code}</span>
                      )}{" "}
                      <ProductionOrderStatus status={r.productionOrder.status} />
                    </>
                  )}
                  {!r.recipe && r.status === "OPEN" && (
                    <span className="muted small"> · No se puede producir sin receta.</span>
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
                        href={`${PRODUCTION_BASE}/nueva?requirementId=${r.id}`}
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
  primary,
}: {
  order: OrderDetailDto;
  onDone: (o: OrderDetailDto, warnings?: string[]) => void;
  primary?: boolean;
}) {
  const [operationId, renew] = useOperationId();
  return (
    <ConfirmAction
      label="Confirmar pedido"
      variant={primary ? "primary" : undefined}
      title={`¿Confirmar el pedido ${order.code}?`}
      message={
        <>
          Se reservan los lotes que sirven para el {formatWallClock(order.requestedAtLocal)}{" "}
          (primero los que vencen antes), se acuerda el precio vigente y se registra lo que falta
          producir con la receta vigente. No se mueve stock ni se reserva materia prima. La
          cobertura se recalcula con el stock de este momento, que puede diferir de la vista previa.
        </>
      }
      confirmLabel="Confirmar pedido"
      onConfirm={async () => {
        const result = await apiFetch<OrderOperationResultDto>(`/api/orders/${order.id}/confirm`, {
          method: "POST",
          body: { operationId },
        });
        renew();
        onDone(result.order, result.warnings ?? []);
      }}
    />
  );
}

function RefreshCoverage({
  order,
  onDone,
  primary,
}: {
  order: OrderDetailDto;
  onDone: (o: OrderDetailDto, warnings?: string[]) => void;
  primary?: boolean;
}) {
  const [operationId, renew] = useOperationId();
  return (
    <ConfirmAction
      label="Actualizar cobertura"
      variant={primary ? "primary" : undefined}
      title={`¿Actualizar la cobertura del pedido ${order.code}?`}
      message={
        <>
          Se liberan las reservas actuales y se vuelve a reservar con el stock de hoy, sin cambiar
          fecha ni productos. Lo que no alcance queda como «Falta producir». Para ver antes el
          resultado, usá «Modificar pedido».
        </>
      }
      confirmLabel="Actualizar cobertura"
      onConfirm={async () => {
        const result = await apiFetch<OrderOperationResultDto>(`/api/orders/${order.id}/replan`, {
          method: "POST",
          body: { operationId },
        });
        renew();
        onDone(result.order, result.warnings ?? []);
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
  const [reasonError, setReasonError] = useState(false);
  const ready = order.status === "READY";
  const active = order.reservations.filter((r) => r.status === "ACTIVE");
  const linkedProduction = order.productionRequirements.filter((r) => r.productionOrder).length;
  const advance = order.commercial.advances?.available ?? null;
  return (
    <ConfirmAction
      label="Cancelar pedido"
      title={`¿Cancelar el pedido ${order.code}?`}
      message={
        <ul className="plain-list">
          {active.length > 0 && (
            <li>
              Se{" "}
              {active.length === 1 ? "libera la reserva" : `liberan las ${active.length} reservas`}{" "}
              de lotes: ese stock vuelve a estar disponible para otros pedidos.
            </li>
          )}
          {linkedProduction > 0 && (
            <li>
              {linkedProduction === 1
                ? "La orden de producción ya creada no se cancela sola"
                : `Las ${linkedProduction} órdenes de producción ya creadas no se cancelan solas`}
              : revisalas en Producción.
            </li>
          )}
          {advance && gt0(advance) && (
            <li>
              La seña de {formatMoney(advance, order.currency)} queda como crédito a favor del
              cliente.
            </li>
          )}
          <li>El pedido cancelado no se puede reabrir.</li>
        </ul>
      }
      confirmLabel="Cancelar pedido"
      danger
      validate={() => {
        if (!reason.trim()) {
          setReasonError(true);
          return "Indicá el motivo de la cancelación.";
        }
        setReasonError(false);
        if (ready && !confirmReady)
          return "El pedido ya está listo: confirmá que querés cancelarlo marcando «Entiendo: cancelar igual».";
        return null;
      }}
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
        <label htmlFor={`cancel-reason-${order.id}`}>
          Motivo{" "}
          <span className="form__required" aria-hidden="true">
            *
          </span>
        </label>
        <textarea
          id={`cancel-reason-${order.id}`}
          value={reason}
          maxLength={500}
          rows={2}
          required
          aria-invalid={reasonError || undefined}
          onChange={(e) => {
            setReason(e.target.value);
            if (e.target.value.trim()) setReasonError(false);
          }}
        />
        <span className="form__hint">Queda registrado en el historial del pedido.</span>
      </div>
    </ConfirmAction>
  );
}

/* ---------- Precio y cobros ---------- */

function OrderCommercial({ order, tz }: { order: OrderDetailDto; tz: string }) {
  const c = order.commercial;
  const currency = order.currency;
  return (
    <section className="panel" aria-labelledby="commercial-title" data-testid="order-commercial">
      <h2 id="commercial-title">Precio, seña y ventas</h2>
      <Details
        hideEmpty
        items={[
          ["Precio", ORDER_PRICING_STATUS_LABELS[c.pricingStatus]],
          ["Lista de precios", c.priceList ? c.priceList.name : null],
          ["Total acordado", c.quotedTotal ? formatMoney(c.quotedTotal, currency) : null],
          [
            "Descuentos",
            c.quotedDiscountTotal && gt0(c.quotedDiscountTotal)
              ? formatMoney(c.quotedDiscountTotal, currency)
              : null,
          ],
          [
            "Seña disponible",
            c.advances ? (
              <span data-testid="advance-available">
                {formatMoney(c.advances.available, currency)}
              </span>
            ) : null,
          ],
          ["Primera entrega", c.firstDeliveredAt ? formatDateTime(c.firstDeliveredAt, tz) : null],
          ["Entregado completo", c.deliveredAt ? formatDateTime(c.deliveredAt, tz) : null],
        ]}
      />
      {c.pricingStatus === "UNPRICED" && order.status !== "DRAFT" && (
        <p className="alert alert--warn" role="status">
          Pedido sin precio acordado: hay que acordarlo antes de la primera entrega.
        </p>
      )}
      {c.advances && c.advances.payments.length > 0 && (
        <>
          <h3 className="section-title">Señas cobradas</h3>
          <div className="table-wrap">
            <table className="table table--compact" aria-label="Señas cobradas">
              <thead>
                <tr>
                  <th scope="col">Cobro</th>
                  <th scope="col">Fecha</th>
                  <th scope="col" className="hide-md">
                    Medio
                  </th>
                  <th scope="col" className="num">
                    Monto
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.advances.payments.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className="code">{p.code}</span>
                    </td>
                    <td>{formatDateTime(p.paymentDate, tz)}</td>
                    <td className="hide-md">{PAYMENT_METHOD_LABELS[p.method]}</td>
                    <td className="num">{formatMoney(p.amount, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {c.sales && c.sales.length > 0 && (
        <>
          <h3 className="section-title">Ventas del pedido</h3>
          <div className="table-wrap">
            <table className="table table--compact" aria-label="Ventas del pedido">
              <thead>
                <tr>
                  <th scope="col">Venta</th>
                  <th scope="col">Estado</th>
                  <th scope="col" className="hide-md">
                    Fecha
                  </th>
                  <th scope="col" className="num">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.sales.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link className="code" href={`${SALES_BASE}/${s.id}`}>
                        {s.code}
                      </Link>
                    </td>
                    <td>
                      <SaleStatusBadge status={s.status} />{" "}
                      {s.status === "POSTED" && <PaymentStatusBadge status={s.paymentStatus} />}
                    </td>
                    <td className="hide-md">{formatDateTime(s.date, tz)}</td>
                    <td className="num">
                      {s.total !== null ? formatMoney(s.total, currency) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function QuoteOrder({
  order,
  onDone,
  primary,
}: {
  order: OrderDetailDto;
  onDone: (o: OrderDetailDto) => void;
  primary?: boolean;
}) {
  return (
    <ConfirmAction
      label="Acordar precio"
      variant={primary ? "primary" : undefined}
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
