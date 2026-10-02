import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  cancelOrderSchema,
  confirmOrderSchema,
  coveragePreviewSchema,
  createOrderSchema,
  materialDemandQuerySchema,
  orderListQuerySchema,
  planningQuerySchema,
  replanOrderSchema,
  replanPreviewSchema,
  updateOrderSchema,
} from "@bakery/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as orders from "./orders.service.js";
import * as planning from "./planning.service.js";

/**
 * Pedidos de clientes y planificación (Fase 5A). Ningún GET escribe: la
 * vista previa de un pedido nuevo es un POST que no persiste nada, y
 * "actualizar cobertura" es POST /orders/:id/replan.
 */
export async function orderRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const orderId = (params: unknown) => idParam(params, "Pedido");
  const viewer = (req: FastifyRequest) => ({ permissions: req.auth?.permissions ?? [] });

  app.get("/orders", { preHandler: requirePermission(P.ORDERS_READ) }, (req) =>
    orders.listOrders(db, operationContext(req), parseInput(orderListQuerySchema, req.query)),
  );
  app.post("/orders", { preHandler: requirePermission(P.ORDERS_CREATE) }, async (req, reply) =>
    reply
      .status(201)
      .send(
        await orders.createOrder(
          db,
          operationContext(req),
          parseInput(createOrderSchema, req.body),
          viewer(req),
        ),
      ),
  );
  app.post("/orders/coverage-preview", { preHandler: requirePermission(P.ORDERS_CREATE) }, (req) =>
    orders.previewCoverage(db, operationContext(req), parseInput(coveragePreviewSchema, req.body)),
  );
  app.get("/orders/:id", { preHandler: requirePermission(P.ORDERS_READ) }, (req) =>
    orders.getOrder(db, operationContext(req), orderId(req.params), viewer(req)),
  );
  app.patch("/orders/:id", { preHandler: requirePermission(P.ORDERS_UPDATE) }, (req) =>
    orders.updateOrder(
      db,
      operationContext(req),
      orderId(req.params),
      parseInput(updateOrderSchema, req.body),
      viewer(req),
    ),
  );
  app.get("/orders/:id/coverage-preview", { preHandler: requirePermission(P.ORDERS_READ) }, (req) =>
    orders.previewDraft(db, operationContext(req), orderId(req.params)),
  );
  app.post("/orders/:id/confirm", { preHandler: requirePermission(P.ORDERS_CONFIRM) }, (req) =>
    orders.confirmOrder(
      db,
      operationContext(req),
      orderId(req.params),
      parseInput(confirmOrderSchema, req.body).operationId,
      viewer(req),
    ),
  );
  app.post(
    "/orders/:id/replan-preview",
    { preHandler: requirePermission(P.ORDERS_REPLAN) },
    (req) =>
      orders.previewReplan(
        db,
        operationContext(req),
        orderId(req.params),
        parseInput(replanPreviewSchema, req.body ?? {}),
      ),
  );
  app.post("/orders/:id/replan", { preHandler: requirePermission(P.ORDERS_REPLAN) }, (req) =>
    orders.replanOrder(
      db,
      operationContext(req),
      orderId(req.params),
      parseInput(replanOrderSchema, req.body),
      viewer(req),
    ),
  );
  app.post("/orders/:id/cancel", { preHandler: requirePermission(P.ORDERS_CANCEL) }, (req) =>
    orders.cancelOrder(
      db,
      operationContext(req),
      orderId(req.params),
      parseInput(cancelOrderSchema, req.body),
      viewer(req),
    ),
  );
  app.post(
    "/orders/:id/start-preparation",
    { preHandler: requirePermission(P.ORDERS_PREPARE) },
    (req) => orders.startPreparation(db, operationContext(req), orderId(req.params), viewer(req)),
  );
  app.post("/orders/:id/mark-ready", { preHandler: requirePermission(P.ORDERS_READY) }, (req) =>
    orders.markReady(db, operationContext(req), orderId(req.params), viewer(req)),
  );

  /* ---- Planificación ---- */
  app.get(
    "/planning/production-needs",
    { preHandler: requirePermission(P.ORDER_PLANNING_READ) },
    (req) =>
      planning.productionNeeds(
        db,
        operationContext(req),
        parseInput(planningQuerySchema, req.query),
      ),
  );
  app.get(
    "/planning/material-demand",
    { preHandler: requirePermission(P.ORDER_PLANNING_READ) },
    (req) =>
      planning.calculateMaterialDemand(
        db,
        operationContext(req),
        parseInput(materialDemandQuerySchema, req.query),
      ),
  );
  app.get(
    "/planning/orders-at-risk",
    { preHandler: requirePermission(P.ORDER_PLANNING_READ) },
    (req) =>
      planning.ordersAtRisk(db, operationContext(req), parseInput(planningQuerySchema, req.query)),
  );
  app.get(
    "/planning/requirements/:id",
    { preHandler: requirePermission(P.ORDER_PLANNING_READ) },
    (req) => planning.getRequirement(db, operationContext(req), idParam(req.params, "Necesidad")),
  );
}
