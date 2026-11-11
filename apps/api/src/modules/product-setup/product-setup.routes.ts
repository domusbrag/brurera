import type { Database } from "@bakery/database";
import { PERMISSIONS, productSetupSchema } from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { requirePermission } from "../auth/auth.plugin.js";
import { setupProduct } from "./product-setup.service.js";

/**
 * Alta de producto de corrido (categoría, insumos, producto, receta y precios en
 * una sola operación). Exige products.create; cada parte opcional exige además
 * su propio permiso (ver product-setup.service.ts).
 */
export async function productSetupRoutes(app: FastifyInstance, { db }: { db: Database }) {
  app.post(
    "/product-setup",
    { preHandler: requirePermission(PERMISSIONS.PRODUCTS_CREATE) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await setupProduct(
            db,
            operationContext(req),
            parseInput(productSetupSchema, req.body),
            req.auth?.permissions ?? [],
          ),
        ),
  );
}
