"use client";

import type { Page } from "@bakery/shared";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { listPath } from "@/lib/api-client";
import { formatDate } from "@/lib/format";
import { Icon } from "../ui/icons";
import { EmptyState, ErrorState, Loading, PageHeader, useResource } from "./ui";

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
  /** Filtros de fecha (desde/hasta) sincronizados con la URL. */
  dateFilters?: { name: string; label: string }[];
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
  dateFilters = [],
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

  // Búsqueda con demora para no consultar en cada tecla; Enter la aplica ya.
  useEffect(() => {
    if (draft.trim() === search) return;
    const timer = setTimeout(() => setParams({ q: draft.trim() || null }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const extraValues = Object.fromEntries(
    [...extraFilters, ...dateFilters].map((f) => [f.name, params.get(f.name) ?? undefined]),
  );
  const { data, error, stale } = useResource<Page<T>>(
    listPath(endpoint, {
      search: search || undefined,
      ...(hideStatusFilter ? {} : { [statusParam]: status }),
      page,
      pageSize: PAGE_SIZE,
      ...extraValues,
    }),
  );
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  // Mientras la búsqueda escrita no se aplicó, la tabla muestra resultados viejos:
  // se marca como ocupada para no abrir una fila que ya no corresponde.
  const pendingSearch = draft.trim() !== search;
  const busy = stale || pendingSearch;

  const statusChoices = statusOptions ?? [
    { value: "active", label: statusLabels.active },
    { value: "inactive", label: statusLabels.inactive },
    { value: "all", label: "Todos" },
  ];
  const activeChips: { key: string; label: string; clear: Record<string, string | null> }[] = [];
  if (search) activeChips.push({ key: "q", label: `“${search}”`, clear: { q: null } });
  if (!hideStatusFilter && status !== defaultStatus) {
    const label = statusChoices.find((o) => o.value === status)?.label ?? status;
    activeChips.push({ key: "estado", label: `Estado: ${label}`, clear: { estado: null } });
  }
  for (const f of extraFilters) {
    const value = params.get(f.name);
    if (!value) continue;
    const label = f.options.find((o) => o.value === value)?.label ?? value;
    activeChips.push({ key: f.name, label: `${f.label}: ${label}`, clear: { [f.name]: null } });
  }
  for (const f of dateFilters) {
    const value = params.get(f.name);
    if (value)
      activeChips.push({
        key: f.name,
        label: `${f.label}: ${formatDate(value)}`,
        clear: { [f.name]: null },
      });
  }
  const clearAll = () => {
    setDraft("");
    setParams(Object.fromEntries(activeChips.flatMap((c) => Object.entries(c.clear))));
  };

  const createAction =
    canCreate && createLabel ? (
      <Link className="button button--primary" href={createHref ?? `${basePath}/nuevo`}>
        <Icon name="plus" size="sm" />
        {createLabel}
      </Link>
    ) : undefined;

  return (
    <div className="page">
      <PageHeader title={title} subtitle={subtitle} actions={createAction} />
      {headerExtra}
      <section className="panel">
        <div className="filters" role="search">
          <div className="filters__search">
            <Icon name="search" size="sm" />
            <input
              type="search"
              aria-label="Buscar"
              placeholder={searchPlaceholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setParams({ q: draft.trim() || null });
                }
              }}
            />
          </div>
          {!hideStatusFilter && (
            <select
              aria-label="Estado"
              value={status}
              onChange={(e) => setParams({ estado: e.target.value })}
            >
              {statusChoices.map((o) => (
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
          {dateFilters.map((f) => (
            <label key={f.name} className="filters__date">
              <span>{f.label}</span>
              <input
                type="date"
                value={params.get(f.name) ?? ""}
                onChange={(e) => setParams({ [f.name]: e.target.value || null })}
              />
            </label>
          ))}
        </div>
        {activeChips.length > 0 && (
          <div className="filters__active" aria-label="Filtros aplicados">
            {activeChips.map((c) => (
              <button
                key={c.key}
                type="button"
                className="filter-chip"
                aria-label={`Quitar filtro ${c.label}`}
                onClick={() => {
                  if (c.key === "q") setDraft("");
                  setParams(c.clear);
                }}
              >
                {c.label}
                <Icon name="close" size="sm" />
              </button>
            ))}
            <button type="button" className="link-button" onClick={clearAll}>
              Limpiar filtros
            </button>
          </div>
        )}

        {error ? (
          <ErrorState error={error} />
        ) : !data ? (
          <Loading />
        ) : data.items.length === 0 && !busy ? (
          search ? (
            <EmptyState
              compact
              title={`Sin resultados para “${search}”.`}
              description="Probá con otra parte del nombre o del código."
              action={
                <button type="button" className="button button--small" onClick={clearAll}>
                  Limpiar filtros
                </button>
              }
            />
          ) : activeChips.length > 0 ? (
            <EmptyState
              compact
              title="Nada coincide con los filtros elegidos."
              action={
                <button type="button" className="button button--small" onClick={clearAll}>
                  Limpiar filtros
                </button>
              }
            />
          ) : (
            <EmptyState title={emptyText} action={createAction} />
          )
        ) : (
          <>
            <div className={`table-wrap ${busy ? "is-busy" : ""}`} aria-busy={busy || undefined}>
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
            {(data.total > data.pageSize || page > 1) ? (
              <nav className="pagination" aria-label="Páginas">
                <span>
                  {data.total} {data.total === 1 ? "resultado" : "resultados"} · página {data.page}{" "}
                  de {totalPages}
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
              </nav>
            ) : (
              <p className="pagination muted">
                {data.total} {data.total === 1 ? "resultado" : "resultados"}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
