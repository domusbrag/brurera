import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  accountAdjustmentSchema,
  accountMovementsQuerySchema,
  applyPaymentSchema,
  onAccountPaymentSchema,
  orderAdvanceSchema,
  paymentListQuerySchema,
  receivablesQuerySchema,
  salePaymentSchema,
} from "@bakery/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as payments from "./payments.service.js";

/**
 * Cobros, señas y cuenta corriente (Fase 5B). Un cobro nuevo responde 201; un
 * reintento con el mismo operationId responde 200 con `replayed: true`.
 */
export async function paymentRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const perms = (req: FastifyRequest) => req.auth?.permissions ?? [];
  const post = { preHandler: requirePermission(P.PAYMENTS_CREATE, P.PAYMENTS_POST) };
  const created = (reply: FastifyReply, result: { replayed: boolean }) =>
    reply.status(result.replayed ? 200 : 201).send(result);

  app.get("/payments", { preHandler: requirePermission(P.PAYMENTS_READ) }, (req) =>
    payments.listPayments(db, operationContext(req), parseInput(paymentListQuerySchema, req.query)),
  );
  app.get("/payments/:id", { preHandler: requirePermission(P.PAYMENTS_READ) }, (req) =>
    payments.getPayment(db, operationContext(req), idParam(req.params, "Cobro")),
  );
  app.post("/sales/:id/payments", post, async (req, reply) =>
    created(
      reply,
      await payments.registerSalePayment(
        db,
        operationContext(req),
        idParam(req.params, "Venta"),
        parseInput(salePaymentSchema, req.body),
      ),
    ),
  );
  app.post(
    "/orders/:id/advances",
    { preHandler: requirePermission(P.ORDER_ADVANCES_CREATE, P.PAYMENTS_POST) },
    async (req, reply) =>
      created(
        reply,
        await payments.registerOrderAdvance(
          db,
          operationContext(req),
          idParam(req.params, "Pedido"),
          parseInput(orderAdvanceSchema, req.body),
        ),
      ),
  );
  app.post("/customers/:id/payments", post, async (req, reply) =>
    created(
      reply,
      await payments.registerOnAccountPayment(
        db,
        operationContext(req),
        idParam(req.params, "Cliente"),
        parseInput(onAccountPaymentSchema, req.body),
      ),
    ),
  );
  app.post("/payments/:id/applications", post, async (req, reply) =>
    created(
      reply,
      await payments.applyPayment(
        db,
        operationContext(req),
        idParam(req.params, "Cobro"),
        parseInput(applyPaymentSchema, req.body),
      ),
    ),
  );
  app.get(
    "/customers/:id/account",
    { preHandler: requirePermission(P.CUSTOMER_ACCOUNTS_READ) },
    (req) =>
      payments.getCustomerAccount(
        db,
        operationContext(req),
        idParam(req.params, "Cliente"),
        parseInput(accountMovementsQuerySchema, req.query),
        perms(req),
      ),
  );
  app.post(
    "/customers/:id/account/adjustments",
    { preHandler: requirePermission(P.CUSTOMER_ACCOUNTS_ADJUST) },
    async (req, reply) => {
      const account = await payments.adjustAccount(
        db,
        operationContext(req),
        idParam(req.params, "Cliente"),
        parseInput(accountAdjustmentSchema, req.body),
        perms(req),
        parseInput(accountMovementsQuerySchema, {}),
      );
      return reply.status(account.replayed ? 200 : 201).send(account);
    },
  );
  app.get(
    "/customer-accounts",
    { preHandler: requirePermission(P.CUSTOMER_ACCOUNTS_READ) },
    (req) =>
      payments.listReceivables(
        db,
        operationContext(req),
        parseInput(receivablesQuerySchema, req.query),
      ),
  );
}
