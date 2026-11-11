import "server-only";
import type { CurrentUser } from "@bakery/shared";
import { SESSION_COOKIE_NAME } from "@bakery/shared";
import { cookies } from "next/headers";

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`API ${path} respondió ${status}`);
  }
}

/**
 * Llama a la API desde el servidor web reenviando la cookie de sesión.
 * Devuelve null ante 401; cualquier otro error se propaga (no se oculta).
 */
async function apiGet<T>(path: string): Promise<T | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const res = await fetch(`${API_INTERNAL_URL}${path}`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    cache: "no-store",
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiRequestError(res.status, path);
  return (await res.json()) as T;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const body = await apiGet<{ user: CurrentUser }>("/api/auth/me");
  return body?.user ?? null;
}
