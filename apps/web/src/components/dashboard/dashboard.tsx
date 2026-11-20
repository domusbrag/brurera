"use client";

import {
  AUDIT_ACTION_LABELS,
  PERMISSIONS as P,
  formatLocalDateTime,
  instantToZonedLocal,
  type OrderListItemDto,
  type Page,
  type ProductionOrderListItemDto,
} from "@bakery/shared";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api-client";
import { QUICK_ACTIONS } from "@/lib/navigation";
import { formatDateTime, formatMoney } from "@/lib/format";
import { Icon } from "../ui/icons";
import { OrderStatusBadge, CoverageBadge, ORDERS_BASE } from "../orders/order-shared";
import { ProductionStatusBadge } from "../production/production-shared";
import { useCan, useCurrentUser } from "../user-context";
import { companyToday, useDayTotals, useTodayOrders } from "../shell/day-panel";

/*
 * Inicio operativo — «Resumen de jornada» (diseño La Espiga, Tailwind). Arriba
 * el pulso del día en tres tarjetas; después lo que requiere acción, las
 * próximas entregas y la producción. Primero lo que requiere acción hoy (cada tarjeta es un
 * conteo real con enlace al listado ya filtrado), después lo que viene y las
 * acciones rápidas. Todo depende de los permisos: nadie ve conteos ni accesos de
 * módulos que no puede usar, y una tarjeta que no carga no rompe la página.
 */

type Tone = "danger" | "warning" | "ok";

interface AttentionDef {
  key: string;
  /** Permisos necesarios (todos). */
  needs: string[];
  /** Endpoint que devuelve una página; se usa `total`. */
  endpoint: string;
  title: (n: number) => string;
  hint: string;
  href: string;
  /** Tono cuando hay algo (con 0 queda en "ok"). */
  tone: Exclude<Tone, "ok">;
}

/** Saludo según la hora de la empresa. */
function greeting(timeZone: string): string {
  const hour = Number(instantToZonedLocal(new Date(), timeZone).slice(11, 13));
  if (hour >= 5 && hour < 13) return "Buen día";
  if (hour >= 13 && hour < 20) return "Buenas tardes";
  return "Buenas noches";
}

function attentionItems(today: string): AttentionDef[] {
  return [
    {
      key: "orders-today",
      needs: [P.ORDERS_READ],
      endpoint: `/api/orders?status=active&from=${today}&to=${today}&pageSize=1`,
      title: (n) => (n === 1 ? "pedido para entregar hoy" : "pedidos para entregar hoy"),
      hint: "Confirmados o en preparación con entrega en el día.",
      href: `${ORDERS_BASE}?from=${today}&to=${today}`,
      tone: "warning",
    },
    {
      key: "orders-at-risk",
      needs: [P.ORDER_PLANNING_READ],
      endpoint: "/api/planning/orders-at-risk?pageSize=1",
      title: (n) => (n === 1 ? "pedido en riesgo" : "pedidos en riesgo"),
      hint: "Con producto sin cubrir, sin receta o que hay que replanificar.",
      href: "/necesidades/en-riesgo",
      tone: "danger",
    },
    {
      key: "production-open",
      needs: [P.PRODUCTION_ORDERS_READ],
      endpoint: "/api/production-orders?status=open&pageSize=1",
      title: (n) =>
        n === 1 ? "orden de producción sin completar" : "órdenes de producción sin completar",
      hint: "Planificadas o en curso.",
      href: "/produccion?estado=open",
      tone: "warning",
    },
    {
      key: "lots-expired",
      needs: [P.INVENTORY_EXPIRY_READ],
      endpoint: "/api/inventory/expiring?status=expired&pageSize=1",
      title: (n) => (n === 1 ? "lote vencido con stock" : "lotes vencidos con stock"),
      hint: "No se pueden vender: hay que darlos de baja.",
      href: "/stock/productos/por-vencer?estado=expired",
      tone: "danger",
    },
    {
      key: "lots-near-expiry",
      needs: [P.INVENTORY_EXPIRY_READ],
      endpoint: "/api/inventory/expiring?status=near_expiry&pageSize=1",
      title: (n) => (n === 1 ? "lote próximo a vencer" : "lotes próximos a vencer"),
      hint: "Conviene venderlos o usarlos primero.",
      href: "/stock/productos/por-vencer?estado=near_expiry",
      tone: "warning",
    },
    {
      key: "low-stock",
      needs: [P.INVENTORY_READ],
      endpoint: "/api/inventory/low-stock?pageSize=1",
      title: (n) => (n === 1 ? "materia prima bajo el mínimo" : "materias primas bajo el mínimo"),
      hint: "Revisá si hay que comprar.",
      href: "/stock/bajo-minimo",
      tone: "warning",
    },
    {
      key: "purchases-open",
      needs: [P.PURCHASES_READ],
      endpoint: "/api/purchases?status=open&pageSize=1",
      title: (n) => (n === 1 ? "compra pendiente de recibir" : "compras pendientes de recibir"),
      hint: "Pedidas al proveedor o recibidas en parte.",
      href: "/compras?estado=open",
      tone: "warning",
    },
    {
      key: "sales-draft",
      needs: [P.SALES_READ],
      endpoint: "/api/sales?status=DRAFT&pageSize=1",
      title: (n) => (n === 1 ? "venta en borrador" : "ventas en borrador"),
      hint: "Todavía no se entregaron ni descontaron stock.",
      href: "/ventas?estado=DRAFT",
      tone: "warning",
    },
    {
      key: "receivables",
      needs: [P.CUSTOMER_ACCOUNTS_READ],
      endpoint: "/api/customer-accounts?balance=debt&pageSize=1",
      title: (n) => (n === 1 ? "cliente con saldo pendiente" : "clientes con saldo pendiente"),
      hint: "Cuentas corrientes que deben.",
      href: "/cuentas-a-cobrar",
      tone: "warning",
    },
  ];
}

