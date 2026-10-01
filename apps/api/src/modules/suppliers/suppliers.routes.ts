import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  createSupplierSchema,
  listQuerySchema,
  updateSupplierSchema,
} from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as service from "./suppliers.service.js";

export async function supplierRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  app.get("/suppliers", { preHandler: requirePermission(P.SUPPLIERS_READ) }, (req) =>
    service.listSuppliers(db, operationContext(req), parseInput(listQuerySchema, req.query)),
  );
  app.get("/suppliers/:id", { preHandler: requirePermission(P.SUPPLIERS_READ) }, (req) =>
    service.getSupplier(db, operationContext(req), idParam(req.params, "Proveedor")),
  );
  app.post(
    "/suppliers",
    { preHandler: requirePermission(P.SUPPLIERS_CREATE) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await service.createSupplier(
            db,
            operationContext(req),
            parseInput(createSupplierSchema, req.body),
          ),
        ),
  );
  app.patch("/suppliers/:id", { preHandler: requirePermission(P.SUPPLIERS_UPDATE) }, (req) =>
    service.updateSupplier(
      db,
      operationContext(req),
      idParam(req.params, "Proveedor"),
      parseInput(updateSupplierSchema, req.body),
    ),
  );
  app.post(
    "/suppliers/:id/deactivate",
    { preHandler: requirePermission(P.SUPPLIERS_DEACTIVATE) },
    (req) =>
      service.setSupplierActive(db, operationContext(req), idParam(req.params, "Proveedor"), false),
  );
  app.post(
    "/suppliers/:id/activate",
    { preHandler: requirePermission(P.SUPPLIERS_DEACTIVATE) },
    (req) =>
      service.setSupplierActive(db, operationContext(req), idParam(req.params, "Proveedor"), true),
  );
}
