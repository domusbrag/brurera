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
import { formatDateTime } from "@/lib/format";
import { Icon, type IconName } from "../ui/icons";
import { OrderStatusBadge, CoverageBadge, ORDERS_BASE } from "../orders/order-shared";
import { ProductionStatusBadge } from "../production/production-shared";
import { useCan, useCurrentUser } from "../user-context";

/*
 * Inicio operativo. Primero lo que requiere acción hoy (cada tarjeta es un
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

interface QuickAction {
  href: string;
  label: string;
  icon: IconName;
  needs: string[];
}

const QUICK_ACTIONS: QuickAction[] = [
  { href: "/ventas/nueva", label: "Nueva venta", icon: "cash", needs: [P.SALES_CREATE] },
  { href: `${ORDERS_BASE}/nuevo`, label: "Nuevo pedido", icon: "clipboard", needs: [P.ORDERS_CREATE] },
  {
    href: "/produccion/nueva",
    label: "Nueva orden de producción",
    icon: "factory",
    needs: [P.PRODUCTION_ORDERS_CREATE],
  },
  { href: "/compras/nueva", label: "Nueva compra", icon: "truck", needs: [P.PURCHASES_CREATE] },
  {
    href: "/cuentas-a-cobrar",
    label: "Registrar un cobro",
    icon: "wallet",
    needs: [P.CUSTOMER_ACCOUNTS_READ, P.PAYMENTS_CREATE],
  },
];

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
      title: (n) =>
        n === 1 ? "materia prima bajo el mínimo" : "materias primas bajo el mínimo",
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

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria de la empresa. */
function companyToday(timeZone: string): string {
  return instantToZonedLocal(new Date(), timeZone).slice(0, 10);
}

