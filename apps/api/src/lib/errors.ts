import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError, type ZodType } from "zod";
import type { ApiErrorBody } from "@bakery/shared";

/** Error de aplicación esperado, con código estable para el cliente. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthorized = () => new AppError(401, "UNAUTHENTICATED", "Sesión requerida");
export const forbidden = () =>
  new AppError(403, "FORBIDDEN", "No tiene permiso para esta operación");

/** Valida una entrada externa; lanza 400 con el detalle de los campos inválidos. */
export function parseInput<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Datos inválidos",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const requestId = request.id;
  let status = 500;
  let body: ApiErrorBody = {
    error: { code: "INTERNAL_ERROR", message: "Error interno", requestId },
  };

  if (error instanceof AppError) {
    status = error.statusCode;
    body = {
      error: { code: error.code, message: error.message, requestId, details: error.details },
    };
  } else if (error instanceof ZodError) {
    status = 400;
    body = { error: { code: "VALIDATION_ERROR", message: "Datos inválidos", requestId } };
  } else if (
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode < 500
  ) {
    status = error.statusCode;
    body = { error: { code: error.code ?? "BAD_REQUEST", message: error.message, requestId } };
  }

  if (status >= 500) {
    request.log.error(
      { err: error, route: request.routeOptions.url, userId: request.auth?.user.id },
      "error no controlado",
    );
  } else {
    request.log.info({ code: body.error.code, status }, "request rechazada");
  }
  return reply.status(status).send(body);
}
