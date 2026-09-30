import { SESSION_COOKIE_NAME, loginRequestSchema } from "@bakery/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError, parseInput } from "../../lib/errors.js";
import { getAuth, requireAuth } from "./auth.plugin.js";
import type { AuthService, RequestMeta } from "./auth.service.js";

export interface AuthRoutesOptions {
  authService: AuthService;
  secureCookies: boolean;
  loginRateLimitPerMinute: number;
}

export function requestMeta(request: FastifyRequest): RequestMeta {
  return { requestId: request.id, ipAddress: request.ip, userAgent: request.headers["user-agent"] };
}

export async function authRoutes(app: FastifyInstance, opts: AuthRoutesOptions) {
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: opts.secureCookies,
  };

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: opts.loginRateLimitPerMinute, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = parseInput(loginRequestSchema, request.body);
      const result = await opts.authService.login(
        input.email,
        input.password,
        requestMeta(request),
      );
      if (!result) throw new AppError(401, "INVALID_CREDENTIALS", "Email o contraseña incorrectos");
      reply.setCookie(SESSION_COOKIE_NAME, result.token, {
        ...cookieOptions,
        expires: result.expiresAt,
      });
      return { user: result.user };
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    if (request.auth) await opts.authService.logout(request.auth, requestMeta(request));
    reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
    return reply.status(204).send();
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (request) => ({
    user: getAuth(request).user,
  }));
}
