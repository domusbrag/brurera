"use client";

import {
  ORDER_PRIORITY_LABELS,
  PERMISSIONS as P,
  REQUIREMENT_PROBLEM_LABELS,
  REQUIREMENT_STATUS_LABELS,
  type MaterialDemandDto,
  type OrderRiskDto,
  type Page,
  type ProductionNeedDto,
  type RequirementStatusDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { listPath } from "@/lib/api-client";
import { formatDateTime, formatQuantity } from "@/lib/format";
import type { Tone } from "@/lib/status";
import { EmptyState, ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { StatusBadge } from "../ui/status";
import { useCan, useCurrentUser } from "../user-context";
import {
  CoverageBadge,
  NEEDS_BASE,
  ORDERS_BASE,
  OrderStatusBadge,
  WallClockInput,
  formatWallClock,
  isCompleteWallClock,
  wallClockIn,
} from "./order-shared";

/*
 * Planificación → Necesidades: qué falta producir y qué materia prima hace
 * falta para los pedidos confirmados, con horizonte de fecha (hora de pared de
 * la empresa; atajos Hoy / Mañana / 7 días). Todo es lectura: nada reserva ni
 * mueve stock. La acción de cada fila es crear la orden de producción.
 */

const TABS = [
  { href: NEEDS_BASE, label: "Falta producir" },
  { href: `${NEEDS_BASE}/materias-primas`, label: "Materias primas" },
  { href: `${NEEDS_BASE}/en-riesgo`, label: "Pedidos en riesgo" },
];

const gt0 = (v: string) => new D(v).gt(0);

function PlanningShell({
  children,
}: {
  children: (until: string | undefined, extra: Record<string, string>) => ReactNode;
}) {
  return (
    <Suspense fallback={<Loading />}>
      <PlanningShellInner>{children}</PlanningShellInner>
    </Suspense>
  );
}

function PlanningShellInner({
  children,
}: {
  children: (until: string | undefined, extra: Record<string, string>) => ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const tz = useCurrentUser().company.timezone;
  const until = params.get("hasta") ?? "";
  const shortageOnly = params.get("faltantes") === "1";
  const [draft, setDraft] = useState(until);
  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const isMaterials = pathname === `${NEEDS_BASE}/materias-primas`;
  const endOfDay = (days: number) => `${wallClockIn(tz, days).slice(0, 10)}T23:59`;
  const quick = [
    { label: "Hoy", value: endOfDay(0) },
    { label: "Hasta mañana", value: endOfDay(1) },
    { label: "Próximos 7 días", value: endOfDay(7) },
    { label: "Sin límite", value: "" },
  ];
  const query = params.toString();
  return (
    <div className="page">
      <PageHeader
        title="Necesidades"
        subtitle="Lo que piden los pedidos confirmados y no está cubierto con el stock reservado: qué falta producir, qué materia prima hace falta y qué pedidos están en riesgo."
      />
      <nav className="tabs" aria-label="Necesidades">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={query ? `${t.href}?${query}` : t.href}
            className={`tabs__link ${pathname === t.href ? "tabs__link--active" : ""}`}
            aria-current={pathname === t.href ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <section className="panel" aria-label="Horizonte">
        <div className="filters">
          <div className="actions" role="group" aria-label="Atajos de fecha de entrega">
            {quick.map((q) => (
              <button
                key={q.label}
                type="button"
                className={`button button--small ${until === q.value ? "button--primary" : "button--tertiary"}`}
                aria-pressed={until === q.value}
                onClick={() => {
                  setDraft(q.value);
                  set({ hasta: q.value || null });
                }}
              >
                {q.label}
              </button>
            ))}
          </div>
          <label className="filters__date" htmlFor="horizon">
            <span>Entregas hasta</span>
          </label>
          <WallClockInput id="horizon" value={draft} timeZone={tz} onChange={setDraft} />
          <button
            type="button"
            className="button button--small"
            disabled={draft === until || (draft !== "" && !isCompleteWallClock(draft))}
            onClick={() => set({ hasta: draft || null })}
          >
            Aplicar
          </button>
          {isMaterials && (
            <label className="inline-check">
              <input
                type="checkbox"
                checked={shortageOnly}
                onChange={(e) => set({ faltantes: e.target.checked ? "1" : null })}
              />{" "}
              Sólo lo que falta comprar
            </label>
          )}
        </div>
        <p className="muted small" role="status">
          {until
            ? `Pedidos confirmados con entrega hasta el ${formatWallClock(until)}.`
            : "Todos los pedidos confirmados, sin límite de fecha."}
        </p>
        {children(until || undefined, isMaterials && shortageOnly ? { shortageOnly: "true" } : {})}
      </section>
    </div>
  );
}

function usePage<T>(endpoint: string, until: string | undefined, extra: Record<string, string>) {
  return useResource<Page<T>>(listPath(endpoint, { until, pageSize: 100, ...extra }));
}

function More({ page }: { page: Page<unknown> }) {
  return page.total > page.items.length ? (
    <p className="muted small">
      Se muestran {page.items.length} de {page.total}. Acotá la fecha de entrega para ver el resto.
    </p>
  ) : null;
}

/** Mientras llega el resultado de otro horizonte, la tabla anterior se marca como desactualizada. */
function Stale({ stale, children }: { stale: boolean; children: ReactNode }) {
  return (
    <div aria-busy={stale || undefined} style={stale ? { opacity: 0.55 } : undefined}>
      {stale && (
        <p className="muted small" role="status">
          Actualizando…
        </p>
      )}
      {children}
    </div>
  );
}

const horizonText = (until: string | undefined) =>
  until ? ` con entrega hasta el ${formatWallClock(until)}` : "";

const REQUIREMENT_TONE: Record<RequirementStatusDto, Tone> = {
  OPEN: "warning",
  PRODUCTION_CREATED: "info",
  SATISFIED: "success",
  CANCELLED: "neutral",
};

/* ---------- Falta producir ---------- */

export function ProductionNeeds() {
  return <PlanningShell>{(until) => <ProductionNeedsTable until={until} />}</PlanningShell>;
}

function ProductionNeedsTable({ until }: { until: string | undefined }) {
  const can = useCan();
  const tz = useCurrentUser().company.timezone;
  const { data, error, stale } = usePage<ProductionNeedDto>(
    "/api/planning/production-needs",
    until,
    {},
  );
  const canCreate = can(P.ORDER_PRODUCTION_CREATE) && can(P.PRODUCTION_ORDERS_CREATE);
  const canSeeProduction = can(P.PRODUCTION_ORDERS_READ);
  const canSeeRecipes = can(P.RECIPES_READ);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading label="Calculando qué falta producir…" />;
  if (data.items.length === 0)
    return (
      <Stale stale={stale}>
        <EmptyState
          compact
          title="No falta producir nada"
          description={`Los pedidos confirmados${horizonText(until)} están cubiertos con stock reservado.`}
        />
      </Stale>
    );
  return (
    <Stale stale={stale}>
      <div className="table-wrap">
        <table className="table" aria-label="Producción necesaria">
          <thead>
            <tr>
              <th scope="col">Producto</th>
              <th scope="col" className="num">
                Falta producir
              </th>
              <th scope="col" className="hide-md">
                Primera entrega
              </th>
              <th scope="col">Pedidos</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((n) => (
              <tr key={n.product.id}>
                <td>
                  {n.product.name}
                  {gt0(n.withoutRecipe) && (
                    <span className="text-negative small">
                      {" "}
                      · {formatQuantity(n.withoutRecipe, n.unit.symbol)} sin receta
                    </span>
                  )}
                </td>
                <td className="num">
                  <strong>{formatQuantity(n.quantity, n.unit.symbol)}</strong>
                </td>
                <td className="hide-md">{formatDateTime(n.earliestRequestedAt, tz)}</td>
                <td>
                  <ul className="plain-list">
                    {n.orders.map((o) => (
                      <li key={o.requirementId}>
                        <Link href={`${ORDERS_BASE}/${o.orderId}`} className="code">
                          {o.orderCode}
                        </Link>{" "}
                        <span className="muted small">
                          para el {formatDateTime(o.requestedAt, tz)} ·{" "}
                        </span>
                        {formatQuantity(o.quantity, n.unit.symbol)}{" "}
                        {o.problem ? (
                          <StatusBadge tone="danger">
                            {REQUIREMENT_PROBLEM_LABELS[o.problem]}
                          </StatusBadge>
                        ) : (
                          <StatusBadge tone={REQUIREMENT_TONE[o.status]}>
                            {REQUIREMENT_STATUS_LABELS[o.status]}
                          </StatusBadge>
                        )}
                        {o.productionOrder && (
                          <>
                            {" "}
                            {canSeeProduction ? (
                              <Link href={`/produccion/${o.productionOrder.id}`}>
                                {o.productionOrder.code}
                              </Link>
                            ) : (
                              <span className="code">{o.productionOrder.code}</span>
                            )}
                          </>
                        )}
                        {o.problem && canSeeRecipes && (
                          <>
                            {" "}
                            <Link href="/recetas" className="small">
                              Ver recetas
                            </Link>
                          </>
                        )}
                        {o.status === "OPEN" && !o.problem && canCreate && (
                          <>
                            {" "}
                            <Link
                              className="button button--small"
                              href={`/produccion/nueva?requirementId=${o.requirementId}`}
                            >
                              Crear orden
                            </Link>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <More page={data} />
      <p className="muted small">
        Cada pedido genera su propia orden de producción; todavía no se juntan varios pedidos en una
        sola orden.
      </p>
    </Stale>
  );
}

/* ---------- Materias primas ---------- */

export function MaterialNeeds() {
  return (
    <PlanningShell>
      {(until, extra) => <MaterialNeedsTable until={until} extra={extra} />}
    </PlanningShell>
  );
}

function MaterialNeedsTable({
  until,
  extra,
}: {
  until: string | undefined;
  extra: Record<string, string>;
}) {
  const { data, error, stale } = usePage<MaterialDemandDto>(
    "/api/planning/material-demand",
    until,
    extra,
  );
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading label="Calculando la materia prima…" />;
  if (data.items.length === 0)
    return (
      <Stale stale={stale}>
        <EmptyState
          compact
          title={
            extra.shortageOnly ? "No falta comprar materia prima" : "No hace falta materia prima"
          }
          description={
            extra.shortageOnly
              ? `El stock alcanza para los pedidos confirmados${horizonText(until)}.`
              : `No hay nada para producir en los pedidos confirmados${horizonText(until)}.`
          }
        />
      </Stale>
    );
  return (
    <Stale stale={stale}>
      <div className="table-wrap">
        <table className="table" aria-label="Materia prima necesaria">
          <thead>
            <tr>
              <th scope="col">Materia prima</th>
              <th scope="col" className="num hide-md">
                Stock actual
              </th>
              <th scope="col" className="num">
                Comprometido por pedidos
              </th>
              <th scope="col" className="num hide-md">
                Disponible después
              </th>
              <th scope="col" className="num">
                Falta comprar
              </th>
              <th scope="col">Proveedor sugerido</th>
              <th scope="col" className="hide-md">
                Pedidos
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((m) => {
              const u = m.unit.symbol;
              return (
                <tr key={m.rawMaterial.id}>
                  <td>{m.rawMaterial.name}</td>
                  <td className="num hide-md">{formatQuantity(m.currentStock, u)}</td>
                  <td className="num">{formatQuantity(m.openOrderDemand, u)}</td>
                  <td className="num hide-md">{formatQuantity(m.availableAfterDemand, u)}</td>
                  <td className={`num ${gt0(m.shortage) ? "text-negative" : ""}`}>
                    {gt0(m.shortage) ? (
                      <strong>{formatQuantity(m.shortage, u)}</strong>
                    ) : (
                      <span className="muted">No falta</span>
                    )}
                  </td>
                  <td>
                    {m.preferredSupplier?.name ?? <span className="muted">Sin proveedor</span>}
                  </td>
                  <td className="hide-md">
                    {m.orders.map((o, i) => (
                      <span key={o.orderId}>
                        {i > 0 && ", "}
                        <Link href={`${ORDERS_BASE}/${o.orderId}`}>{o.orderCode}</Link>
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <More page={data} />
      <p className="muted small">
        Proyección: la materia prima no se reserva. El stock es el total de la empresa (todos los
        depósitos).
      </p>
    </Stale>
  );
}

/* ---------- Pedidos en riesgo ---------- */

export function OrdersAtRisk() {
  return <PlanningShell>{(until) => <OrdersAtRiskTable until={until} />}</PlanningShell>;
}

function OrdersAtRiskTable({ until }: { until: string | undefined }) {
  const { data, error, stale } = usePage<OrderRiskDto>("/api/planning/orders-at-risk", until, {});
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading label="Buscando pedidos en riesgo…" />;
  if (data.items.length === 0)
    return (
      <Stale stale={stale}>
        <EmptyState
          compact
          title="Ningún pedido en riesgo"
          description={`Los pedidos confirmados${horizonText(until)} están cubiertos.`}
        />
      </Stale>
    );
  return (
    <Stale stale={stale}>
      <div className="table-wrap">
        <table className="table" aria-label="Pedidos en riesgo">
          <thead>
            <tr>
              <th scope="col">Pedido</th>
              <th scope="col">Para cuándo</th>
              <th scope="col" className="hide-md">
                Cliente
              </th>
              <th scope="col">Estado</th>
              <th scope="col">Qué pasa</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.order.id}>
                <td>
                  <Link href={`${ORDERS_BASE}/${r.order.id}`} className="code">
                    {r.order.code}
                  </Link>
                  {r.order.priority !== "NORMAL" && (
                    <>
                      {" "}
                      <StatusBadge tone={r.order.priority === "URGENT" ? "danger" : "warning"}>
                        Prioridad {ORDER_PRIORITY_LABELS[r.order.priority].toLowerCase()}
                      </StatusBadge>
                    </>
                  )}
                </td>
                <td>{formatWallClock(r.order.requestedAtLocal)}</td>
                <td className="hide-md">{r.customer}</td>
                <td>
                  <OrderStatusBadge status={r.order.status} />{" "}
                  <CoverageBadge coverage={r.order.coverageStatus} />
                </td>
                <td>
                  <ul className="plain-list">
                    {r.problems.map((p) => (
                      <li key={`${p.code}-${p.message}`}>{p.message}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <More page={data} />
    </Stale>
  );
}
