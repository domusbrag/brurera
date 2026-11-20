"use client";

import { D } from "@bakery/domain";
import {
  PERMISSIONS as P,
  instantToZonedLocal,
  type LowStockItemDto,
  type OrderListItemDto,
  type Page,
  type SaleListItemDto,
} from "@bakery/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { formatMoney, formatQuantity } from "@/lib/format";
import { Icon } from "../ui/icons";

/*
 * «Lo de hoy» (diseño La Espiga): los bloques de pizarra del panel kraft
 * (pedidos del día por estado y alertas de stock) y la barra de resultados del
 * día al pie. Todo sale de la API real y respeta permisos: sin permiso, el
 * bloque no se pide ni se muestra. Se vuelve a pedir al cambiar de pantalla,
 * así los números acompañan lo que se acaba de hacer.
 */

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria de la empresa. */
export function companyToday(timeZone: string): string {
  return instantToZonedLocal(new Date(), timeZone).slice(0, 10);
}

type Load<T> = { status: "loading" } | { status: "error" } | { status: "ok"; data: T };

/** Recorre las páginas de un listado (hasta `maxPages`), para sumar el día completo. */
async function fetchAll<T>(endpoint: string, maxPages = 5): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = endpoint.includes("?") ? "&" : "?";
    const res = await apiFetch<Page<T>>(`${endpoint}${sep}page=${page}&pageSize=100`);
    items.push(...res.items);
    if (items.length >= res.total || res.items.length === 0) break;
  }
  return items;
}