type TotalState = { total: number } | "error" | null;

/** Totales de todas las tarjetas de «Requiere atención», pedidos en paralelo. */
function useTotals(defs: AttentionDef[]): Record<string, TotalState> {
  const [state, setState] = useState<Record<string, TotalState>>({});
  const key = defs.map((d) => d.endpoint).join("|");
  useEffect(() => {
    let cancelled = false;
    for (const def of defs) {
      apiFetch<Page<unknown>>(def.endpoint)
        .then((page) => !cancelled && setState((s) => ({ ...s, [def.key]: { total: page.total } })))
        .catch(() => !cancelled && setState((s) => ({ ...s, [def.key]: "error" })));
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const CARD = "rounded-2xl border border-line bg-surface";
const SERIF_TITLE = "m-0 font-display text-lg font-semibold text-fg";

const TONE_CARD: Record<Tone, string> = {
  danger: "border-danger-line bg-danger-bg/60 hover:border-danger",
  warning: "border-line hover:border-ember/60",
  ok: "border-line hover:border-success-line",
};
const TONE_COUNT: Record<Tone, string> = {
  danger: "text-danger",
  warning: "text-warning",
  ok: "text-success",
};

function AttentionCard({ def, state }: { def: AttentionDef; state: TotalState }) {
  const box = `flex items-start gap-3.5 rounded-2xl border bg-surface p-4`;
  if (state === null)
    return (
      <div className={`${box} border-line`} aria-busy="true">
        <span className="h-8 w-8 animate-pulse rounded-lg bg-surface-hover" aria-hidden="true" />
        <span className="text-sm text-muted">Cargando…</span>
      </div>
    );
  if (state === "error")
    return (
      <div className={`${box} border-line`}>
        <span className="font-display text-3xl leading-none text-subtle" aria-hidden="true">
          –
        </span>
        <span className="text-sm">
          <span className="block font-semibold">No se pudo cargar</span>
          <span className="text-muted">{def.title(2)}</span>
        </span>
      </div>
    );
  const tone: Tone = state.total > 0 ? def.tone : "ok";
  return (
    <Link
      href={def.href}
      className={`${box} ${TONE_CARD[tone]} transition-colors hover:no-underline ${FOCUS}`}
      data-testid={`attention-${def.key}`}
    >
      <span className={`font-display text-3xl leading-none font-bold ${TONE_COUNT[tone]}`}>
        {state.total}
      </span>
      <span className="min-w-0 text-sm">
        <span className="block font-semibold text-fg">{def.title(state.total)}</span>
        <span className="text-muted">{state.total > 0 ? def.hint : "Nada pendiente."}</span>
      </span>
    </Link>
  );
}

/**
 * Lo pendiente va en tarjetas; lo que está en cero se resume en una línea
 * «Al día» (nueve tarjetas con «0 · Nada pendiente» tapaban lo urgente).
 */
function Attention({ defs }: { defs: AttentionDef[] }) {
  const totals = useTotals(defs);
  const state = (d: AttentionDef) => totals[d.key] ?? null;
  const isClear = (d: AttentionDef) => {
    const s = state(d);
    return s !== null && s !== "error" && s.total === 0;
  };
  const pending = defs.filter((d) => !isClear(d));
  const clear = defs.filter(isClear);
  return (
    <section aria-labelledby="attention-title" className="space-y-3">
      <h2 id="attention-title" className={SERIF_TITLE}>
        Requiere atención
      </h2>
      {pending.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {pending.map((d) => (
            <AttentionCard key={d.key} def={d} state={state(d)} />
          ))}
        </div>
      ) : (
        <p className={`${CARD} m-0 flex items-center gap-2 p-4 text-sm text-success`}>
          <Icon name="check" size="sm" /> Todo al día: no hay nada pendiente.
        </p>
      )}
      {clear.length > 0 && pending.length > 0 && (
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="flex items-center gap-1 font-semibold text-success">
            <Icon name="check" size="sm" /> Al día:
          </span>
          {clear.map((d) => (
            <Link
              key={d.key}
              href={d.href}
              className="text-muted hover:text-fg"
              data-testid={`attention-${d.key}`}
            >
              {d.title(0)}
            </Link>
          ))}
        </p>
      )}
    </section>
  );
}

function Panel({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`${CARD} min-w-0 p-5 sm:p-6`} aria-labelledby={id}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id={id} className={SERIF_TITLE}>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={`text-xs text-muted hover:text-fg ${FOCUS}`}>
      {children} →
    </Link>
  );
}

function useList<T>(endpoint: string | null) {
  const [items, setItems] = useState<T[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!endpoint) return;
    let cancelled = false;
    apiFetch<Page<T>>(endpoint)
      .then((page) => !cancelled && setItems(page.items))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [endpoint]);
  return { items, failed };
}

function ListState({ failed, empty }: { failed: boolean; empty: string }) {
  return (
    <p className="m-0 py-6 text-center text-sm text-muted">
      {failed ? "No se pudo cargar." : empty}
    </p>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <span className="block h-10 animate-pulse rounded-lg bg-surface-hover" />
      <span className="block h-10 animate-pulse rounded-lg bg-surface-hover" />
    </div>
  );
}

/* ---------- Pulso del día ---------- */

function PulseCard({
  href,
  label,
  value,
  foot,
  gold,
  testId,
}: {
  href: string;
  label: string;
  value: ReactNode;
  foot: ReactNode;
  gold?: boolean;
  testId: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className={`${CARD} block p-5 transition-colors hover:border-ember/60 hover:no-underline ${FOCUS}`}
    >
      <span className="text-xs text-muted">{label}</span>
      <span
        className={`mt-2 block font-display text-3xl font-bold ${gold ? "text-accent" : "text-fg"}`}
      >
        {value}
      </span>
      <span className="mt-2 flex items-center gap-1 text-xs text-primary">{foot}</span>
    </Link>
  );
}

function Pulse({ today }: { today: string }) {
  const user = useCurrentUser();
  const can = useCan();
  const orders = useTodayOrders(can(P.ORDERS_READ), today, null);
  const [productionTotal, setProductionTotal] = useState<number | null>(null);
  useEffect(() => {
    if (!can(P.PRODUCTION_ORDERS_READ)) return;
    let cancelled = false;
    apiFetch<Page<unknown>>("/api/production-orders?status=open&pageSize=1")
      .then((p) => !cancelled && setProductionTotal(p.total))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const totals = useDayTotals(can(P.SALES_READ), can(P.SALES_MARGIN_READ), today, null);
  const o = orders?.status === "ok" ? orders.data : null;
  const t = totals?.status === "ok" ? totals.data : null;
  const cards: ReactNode[] = [];
  if (orders)
    cards.push(
      <PulseCard
        key="orders"
        testId="pulse-orders"
        href={`${ORDERS_BASE}?from=${today}&to=${today}`}
        label="Pedidos activos para hoy"
        value={
          o
            ? `${o.toPrepare + o.inPreparation + o.ready} ${o.toPrepare + o.inPreparation + o.ready === 1 ? "pedido" : "pedidos"}`
            : "…"
        }
        foot={
          <span className="text-muted">
            {o ? `${o.inPreparation} en preparación · ${o.ready} listos` : "Cargando"}
          </span>
        }
      />,
    );
  if (can(P.PRODUCTION_ORDERS_READ))
    cards.push(
      <PulseCard
        key="production"
        testId="pulse-production"
        href="/produccion?estado=open"
        label="Producción sin completar"
        value={
          productionTotal === null
            ? "…"
            : `${productionTotal} ${productionTotal === 1 ? "orden" : "órdenes"}`
        }
        foot={
          <>
            Ir a producción <span aria-hidden="true">→</span>
          </>
        }
      />,
    );
  if (totals && !(t && t.sold === null))
    cards.push(
      <PulseCard
        key="sales"
        testId="pulse-sales"
        href={`/ventas?from=${today}&to=${today}`}
        label={t?.margin !== null && t ? "Margen sobre materiales hoy" : "Vendido hoy"}
        gold
        value={t ? formatMoney(t.margin ?? t.sold, user.company.currencyCode) : "…"}
        foot={
          <span className="text-success">
            {t
              ? t.margin !== null
                ? `Sobre ${formatMoney(t.sold, user.company.currencyCode)} vendidos`
                : `${t.count} ${t.count === 1 ? "venta" : "ventas"}`
              : "Cargando"}
          </span>
        }
      />,
    );
  if (cards.length === 0) return null;
  return (
    <div className="grid gap-4 md:grid-cols-3" aria-label="Pulso del día" role="group">
      {cards}
    </div>
  );
}

/* ---------- Próximas entregas ---------- */

function UpcomingOrders({ today }: { today: string }) {
  const { items, failed } = useList<OrderListItemDto>(
    `/api/orders?status=active&from=${today}&pageSize=6`,
  );
  return (
    <Panel
      id="dash-orders"
      title="Próximas entregas"
      action={<PanelLink href={`${ORDERS_BASE}?upcoming=true`}>Ver pedidos</PanelLink>}
    >
      {!items ? (
        failed ? (
          <ListState failed empty="" />
        ) : (
          <Skeleton />
        )
      ) : items.length === 0 ? (
        <ListState failed={false} empty="No hay pedidos activos desde hoy." />
      ) : (
        <ul className="m-0 list-none divide-y divide-line p-0" aria-label="Próximas entregas">
          {[...items]
            .sort((a, b) => a.requestedAtLocal.localeCompare(b.requestedAtLocal))
            .map((o) => (
              <li
                key={o.id}
                className="flex flex-col justify-between gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                    <span className="text-sm font-semibold text-fg">{o.customer.name}</span>
                    <span className="text-xs font-medium text-primary">
                      • {formatLocalDateTime(o.requestedAtLocal)}
                    </span>
                  </div>
                  <p className="m-0 mt-1 truncate text-xs text-muted">
                    <Link href={`${ORDERS_BASE}/${o.id}`} className="code">
                      {o.code}
                    </Link>
                    {o.products.length > 0 &&
                      ` — ${o.products.map((p) => `${p.quantity} ${p.unit} ${p.name}`).join(" · ")}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 self-end sm:self-center">
                  {o.coverageStatus ? (
                    <CoverageBadge coverage={o.coverageStatus} />
                  ) : (
                    <OrderStatusBadge status={o.status} />
                  )}
                  <Link
                    href={`${ORDERS_BASE}/${o.id}`}
                    className={`rounded-lg border border-line bg-surface-sunken px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-ember hover:no-underline ${FOCUS}`}
                    aria-label={`Abrir el pedido ${o.code}`}
                  >
                    Abrir →
                  </Link>
                </div>
              </li>
            ))}
        </ul>
      )}
    </Panel>
  );
}

/** Producción en curso o planificada. */
function OpenProduction() {
  const { items, failed } = useList<ProductionOrderListItemDto>(
    "/api/production-orders?status=open&pageSize=6",
  );
  return (
    <Panel
      id="dash-production"
      title="Producción pendiente"
      action={<PanelLink href="/produccion?estado=open">Ver órdenes</PanelLink>}
    >
      {!items ? (
        failed ? (
          <ListState failed empty="" />
        ) : (
          <Skeleton />
        )
      ) : items.length === 0 ? (
        <ListState failed={false} empty="No hay órdenes planificadas ni en curso." />
      ) : (
        <ul className="m-0 list-none divide-y divide-line p-0">
          {items.map((o) => (
            <li
              key={o.id}
              className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <span className="min-w-0 text-sm">
                <Link href={`/produccion/${o.id}`} className="code">
                  {o.code}
                </Link>{" "}
                <span className="text-fg">{o.product.name}</span>
              </span>
              <ProductionStatusBadge status={o.status} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

interface AuditItem {
  id: number;
  action: string;
  actor: { displayName: string } | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/** Código del registro afectado (VTA-0001, COM-0001…), si la auditoría lo guardó. */
function auditReference(a: AuditItem): string | null {
  const m = a.metadata ?? {};
  for (const key of ["code", "number", "receipt"]) {
    if (typeof m[key] === "string" && m[key]) return m[key] as string;
  }
  return null;
}

const ACTION_LABELS: Record<string, string> = AUDIT_ACTION_LABELS;

function RecentActivity({ timeZone }: { timeZone: string }) {
  const { items, failed } = useList<AuditItem>("/api/audit-logs?page=1&pageSize=8&operational=1");
  return (
    <Panel
      id="activity-title"
      title="Actividad reciente"
      action={<PanelLink href="/auditoria">Ver auditoría</PanelLink>}
    >
      {!items ? (
        failed ? (
          <ListState failed empty="" />
        ) : (
          <Skeleton />
        )
      ) : items.length === 0 ? (
        <ListState failed={false} empty="Sin actividad registrada." />
      ) : (
        <ul className="m-0 list-none divide-y divide-line p-0" aria-label="Actividad reciente">
          {items.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="m-0 text-sm font-medium text-fg">
                  {ACTION_LABELS[a.action] ?? "Otra operación"}
                  {auditReference(a) && (
                    <span className="code ml-1.5 text-xs text-muted">{auditReference(a)}</span>
                  )}
                </p>
                <p className="m-0 text-xs text-subtle">{a.actor?.displayName ?? "Sistema"}</p>
              </div>
              <span className="shrink-0 text-xs text-muted">
                {formatDateTime(a.createdAt, timeZone)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function Dashboard() {
  const user = useCurrentUser();
  const can = useCan();
  const tz = user.company.timezone;
  const [today] = useState(() => companyToday(tz));
  const allowed = (needs: string[]) => needs.every((n) => can(n as never));
  const attention = attentionItems(today).filter((d) => allowed(d.needs));
  const quick = QUICK_ACTIONS.filter((q) => allowed(q.needs));
  const firstName = user.displayName.split(" ")[0];
  const [hello] = useState(() => greeting(tz));

  return (
    <div className="animate-fade-up space-y-7">
      <header className="flex flex-col justify-between gap-4 border-b border-line pb-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="m-0 text-xs font-semibold tracking-[0.2em] text-primary uppercase">
            Inicio
          </h1>
          <p className="m-0 mt-1 font-display text-2xl font-semibold text-fg sm:text-3xl">
            {hello}, {firstName}
          </p>
          <p className="m-0 mt-1 text-sm text-muted">
            Resumen de la jornada · {formatLocalDateTime(`${today}T00:00`).slice(0, 10)}
          </p>
        </div>
      </header>

      <Pulse today={today} />

      {quick.length > 0 && (
        <nav className="flex flex-wrap gap-2" aria-label="Acciones rápidas">
          {quick.map((q, i) => (
            <Link
              key={q.href}
              href={q.href}
              title={q.hint}
              className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-semibold transition-colors hover:no-underline ${FOCUS} ${
                i === 0
                  ? "border-transparent bg-ember text-kraft-ink shadow-md hover:bg-ember-text"
                  : "border-line bg-surface text-fg hover:border-ember/60"
              }`}
            >
              <span className={i === 0 ? "" : "text-primary"}>
                <Icon name={q.icon} size="sm" />
              </span>
              {q.label}
            </Link>
          ))}
        </nav>
      )}

      {attention.length > 0 && <Attention defs={attention} />}

      {(can(P.ORDERS_READ) || can(P.PRODUCTION_ORDERS_READ)) && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {can(P.ORDERS_READ) && <UpcomingOrders today={today} />}
          {can(P.PRODUCTION_ORDERS_READ) && <OpenProduction />}
        </div>
      )}

      {can(P.AUDIT_READ) && <RecentActivity timeZone={tz} />}

      {attention.length === 0 && quick.length === 0 && !can(P.AUDIT_READ) && (
        <section className={`${CARD} p-6`}>
          <p className="m-0 text-muted">
            Tu usuario todavía no tiene módulos asignados. Pedile a un administrador que te asigne
            un rol.
          </p>
        </section>
      )}
    </div>
  );
}
