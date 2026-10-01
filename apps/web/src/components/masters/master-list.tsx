"use client";

import type { Page } from "@bakery/shared";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { listPath } from "@/lib/api-client";
import { ErrorState, Loading, PageHeader, useResource } from "./ui";

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

export interface MasterListProps<T> {
  title: string;
  subtitle?: ReactNode;
  endpoint: string;
  basePath: string;
  columns: Column<T>[];
  searchPlaceholder: string;
  createLabel?: string;
  /** Ruta del alta (por defecto `${basePath}/nuevo`). */
  createHref?: string;
  canCreate?: boolean;
  /** Filtros adicionales (select) sincronizados con la URL. */
  extraFilters?: {
    name: string;
    label: string;
    allLabel?: string;
    options: { value: string; label: string }[];
  }[];
  statusLabels?: { active: string; inactive: string };
  /** Opciones propias del filtro de estado (p. ej. estados de una compra). */
  statusOptions?: { value: string; label: string }[];
  defaultStatus?: string;
  /** Nombre del parámetro de estado en la API (por defecto `status`). */
  statusParam?: string;
  /** Sin filtro de estado (el endpoint no lo admite). */
  hideStatusFilter?: boolean;
  emptyText: string;
  headerExtra?: ReactNode;
}

const PAGE_SIZE = 25;

/**
 * Listado estándar de un maestro: búsqueda (con demora), filtro de estado,
 * filtros extra y paginación del lado del servidor. El estado vive en la URL,
 * así volver desde el detalle conserva la búsqueda.
 */
export function MasterList<T extends { id: string }>(props: MasterListProps<T>) {
  return (
    <Suspense fallback={<Loading />}>
      <MasterListInner {...props} />
    </Suspense>
  );
}

function MasterListInner<T extends { id: string }>({
  title,
  subtitle,
  endpoint,
  basePath,
  columns,
  searchPlaceholder,
  createLabel,
  createHref,
  canCreate,
  extraFilters = [],
  statusLabels = { active: "Activos", inactive: "Inactivos" },
  statusOptions,
  defaultStatus = "active",
  statusParam = "status",
  hideStatusFilter = false,
  emptyText,
  headerExtra,
}: MasterListProps<T>) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const search = params.get("q") ?? "";
  const status = params.get("estado") ?? defaultStatus;
  const page = Math.max(1, Number(params.get("pagina") ?? "1") || 1);
  const [draft, setDraft] = useState(search);

  const setParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    if (!("pagina" in changes)) next.delete("pagina");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Búsqueda con demora para no consultar en cada tecla.
  useEffect(() => {
    if (draft === search) return;
    const timer = setTimeout(() => setParams({ q: draft.trim() || null }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const extraValues = Object.fromEntries(
    extraFilters.map((f) => [f.name, params.get(f.name) ?? undefined]),
  );
  const { data, error } = useResource<Page<T>>(
    listPath(endpoint, {
      search: search || undefined,
      ...(hideStatusFilter ? {} : { [statusParam]: status }),
      page,
      pageSize: PAGE_SIZE,
      ...extraValues,
    }),
  );
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="page">
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          canCreate && createLabel ? (
            <Link className="button button--primary" href={createHref ?? `${basePath}/nuevo`}>
              {createLabel}
            </Link>
          ) : undefined
        }
      />
      {headerExtra}
      <section className="panel">
        <div className="filters" role="search">
          <input
            type="search"
            aria-label="Buscar"
            placeholder={searchPlaceholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {!hideStatusFilter && (
            <select
              aria-label="Estado"
              value={status}
              onChange={(e) => setParams({ estado: e.target.value })}
            >
              {(
                statusOptions ?? [
                  { value: "active", label: statusLabels.active },
                  { value: "inactive", label: statusLabels.inactive },
                  { value: "all", label: "Todos" },
                ]
              ).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {extraFilters.map((f) => (
            <select
              key={f.name}
              aria-label={f.label}
              value={params.get(f.name) ?? ""}
              onChange={(e) => setParams({ [f.name]: e.target.value || null })}
            >
              <option value="">{f.allLabel ?? `${f.label}: todas`}</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ))}
        </div>

        {error ? (
          <ErrorState error={error} />
        ) : !data ? (
          <Loading />
        ) : data.items.length === 0 ? (
          <p className="muted">{search ? `Sin resultados para “${search}”.` : emptyText}</p>
        ) : (
          <>
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
                  {data.items.map((row) => (
                    <tr key={row.id}>
                      {columns.map((c) => (
                        <td key={c.header} className={c.className}>
                          {c.cell(row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                {data.total} {data.total === 1 ? "resultado" : "resultados"} · página {data.page} de{" "}
                {totalPages}
              </span>
              <div className="actions">
                <button
                  type="button"
                  className="button button--small"
                  disabled={page <= 1}
                  onClick={() => setParams({ pagina: String(page - 1) })}
                >
                  Anterior
                </button>
                <button
                  type="button"
                  className="button button--small"
                  disabled={page >= totalPages}
                  onClick={() => setParams({ pagina: String(page + 1) })}
                >
                  Siguiente
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
