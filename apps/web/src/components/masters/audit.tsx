"use client";

import { AUDIT_ACTION_LABELS, type AuditLogItemDto, type Page } from "@bakery/shared";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { listPath } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { useCurrentUser } from "../user-context";
import { EmptyState, ErrorState, Loading, PageHeader, useResource } from "./ui";

/** Módulo (tipo de registro) en lenguaje de negocio. La clave es el valor del filtro de la API. */
const ENTITY_LABELS: Record<string, string> = {
  session: "Ingresos al sistema",
  company: "Empresa",
  employee: "Empleados",
  user: "Usuarios",
  customer: "Clientes",
  supplier: "Proveedores",
  unit: "Unidades",
  category: "Categorías",
  raw_material: "Materias primas",
  product: "Productos",
  warehouse: "Depósitos",
  recipe: "Recetas",
  purchase: "Compras",
  production_order: "Órdenes de producción",
  product_lot: "Lotes",
  customer_order: "Pedidos",
  sale: "Ventas",
  customer_payment: "Cobros",
  price_list: "Listas de precios",
};

/** Detalle de cada tipo de registro (para el enlace "Ver"). */
const ENTITY_ROUTES: Record<string, string> = {
  employee: "/empleados",
  user: "/usuarios",
  customer: "/clientes",
  supplier: "/proveedores",
  unit: "/configuracion/unidades",
  category: "/configuracion/categorias",
  raw_material: "/materias-primas",
  product: "/productos",
  warehouse: "/configuracion/depositos",
  recipe: "/recetas",
  purchase: "/compras",
  production_order: "/produccion",
  product_lot: "/stock/lotes",
  customer_order: "/pedidos",
  sale: "/ventas",
  price_list: "/listas-de-precios",
};

const PAGE_SIZE = 25;

/** Registro de auditoría de la empresa (solo lectura, más reciente primero). */
export function AuditLog() {
  return (
    <Suspense fallback={<Loading />}>
      <AuditLogInner />
    </Suspense>
  );
}

function AuditLogInner() {
  const user = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // El filtro vive en la URL: volver desde un registro conserva el módulo y la página.
  const entityType = params.get("modulo") ?? "";
  const page = Math.max(1, Number(params.get("pagina") ?? "1") || 1);
  const setParams = (modulo: string, pagina: number) => {
    const next = new URLSearchParams();
    if (modulo) next.set("modulo", modulo);
    if (pagina > 1) next.set("pagina", String(pagina));
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const { data, error, reload } = useResource<Page<AuditLogItemDto>>(
    listPath("/api/audit-logs", {
      entityType: entityType || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
  );
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const tz = user.company.timezone;
  return (
    <div className="page">
      <PageHeader
        title="Auditoría"
        subtitle="Quién hizo qué y cuándo. Los registros no se pueden modificar ni borrar."
      />
      <section className="panel">
        <div className="filters">
          <div className="form__field">
            <label htmlFor="audit-module">Módulo</label>
            <select
              id="audit-module"
              value={entityType}
              onChange={(e) => setParams(e.target.value, 1)}
            >
              <option value="">Todos los módulos</option>
              {Object.entries(ENTITY_LABELS)
                .sort(([, a], [, b]) => a.localeCompare(b, "es"))
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </div>
          {entityType && (
            <button type="button" className="link-button" onClick={() => setParams("", 1)}>
              Limpiar filtro
            </button>
          )}
        </div>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data ? (
          <Loading label="Cargando la auditoría…" />
        ) : data.items.length === 0 ? (
          <EmptyState
            compact
            title={
              entityType
                ? `No hay registros de ${ENTITY_LABELS[entityType]?.toLowerCase() ?? "este módulo"}.`
                : "Todavía no hay registros."
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table" aria-label="Registros de auditoría">
                <thead>
                  <tr>
                    <th scope="col">Fecha</th>
                    <th scope="col">Acción</th>
                    <th scope="col" className="hide-md">
                      Módulo
                    </th>
                    <th scope="col">Usuario</th>
                    <th scope="col">
                      <span className="sr-only">Registro</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => {
                    const route = item.entityId ? ENTITY_ROUTES[item.entityType] : undefined;
                    return (
                      <tr key={item.id}>
                        <td>{formatDateTime(item.createdAt, tz)}</td>
                        <td>
                          {AUDIT_ACTION_LABELS[item.action as keyof typeof AUDIT_ACTION_LABELS] ??
                            "Acción registrada"}
                        </td>
                        <td className="hide-md">{ENTITY_LABELS[item.entityType] ?? "Otros"}</td>
                        <td>
                          {item.actor?.displayName ?? (
                            <span className="muted" title="Acción automática, sin usuario">
                              Sistema
                            </span>
                          )}
                        </td>
                        <td>
                          {route && (
                            <Link href={`${route}/${item.entityId}`}>
                              Ver
                              <span className="sr-only">
                                {" "}
                                {ENTITY_LABELS[item.entityType]?.toLowerCase() ?? "registro"}
                              </span>
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <nav className="pagination" aria-label="Páginas de la auditoría">
              <span className="muted small">
                {data.total} {data.total === 1 ? "registro" : "registros"} · página {data.page} de{" "}
                {totalPages}
              </span>
              <div className="actions">
                <button
                  type="button"
                  className="button button--small"
                  disabled={page <= 1}
                  onClick={() => setParams(entityType, page - 1)}
                >
                  Anterior
                </button>
                <button
                  type="button"
                  className="button button--small"
                  disabled={page >= totalPages}
                  onClick={() => setParams(entityType, page + 1)}
                >
                  Siguiente
                </button>
              </div>
            </nav>
          </>
        )}
      </section>
    </div>
  );
}
