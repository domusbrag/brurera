import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  createCustomerSchema,
  listQuerySchema,
  updateCustomerSchema,
} from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as service from "./customers.service.js";

export async function customerRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  app.get("/customers", { preHandler: requirePermission(P.CUSTOMERS_READ) }, (req) =>
    service.listCustomers(db, operationContext(req), parseInput(listQuerySchema, req.query)),
  );
  app.get("/customers/:id", { preHandler: requirePermission(P.CUSTOMERS_READ) }, (req) =>
    service.getCustomer(db, operationContext(req), idParam(req.params, "Cliente")),
  );
  app.post(
    "/customers",
    { preHandler: requirePermission(P.CUSTOMERS_CREATE) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await service.createCustomer(
            db,
            operationContext(req),
            parseInput(createCustomerSchema, req.body),
          ),
        ),
  );
  app.patch("/customers/:id", { preHandler: requirePermission(P.CUSTOMERS_UPDATE) }, (req) =>
    service.updateCustomer(
      db,
      operationContext(req),
      idParam(req.params, "Cliente"),
      parseInput(updateCustomerSchema, req.body),
    ),
  );
  app.post(
    "/customers/:id/deactivate",
    { preHandler: requirePermission(P.CUSTOMERS_DEACTIVATE) },
    (req) =>
      service.setCustomerActive(db, operationContext(req), idParam(req.params, "Cliente"), false),
  );
  app.post(
    "/customers/:id/activate",
    { preHandler: requirePermission(P.CUSTOMERS_DEACTIVATE) },
    (req) =>
      service.setCustomerActive(db, operationContext(req), idParam(req.params, "Cliente"), true),
  );
}
