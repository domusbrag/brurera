"use client";

import { D } from "@bakery/domain";
import {
  AUDIT_ACTION_LABELS,
  CONSERVATION_STATES,
  CONSERVATION_STATE_LABELS,
  LOT_INELIGIBILITY_LABELS,
  PERMISSIONS as P,
  PRODUCT_WASTE_REASONS,
  PRODUCT_WASTE_REASON_LABELS,
  type ConservationBreakdownDto,
  type ExpiringLotDto,
  type LotOperationResultDto,
  type Page,
  type ProductAvailabilityDto,
  type ProductLotDetailDto,
  type ProductLotDto,
  type ProductWasteReasonDto,
  zonedLocalToInstant,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError, apiFetch, listPath } from "@/lib/api-client";
import { isPositive, parseDecimal, toDecimal } from "@/lib/decimal-input";
import { formatDateTime, formatMoney, formatQuantity, formatReferenceCost } from "@/lib/format";
import { MasterList } from "../masters/master-list";
import {
  ConfirmAction,
  Details,
  ErrorState,
  Loading,
  PageHeader,
  useResource,
} from "../masters/ui";
import { useCan, useCurrentUser } from "../user-context";
import {
  PRODUCT_STOCK_BASE,
  Pager,
  StockTabs,
  movementColumns,
  useWarehouseOptions,
} from "../inventory/inventory-pages";
import {
  ConservationBadge,
  LOTS_BASE,
  LotStatusBadge,
  formatRemaining,
  formatShelfLife,
} from "./lot-shared";
import { WallClockInput, isCompleteWallClock, wallClockIn } from "../orders/order-shared";

/*
 * Lotes de producto terminado (Fase 4.5): lotes de un producto, disponibilidad a
 * una fecha, detalle del lote, congelar / descongelar, merma y próximos a vencer.
 * Todo lo que cambia stock es una operación explícita con resumen previo.
 */

/** Cantidades por estado, sólo los que tienen stock: "Fresco 200 kg · Congelado 300 kg". */
export function StateBreakdown({
  byState,
  unit,
}: {
  byState: ConservationBreakdownDto;
  unit: string;
}) {
  const parts = CONSERVATION_STATES.filter((s) => new D(byState[s]).gt(0));
  if (parts.length === 0) return <>—</>;
  return (
    <>
      {parts.map((s, i) => (
        <span key={s}>
          {i > 0 && " · "}
          {CONSERVATION_STATE_LABELS[s]} {formatQuantity(byState[s], unit)}
        </span>
      ))}
    </>
  );
}

/** Acciones posibles hoy sobre un lote, según sus reglas y los permisos. */
function LotActions({ lot }: { lot: ProductLotDto }) {
  const can = useCan();
  const actions: [string, string][] = [];
  if (can(P.PRODUCT_LOTS_TRANSFORM)) {
    if (lot.transformTargets.includes("FROZEN")) actions.push(["Congelar", "congelar"]);
    if (lot.transformTargets.includes("THAWED")) actions.push(["Descongelar", "descongelar"]);
  }
  if (can(P.PRODUCT_LOTS_WASTE) && lot.status !== "DEPLETED") actions.push(["Merma", "merma"]);
  if (actions.length === 0) return <>—</>;
  return (
    <span className="row-actions">
      {actions.map(([label, path]) => (
        <Link
          key={path}
          href={`${LOTS_BASE}/${lot.id}/${path}`}
          aria-label={`${label} ${lot.code}`}
        >
          {label}
        </Link>
      ))}
    </span>
  );
}

/* ---------- Lotes de un producto ---------- */

