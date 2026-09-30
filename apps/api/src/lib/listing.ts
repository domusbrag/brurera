import type { ActiveFilter, ListQuery, Page } from "@bakery/shared";
import { eq, ilike, or, type AnyColumn, type SQL } from "drizzle-orm";

/** Escapa comodines de LIKE para que la búsqueda sea literal. */
export function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Condición de búsqueda (ILIKE contiene) sobre varias columnas; undefined si no hay texto. */
export function searchCondition(search: string | undefined, columns: AnyColumn[]): SQL | undefined {
  if (!search) return undefined;
  const pattern = likePattern(search);
  return or(...columns.map((c) => ilike(c, pattern)));
}

/** Filtro estándar activo / inactivo / todos sobre una columna booleana. */
export function activeCondition(column: AnyColumn, status: ActiveFilter): SQL | undefined {
  if (status === "all") return undefined;
  return eq(column, status === "active");
}

export function pageWindow(query: Pick<ListQuery, "page" | "pageSize">) {
  return { limit: query.pageSize, offset: (query.page - 1) * query.pageSize };
}

export function toPage<T>(
  items: T[],
  total: number,
  query: Pick<ListQuery, "page" | "pageSize">,
): Page<T> {
  return { items, total, page: query.page, pageSize: query.pageSize };
}
