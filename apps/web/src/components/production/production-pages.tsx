"use client";

import {
  CONSERVATION_STATE_LABELS,
  PERMISSIONS as P,
  PRODUCTION_LINE_TYPE_LABELS,
  PRODUCTION_STATUSES,
  PRODUCTION_STATUS_LABELS,
  type ConservationProfileDto,
  type ConservationStateDto,
  type ProductDto,
  type ProductionMaterialLineDto,
  type ProductionOrderDto,
  type ProductionOrderListItemDto,
  type RawMaterialDto,
  type ResponsibleOptionDto,
  type StockMovementDto,
  type UnitDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { isDecimal, isPositive, toDecimal } from "@/lib/decimal-input";
import { describeError } from "@/lib/errors";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatUnitCost,
} from "@/lib/format";
import { movementColumns } from "../inventory/inventory-pages";
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
import { useFlash } from "../ui/flash";
import { useCan, useCurrentUser } from "../user-context";
import { ConservationBadge, LOTS_BASE, formatShelfLife } from "../lots/lot-shared";
import {
  AvailabilityTable,
  PRODUCTION_BASE,
  ProductionCosts,
  ProductionStatusBadge,
  compatibleUnits,
  formatFactor,
  useUnits,
} from "./production-shared";

/*
 * Órdenes de producción (Fase 4): listado y detalle. El detalle cambia según el
 * estado: plan y disponibilidad (borrador/planificada), carga del consumo y la
 * salida reales (en curso) y plan contra real con sus movimientos (completada).
 * Completar es el único paso que mueve stock y se confirma en un diálogo.
 */

/* ---------- Listado ---------- */