function useTotal(endpoint: string | null) {
  const [state, setState] = useState<{ total: number } | "error" | null>(null);
  useEffect(() => {
    if (!endpoint) return;
    let cancelled = false;
    apiFetch<Page<unknown>>(endpoint)
      .then((page) => !cancelled && setState({ total: page.total }))
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [endpoint]);
  return state;
}

function AttentionCard({ def }: { def: AttentionDef }) {
  const state = useTotal(def.endpoint);
  if (state === null)
    return (
      <div className="attention__item" aria-busy="true">
        <span className="attention__count skeleton__line" aria-hidden="true" />
        <span className="attention__title muted">Cargando…</span>
      </div>
    );
  if (state === "error")
    return (
      <div className="attention__item">
        <span className="attention__count muted" aria-hidden="true">
          –
        </span>
        <span className="attention__title">No se pudo cargar</span>
        <span className="attention__hint">{def.title(2)}</span>
      </div>
    );
  const tone: Tone = state.total > 0 ? def.tone : "ok";
  return (
    <Link
      href={def.href}
      className={`attention__item attention__item--${tone}`}
      data-testid={`attention-${def.key}`}
    >
      <span className="attention__count">{state.total}</span>
      <span className="attention__title">{def.title(state.total)}</span>
      <span className="attention__hint">{state.total > 0 ? def.hint : "Nada pendiente."}</span>
    </Link>
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
    <section className="panel" aria-labelledby={id}>
      <div className="panel__header">
        <h2 id={id}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
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
  return <p className="muted">{failed ? "No se pudo cargar." : empty}</p>;
}

/** Próximas entregas: los pedidos activos desde hoy, en orden de entrega. */
function UpcomingOrders({ today }: { today: string }) {
  const { items, failed } = useList<OrderListItemDto>(
    `/api/orders?status=active&from=${today}&pageSize=6`,
  );
  return (
    <Panel
      id="dash-orders"
      title="Próximas entregas"
      action={
        <Link className="link-button" href={`${ORDERS_BASE}?upcoming=true`}>
          Ver pedidos
        </Link>
      }
    >
      {!items ? (
        failed ? (
          <ListState failed empty="" />
        ) : (
          <div className="skeleton" aria-hidden="true">
            <span className="skeleton__line" />
            <span className="skeleton__line" />
          </div>
        )
      ) : items.length === 0 ? (
        <ListState failed={false} empty="No hay pedidos activos desde hoy." />
      ) : (
        <div className="table-wrap">
          <table className="table table--compact" aria-label="Próximas entregas">
            <thead>
              <tr>
                <th scope="col">Pedido</th>
                <th scope="col">Para</th>
                <th scope="col">Cliente</th>
                <th scope="col">Cobertura</th>
              </tr>
            </thead>
            <tbody>
              {[...items]
                .sort((a, b) => a.requestedAtLocal.localeCompare(b.requestedAtLocal))
                .map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`${ORDERS_BASE}/${o.id}`} className="code">
                        {o.code}
                      </Link>
                    </td>
                    <td>{formatLocalDateTime(o.requestedAtLocal)}</td>
                    <td>{o.customer.name}</td>
                    <td>
                      {o.coverageStatus ? (
                        <CoverageBadge coverage={o.coverageStatus} />
                      ) : (
                        <OrderStatusBadge status={o.status} />
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
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
      action={
        <Link className="link-button" href="/produccion?estado=open">
          Ver órdenes
        </Link>
      }
    >
      {!items ? (
        failed ? (
          <ListState failed empty="" />
        ) : (
          <div className="skeleton" aria-hidden="true">
            <span className="skeleton__line" />
            <span className="skeleton__line" />
          </div>
        )
      ) : items.length === 0 ? (
        <ListState failed={false} empty="No hay órdenes planificadas ni en curso." />
      ) : (
        <ul className="plain-list">
          {items.map((o) => (
            <li key={o.id}>
              <Link href={`/produccion/${o.id}`} className="code">
                {o.code}
              </Link>{" "}
              {o.product.name} <ProductionStatusBadge status={o.status} />
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
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = AUDIT_ACTION_LABELS;

function RecentActivity({ timeZone }: { timeZone: string }) {
  const { items, failed } = useList<AuditItem>("/api/audit-logs?page=1&pageSize=8");
  return (
    <Panel
      id="activity-title"
      title="Actividad reciente"
      action={
        <Link className="link-button" href="/auditoria">
          Ver auditoría
        </Link>
      }
    >
      {!items ? (
        failed ? (
          <ListState failed empty="" />
        ) : (
          <div className="skeleton" aria-hidden="true">
            <span className="skeleton__line" />
            <span className="skeleton__line" />
          </div>
        )
      ) : items.length === 0 ? (
        <ListState failed={false} empty="Sin actividad registrada." />
      ) : (
        <div className="table-wrap">
          <table className="table table--compact" aria-label="Actividad reciente">
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">Acción</th>
                <th scope="col">Usuario</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>{formatDateTime(a.createdAt, timeZone)}</td>
                  <td>{ACTION_LABELS[a.action] ?? "Otra operación"}</td>
                  <td>{a.actor?.displayName ?? "Sistema"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

  return (
    <div className="page dashboard">
      <header className="page__header">
        <div className="page__title">
          <h1>Inicio</h1>
          <p className="page__subtitle">
            Hola, {firstName}. {formatLocalDateTime(`${today}T00:00`).slice(0, 10)} ·{" "}
            {user.company.tradeName}
          </p>
        </div>
      </header>

      {quick.length > 0 && (
        <nav className="quick-actions" aria-label="Acciones rápidas">
          {quick.map((q, i) => (
            <Link
              key={q.href}
              href={q.href}
              className={`button ${i === 0 ? "button--primary" : ""}`}
            >
              <Icon name={q.icon} size="sm" />
              {q.label}
            </Link>
          ))}
        </nav>
      )}

      {attention.length > 0 && (
        <section aria-labelledby="attention-title">
          <h2 id="attention-title" className="section-title">
            Requiere atención
          </h2>
          <div className="attention">
            {attention.map((d) => (
              <AttentionCard key={d.key} def={d} />
            ))}
          </div>
        </section>
      )}

      <div className="dash-grid">
        {can(P.ORDERS_READ) && <UpcomingOrders today={today} />}
        {can(P.PRODUCTION_ORDERS_READ) && <OpenProduction />}
      </div>

      {can(P.AUDIT_READ) && <RecentActivity timeZone={tz} />}

      {attention.length === 0 && quick.length === 0 && !can(P.AUDIT_READ) && (
        <section className="panel">
          <p className="muted">
            Tu usuario todavía no tiene módulos asignados. Pedile a un administrador que te asigne
            un rol.
          </p>
        </section>
      )}
    </div>
  );
}
