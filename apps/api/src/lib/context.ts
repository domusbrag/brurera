import type { FastifyRequest } from "fastify";
import { unauthorized } from "./errors.js";

/**
 * Contexto de una operación autenticada. `companyId` sale SIEMPRE de la sesión
 * (membresía autorizada), nunca de parámetros enviados por el cliente.
 */
export interface OperationContext {
  companyId: string;
  userId: string;
  timezone: string;
  requestId: string;
  ipAddress: string;
}

export function operationContext(request: FastifyRequest): OperationContext {
  const auth = request.auth;
  if (!auth) throw unauthorized();
  return {
    companyId: auth.user.company.id,
    userId: auth.user.id,
    timezone: auth.companyTimezone,
    requestId: request.id,
    ipAddress: request.ip,
  };
}

/** Datos para recordAudit a partir del contexto. */
export function auditBase(ctx: OperationContext) {
  return {
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    requestId: ctx.requestId,
    ipAddress: ctx.ipAddress,
  };
}

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria de la empresa. */
export function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
}
