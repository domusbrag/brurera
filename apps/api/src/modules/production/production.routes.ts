import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  completeProductionSchema,
  cancelProductionSchema,
  createProductionOrderSchema,
  extraMaterialSchema,
  hasPermissions,
  productionActualsSchema,
  productionListQuerySchema,
  updateProductionOrderSchema,
} from "@bakery/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { operationContext } from "../../lib/context.js";
import { forbidden, parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as production from "./production.service.js";

/**
 * Producción (Fase 4). Sólo completar una orden mueve stock. Los importes
 * (costo esperado, real, por unidad) exigen production.cost.read y se quitan
 * en el backend para el resto.
 */
export async function productionRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const orderId = (params: unknown) => idParam(params, "Orden de producción");
  const lineId = (params: unknown) =>
    idParam({ id: (params as { lineId?: unknown }).lineId }, "Línea");
  const canSeeCosts = (req: FastifyRequest) =>
    hasPermissions(req.auth?.permissions ?? [], [P.PRODUCTION_COST_READ]);
  /** Crear desde la necesidad de un pedido exige además order_production.create. */
  const createInput = (req: FastifyRequest) => {
    const input = parseInput(createProductionOrderSchema, req.body);
    if (
      input.sourceOrderRequirementId &&
      !hasPermissions(req.auth?.permissions ?? [], [P.ORDER_PRODUCTION_CREATE])
    ) {
      throw forbidden();
    }
    return input;
  };

  app.get(
    "/production-orders",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_READ) },
    (req) =>
      production.listOrders(
        db,
        operationContext(req),
        parseInput(productionListQuerySchema, req.query),
        canSeeCosts(req),
      ),
  );
  app.post(
    "/production-orders",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_CREATE) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await production.createOrder(
            db,
            operationContext(req),
            createInput(req),
            canSeeCosts(req),
          ),
        ),
  );
  app.post(
    "/production-orders/preview",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_CREATE) },
    (req) => production.previewOrder(db, operationContext(req), createInput(req), canSeeCosts(req)),
  );
  app.get(
    "/production-orders/:id",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_READ) },
    (req) => production.getOrder(db, operationContext(req), orderId(req.params), canSeeCosts(req)),
  );
  app.patch(
    "/production-orders/:id",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_UPDATE) },
    (req) =>
      production.updateOrder(
        db,
        operationContext(req),
        orderId(req.params),
        parseInput(updateProductionOrderSchema, req.body),
        canSeeCosts(req),
      ),
  );
  app.post(
    "/production-orders/:id/plan",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_PLAN) },
    (req) => production.planOrder(db, operationContext(req), orderId(req.params), canSeeCosts(req)),
  );
  app.post(
    "/production-orders/:id/start",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_START) },
    (req) =>
      production.startOrder(db, operationContext(req), orderId(req.params), canSeeCosts(req)),
  );
  app.post(
    "/production-orders/:id/cancel",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_CANCEL) },
    (req) =>
      production.cancelOrder(
        db,
        operationContext(req),
        orderId(req.params),
        parseInput(cancelProductionSchema, req.body ?? {}).reason,
        canSeeCosts(req),
      ),
  );
  app.put(
    "/production-orders/:id/actuals",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_UPDATE) },
    (req) =>
      production.updateActuals(
        db,
        operationContext(req),
        orderId(req.params),
        parseInput(productionActualsSchema, req.body),
        canSeeCosts(req),
      ),
  );
  app.post(
    "/production-orders/:id/extra-materials",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_ADD_EXTRA_MATERIAL) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await production.addExtraMaterial(
            db,
            operationContext(req),
            orderId(req.params),
            parseInput(extraMaterialSchema, req.body),
            canSeeCosts(req),
          ),
        ),
  );
  app.delete(
    "/production-orders/:id/extra-materials/:lineId",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_ADD_EXTRA_MATERIAL) },
    (req) =>
      production.removeExtraMaterial(
        db,
        operationContext(req),
        orderId(req.params),
        lineId(req.params),
        canSeeCosts(req),
      ),
  );
  app.post(
    "/production-orders/:id/complete",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_COMPLETE) },
    (req) =>
      production.completeOrder(
        db,
        operationContext(req),
        orderId(req.params),
        parseInput(completeProductionSchema, req.body ?? {}),
        canSeeCosts(req),
      ),
  );
  app.get(
    "/production-orders/:id/availability",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_READ) },
    (req) => production.getAvailability(db, operationContext(req), orderId(req.params)),
  );
  app.get(
    "/production-orders/:id/cost-comparison",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_READ, P.PRODUCTION_COST_READ) },
    (req) => production.getCostComparison(db, operationContext(req), orderId(req.params)),
  );
  app.get(
    "/production-orders/:id/movements",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_READ) },
    (req) =>
      production.listOrderMovements(
        db,
        operationContext(req),
        orderId(req.params),
        canSeeCosts(req),
      ),
  );
  app.get(
    "/production/responsibles",
    { preHandler: requirePermission(P.PRODUCTION_ORDERS_READ) },
    (req) => production.listResponsibles(db, operationContext(req)),
  );
}