export function ProductionList() {
  const can = useCan();
  const [products, setProducts] = useState<{ value: string; label: string }[]>([]);
  const [responsibles, setResponsibles] = useState<{ value: string; label: string }[]>([]);
  const [filtersError, setFiltersError] = useState<string | null>(null);
  useEffect(() => {
    const fail = (err: unknown) =>
      setFiltersError(
        err instanceof ApiError ? describeError(err) : "No se pudieron cargar los filtros.",
      );
    fetchOptions<ProductDto>("/api/products", { status: "all" })
      .then((items) =>
        setProducts(
          items.filter((p) => p.controlsStock).map((p) => ({ value: p.id, label: p.name })),
        ),
      )
      .catch(fail);
    apiFetch<ResponsibleOptionDto[]>("/api/production/responsibles")
      .then((items) => setResponsibles(items.map((r) => ({ value: r.id, label: r.name }))))
      .catch(fail);
  }, []);
  const showCosts = can(P.PRODUCTION_COST_READ);
  return (
    <MasterList<ProductionOrderListItemDto>
      title="Órdenes de producción"
      subtitle="Qué se va a producir, qué está en curso y qué se terminó. El stock cambia recién al completar."
      endpoint="/api/production-orders"
      basePath={PRODUCTION_BASE}
      searchPlaceholder="Buscar por orden, lote o producto"
      createLabel="Nueva orden"
      createHref={`${PRODUCTION_BASE}/nueva`}
      canCreate={can(P.PRODUCTION_ORDERS_CREATE)}
      emptyText="Todavía no hay órdenes de producción."
      defaultStatus="all"
      headerExtra={
        filtersError && (
          <p className="alert alert--warn" role="status">
            Los filtros de producto y responsable no se pudieron cargar: {filtersError}
          </p>
        )
      }
      statusOptions={[
        { value: "all", label: "Todos los estados" },
        { value: "open", label: "Pendientes (sin completar)" },
        ...PRODUCTION_STATUSES.map((s) => ({ value: s, label: PRODUCTION_STATUS_LABELS[s] })),
      ]}
      extraFilters={[
        {
          name: "productId",
          label: "Producto",
          allLabel: "Todos los productos",
          options: products,
        },
        {
          name: "responsibleEmployeeId",
          label: "Responsable",
          allLabel: "Todos los responsables",
          options: responsibles,
        },
      ]}
      dateFilters={[
        { name: "from", label: "Desde" },
        { name: "to", label: "Hasta" },
      ]}
      columns={[
        {
          header: "Orden",
          cell: (o) => (
            <Link href={`${PRODUCTION_BASE}/${o.id}`} className="code">
              {o.code}
            </Link>
          ),
        },
        { header: "Producto", cell: (o) => o.product.name },
        {
          header: "Cantidad",
          cell: (o) =>
            o.status === "COMPLETED" && o.actualOutputNormalized !== null ? (
              <>
                {formatQuantity(o.actualOutputNormalized, o.saleUnit.symbol)}
                <span className="cost-source">
                  planificado {formatQuantity(o.plannedOutputNormalized, o.saleUnit.symbol)}
                </span>
              </>
            ) : (
              formatQuantity(o.plannedOutputNormalized, o.saleUnit.symbol)
            ),
          className: "num",
        },
        { header: "Para cuándo", cell: (o) => formatDate(o.scheduledFor) },
        { header: "Estado", cell: (o) => <ProductionStatusBadge status={o.status} /> },
        {
          header: "Lote",
          cell: (o) => (o.batchCode ? <span className="code">{o.batchCode}</span> : null),
          className: "hide-md",
        },
        {
          header: "Responsable",
          cell: (o) => o.responsible?.name ?? <span className="muted">Sin asignar</span>,
          className: "hide-md",
        },
        ...(showCosts
          ? [
              {
                header: "Costo real",
                cell: (o: ProductionOrderListItemDto) =>
                  o.actualMaterialCost === null
                    ? null
                    : formatMoney(o.actualMaterialCost, o.currency),
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

/** Por qué una orden planificada todavía no se puede iniciar (null: se puede). */
function startBlocker(order: ProductionOrderDto): string | null {
  if (order.issues.length > 0) return "Resolvé los avisos de la orden para poder iniciarla.";
  if (order.availability && !order.availability.sufficient)
    return `Falta materia prima en ${order.sourceWarehouse.name}: registrá la compra o un ajuste de stock y tocá «Volver a verificar».`;
  return null;
}

export function ProductionDetail({ id }: { id: string }) {
  const can = useCan();
  const user = useCurrentUser();
  const flash = useFlash();
  const { data, error, reload, setData } = useResource<ProductionOrderDto>(
    `/api/production-orders/${id}`,
  );
  const [version, setVersion] = useState(0);
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  const replace = (order: ProductionOrderDto) => {
    setData(order);
    setVersion((v) => v + 1);
  };
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const tz = user.company.timezone;
  const unit = data.saleUnit.symbol;
  const open =
    data.status === "DRAFT" || data.status === "PLANNED" || data.status === "IN_PROGRESS";
  const blocking = data.issues.length > 0;
  const blocker = data.status === "PLANNED" ? startBlocker(data) : null;
  const canReadLots = can(P.PRODUCT_LOTS_READ);
  const lotLink = (lot: { id: string; code: string }) =>
    canReadLots ? (
      <Link href={`${LOTS_BASE}/${lot.id}`} className="code">
        {lot.code}
      </Link>
    ) : (
      <span className="code">{lot.code}</span>
    );
  const waste =
    data.theoreticalWastePercentage && new D(data.theoreticalWastePercentage).gt(0)
      ? ` · merma teórica ${formatPercent(data.theoreticalWastePercentage)}`
      : "";

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: PRODUCTION_BASE, label: "Órdenes de producción" }}
        title={`Orden ${data.code}`}
        status={<ProductionStatusBadge status={data.status} />}
        subtitle={`${data.product.name} · ${formatQuantity(data.plannedOutputNormalized, unit)} · para el ${formatDate(data.scheduledFor)}${data.sourceOrder ? ` · pedido ${data.sourceOrder.orderCode}` : ""}`}
        actions={
          <>
            {data.status === "DRAFT" && can(P.PRODUCTION_ORDERS_PLAN) && (
              <ConfirmAction
                label="Planificar producción"
                variant="primary"
                title={`¿Planificar la orden ${data.code}?`}
                message={
                  <>
                    Se fijan la receta (versión {data.recipeVersion.versionNumber}), las cantidades,
                    el costo esperado y el código de lote. Después sólo se cambian responsable, lote
                    y notas.
                    {data.availability && !data.availability.sufficient && (
                      <> Hoy falta materia prima: se puede planificar igual, pero no iniciar.</>
                    )}
                  </>
                }
                confirmLabel="Planificar producción"
                onConfirm={async () => {
                  replace(
                    await apiFetch<ProductionOrderDto>(`/api/production-orders/${id}/plan`, {
                      method: "POST",
                    }),
                  );
                }}
              />
            )}
            {data.status === "PLANNED" && can(P.PRODUCTION_ORDERS_START) && (
              <StartButton order={data} blocker={blocker} onDone={replace} />
            )}
            {data.status === "DRAFT" && can(P.PRODUCTION_ORDERS_UPDATE) && (
              <Link className="button" href={`${PRODUCTION_BASE}/${id}/editar`}>
                Editar
              </Link>
            )}
            {(data.status === "PLANNED" || data.status === "IN_PROGRESS") &&
              can(P.PRODUCTION_ORDERS_UPDATE) && (
                <Link className="button" href={`${PRODUCTION_BASE}/${id}/editar`}>
                  Editar responsable, lote o notas
                </Link>
              )}
            {open && can(P.PRODUCTION_ORDERS_CANCEL) && (
              <CancelProduction order={data} onDone={replace} />
            )}
          </>
        }
      />

      {blocker && can(P.PRODUCTION_ORDERS_START) && !blocking && (
        <p className="alert alert--warn" role="status">
          <strong>Todavía no se puede iniciar.</strong> {blocker}
        </p>
      )}
      {data.status === "CANCELLED" && (
        <p className="notice">
          Cancelada el {data.cancelledAt ? formatDateTime(data.cancelledAt, tz) : "—"}
          {data.cancelledBy ? ` por ${data.cancelledBy.displayName}` : ""}
          {data.cancelReason ? `: ${data.cancelReason}` : "."} No se movió stock.
        </p>
      )}
      {data.status === "COMPLETED" && (
        <p className="alert alert--success" role="status">
          Producción completada: se descontaron las materias primas de {data.sourceWarehouse.name} y
          entraron {formatQuantity(data.actualOutputNormalized, unit)} de {data.product.name} en{" "}
          {data.outputWarehouse.name}
          {data.productLot && <> en el lote {lotLink(data.productLot)}</>}. Una producción
          completada no se modifica.
          {data.sourceOrder && (
            <>
              {" "}
              <Link href={`/pedidos/${data.sourceOrder.orderId}`}>
                Volver al pedido {data.sourceOrder.orderCode}
              </Link>
            </>
          )}
        </p>
      )}
      {open && blocking && (
        <div className="alert alert--warn" role="status">
          <strong>Hay que resolver esto antes de avanzar:</strong>
          <ul>
            {data.issues.map((i) => (
              <li key={i.code}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}
      {data.status === "DRAFT" && data.suggestedVersion && (
        <p className="notice">
          Esta orden usa la versión {data.recipeVersion.versionNumber} de la receta; para la fecha
          programada la vigente es la versión {data.suggestedVersion.versionNumber}.
        </p>
      )}

      <section className="panel" aria-labelledby="summary-title">
        <h2 id="summary-title" className="sr-only">
          Resumen
        </h2>
        <dl className="metrics">
          <div className="metric">
            <dt className="metric__label">Producto</dt>
            <dd className="metric__value">
              <Link href={`/stock/productos/${data.product.id}`}>{data.product.name}</Link>
            </dd>
          </div>
          <div className="metric metric--emphasis">
            <dt className="metric__label">
              {data.status === "COMPLETED" ? "Producido" : "Cantidad planificada"}
            </dt>
            <dd className="metric__value">
              {data.status === "COMPLETED"
                ? formatQuantity(data.actualOutputNormalized, unit)
                : formatQuantity(data.plannedOutputNormalized, unit)}
            </dd>
            {data.status === "COMPLETED" ? (
              <dd className="metric__note">
                Planificado {formatQuantity(data.plannedOutputNormalized, unit)}
                {data.output && ` · rendimiento ${formatPercent(data.output.yieldPerformance)}`}
              </dd>
            ) : data.actualOutputNormalized ? (
              <dd className="metric__note">
                Real cargado: {formatQuantity(data.actualOutputNormalized, unit)}
              </dd>
            ) : null}
          </div>
          <div className="metric">
            <dt className="metric__label">Para cuándo</dt>
            <dd className="metric__value">{formatDate(data.scheduledFor)}</dd>
            {data.sourceOrder && (
              <dd className="metric__note">
                Entrega del pedido: {formatDateTime(data.sourceOrder.requestedAt, tz)}
              </dd>
            )}
          </div>
          <div className="metric">
            <dt className="metric__label">Pedido</dt>
            <dd className="metric__value">
              {data.sourceOrder ? (
                <Link href={`/pedidos/${data.sourceOrder.orderId}`} className="code">
                  {data.sourceOrder.orderCode}
                </Link>
              ) : (
                <span className="muted">Para stock</span>
              )}
            </dd>
            {data.sourceOrder && <dd className="metric__note">Creada para ese pedido</dd>}
          </div>
          <div className="metric">
            <dt className="metric__label">{data.productLot ? "Lote producido" : "Lote"}</dt>
            <dd className="metric__value">
              {data.productLot ? (
                <>
                  {lotLink(data.productLot)}{" "}
                  <ConservationBadge state={data.productLot.conservationState} />
                </>
              ) : data.batchCode ? (
                <span className="code">{data.batchCode}</span>
              ) : (
                <span className="muted">
                  {data.status === "DRAFT" ? "Se asigna al planificar" : "Sin lote"}
                </span>
              )}
            </dd>
            {!data.productLot && data.batchCode && open && (
              <dd className="metric__note">El lote se crea al completar</dd>
            )}
          </div>
        </dl>
      </section>

      {data.status === "IN_PROGRESS" && (
        <ActualsEditor
          order={data}
          onChange={replace}
          onCompleted={(o) => {
            replace(o);
            flash(
              o.productLot
                ? `Producción ${o.code} completada: entró el lote ${o.productLot.code} con ${formatQuantity(o.actualOutputNormalized, o.saleUnit.symbol)}.`
                : `Producción ${o.code} completada.`,
            );
          }}
        />
      )}
      {(data.status === "DRAFT" || data.status === "PLANNED") && data.availability && (
        <section className="panel" aria-labelledby="availability-title">
          <div className="panel__header">
            <h2 id="availability-title">Disponibilidad en {data.sourceWarehouse.name}</h2>
            <button type="button" className="button button--small" onClick={refresh}>
              Volver a verificar
            </button>
          </div>
          <AvailabilityTable availability={data.availability} />
        </section>
      )}
      {(data.status === "DRAFT" || data.status === "PLANNED" || data.status === "CANCELLED") && (
        <PlanPanel order={data} />
      )}
      {data.status === "COMPLETED" && <PlanVsActual order={data} />}

      <section className="panel" aria-labelledby="order-data-title">
        <h2 id="order-data-title">Datos de la orden</h2>
        <Details
          hideEmpty
          items={[
            [
              "Receta",
              <Link key="r" href={`/recetas/${data.recipe.id}`}>
                {data.recipe.name} · versión {data.recipeVersion.versionNumber}
              </Link>,
            ],
            [
              "Escala",
              data.scaleFactor
                ? `${formatFactor(data.scaleFactor)} sobre ${formatQuantity(data.recipeVersion.yieldQuantity, data.recipeVersion.yieldUnit.symbol)}${waste}`
                : null,
            ],
            ["Depósito de materias primas", data.sourceWarehouse.name],
            ["Depósito de producto terminado", data.outputWarehouse.name],
            ["Responsable", data.responsible?.name ?? "Sin asignar"],
            ["Creada", who(data.createdAt, data.createdBy, tz)],
            ["Planificada", who(data.plannedAt, data.plannedBy, tz)],
            ["Iniciada", who(data.startedAt, data.startedBy, tz)],
            ["Completada", who(data.completedAt, data.completedBy, tz)],
            ["Notas", data.notes],
          ]}
        />
      </section>

      <ProductionCosts order={data} />
      {data.status === "COMPLETED" && <OrderMovements orderId={id} />}
      <AuditHistory entityType="production_order" entityId={id} version={version} />
    </div>
  );
}

function StartButton({
  order,
  blocker,
  onDone,
}: {
  order: ProductionOrderDto;
  blocker: string | null;
  onDone: (o: ProductionOrderDto) => void;
}) {
  return (
    <ConfirmAction
      label="Iniciar producción"
      variant="primary"
      disabled={blocker !== null}
      disabledReason={blocker ?? undefined}
      title={`¿Iniciar la orden ${order.code}?`}
      message={
        <>
          {formatQuantity(order.plannedOutputNormalized, order.saleUnit.symbol)} de{" "}
          {order.product.name}
          {order.sourceOrder ? ` para el pedido ${order.sourceOrder.orderCode}` : ""}. Queda en
          curso para cargar lo que realmente se usó y lo que salió. El stock no cambia hasta
          completarla.
        </>
      }
      confirmLabel="Iniciar producción"
      onConfirm={async () => {
        onDone(
          await apiFetch<ProductionOrderDto>(`/api/production-orders/${order.id}/start`, {
            method: "POST",
          }),
        );
      }}
    />
  );
}

function CancelProduction({
  order,
  onDone,
}: {
  order: ProductionOrderDto;
  onDone: (o: ProductionOrderDto) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <ConfirmAction
      label="Cancelar orden"
      title={`¿Cancelar la orden ${order.code}?`}
      message={`No se mueve stock. La orden ${order.code} queda cancelada y no se puede reabrir${order.sourceOrder ? `; deja de cubrir el pedido ${order.sourceOrder.orderCode}` : ""}.`}
      confirmLabel="Cancelar orden"
      danger
      onConfirm={async () => {
        onDone(
          await apiFetch<ProductionOrderDto>(`/api/production-orders/${order.id}/cancel`, {
            method: "POST",
            body: { reason: reason.trim() || null },
          }),
        );
      }}
    >
      <div className="form__field">
        <label htmlFor="cancel-reason">Motivo (opcional)</label>
        <textarea
          id="cancel-reason"
          value={reason}
          maxLength={500}
          rows={2}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
    </ConfirmAction>
  );
}

/* ---------- Plan (borrador / planificada) ---------- */

function PlanPanel({ order }: { order: ProductionOrderDto }) {
  const showCosts = order.canSeeCosts && order.costs !== null;
  const c = order.costs?.currency ?? "ARS";
  return (
    <section className="panel" aria-labelledby="plan-title">
      <h2 id="plan-title">Materias primas del plan</h2>
      <p className="muted small">
        {order.materialsArePreview
          ? "Cálculo con la receta y los costos de hoy. Se fija al planificar."
          : `Lo que la receta pide para ${formatQuantity(order.plannedOutputNormalized, order.saleUnit.symbol)}. Se descuenta de ${order.sourceWarehouse.name} recién al completar.`}
      </p>
      {order.materials.length === 0 ? (
        <p className="muted">La receta no tiene ingredientes.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Materia prima</th>
                <th scope="col" className="num">
                  Requerido
                </th>
                {showCosts && (
                  <>
                    <th scope="col" className="num hide-sm">
                      Costo unitario
                    </th>
                    <th scope="col" className="num">
                      Costo esperado
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {order.materials.map((m) => (
                <tr key={m.id ?? m.rawMaterial.id}>
                  <td>
                    {m.rawMaterial.name}
                    {!m.rawMaterial.active && <span className="cost-source">Dada de baja</span>}
                  </td>
                  <td className="num">{formatQuantity(m.plannedNormalized, m.baseUnit.symbol)}</td>
                  {showCosts && (
                    <>
                      <td className="num hide-sm">
                        {m.plannedUnitCost === null
                          ? "Sin costo"
                          : formatUnitCost(m.plannedUnitCost, c, m.baseUnit.symbol)}
                      </td>
                      <td className="num">
                        {m.plannedCost === null ? "—" : formatMoney(m.plannedCost, c)}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ---------- En curso: consumo y salida reales ---------- */

interface Entry {
  quantity: string;
  unitId: string;
}

const plain = (v: string | null | undefined) =>
  v ? v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : "";

function entryOf(line: ProductionMaterialLineDto): Entry {
  return {
    quantity: plain(line.actualQuantity),
    unitId: line.actualUnit?.id ?? line.plannedUnit?.id ?? line.baseUnit.id,
  };
}

function ActualsEditor({
  order,
  onChange,
  onCompleted,
}: {
  order: ProductionOrderDto;
  onChange: (o: ProductionOrderDto) => void;
  onCompleted: (o: ProductionOrderDto) => void;
}) {
  const can = useCan();
  const units = useUnits();
  const editable = can(P.PRODUCTION_ORDERS_UPDATE);
  // Sólo lo editado; el resto se lee de la orden (así un consumo extra nuevo no pisa lo tipeado).
  const [edited, setEntries] = useState<Record<string, Entry>>({});
  const entries: Record<string, Entry> = Object.fromEntries(
    order.materials.map((m) => [m.id!, edited[m.id!] ?? entryOf(m)]),
  );
  const [output, setOutput] = useState<Entry>({
    quantity: plain(order.actualOutputQuantity),
    unitId: order.actualOutputUnit?.id ?? order.saleUnit.id,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [review, setReview] = useState<ProductionOrderDto | null>(null);

  function validate(requireOutput: boolean): Record<string, string> {
    const e: Record<string, string> = {};
    for (const m of order.materials) {
      const entry = entries[m.id!];
      if (!entry || !isDecimal(entry.quantity))
        e[m.id!] = "Indicá la cantidad usada (0 si no se usó)";
      else if (m.lineType === "EXTRA" && !isPositive(entry.quantity))
        e[m.id!] = "Debe ser mayor que cero; quitá la línea si no se usó";
    }
    if (output.quantity.trim() !== "" || requireOutput) {
      if (!isPositive(output.quantity)) e.output = "Indicá cuánto salió (mayor que cero)";
    }
    return e;
  }

  async function save(requireOutput: boolean): Promise<ProductionOrderDto | null> {
    const e = validate(requireOutput);
    setErrors(e);
    setMessage(null);
    if (Object.keys(e).length > 0) {
      setMessage({ kind: "error", text: "Revisá los datos marcados." });
      return null;
    }
    setPending(true);
    try {
      const saved = await apiFetch<ProductionOrderDto>(
        `/api/production-orders/${order.id}/actuals`,
        {
          method: "PUT",
          body: {
            lines: order.materials.map((m) => ({
              lineId: m.id,
              quantity: toDecimal(entries[m.id!]!.quantity),
              unitId: entries[m.id!]!.unitId,
            })),
            ...(output.quantity.trim() !== ""
              ? {
                  actualOutputQuantity: toDecimal(output.quantity),
                  actualOutputUnitId: output.unitId,
                }
              : {}),
          },
        },
      );
      onChange(saved);
      return saved;
    } catch (err) {
      if (err instanceof ApiError) {
        const mapped: Record<string, string> = {};
        for (const [path, text] of Object.entries(err.fieldErrors)) {
          const match = /^lines\.(\d+)\./.exec(path);
          const line = match ? order.materials[Number(match[1])] : undefined;
          if (line?.id) mapped[line.id] = text;
          else if (path.startsWith("actualOutput")) mapped.output = text;
        }
        setErrors(mapped);
        setMessage({ kind: "error", text: describeError(err) });
      } else {
        setMessage({ kind: "error", text: "No se pudo guardar." });
      }
      return null;
    } finally {
      setPending(false);
    }
  }

  const c = order.costs?.currency ?? "ARS";
  const unit = order.saleUnit.symbol;
  return (
    <section className="panel" id="actuals" aria-labelledby="actuals-title">
      <h2 id="actuals-title">Consumo y salida reales</h2>
      <p className="muted small">
        Cargá lo que realmente se usó de cada materia prima (arranca con lo requerido por la receta)
        y cuánto salió. Podés guardar el avance y completar después: el stock se mueve recién al
        confirmar.
      </p>
      <div className="table-wrap">
        <table className="table ingredients-editor production-actuals">
          <thead>
            <tr>
              <th scope="col">Materia prima</th>
              <th scope="col" className="num">
                Requerido
              </th>
              <th scope="col" className="col-qty">
                Consumido
              </th>
              <th scope="col" className="col-unit">
                Unidad
              </th>
              <th scope="col" className="num hide-sm">
                Diferencia
              </th>
              {editable && can(P.PRODUCTION_ORDERS_ADD_EXTRA_MATERIAL) && (
                <th scope="col">
                  <span className="sr-only">Acciones</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {order.materials.map((m) => {
              const entry = entries[m.id!] ?? entryOf(m);
              const options = units ? compatibleUnits(units, m.baseUnit.id) : [];
              return (
                <tr key={m.id}>
                  <td>
                    {m.rawMaterial.name}
                    {m.lineType === "EXTRA" && (
                      <span className="cost-source">
                        {PRODUCTION_LINE_TYPE_LABELS.EXTRA}
                        {m.notes ? `: ${m.notes}` : ""}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {m.plannedNormalized === null
                      ? "—"
                      : formatQuantity(m.plannedNormalized, m.baseUnit.symbol)}
                  </td>
                  <td className="col-qty">
                    <input
                      aria-label={`Real ${m.rawMaterial.name}`}
                      inputMode="decimal"
                      autoComplete="off"
                      value={entry.quantity}
                      disabled={!editable}
                      aria-invalid={errors[m.id!] ? true : undefined}
                      aria-describedby={errors[m.id!] ? `actual-${m.id}-error` : undefined}
                      onChange={(e) =>
                        setEntries((prev) => ({
                          ...prev,
                          [m.id!]: { ...entry, quantity: e.target.value },
                        }))
                      }
                    />
                    {errors[m.id!] && (
                      <span className="form__error" id={`actual-${m.id}-error`}>
                        {errors[m.id!]}
                      </span>
                    )}
                  </td>
                  <td className="col-unit">
                    <select
                      aria-label={`Unidad ${m.rawMaterial.name}`}
                      value={entry.unitId}
                      disabled={!editable}
                      onChange={(e) =>
                        setEntries((prev) => ({
                          ...prev,
                          [m.id!]: { ...entry, unitId: e.target.value },
                        }))
                      }
                    >
                      {options.length === 0 && (
                        <option value={entry.unitId}>
                          {m.actualUnit?.symbol ?? m.baseUnit.symbol}
                        </option>
                      )}
                      {options.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.symbol}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num hide-sm">
                    {m.variance ? (
                      <>
                        {formatQuantity(m.variance.quantity, m.baseUnit.symbol)}
                        {m.variance.percentage !== null && (
                          <span className="cost-source">
                            {formatPercent(m.variance.percentage)}
                          </span>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  {editable && can(P.PRODUCTION_ORDERS_ADD_EXTRA_MATERIAL) && (
                    <td>
                      {m.lineType === "EXTRA" && (
                        <RemoveExtra order={order} line={m} onDone={onChange} />
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">La diferencia se recalcula al guardar el avance.</p>

      {can(P.PRODUCTION_ORDERS_ADD_EXTRA_MATERIAL) && (
        <ExtraMaterialForm order={order} units={units} onDone={onChange} />
      )}

      <h3 className="section-title">Salida real</h3>
      <div className="output-row">
        <div className="form__field">
          <label htmlFor="actual-output">Cantidad obtenida de {order.product.name}</label>
          <div className="input-group">
            <input
              id="actual-output"
              inputMode="decimal"
              autoComplete="off"
              value={output.quantity}
              disabled={!editable}
              placeholder={`Planificado: ${formatQuantity(order.plannedOutputNormalized, unit)}`}
              aria-invalid={errors.output ? true : undefined}
              aria-describedby={errors.output ? "actual-output-error" : "actual-output-hint"}
              onChange={(e) => setOutput((o) => ({ ...o, quantity: e.target.value }))}
            />
            <select
              aria-label="Unidad de la salida real"
              value={output.unitId}
              disabled={!editable}
              onChange={(e) => setOutput((o) => ({ ...o, unitId: e.target.value }))}
            >
              {(units ? compatibleUnits(units, order.saleUnit.id) : []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.symbol}
                </option>
              ))}
              {!units && <option value={output.unitId}>{unit}</option>}
            </select>
          </div>
          {errors.output && (
            <span className="form__error" id="actual-output-error">
              {errors.output}
            </span>
          )}
        </div>
        <p className="muted small" id="actual-output-hint">
          Entra a {order.outputWarehouse.name} al completar. Si sale menos que lo planificado, la
          diferencia queda como rendimiento: no se registra merma aparte.
        </p>
      </div>

      {message && (
        <p className={message.kind === "error" ? "form__error" : "muted"} role="alert">
          {message.text}
        </p>
      )}
      {editable && (
        <div className="form__footer">
          {can(P.PRODUCTION_ORDERS_COMPLETE) && (
            <button
              type="button"
              className="button button--primary"
              disabled={pending}
              onClick={async () => {
                const saved = await save(true);
                if (saved) setReview(saved);
              }}
            >
              Revisar y completar
            </button>
          )}
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={async () => {
              if (await save(false)) setMessage({ kind: "ok", text: "Avance guardado." });
            }}
          >
            {pending ? "Guardando…" : "Guardar avance"}
          </button>
        </div>
      )}
      {review && (
        <ReviewDialog
          order={review}
          currency={c}
          onClose={() => setReview(null)}
          onCompleted={(o) => {
            setReview(null);
            onCompleted(o);
            window.scrollTo({ top: 0 });
          }}
        />
      )}
    </section>
  );
}

function RemoveExtra({
  order,
  line,
  onDone,
}: {
  order: ProductionOrderDto;
  line: ProductionMaterialLineDto;
  onDone: (o: ProductionOrderDto) => void;
}) {
  return (
    <ConfirmAction
      label="Quitar"
      small
      danger
      title={`¿Quitar el consumo extra de ${line.rawMaterial.name}?`}
      message={`Se borra la línea${line.notes ? ` («${line.notes}»)` : ""} de esta orden. No mueve stock: el consumo se descuenta recién al completar.`}
      confirmLabel="Quitar consumo extra"
      onConfirm={async () => {
        onDone(
          await apiFetch<ProductionOrderDto>(
            `/api/production-orders/${order.id}/extra-materials/${line.id}`,
            { method: "DELETE" },
          ),
        );
      }}
    />
  );
}

function ExtraMaterialForm({
  order,
  units,
  onDone,
}: {
  order: ProductionOrderDto;
  units: UnitDto[] | null;
  onDone: (o: ProductionOrderDto) => void;
}) {
  const [open, setOpen] = useState(false);
  const [materials, setMaterials] = useState<RawMaterialDto[] | null>(null);
  const [form, setForm] = useState({ rawMaterialId: "", quantity: "", unitId: "", notes: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || materials) return;
    let cancelled = false;
    fetchOptions<RawMaterialDto>("/api/raw-materials")
      .then((items) => {
        if (!cancelled) setMaterials(items);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setLoadError(
            err instanceof ApiError
              ? describeError(err)
              : "No se pudieron cargar las materias primas.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [open, materials, attempt]);
  const material = materials?.find((m) => m.id === form.rawMaterialId) ?? null;
  const options = material && units ? compatibleUnits(units, material.baseUnit.id) : [];
  const unitId = form.unitId || material?.baseUnit.id || "";

  if (!open) {
    return (
      <p>
        <button type="button" className="button button--small" onClick={() => setOpen(true)}>
          Agregar consumo extra
        </button>
      </p>
    );
  }

  async function submit() {
    const e: Record<string, string> = {};
    if (!form.rawMaterialId) e.rawMaterialId = "Elegí la materia prima";
    if (!isPositive(form.quantity)) e.quantity = "Mayor que cero";
    if (!form.notes.trim()) e.notes = "Contá por qué se usó";
    setErrors(e);
    setError(null);
    if (Object.keys(e).length > 0) return;
    setPending(true);
    try {
      onDone(
        await apiFetch<ProductionOrderDto>(`/api/production-orders/${order.id}/extra-materials`, {
          method: "POST",
          body: {
            rawMaterialId: form.rawMaterialId,
            quantity: toDecimal(form.quantity),
            unitId,
            notes: form.notes.trim(),
          },
        }),
      );
      setForm({ rawMaterialId: "", quantity: "", unitId: "", notes: "" });
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setError(describeError(err));
      } else setError("No se pudo agregar el consumo extra.");
    } finally {
      setPending(false);
    }
  }

  return (
    <fieldset className="extra-form">
      <legend className="sr-only">Agregar consumo extra</legend>
      <p className="form__hint form__field--full">
        Para algo que se usó y no estaba en la receta. Todos los campos son obligatorios.
      </p>
      {loadError && (
        <p className="alert alert--warn form__field--full" role="alert">
          {loadError}{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setLoadError(null);
              setAttempt((a) => a + 1);
            }}
          >
            Reintentar
          </button>
        </p>
      )}
      <div className="form__field">
        <label htmlFor="extra-material">Materia prima</label>
        <select
          id="extra-material"
          value={form.rawMaterialId}
          aria-required
          aria-invalid={errors.rawMaterialId ? true : undefined}
          aria-describedby={errors.rawMaterialId ? "extra-material-error" : undefined}
          onChange={(e) => setForm({ ...form, rawMaterialId: e.target.value, unitId: "" })}
        >
          <option value="">
            {materials ? "Elegí una materia prima" : loadError ? "Sin datos" : "Cargando…"}
          </option>
          {(materials ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {errors.rawMaterialId && (
          <span className="form__error" id="extra-material-error">
            {errors.rawMaterialId}
          </span>
        )}
      </div>
      <div className="form__field">
        <label htmlFor="extra-quantity">Cantidad</label>
        <input
          id="extra-quantity"
          inputMode="decimal"
          autoComplete="off"
          value={form.quantity}
          aria-required
          aria-invalid={errors.quantity ? true : undefined}
          aria-describedby={errors.quantity ? "extra-quantity-error" : undefined}
          onChange={(e) => setForm({ ...form, quantity: e.target.value })}
        />
        {errors.quantity && (
          <span className="form__error" id="extra-quantity-error">
            {errors.quantity}
          </span>
        )}
      </div>
      <div className="form__field">
        <label htmlFor="extra-unit">Unidad</label>
        <select
          id="extra-unit"
          value={unitId}
          disabled={!material}
          aria-invalid={errors.unitId ? true : undefined}
          aria-describedby={errors.unitId ? "extra-unit-error" : undefined}
          onChange={(e) => setForm({ ...form, unitId: e.target.value })}
        >
          {options.length === 0 && <option value="">—</option>}
          {options.map((u) => (
            <option key={u.id} value={u.id}>
              {u.symbol}
            </option>
          ))}
        </select>
        {errors.unitId && (
          <span className="form__error" id="extra-unit-error">
            {errors.unitId}
          </span>
        )}
      </div>
      <div className="form__field form__field--full">
        <label htmlFor="extra-notes">Motivo</label>
        <input
          id="extra-notes"
          value={form.notes}
          maxLength={500}
          placeholder="Ej.: engrase de bandejas"
          aria-required
          aria-invalid={errors.notes ? true : undefined}
          aria-describedby={errors.notes ? "extra-notes-error" : undefined}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
        {errors.notes && (
          <span className="form__error" id="extra-notes-error">
            {errors.notes}
          </span>
        )}
      </div>
      <div className="actions extra-form__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={pending}
          onClick={submit}
        >
          {pending ? "Agregando…" : "Agregar"}
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)} disabled={pending}>
          Cancelar
        </button>
      </div>
      {error && (
        <p className="form__error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Revisión final antes de mover stock: plan contra real, faltantes y costo estimado. */
function ReviewDialog({
  order,
  currency,
  onClose,
  onCompleted,
}: {
  order: ProductionOrderDto;
  currency: string;
  onClose: () => void;
  onCompleted: (o: ProductionOrderDto) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const unit = order.saleUnit.symbol;
  const tz = useCurrentUser().company.timezone;
  const short = order.availability ? !order.availability.sufficient : false;
  const estimated = order.costs?.estimated ?? null;
  const can = useCan();
  const { data: conservation } = useResource<ConservationProfileDto>(
    can(P.PRODUCT_CONSERVATION_READ) ? `/api/products/${order.product.id}/conservation` : null,
  );
  const initialStates = conservation?.states.filter((s) => s.enabled && s.allowedAsInitial) ?? [];
  const [initialState, setInitialState] = useState<ConservationStateDto | "">("");
  const chosenState = initialState || conservation?.defaultInitialState || "FRESH";
  const chosenEntry = conservation?.states.find((s) => s.state === chosenState);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const done = await apiFetch<ProductionOrderDto>(
        `/api/production-orders/${order.id}/complete`,
        {
          method: "POST",
          body: initialState ? { conservationState: initialState } : {},
        },
      );
      ref.current?.close();
      onCompleted(done);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INSUFFICIENT_STOCK") {
        const details = err.details as { message?: string }[];
        setError(
          <>
            {describeError(err)}
            <ul>
              {details.map((d, i) => (
                <li key={i}>{d.message}</li>
              ))}
            </ul>
          </>,
        );
      } else {
        setError(
          err instanceof ApiError ? describeError(err) : "No se pudo completar la producción.",
        );
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="dialog dialog--wide"
      aria-labelledby="review-title"
      onClose={onClose}
    >
      <h2 id="review-title">Revisar antes de completar la orden {order.code}</h2>
      <p className="muted">
        {order.product.name}
        {order.batchCode && (
          <>
            {" "}
            · entra como lote <span className="code">{order.batchCode}</span>
          </>
        )}
        {order.sourceOrder && (
          <>
            {" "}
            · para el pedido <span className="code">
              {order.sourceOrder.orderCode}
            </span> (entrega {formatDateTime(order.sourceOrder.requestedAt, tz)})
          </>
        )}
      </p>
      <p className="small muted">
        Lo cargado en consumo y salida ya quedó guardado. Si volvés sin confirmar, la orden sigue en
        curso con esos datos.
      </p>
      <dl className="cost-summary">
        <div>
          <dt>Planificado</dt>
          <dd>{formatQuantity(order.plannedOutputNormalized, unit)}</dd>
        </div>
        <div>
          <dt>Producido</dt>
          <dd>{formatQuantity(order.actualOutputNormalized, unit)}</dd>
        </div>
        <div>
          <dt>Rendimiento</dt>
          <dd>{order.output ? formatPercent(order.output.yieldPerformance) : "—"}</dd>
        </div>
        <div>
          <dt>Stock suficiente</dt>
          <dd>{order.availability ? (short ? "No" : "Sí") : "—"}</dd>
        </div>
      </dl>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Materia prima</th>
              <th scope="col" className="num">
                Requerido
              </th>
              <th scope="col" className="num">
                Consumido
              </th>
              <th scope="col" className="num">
                Diferencia
              </th>
            </tr>
          </thead>
          <tbody>
            {order.materials.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.rawMaterial.name}
                  {m.lineType === "EXTRA" && <span className="cost-source">Consumo extra</span>}
                </td>
                <td className="num">
                  {m.plannedNormalized === null
                    ? "—"
                    : formatQuantity(m.plannedNormalized, m.baseUnit.symbol)}
                </td>
                <td className="num">{formatQuantity(m.actualNormalized, m.baseUnit.symbol)}</td>
                <td className="num">
                  {m.variance ? formatQuantity(m.variance.quantity, m.baseUnit.symbol) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {short && order.availability && <AvailabilityTable availability={order.availability} />}
      {estimated && (
        <p>
          <strong>Costo estimado del consumo cargado:</strong>{" "}
          {estimated.total ? formatMoney(estimated.total, currency) : "incompleto"}
          {estimated.unit && ` (${formatUnitCost(estimated.unit, currency, unit)})`}. El costo real
          se fija al confirmar con el costo promedio de cada materia prima en ese momento.
        </p>
      )}
      <p className="muted">
        Al confirmar se descuentan las materias primas de {order.sourceWarehouse.name} y entran{" "}
        {formatQuantity(order.actualOutputNormalized, unit)} de {order.product.name} en{" "}
        {order.outputWarehouse.name}
        {conservation?.configured
          ? `, en un lote ${CONSERVATION_STATE_LABELS[chosenState].toLowerCase()} que dura ${formatShelfLife(chosenEntry?.shelfLifeMinutes ?? null)}`
          : ", en un lote fresco sin vencimiento (el producto no tiene conservación configurada)"}
        . No se puede deshacer.
      </p>
      {initialStates.length > 1 && (
        <div className="form__field">
          <label htmlFor="initial-state">Estado del lote producido</label>
          <select
            id="initial-state"
            value={chosenState}
            onChange={(e) => setInitialState(e.target.value as ConservationStateDto)}
          >
            {initialStates.map((s) => (
              <option key={s.state} value={s.state}>
                {CONSERVATION_STATE_LABELS[s.state]} · dura {formatShelfLife(s.shelfLifeMinutes)}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <div className="form__error" role="alert">
          {error}
        </div>
      )}
      {short && (
        <p className="form__error" id="review-blocked">
          No se puede confirmar: falta materia prima para el consumo cargado (ver la tabla de
          arriba). Volvé, corregí el consumo o registrá el stock que falta.
        </p>
      )}
      <div className="form__footer">
        <button
          type="button"
          className="button"
          onClick={() => ref.current?.close()}
          disabled={pending}
        >
          Volver
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={confirm}
          disabled={pending || short}
          aria-describedby={short ? "review-blocked" : undefined}
          aria-busy={pending || undefined}
        >
          {pending ? "Procesando…" : "Confirmar producción"}
        </button>
      </div>
    </dialog>
  );
}

/* ---------- Completada ---------- */

function PlanVsActual({ order }: { order: ProductionOrderDto }) {
  const showCosts = order.canSeeCosts && order.costs !== null;
  const c = order.costs?.currency ?? "ARS";
  return (
    <section className="panel" aria-labelledby="pva-title">
      <h2 id="pva-title">Plan contra real</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Materia prima</th>
              <th scope="col" className="num">
                Requerido
              </th>
              <th scope="col" className="num">
                Consumido
              </th>
              <th scope="col" className="num">
                Diferencia
              </th>
              {showCosts && (
                <>
                  <th scope="col" className="num hide-sm">
                    Costo esperado
                  </th>
                  <th scope="col" className="num">
                    Costo real
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {order.materials.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.rawMaterial.name}
                  {m.lineType === "EXTRA" && (
                    <span className="cost-source">
                      Consumo extra{m.notes ? `: ${m.notes}` : ""}
                    </span>
                  )}
                </td>
                <td className="num">
                  {m.plannedNormalized === null
                    ? "—"
                    : formatQuantity(m.plannedNormalized, m.baseUnit.symbol)}
                </td>
                <td className="num">{formatQuantity(m.actualNormalized, m.baseUnit.symbol)}</td>
                <td className="num">
                  {m.variance ? (
                    <>
                      {formatQuantity(m.variance.quantity, m.baseUnit.symbol)}
                      {m.variance.percentage !== null && (
                        <span className="cost-source">{formatPercent(m.variance.percentage)}</span>
                      )}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                {showCosts && (
                  <>
                    <td className="num hide-sm">
                      {m.plannedCost === null ? "—" : formatMoney(m.plannedCost, c)}
                    </td>
                    <td className="num">
                      {m.actualCost === null ? "—" : formatMoney(m.actualCost, c)}
                      {m.actualUnitCost !== null && (
                        <span className="cost-source">
                          {formatUnitCost(m.actualUnitCost, c, m.baseUnit.symbol)}
                        </span>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OrderMovements({ orderId }: { orderId: string }) {
  const user = useCurrentUser();
  const can = useCan();
  const { data, error, reload } = useResource<StockMovementDto[]>(
    `/api/production-orders/${orderId}/movements`,
  );
  const columns = movementColumns(
    user.company.timezone,
    user.company.currencyCode,
    can(P.PRODUCTION_COST_READ),
    true,
  ).filter((col) => col.header !== "Origen / motivo");
  return (
    <section className="panel" aria-labelledby="movements-title">
      <h2 id="movements-title">Movimientos de stock</h2>
      {error ? (
        <div className="alert alert--warn" role="alert">
          No se pudieron cargar los movimientos: {describeError(error)}{" "}
          <button type="button" className="link-button" onClick={reload}>
            Reintentar
          </button>
        </div>
      ) : !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <p className="muted">Sin movimientos.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.header} scope="col" className={col.className}>
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id}>
                  {columns.map((col) => (
                    <td key={col.header} className={col.className}>
                      {col.cell(m)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
