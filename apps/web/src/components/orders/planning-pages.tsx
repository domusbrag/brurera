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
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { listPath } from "@/lib/api-client";
import { formatDateTime, formatQuantity } from "@/lib/format";
import { ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { useCan, useCurrentUser } from "../user-context";
import {
  CoverageBadge,
  NEEDS_BASE,
  ORDERS_BASE,
  OrderStatusBadge,
  WallClockInput,
  formatWallClock,
  isCompleteWallClock,
} from "./order-shared";

/*
 * Planificación → Necesidades (Fase 5A): qué hay que producir y qué materia
 * prima hace falta para los pedidos confirmados, con horizonte de fecha
 * (hora de pared de la empresa). Todo es lectura: nada reserva ni mueve stock.
 */

const TABS = [
  { href: NEEDS_BASE, label: "Producción" },
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
  const query = params.toString();
  return (
    <div className="page">
      <PageHeader
        title="Necesidades"
        subtitle="Lo que piden los pedidos confirmados y todavía no está cubierto con stock reservado."
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
      <section className="panel">
        <div className="filters">
          <label className="filters__date" htmlFor="horizon">
            <span>Entregas hasta</span>
          </label>
          <WallClockInput id="horizon" value={draft} timeZone={tz} onChange={setDraft} />
          <button
            type="button"
            className="button button--small"
            disabled={draft !== "" && !isCompleteWallClock(draft)}
            onClick={() => set({ hasta: draft || null })}
          >
            Aplicar horizonte
          </button>
          {until && (
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                setDraft("");
                set({ hasta: null });
              }}
            >
              Sin horizonte
            </button>
          )}
          {isMaterials && (
            <label className="inline-check">
              <input
                type="checkbox"
                checked={shortageOnly}
                onChange={(e) => set({ faltantes: e.target.checked ? "1" : null })}
              />{" "}
              Sólo con faltante
            </label>
          )}
        </div>
        <p className="muted small">
          {until
            ? `Pedidos con entrega hasta el ${formatWallClock(until)}.`
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
      Se muestran {page.items.length} de {page.total}. Acotá el horizonte para ver el resto.
    </p>
  ) : null;
}

/* ---------- Producción ---------- */

export function ProductionNeeds() {
  return <PlanningShell>{(until) => <ProductionNeedsTable until={until} />}</PlanningShell>;
}

function ProductionNeedsTable({ until }: { until: string | undefined }) {
  const can = useCan();
  const tz = useCurrentUser().company.timezone;
  const { data, error } = usePage<ProductionNeedDto>("/api/planning/production-needs", until, {});
  const canCreate = can(P.ORDER_PRODUCTION_CREATE) && can(P.PRODUCTION_ORDERS_CREATE);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  if (data.items.length === 0)
    return <p className="muted">No hay nada para producir: los pedidos están cubiertos.</p>;
  return (
    <>
      <div className="table-wrap">
        <table className="table" aria-label="Producción necesaria">
          <thead>
            <tr>
              <th scope="col">Producto</th>
              <th scope="col" className="num">
                A producir
              </th>
              <th scope="col">Primera entrega</th>
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
                <td>{formatDateTime(n.earliestRequestedAt, tz)}</td>
                <td>
                  <ul className="plain-list">
                    {n.orders.map((o) => (
                      <li key={o.requirementId}>
                        <Link href={`${ORDERS_BASE}/${o.orderId}`}>{o.orderCode}</Link>:{" "}
                        {formatQuantity(o.quantity, n.unit.symbol)} ·{" "}
                        {o.problem
                          ? REQUIREMENT_PROBLEM_LABELS[o.problem]
                          : REQUIREMENT_STATUS_LABELS[o.status]}
                        {o.productionOrder && (
                          <>
                            {" "}
                            <Link href={`/produccion/${o.productionOrder.id}`}>
                              {o.productionOrder.code}
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
        Cada pedido genera su propia orden de producción; todavía no se consolidan varios pedidos en
        una sola orden.
      </p>
    </>
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
  const { data, error } = usePage<MaterialDemandDto>("/api/planning/material-demand", until, extra);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  if (data.items.length === 0)
    return (
      <p className="muted">
        {extra.shortageOnly
          ? "No falta materia prima para los pedidos."
          : "Los pedidos no necesitan materia prima: no hay nada para producir."}
      </p>
    );
  return (
    <>
      <div className="table-wrap">
        <table className="table" aria-label="Materia prima necesaria">
          <thead>
            <tr>
              <th scope="col">Materia prima</th>
              <th scope="col" className="num">
                Stock actual
              </th>
              <th scope="col" className="num">
                Necesitan los pedidos
              </th>
              <th scope="col" className="num hide-sm">
                Queda
              </th>
              <th scope="col" className="num">
                Faltante
              </th>
              <th scope="col" className="hide-md">
                Proveedor sugerido
              </th>
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
                  <td className="num">{formatQuantity(m.currentStock, u)}</td>
                  <td className="num">{formatQuantity(m.openOrderDemand, u)}</td>
                  <td className="num hide-sm">{formatQuantity(m.availableAfterDemand, u)}</td>
                  <td className={`num ${gt0(m.shortage) ? "text-negative" : ""}`}>
                    {gt0(m.shortage) ? <strong>{formatQuantity(m.shortage, u)}</strong> : "—"}
                  </td>
                  <td className="hide-md">{m.preferredSupplier?.name ?? "—"}</td>
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
        Proyección: la materia prima no se reserva. El stock es el total de la empresa.
      </p>
    </>
  );
}

/* ---------- Pedidos en riesgo ---------- */

export function OrdersAtRisk() {
  return <PlanningShell>{(until) => <OrdersAtRiskTable until={until} />}</PlanningShell>;
}

function OrdersAtRiskTable({ until }: { until: string | undefined }) {
  const { data, error } = usePage<OrderRiskDto>("/api/planning/orders-at-risk", until, {});
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  if (data.items.length === 0)
    return <p className="muted">Ningún pedido en riesgo: todos están cubiertos.</p>;
  return (
    <>
      <div className="table-wrap">
        <table className="table" aria-label="Pedidos en riesgo">
          <thead>
            <tr>
              <th scope="col">Pedido</th>
              <th scope="col">Entrega</th>
              <th scope="col" className="hide-sm">
                Cliente
              </th>
              <th scope="col">Cobertura</th>
              <th scope="col">Problemas</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.order.id}>
                <td>
                  <Link href={`${ORDERS_BASE}/${r.order.id}`} className="code">
                    {r.order.code}
                  </Link>{" "}
                  <OrderStatusBadge status={r.order.status} />
                  {r.order.priority !== "NORMAL" && (
                    <span className="badge badge--warn">
                      {" "}
                      {ORDER_PRIORITY_LABELS[r.order.priority]}
                    </span>
                  )}
                </td>
                <td>{formatWallClock(r.order.requestedAtLocal)}</td>
                <td className="hide-sm">{r.customer}</td>
                <td>
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
    </>
  );
}
