import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Database } from "@bakery/database";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { AppError, errorHandler } from "./lib/errors.js";
import { auditRoutes } from "./modules/audit/audit.routes.js";
import { authPlugin } from "./modules/auth/auth.plugin.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { categoryRoutes } from "./modules/categories/categories.routes.js";
import { companyRoutes } from "./modules/company-settings/company.routes.js";
import { customerRoutes } from "./modules/customers/customers.routes.js";
import { employeeRoutes } from "./modules/employees/employees.routes.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { productRoutes } from "./modules/products/products.routes.js";
import { rawMaterialRoutes } from "./modules/raw-materials/raw-materials.routes.js";
import { recipeRoutes } from "./modules/recipes/recipes.routes.js";
import { roleRoutes } from "./modules/roles/roles.routes.js";
import { supplierRoutes } from "./modules/suppliers/suppliers.routes.js";
import { unitRoutes } from "./modules/units/units.routes.js";
import { userRoutes } from "./modules/users/users.routes.js";
import { warehouseRoutes } from "./modules/warehouses/warehouses.routes.js";

export interface AppDeps {
  config: AppConfig;
  db: Database;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function buildApp({ config, db }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          "res.headers['set-cookie']",
          "*.password",
        ],
        censor: "[REDACTED]",
      },
    },
    // Correlation id: se respeta el x-request-id entrante si es válido.
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
    // La API corre detrás del proxy de Next.js en la misma máquina.
    trustProxy: ["127.0.0.1", "::1"],
    bodyLimit: 1024 * 1024,
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: "NOT_FOUND", message: "Recurso inexistente", requestId: request.id },
    }),
  );
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Protección CSRF: la cookie es SameSite=Lax y además toda request que
  // modifica estado debe ser JSON y, si trae Origin, venir de un origen permitido.
  app.addHook("onRequest", async (request) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin && !config.WEB_ORIGIN.includes(origin)) {
      throw new AppError(403, "ORIGIN_NOT_ALLOWED", "Origen no permitido");
    }
    const contentLength = Number(request.headers["content-length"] ?? 0);
    const contentType = request.headers["content-type"] ?? "";
    if (contentLength > 0 && !contentType.startsWith("application/json")) {
      throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Se requiere application/json");
    }
  });

  const authService = new AuthService(db, config.SESSION_TTL_HOURS * 60 * 60 * 1000);
  await app.register(authPlugin, { authService });

  await app.register(
    async (api) => {
      await api.register(healthRoutes, { db });
      await api.register(authRoutes, {
        authService,
        secureCookies: config.NODE_ENV === "production",
        loginRateLimitPerMinute: config.LOGIN_RATE_LIMIT_PER_MINUTE,
      });
      await api.register(auditRoutes, { db });
      for (const routes of [
        companyRoutes,
        employeeRoutes,
        userRoutes,
        roleRoutes,
        customerRoutes,
        supplierRoutes,
        unitRoutes,
        categoryRoutes,
        rawMaterialRoutes,
        productRoutes,
        warehouseRoutes,
        recipeRoutes,
      ]) {
        await api.register(routes, { db });
      }
    },
    { prefix: "/api" },
  );

  return app;
}
