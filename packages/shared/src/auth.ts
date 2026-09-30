import { z } from "zod";

export const SESSION_COOKIE_NAME = "bakery_session";

export const loginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Representación pública del usuario autenticado (nunca incluye secretos). */
export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  company: { id: string; tradeName: string; timezone: string; currencyCode: string };
  roles: { code: string; name: string }[];
  permissions: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}
