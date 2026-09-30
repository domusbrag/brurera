import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  createWarehouseSchema,
  listQuerySchema,
  updateWarehouseSchema,
} from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as service from "./warehouses.service.js";

export async function warehouseRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const manage = { preHandler: requirePermission(P.WAREHOUSES_MANAGE) };
  app.get("/warehouses", { preHandler: requirePermission(P.WAREHOUSES_READ) }, (req) =>
    service.listWarehouses(db, operationContext(req), parseInput(listQuerySchema, req.query)),
  );
  app.get("/warehouses/:id", { preHandler: requirePermission(P.WAREHOUSES_READ) }, (req) =>
    service.getWarehouse(db, operationContext(req), idParam(req.params, "Depósito")),
  );
  app.post("/warehouses", manage, async (req, reply) =>
    reply
      .status(201)
      .send(
        await service.createWarehouse(
          db,
          operationContext(req),
          parseInput(createWarehouseSchema, req.body),
        ),
      ),
  );
  app.patch("/warehouses/:id", manage, (req) =>
    service.updateWarehouse(
      db,
      operationContext(req),
      idParam(req.params, "Depósito"),
      parseInput(updateWarehouseSchema, req.body),
    ),
  );
  app.post("/warehouses/:id/deactivate", manage, (req) =>
    service.setWarehouseActive(db, operationContext(req), idParam(req.params, "Depósito"), false),
  );
  app.post("/warehouses/:id/activate", manage, (req) =>
    service.setWarehouseActive(db, operationContext(req), idParam(req.params, "Depósito"), true),
  );
}
