import { SESSION_COOKIE_NAME, hasPermissions, type PermissionCode } from "@bakery/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import fp from "fastify-plugin";
import { forbidden, unauthorized } from "../../lib/errors.js";
import type { AuthContext, AuthService } from "./auth.service.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/**
 * Resuelve la sesión en cada request (si hay cookie) y deja `request.auth`.
 * La autorización se aplica por ruta con `requireAuth` / `requirePermission`.
 */
export const authPlugin = fp<{ authService: AuthService }>(
  async (app: FastifyInstance, { authService }) => {
    app.decorateRequest("auth", null);
    app.addHook("onRequest", async (request) => {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (!token) return;
      request.auth = await authService.authenticate(token);
    });
  },
  { name: "auth", dependencies: ["@fastify/cookie"] },
);

export const requireAuth: preHandlerHookHandler = async (
  request: FastifyRequest,
  _reply: FastifyReply,
) => {
  if (!request.auth) throw unauthorized();
};

/** Exige sesión válida y todos los permisos indicados. Se evalúa en el servidor. */
export function requirePermission(...required: PermissionCode[]): preHandlerHookHandler {
  return async (request: FastifyRequest) => {
    if (!request.auth) throw unauthorized();
    if (!hasPermissions(request.auth.permissions, required)) {
      request.log.info({ userId: request.auth.user.id, required }, "permiso denegado");
      throw forbidden();
    }
  };
}

/** Utilidad para handlers detrás de requireAuth/requirePermission. */
export function getAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