export function ProductLotsPanel({ productId, unit }: { productId: string; unit: string }) {
  const user = useCurrentUser();
  const can = useCan();
  const [scope, setScope] = useState<"active" | "all">("active");
  const [page, setPage] = useState(1);
  const { data, error } = useResource<Page<ProductLotDto>>(
    can(P.PRODUCT_LOTS_READ)
      ? listPath(`/api/inventory/products/${productId}/lots`, { scope, page, pageSize: 10 })
      : null,
  );
  if (!can(P.PRODUCT_LOTS_READ)) return null;
  const tz = user.company.timezone;
  return (
    <section className="panel" aria-labelledby="lots-title">
      <div className="panel__header">
        <h2 id="lots-title">Lotes</h2>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={scope === "all"}
            onChange={(e) => {
              setScope(e.target.checked ? "all" : "active");
              setPage(1);
            }}
          />{" "}
          Mostrar agotados
        </label>
      </div>
      <p className="muted small">Ordenados por vencimiento: primero el que hay que usar antes.</p>
      {error ? (
        <p className="muted">{error.message}</p>
      ) : !data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <p className="muted">Sin lotes con stock.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Lote</th>
                  <th scope="col">Conservación</th>
                  <th scope="col" className="num">
                    Cantidad
                  </th>
                  <th scope="col">Utilizable hasta</th>
                  <th scope="col">Estado</th>
                  <th scope="col" className="hide-md">
                    Producción
                  </th>
                  <th scope="col" className="hide-md">
                    Producido
                  </th>
                  <th scope="col" className="hide-sm">
                    Depósito
                  </th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <Link href={`${LOTS_BASE}/${l.id}`}>{l.code}</Link>
                      {l.parentLot && <span className="cost-source">de {l.parentLot.code}</span>}
                    </td>
                    <td>
                      <ConservationBadge state={l.conservationState} />
                    </td>
                    <td className="num">{formatQuantity(l.quantity, unit)}</td>
                    <td>
                      {l.usableUntil ? formatDateTime(l.usableUntil, tz) : "Sin vencimiento"}
                      {l.status !== "DEPLETED" && (
                        <span className="cost-source">{formatRemaining(l.minutesRemaining)}</span>
                      )}
                    </td>
                    <td>
                      <LotStatusBadge status={l.status} />
                    </td>
                    <td className="hide-md">
                      {can(P.PRODUCTION_ORDERS_READ) ? (
                        <Link href={`/produccion/${l.productionOrder.id}`}>
                          {l.productionOrder.code}
                        </Link>
                      ) : (
                        l.productionOrder.code
                      )}
                    </td>
                    <td className="hide-md">{formatDateTime(l.producedAt, tz)}</td>
                    <td className="hide-sm">{l.warehouse.name}</td>
                    <td>
                      <LotActions lot={l} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />
        </>
      )}
    </section>
  );
}

