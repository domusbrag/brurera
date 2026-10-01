import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  createProductSchema,
  listQuerySchema,
  updateProductSchema,
} from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as service from "./products.service.js";

const itemListQuery = listQuerySchema.extend({ categoryId: z.string().uuid().optional() });

export async function productRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  app.get("/products", { preHandler: requirePermission(P.PRODUCTS_READ) }, (req) =>
    service.listProducts(db, operationContext(req), parseInput(itemListQuery, req.query)),
  );
  app.get("/products/:id", { preHandler: requirePermission(P.PRODUCTS_READ) }, (req) =>
    service.getProduct(db, operationContext(req), idParam(req.params, "Producto")),
  );
  app.post("/products", { preHandler: requirePermission(P.PRODUCTS_CREATE) }, async (req, reply) =>
    reply
      .status(201)
      .send(
        await service.createProduct(
          db,
          operationContext(req),
          parseInput(createProductSchema, req.body),
        ),
      ),
  );
  app.patch("/products/:id", { preHandler: requirePermission(P.PRODUCTS_UPDATE) }, (req) =>
    service.updateProduct(
      db,
      operationContext(req),
      idParam(req.params, "Producto"),
      parseInput(updateProductSchema, req.body),
    ),
  );
  app.post(
    "/products/:id/deactivate",
    { preHandler: requirePermission(P.PRODUCTS_DEACTIVATE) },
    (req) =>
      service.setProductActive(db, operationContext(req), idParam(req.params, "Producto"), false),
  );
  app.post(
    "/products/:id/activate",
    { preHandler: requirePermission(P.PRODUCTS_DEACTIVATE) },
    (req) =>
      service.setProductActive(db, operationContext(req), idParam(req.params, "Producto"), true),
  );
}