function useLoad<T>(enabled: boolean, load: () => Promise<T>, deps: unknown[]): Load<T> | null {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    load()
      .then((data) => !cancelled && setState({ status: "ok", data }))
      .catch(() => !cancelled && setState({ status: "error" }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return enabled ? state : null;
}

/* ---------- Pedidos de hoy ---------- */

export interface TodayOrders {
  toPrepare: number;
  inPreparation: number;
  ready: number;
  delivered: number;
}

function countOrders(items: OrderListItemDto[]): TodayOrders {
  const c: TodayOrders = { toPrepare: 0, inPreparation: 0, ready: 0, delivered: 0 };
  for (const o of items) {
    if (o.status === "CONFIRMED" || o.status === "DRAFT") c.toPrepare++;
    else if (o.status === "IN_PREPARATION") c.inPreparation++;
    else if (o.status === "READY" || o.status === "PARTIALLY_DELIVERED") c.ready++;
    else if (o.status === "DELIVERED") c.delivered++;
  }
  return c;
}

export function useTodayOrders(enabled: boolean, today: string, refresh: unknown) {
  return useLoad(
    enabled,
    async () =>
      countOrders(
        await fetchAll<OrderListItemDto>(`/api/orders?status=active&from=${today}&to=${today}`),
      ),
    [today, refresh],
  );
}

/* ---------- Resultados del día ---------- */

export interface DayTotals {
  count: number;
  /** null si el usuario no ve precios. */
  sold: string | null;
  /** null si no ve margen (o alguna venta no lo tiene). */
  margin: string | null;
  materials: string | null;
  pending: string | null;
}

function sumSales(canSeeMargin: boolean, items: SaleListItemDto[]): DayTotals {
  const posted = items.filter((s) => s.status === "POSTED");
  const seesPrices = posted.every((s) => s.total !== null);
  const seesMargin = canSeeMargin && posted.every((s) => s.margin !== null);
  let sold = D(0);
  let margin = D(0);
  let pending = D(0);
  for (const s of posted) {
    sold = sold.plus(s.total ?? 0);
    pending = pending.plus(s.pending ?? 0);
    if (s.margin) margin = margin.plus(s.margin.amount);
  }
  return {
    count: posted.length,
    sold: seesPrices ? sold.toFixed(2) : null,
    margin: seesMargin ? margin.toFixed(2) : null,
    materials: seesMargin ? sold.minus(margin).toFixed(2) : null,
    pending: seesPrices ? pending.toFixed(2) : null,
  };
}

export function useDayTotals(
  enabled: boolean,
  canSeeMargin: boolean,
  today: string,
  refresh: unknown,
) {
  return useLoad(
    enabled,
    async () =>
      sumSales(
        canSeeMargin,
        await fetchAll<SaleListItemDto>(`/api/sales?status=POSTED&from=${today}&to=${today}`),
      ),
    [today, refresh],
  );
}

/* ---------- Bloques de pizarra del panel kraft ---------- */

const CHALK = "rounded-xl border border-kraft-ink/30 bg-chalk p-4 text-chalk-text shadow-md";
const CHALK_TITLE = "flex items-center gap-1.5 font-display text-sm font-semibold tracking-wide";
const ROW =
  "flex items-center justify-between gap-2 rounded-lg bg-chalk-row px-3 py-2 text-xs transition-colors hover:bg-chalk-row-hover focus-visible:outline-2 focus-visible:outline-ember";
const GHOST_ROW = "block h-8 animate-pulse rounded-lg bg-chalk-row";

export function TodayOrdersBlock({
  state,
  today,
  onNavigate,
}: {
  state: Load<TodayOrders>;
  today: string;
  onNavigate?: () => void;
}) {
  const base = `/pedidos?from=${today}&to=${today}`;
  const rows: { key: keyof TodayOrders; label: string; tone?: "hot" | "ok"; estado: string }[] = [
    { key: "toPrepare", label: "Por preparar", estado: "CONFIRMED" },
    { key: "inPreparation", label: "En preparación", tone: "hot", estado: "IN_PREPARATION" },
    { key: "ready", label: "Listos para entregar", tone: "ok", estado: "READY" },
  ];
  return (
    <div role="region" className={CHALK} aria-labelledby="chalk-orders">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="chalk-orders" className={CHALK_TITLE}>
          Pedidos de hoy
        </h2>
        <Link
          className="text-[11px] text-ember-text hover:underline"
          href={base}
          onClick={onNavigate}
        >
          Ver agenda
        </Link>
      </div>
      {state.status === "loading" ? (
        <div className="space-y-2" aria-busy="true">
          <span className={GHOST_ROW} />
          <span className={GHOST_ROW} />
          <span className={GHOST_ROW} />
        </div>
      ) : state.status === "error" ? (
        <p className="py-1 text-xs text-chalk-muted">No se pudieron cargar.</p>
      ) : (
        <ul className="m-0 list-none space-y-2 p-0" data-testid="today-orders">
          {rows.map((r) => (
            <li key={r.key}>
              <Link
                href={`${base}&estado=${r.estado}`}
                onClick={onNavigate}
                className={`${ROW} ${
                  r.tone === "hot" && state.data[r.key] > 0
                    ? "bg-ember font-semibold text-kraft-ink shadow-xs hover:bg-ember-text"
                    : ""
                }`}
              >
                <span
                  className={`flex items-center gap-1.5 ${
                    r.tone === "ok" ? "text-sage" : r.tone === "hot" ? "" : "text-chalk-muted"
                  }`}
                >
                  {r.tone === "hot" && <Icon name="factory" size="sm" />}
                  {r.label}
                </span>
                <strong className={r.tone === "ok" ? "text-sage" : ""}>{state.data[r.key]}</strong>
              </Link>
            </li>
          ))}
          {state.data.delivered > 0 && (
            <li className="flex items-center gap-1.5 px-1 pt-1 text-[11px] text-chalk-muted">
              <Icon name="check" size="sm" /> {state.data.delivered}{" "}
              {state.data.delivered === 1 ? "ya entregado" : "ya entregados"}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export function StockAlertsBlock({
  enabled,
  refresh,
  onNavigate,
}: {
  enabled: boolean;
  refresh: unknown;
  onNavigate?: () => void;
}) {
  const state = useLoad(
    enabled,
    () => apiFetch<Page<LowStockItemDto>>("/api/inventory/low-stock?pageSize=5"),
    [refresh],
  );
  if (!state) return null;
  return (
    <div role="region" className={CHALK} aria-labelledby="chalk-stock">
      <div className="mb-2.5 flex items-center justify-between">
        <h2 id="chalk-stock" className={CHALK_TITLE}>
          <span className="text-ember-text">
            <Icon name="alert" size="sm" />
          </span>
          Alertas de stock
        </h2>
        {state.status === "ok" && state.data.total > 0 ? (
          <Link
            href="/stock/bajo-minimo"
            onClick={onNavigate}
            className="rounded bg-ember/20 px-1.5 py-0.5 text-[11px] font-semibold text-ember-text hover:bg-ember/30 hover:no-underline"
            data-testid="stock-alerts-count"
            title="Ver las materias primas bajo el mínimo"
            aria-label={`Ver ${state.data.total} bajo el mínimo`}
          >
            {state.data.total}
          </Link>
        ) : null}
      </div>
      {state.status === "loading" ? (
        <span className={GHOST_ROW} aria-busy="true" />
      ) : state.status === "error" ? (
        <p className="py-1 text-xs text-chalk-muted">No se pudieron cargar.</p>
      ) : state.data.items.length === 0 ? (
        <p className="py-1 text-xs text-chalk-muted">
          Despensa completa: todo está sobre el mínimo.
        </p>
      ) : (
        <ul className="m-0 list-none space-y-2 p-0">
          {state.data.items.map((i) => (
            <li key={i.id} className={`${ROW} hover:bg-chalk-row`}>
              <span className="truncate text-chalk-text">{i.rawMaterial.name}</span>
              <strong className="shrink-0 text-ember-text">
                {formatQuantity(i.quantity, i.baseUnit.symbol)}
              </strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- Barra de resultados del día (pie de página) ---------- */

export function DayTotalsBar({ state, currency }: { state: Load<DayTotals>; currency: string }) {
  if (state.status === "error") return null;
  const t = state.status === "ok" ? state.data : null;
  // Sin precios no hay nada que mostrar en pesos.
  if (t && t.sold === null) return null;
  const cell = (label: string, value: string | null | undefined, tone = "text-fg") => (
    <div className="pt-3 text-center md:pt-0">
      <dt className="font-display text-xs tracking-wide text-muted">{label}</dt>
      <dd className={`mt-1 font-display text-xl font-bold sm:text-2xl ${tone}`}>
        {t ? formatMoney(value ?? null, currency) : "…"}
      </dd>
    </div>
  );
  return (
    <footer className="px-4 pt-2 pb-6 lg:px-8">
      <Link
        href="/ventas"
        aria-label="Resultados de hoy: abrir ventas"
        className="mx-auto block max-w-6xl rounded-2xl border border-line-strong bg-surface-sunken/90 px-5 py-4 shadow-lg transition-colors hover:border-ember/60 hover:no-underline focus-visible:outline-2 focus-visible:outline-primary sm:px-8"
      >
        <span className="mb-2 block text-center text-[11px] font-semibold tracking-[0.2em] text-primary uppercase">
          Hoy · {t ? `${t.count} ${t.count === 1 ? "venta" : "ventas"}` : "cargando"}
        </span>
        <dl
          className="grid grid-cols-2 items-center gap-4 divide-line md:grid-cols-4 md:divide-x"
          data-testid="day-totals"
        >
          {cell("Vendido", t?.sold)}
          {(!t || t.materials !== null) &&
            cell("(−) Costo de materiales", t?.materials, "text-muted")}
          {(!t || t.margin !== null) &&
            cell("(=) Margen sobre materiales", t?.margin, "text-accent")}
          {cell("Falta cobrar", t?.pending, "text-warning")}
        </dl>
      </Link>
    </footer>
  );
}

/** Permisos que habilitan cada bloque (comodidad de UI: la API vuelve a autorizar). */
export const DAY_PANEL_NEEDS = {
  orders: P.ORDERS_READ,
  stock: P.INVENTORY_READ,
  sales: P.SALES_READ,
} as const;