/** "¿Cuánto voy a poder usar el sábado?": disponibilidad física vs. utilizable a una fecha. */
export function AvailabilityAtDate({ productId, unit }: { productId: string; unit: string }) {
  const user = useCurrentUser();
  const can = useCan();
  const warehouses = useWarehouseOptions();
  const tz = user.company.timezone;
  // Hora de pared de la EMPRESA (no la del navegador): deuda de Fase 4.5 corregida en 5A.
  const [at, setAt] = useState(() => wallClockIn(tz, 2, 10));
  const [warehouseId, setWarehouseId] = useState("");
  const valid = isCompleteWallClock(at);
  const { data, error } = useResource<ProductAvailabilityDto>(
    can(P.PRODUCT_LOTS_READ) && valid
      ? listPath(`/api/inventory/products/${productId}/availability`, {
          at: zonedLocalToInstant(at, tz).toISOString(),
          warehouseId,
        })
      : null,
  );
  if (!can(P.PRODUCT_LOTS_READ)) return null;
  return (
    <section className="panel" aria-labelledby="availability-title">
      <h2 id="availability-title">Disponibilidad a una fecha</h2>
      <div className="form-grid">
        <div className="form__field">
          <label htmlFor="availability-at">Fecha y hora</label>
          <WallClockInput id="availability-at" value={at} timeZone={tz} onChange={setAt} />
        </div>
        <div className="form__field">
          <label htmlFor="availability-warehouse">Depósito</label>
          <select
            id="availability-warehouse"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
          >
            <option value="">Todos los depósitos</option>
            {warehouses.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? (
        <p className="muted">{error.message}</p>
      ) : !data ? (
        valid ? (
          <Loading />
        ) : null
      ) : (
        <div aria-live="polite">
          <dl className="cost-summary">
            <div>
              <dt>Stock físico</dt>
              <dd>{formatQuantity(data.physicalQuantity, unit)}</dd>
            </div>
            <div>
              <dt>Utilizable el {formatDateTime(data.requestedAt, tz)}</dt>
              <dd>
                <strong>{formatQuantity(data.eligibleQuantity, unit)}</strong>
              </dd>
            </div>
            <div>
              <dt>No utilizable</dt>
              <dd className={new D(data.ineligibleQuantity).gt(0) ? "text-negative" : undefined}>
                {formatQuantity(data.ineligibleQuantity, unit)}
              </dd>
            </div>
            <div>
              <dt>Comprometido con pedidos</dt>
              <dd>{formatQuantity(data.committedQuantity, unit)}</dd>
            </div>
            <div>
              <dt>Disponible para pedidos nuevos</dt>
              <dd>
                <strong>{formatQuantity(data.availableQuantity, unit)}</strong>
              </dd>
            </div>
          </dl>
          {data.reasons.length > 0 && (
            <ul className="muted">
              {data.reasons.map((r) => (
                <li key={r.reason}>{r.label}</li>
              ))}
            </ul>
          )}
          <p className="muted small">
            Utilizable por estado: <StateBreakdown byState={data.eligibleByState} unit={unit} />
            {new D(data.shelfLifeUnknownQuantity).gt(0) &&
              ` · ${formatQuantity(data.shelfLifeUnknownQuantity, unit)} sin vida útil configurada (se cuentan como utilizables)`}
          </p>
          {data.lots.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Orden de uso</th>
                    <th scope="col">Lote</th>
                    <th scope="col">Conservación</th>
                    <th scope="col" className="num">
                      Cantidad
                    </th>
                    <th scope="col" className="num hide-sm">
                      Comprometido
                    </th>
                    <th scope="col">Ese día</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.lots]
                    .sort((a, b) => a.fefoRank - b.fefoRank)
                    .map((l) => (
                      <tr key={l.id}>
                        <td>{l.eligible ? l.fefoRank : "—"}</td>
                        <td>
                          <Link href={`${LOTS_BASE}/${l.id}`}>{l.code}</Link>
                        </td>
                        <td>{CONSERVATION_STATE_LABELS[l.conservationState]}</td>
                        <td className="num">{formatQuantity(l.quantity, unit)}</td>
                        <td className="num hide-sm">
                          {new D(l.committed).isZero() ? "—" : formatQuantity(l.committed, unit)}
                        </td>
                        <td>
                          {l.eligible ? (
                            "Utilizable"
                          ) : (
                            <span className="text-negative">
                              {LOT_INELIGIBILITY_LABELS[l.reason!]}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------- Detalle del lote ---------- */

/** Pedidos que reservan este lote (Fase 5A). Sin orders.read sólo se ven los totales. */
function LotReservations({ lot, tz }: { lot: ProductLotDetailDto; tz: string }) {
  const { reservations } = lot.commitment;
  if (reservations === null || reservations.length === 0) return null;
  const unit = lot.unit.symbol;
  return (
    <section className="panel" aria-labelledby="reservations-title">
      <h2 id="reservations-title">Reservado para pedidos</h2>
      <p className="muted small">
        Lo reservado sigue en el lote: no se puede transformar ni usar para otro pedido.
      </p>
      <div className="table-wrap">
        <table className="table" aria-label="Pedidos que reservan el lote">
          <thead>
            <tr>
              <th scope="col">Pedido</th>
              <th scope="col" className="hide-sm">
                Cliente
              </th>
              <th scope="col">Entrega</th>
              <th scope="col" className="num">
                Reservado
              </th>
            </tr>
          </thead>
          <tbody>
            {reservations.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/pedidos/${r.order.id}`}>{r.order.code}</Link>
                </td>
                <td className="hide-sm">{r.customer ?? "—"}</td>
                <td>{formatDateTime(r.order.requestedAt, tz)}</td>
                <td className="num">{formatQuantity(r.quantity, unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function LotDetail({ id }: { id: string }) {
  const user = useCurrentUser();
  const can = useCan();
  const { data, error, reload } = useResource<ProductLotDetailDto>(`/api/product-lots/${id}`);
  const [reason, setReason] = useState("");
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const tz = user.company.timezone;
  const currency = user.company.currencyCode;
  const unit = data.unit.symbol;
  const operable = data.status === "AVAILABLE" || data.status === "NEAR_EXPIRY";
  const freeze = data.transformOptions.find((o) => o.targetState === "FROZEN");
  const thaw = data.transformOptions.find((o) => o.targetState === "THAWED");
  const columns = movementColumns(tz, currency, data.canSeeCosts, false);
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: `${PRODUCT_STOCK_BASE}/${data.product.id}`, label: data.product.name }}
        title={
          <>
            Lote {data.code} <ConservationBadge state={data.conservationState} />{" "}
            <LotStatusBadge status={data.status} />
          </>
        }
        subtitle={
          <>
            {data.product.name} · {formatQuantity(data.quantity, unit)} en {data.warehouse.name}
          </>
        }
        actions={
          <>
            {can(P.PRODUCT_LOTS_TRANSFORM) && freeze?.allowed && (
              <Link className="button" href={`${LOTS_BASE}/${id}/congelar`}>
                Congelar
              </Link>
            )}
            {can(P.PRODUCT_LOTS_TRANSFORM) && thaw?.allowed && (
              <Link className="button" href={`${LOTS_BASE}/${id}/descongelar`}>
                Descongelar
              </Link>
            )}
            {can(P.PRODUCT_LOTS_WASTE) && data.status !== "DEPLETED" && (
              <Link className="button" href={`${LOTS_BASE}/${id}/merma`}>
                Registrar merma
              </Link>
            )}
            {can(P.PRODUCT_LOTS_QUALITY) &&
              data.status !== "DEPLETED" &&
              (data.qualityStatus === "AVAILABLE" ? (
                <ConfirmAction
                  label="Bloquear"
                  title={`Bloquear el lote ${data.code}`}
                  message={
                    new D(data.commitment.committedQuantity).gt(0)
                      ? `Un lote bloqueado no se cuenta como disponible ni se puede congelar o descongelar. Sí admite merma. Tiene ${formatQuantity(data.commitment.committedQuantity, unit)} reservados: esas reservas se invalidan y los pedidos quedan para recalcular cobertura.`
                      : "Un lote bloqueado no se cuenta como disponible ni se puede congelar o descongelar. Sí admite merma."
                  }
                  confirmLabel="Bloquear lote"
                  danger
                  onConfirm={async () => {
                    await apiFetch(`/api/product-lots/${id}/block`, {
                      method: "POST",
                      body: { reason },
                    });
                    reload();
                  }}
                >
                  <div className="form__field">
                    <label htmlFor="block-reason">Motivo</label>
                    <input
                      id="block-reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </div>
                </ConfirmAction>
              ) : (
                <ConfirmAction
                  label="Desbloquear"
                  title={`Desbloquear el lote ${data.code}`}
                  message="El lote vuelve a contarse como disponible si no está vencido."
                  confirmLabel="Desbloquear lote"
                  onConfirm={async () => {
                    await apiFetch(`/api/product-lots/${id}/unblock`, { method: "POST" });
                    reload();
                  }}
                />
              ))}
          </>
        }
      />

      {data.qualityStatus === "BLOCKED" && (
        <p className="alert" role="status">
          Bloqueado por calidad: {data.qualityReason}
        </p>
      )}
      {data.status === "EXPIRED" && (
        <p className="alert" role="status">
          Este lote venció el {formatDateTime(data.usableUntil!, tz)}. No se cuenta como disponible
          ni se puede transformar; podés registrarlo como merma.
        </p>
      )}

      <section className="panel" aria-labelledby="lot-title">
        <h2 id="lot-title">Datos del lote</h2>
        <dl className="cost-summary">
          <div>
            <dt>Cantidad actual</dt>
            <dd>{formatQuantity(data.quantity, unit)}</dd>
          </div>
          <div>
            <dt>Comprometido con pedidos</dt>
            <dd>{formatQuantity(data.commitment.committedQuantity, unit)}</dd>
          </div>
          <div>
            <dt>Libre</dt>
            <dd>
              <strong>{formatQuantity(data.commitment.freeQuantity, unit)}</strong>
            </dd>
          </div>
          <div>
            <dt>Cantidad inicial</dt>
            <dd>{formatQuantity(data.initialQuantity, unit)}</dd>
          </div>
          <div>
            <dt>Utilizable hasta</dt>
            <dd>
              {data.usableUntil ? formatDateTime(data.usableUntil, tz) : "Sin vencimiento"}
              {data.status !== "DEPLETED" && (
                <span className="cost-summary__note">
                  {" "}
                  · {formatRemaining(data.minutesRemaining)}
                </span>
              )}
            </dd>
          </div>
          {data.canSeeCosts && (
            <div>
              <dt>Valor del lote</dt>
              <dd>
                {formatMoney(data.value, currency)}
                <span className="cost-summary__note">
                  {" "}
                  a {formatReferenceCost(data.unitMaterialCost, currency, unit)}
                </span>
              </dd>
            </div>
          )}
        </dl>
        <Details
          items={[
            [
              "Producción",
              can(P.PRODUCTION_ORDERS_READ) ? (
                <Link href={`/produccion/${data.productionOrder.id}`}>
                  {data.productionOrder.code}
                </Link>
              ) : (
                data.productionOrder.code
              ),
            ],
            [
              "Lote de origen",
              data.parentLot ? (
                <Link href={`${LOTS_BASE}/${data.parentLot.id}`}>{data.parentLot.code}</Link>
              ) : null,
            ],
            ["Producido", formatDateTime(data.producedAt, tz)],
            [
              `${CONSERVATION_STATE_LABELS[data.conservationState]} desde`,
              formatDateTime(data.stateChangedAt, tz),
            ],
            ["Vida útil del estado", formatShelfLife(data.shelfLifeMinutes)],
            ["Depósito", data.warehouse.name],
            ["Creado por", data.createdBy?.displayName],
            ["Notas", data.notes],
          ]}
        />
        {!operable && data.status !== "DEPLETED" && (freeze || thaw) && (
          <p className="muted small">
            {[freeze, thaw]
              .filter((o) => o && !o.allowed && o.reason)
              .map((o) => o!.reason)
              .join(" ")}
          </p>
        )}
        {data.conservationState === "THAWED" && (
          <p className="muted small">Un lote descongelado no puede volver a congelarse.</p>
        )}
      </section>

      <LotReservations lot={data} tz={tz} />

      {data.children.length > 0 && (
        <section className="panel" aria-labelledby="children-title">
          <h2 id="children-title">Lotes derivados</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Lote</th>
                  <th scope="col">Conservación</th>
                  <th scope="col" className="num">
                    Inicial
                  </th>
                  <th scope="col" className="num">
                    Actual
                  </th>
                  <th scope="col" className="hide-sm">
                    Fecha
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.children.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`${LOTS_BASE}/${c.id}`}>{c.code}</Link>
                    </td>
                    <td>{CONSERVATION_STATE_LABELS[c.conservationState]}</td>
                    <td className="num">{formatQuantity(c.initialQuantity, unit)}</td>
                    <td className="num">{formatQuantity(c.quantity, unit)}</td>
                    <td className="hide-sm">{formatDateTime(c.createdAt, tz)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel" aria-labelledby="lot-movements-title">
        <h2 id="lot-movements-title">Movimientos del lote</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.header} scope="col" className={c.className}>
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.movements.map((m) => (
                <tr key={m.id}>
                  {columns.map((c) => (
                    <td key={c.header} className={c.className}>
                      {c.cell(m)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {data.audit.length > 0 && (
        <section className="panel" aria-labelledby="lot-history-title">
          <h2 id="lot-history-title">Historial</h2>
          <ul className="timeline">
            {data.audit.map((a) => (
              <li key={a.id}>
                <strong>
                  {AUDIT_ACTION_LABELS[a.action as keyof typeof AUDIT_ACTION_LABELS] ?? a.action}
                </strong>{" "}
                <span className="muted">
                  {formatDateTime(a.createdAt, tz)}
                  {a.actor ? ` · ${a.actor.displayName}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ---------- Congelar, descongelar y merma ---------- */

export type LotOperationKind = "freeze" | "thaw" | "waste";

const OPERATION_COPY: Record<LotOperationKind, { title: string; confirm: string; verb: string }> = {
  freeze: { title: "Congelar", confirm: "Confirmar congelado", verb: "congelar" },
  thaw: { title: "Descongelar", confirm: "Confirmar descongelado", verb: "descongelar" },
  waste: { title: "Registrar merma", confirm: "Confirmar merma", verb: "descartar" },
};

export function LotOperationForm({ id, kind }: { id: string; kind: LotOperationKind }) {
  const { data, error } = useResource<ProductLotDetailDto>(`/api/product-lots/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  return <LotOperationEditor lot={data} kind={kind} />;
}

function LotOperationEditor({ lot, kind }: { lot: ProductLotDetailDto; kind: LotOperationKind }) {
  const router = useRouter();
  const user = useCurrentUser();
  const copy = OPERATION_COPY[kind];
  // Un id por intento de operación: reintentar (doble click, red) no duplica.
  const [operationId] = useState(() => crypto.randomUUID());
  // "Ahora" fijo al abrir el formulario: el vencimiento del lote nuevo se calcula desde acá.
  const [openedAt] = useState(() => Date.now());
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState<ProductWasteReasonDto | "">(
    lot.status === "EXPIRED" ? "EXPIRED" : "",
  );
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const tz = user.company.timezone;
  const currency = user.company.currencyCode;
  const unit = lot.unit.symbol;
  const lotHref = `${LOTS_BASE}/${lot.id}`;
  const target = kind === "freeze" ? "FROZEN" : kind === "thaw" ? "THAWED" : null;
  const option = target ? lot.transformOptions.find((o) => o.targetState === target) : null;
  const blockedReason =
    target && !option?.allowed
      ? (option?.reason ?? `Este lote no se puede ${copy.verb}.`)
      : lot.status === "DEPLETED"
        ? "El lote está agotado."
        : null;

  // Lo reservado por pedidos no se transforma (LOT_QUANTITY_COMMITTED); la merma sí
  // puede tocarlo, e invalida esas reservas.
  const committed = new D(lot.commitment.committedQuantity);
  const available = target ? new D(lot.commitment.freeQuantity) : new D(lot.quantity);
  const qty = isPositive(quantity) ? parseDecimal(quantity) : null;
  const after = qty ? available.minus(qty) : null;
  const tooMuch = after?.lt(0) ?? false;
  const touchesReservations =
    kind === "waste" && !!qty && committed.gt(0) && qty.gt(new D(lot.commitment.freeQuantity));
  const ready = !!qty && !tooMuch && (kind !== "waste" || !!reason) && !blockedReason;
  const newUsableUntil =
    option?.shelfLifeMinutes !== null && option?.shelfLifeMinutes !== undefined
      ? new Date(openedAt + option.shelfLifeMinutes * 60_000).toISOString()
      : null;
  const value =
    lot.canSeeCosts && qty && lot.unitMaterialCost
      ? (qty.eq(lot.quantity) ? new D(lot.value!) : qty.times(lot.unitMaterialCost)).toString()
      : null;

  async function confirm() {
    setPending(true);
    setFormError(null);
    try {
      const result = await apiFetch<LotOperationResultDto>(
        `/api/product-lots/${lot.id}/${kind === "waste" ? "waste" : "transform"}`,
        {
          method: "POST",
          body:
            kind === "waste"
              ? { quantity: toDecimal(quantity), reason, operationId, notes: notes || null }
              : {
                  targetState: target,
                  quantity: toDecimal(quantity),
                  operationId,
                  notes: notes || null,
                },
        },
      );
      router.push(result.childLot ? `${LOTS_BASE}/${result.childLot.id}` : lotHref);
      router.refresh();
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? err.code === "INSUFFICIENT_LOT_QUANTITY"
            ? "El lote ya no tiene esa cantidad (otra operación lo usó). Revisá el saldo."
            : (Object.values(err.fieldErrors)[0] ?? err.message)
          : "No se pudo registrar la operación.",
      );
      setStep("edit");
      setPending(false);
    }
  }

  const summary = (
    <dl className="cost-summary impact">
      <div>
        <dt>Lote {lot.code} antes</dt>
        <dd>{formatQuantity(lot.quantity, unit)}</dd>
      </div>
      <div>
        <dt>{kind === "waste" ? "Merma" : copy.title}</dt>
        <dd className="text-negative">{qty ? `−${formatQuantity(qty.toString(), unit)}` : "—"}</dd>
      </div>
      <div>
        <dt>Lote {lot.code} después</dt>
        <dd className={tooMuch ? "text-negative" : undefined}>
          {qty ? formatQuantity(new D(lot.quantity).minus(qty).toString(), unit) : "—"}
        </dd>
      </div>
      {target && (
        <div>
          <dt>Lote nuevo ({CONSERVATION_STATE_LABELS[target]})</dt>
          <dd className="text-positive">
            {qty ? `+${formatQuantity(qty.toString(), unit)}` : "—"}
            {newUsableUntil && (
              <span className="cost-summary__note">
                {" "}
                · utilizable hasta {formatDateTime(newUsableUntil, tz)} (
                {formatShelfLife(option!.shelfLifeMinutes)})
              </span>
            )}
          </dd>
        </div>
      )}
      {touchesReservations && (
        <div>
          <dt>Pedidos afectados</dt>
          <dd className="text-negative">
            La merma toca stock reservado: esas reservas se invalidan y los pedidos quedan para
            recalcular cobertura.
          </dd>
        </div>
      )}
    </dl>
  );

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: lotHref, label: `Lote ${lot.code}` }}
        title={`${copy.title}: ${lot.product.name}`}
        subtitle={
          <>
            Lote {lot.code} · {CONSERVATION_STATE_LABELS[lot.conservationState]} ·{" "}
            {formatQuantity(lot.quantity, unit)} disponibles en {lot.warehouse.name}
          </>
        }
      />
      {formError && (
        <p className="alert" role="alert">
          {formError}
        </p>
      )}
      {blockedReason ? (
        <section className="panel">
          <p className="alert" role="status">
            {blockedReason}
          </p>
          <Link className="button" href={lotHref}>
            Volver al lote
          </Link>
        </section>
      ) : step === "edit" ? (
        <form
          className="form"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (ready) setStep("review");
          }}
        >
          <section className={kind === "waste" ? "panel panel--waste" : "panel"}>
            {kind === "thaw" && (
              <p className="alert alert--warn" role="note">
                Lo que se descongela no se puede volver a congelar. Dura{" "}
                {formatShelfLife(option?.shelfLifeMinutes ?? null)} desde ahora.
              </p>
            )}
            {kind === "freeze" && (
              <p className="muted">
                Se crea un lote congelado nuevo, con su propio vencimiento. El stock total, su valor
                y el costo promedio no cambian.
              </p>
            )}
            {kind === "waste" && (
              <p className="muted">
                Sale del stock al costo del lote. El costo promedio del producto no cambia.
              </p>
            )}
            <div className="form-grid">
              <div className="form__field">
                <label htmlFor="quantity">
                  Cantidad a {copy.verb} ({unit})
                </label>
                <input
                  id="quantity"
                  inputMode="decimal"
                  autoComplete="off"
                  value={quantity}
                  aria-invalid={(quantity && !qty) || tooMuch ? true : undefined}
                  onChange={(e) => setQuantity(e.target.value)}
                />
                <span className="form__hint">
                  {target ? "Libre" : "Disponible"}: {formatQuantity(available.toString(), unit)}
                  {committed.gt(0) &&
                    ` (${formatQuantity(lot.commitment.committedQuantity, unit)} reservados para pedidos${target ? ", no se pueden " + copy.verb : ""})`}
                  .{" "}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setQuantity(available.toString())}
                  >
                    Usar todo
                  </button>
                </span>
              </div>
              {kind === "waste" && (
                <div className="form__field">
                  <label htmlFor="reason">Motivo</label>
                  <select
                    id="reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value as ProductWasteReasonDto)}
                  >
                    <option value="">Elegí un motivo</option>
                    {PRODUCT_WASTE_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {PRODUCT_WASTE_REASON_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="form__field form__field--full" style={{ marginTop: "1rem" }}>
              <label htmlFor="notes">Observación</label>
              <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </section>
          <section className="panel" aria-labelledby="impact-title" aria-live="polite">
            <h2 id="impact-title">Resumen</h2>
            {summary}
            {tooMuch && (
              <p className="form__error" role="alert">
                El lote no tiene esa cantidad.
              </p>
            )}
            <div className="form__footer">
              <button type="submit" className="button button--primary" disabled={!ready}>
                Revisar
              </button>
              <Link className="button" href={lotHref}>
                Cancelar
              </Link>
            </div>
          </section>
        </form>
      ) : (
        <section
          className={kind === "waste" ? "panel panel--waste" : "panel"}
          aria-labelledby="review-title"
          aria-live="polite"
        >
          <h2 id="review-title">
            {copy.title} {qty ? formatQuantity(qty.toString(), unit) : ""} del lote {lot.code}
          </h2>
          {summary}
          {kind === "waste" && reason && (
            <p className="muted">
              Motivo: {PRODUCT_WASTE_REASON_LABELS[reason]}
              {value ? ` · valor ${formatMoney(value, currency)}` : ""}
            </p>
          )}
          {kind === "thaw" && (
            <p className="alert alert--warn" role="note">
              Lo descongelado no se puede volver a congelar.
            </p>
          )}
          <p className="muted small">Se registra como movimiento del lote y no se puede editar.</p>
          <div className="form__footer">
            <button
              type="button"
              className={`button ${kind === "waste" ? "button--danger" : "button--primary"}`}
              disabled={pending}
              onClick={confirm}
            >
              {pending ? "Registrando…" : copy.confirm}
            </button>
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => setStep("edit")}
            >
              Volver a editar
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

/* ---------- Próximos a vencer ---------- */

export function ExpiringList() {
  const user = useCurrentUser();
  const warehouses = useWarehouseOptions();
  const tz = user.company.timezone;
  return (
    <MasterList<ExpiringLotDto>
      title="Próximos a vencer"
      subtitle="Lotes vencidos o que vencen pronto, primero el que vence antes. El aviso usa el umbral configurado en cada producto."
      endpoint="/api/inventory/expiring"
      basePath={LOTS_BASE}
      searchPlaceholder="Buscar producto o lote"
      emptyText="No hay lotes vencidos ni próximos a vencer."
      statusOptions={[
        { value: "all", label: "Vencidos y próximos" },
        { value: "near_expiry", label: "Sólo próximos a vencer" },
        { value: "expired", label: "Sólo vencidos" },
      ]}
      defaultStatus="all"
      extraFilters={[
        {
          name: "withinHours",
          label: "Ventana",
          allLabel: "Según cada producto",
          options: [
            { value: "24", label: "Próximas 24 horas" },
            { value: "72", label: "Próximos 3 días" },
            { value: "168", label: "Próxima semana" },
          ],
        },
        {
          name: "warehouseId",
          label: "Depósito",
          allLabel: "Todos los depósitos",
          options: warehouses,
        },
      ]}
      headerExtra={
        <div className="toolbar">
          <StockTabs />
        </div>
      }
      columns={[
        {
          header: "Lote",
          cell: (l) => (
            <>
              <Link href={`${LOTS_BASE}/${l.id}`}>{l.code}</Link>
              <span className="cost-source">{l.product.name}</span>
            </>
          ),
        },
        {
          header: "Conservación",
          cell: (l) => <ConservationBadge state={l.conservationState} />,
        },
        {
          header: "Cantidad",
          cell: (l) => formatQuantity(l.quantity, l.unit.symbol),
          className: "num",
        },
        {
          header: "Utilizable hasta",
          cell: (l) => (
            <>
              {l.usableUntil ? formatDateTime(l.usableUntil, tz) : "—"}
              <span className="cost-source">{formatRemaining(l.minutesRemaining)}</span>
            </>
          ),
        },
        { header: "Estado", cell: (l) => <LotStatusBadge status={l.status} /> },
        { header: "Depósito", cell: (l) => l.warehouse.name, className: "hide-sm" },
        { header: "Acciones", cell: (l) => <LotActions lot={l} /> },
      ]}
    />
  );
}
