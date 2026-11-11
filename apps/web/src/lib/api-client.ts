import type { ApiErrorBody, Page } from "@bakery/shared";
import { localizeNumbers } from "./errors";

/** Error de la API con su código estable y el detalle por campo (si lo hay). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Record<string, string> = {},
    /** Detalle crudo del error (p. ej. faltantes de stock por materia prima). */
    readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const GENERIC_MESSAGES: Record<number, string> = {
  401: "Tu sesión terminó. Volvé a ingresar.",
  403: "No tenés permiso para esta operación.",
  404: "El registro no existe o no pertenece a tu empresa.",
};

/**
 * Llamada a la API desde el navegador (mismo origen, cookie de sesión).
 * Las requests que modifican estado siempre envían JSON (la API lo exige).
 */
export async function apiFetch<T>(
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const init: RequestInit = { method, cache: "no-store" };
  if (method !== "GET" && method !== "DELETE") {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "NETWORK", "No hay conexión con el servidor.");
  }
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* respuesta sin cuerpo JSON */
    }
    const fieldErrors: Record<string, string> = {};
    const details = body?.error.details;
    if (Array.isArray(details)) {
      for (const d of details as { path?: string; message?: string }[]) {
        if (d.path && d.message && !fieldErrors[d.path]) fieldErrors[d.path] = d.message;
      }
    }
    const message =
      body?.error.code === "VALIDATION_ERROR"
        ? "Revisá los datos marcados."
        : (GENERIC_MESSAGES[res.status] ??
          (body?.error.message ? localizeNumbers(body.error.message) : null) ??
          "Ocurrió un error inesperado.");
    throw new ApiError(
      res.status,
      body?.error.code ?? "HTTP_ERROR",
      message,
      fieldErrors,
      Array.isArray(details) ? details : [],
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function listPath(
  endpoint: string,
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${endpoint}?${qs}` : endpoint;
}

/**
 * Opciones para un selector: todos los registros activos, de a páginas de 100
 * (antes se cortaba en 100 sin aviso). Tope de seguridad: 2.000 registros.
 */
export async function fetchOptions<T>(
  endpoint: string,
  extra: Record<string, string> = {},
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await apiFetch<Page<T>>(listPath(endpoint, { pageSize: 100, ...extra, page }));
    items.push(...result.items);
    if (items.length >= result.total || result.items.length === 0) break;
  }
  return items;
}
