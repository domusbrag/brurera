import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  cancelSaleSchema,
  hasPermissions,
  createSaleSchema,
  postSaleSchema,
  saleListQuerySchema,
  updateSaleSchema,
} from "@bakery/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { operationContext } from "../../lib/context.js";
import { forbidden, parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import { listSales, getSaleDetail } from "./sales.data.js";
import * as sales from "./sales.service.js";

/**
 * Ventas y entregas (Fase 5B). Ningún GET escribe: la vista previa de la
 * entrega es GET /sales/:id/preview y confirmar es POST /sales/:id/post.
 */
export async function saleRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const saleId = (params: unknown) => idParam(params, "Venta");
  const viewer = (req: FastifyRequest) => ({ permissions: req.auth?.permissions ?? [] });

  app.get("/sales", { preHandler: requirePermission(P.SALES_READ) }, (req) =>
    listSales(db, operationContext(req), parseInput(saleListQuerySchema, req.query), viewer(req)),
  );
  app.get("/sales/:id", { preHandler: requirePermission(P.SALES_READ) }, (req) =>
    getSaleDetail(db, operationContext(req), saleId(req.params), viewer(req)),
  );
  app.post("/sales", { preHandler: requirePermission(P.SALES_CREATE) }, async (req, reply) =>
    reply
      .status(201)
      .send(
        await sales.createSale(
          db,
          operationContext(req),
          parseInput(createSaleSchema, req.body),
          viewer(req),
        ),
      ),
  );
  app.patch("/sales/:id", { preHandler: requirePermission(P.SALES_UPDATE) }, (req) =>
    sales.updateSale(
      db,
      operationContext(req),
      saleId(req.params),
      parseInput(updateSaleSchema, req.body),
      viewer(req),
    ),
  );
  app.get("/sales/:id/preview", { preHandler: requirePermission(P.SALES_READ) }, (req) =>
    sales.previewSale(db, operationContext(req), saleId(req.params), viewer(req)),
  );
  app.post("/sales/:id/post", { preHandler: requirePermission(P.SALES_POST) }, (req) => {
    const input = parseInput(postSaleSchema, req.body ?? {});
    // Cobrar en el momento exige además poder registrar cobros.
    if (input.initialPayment && !hasPermissions(viewer(req).permissions, [P.PAYMENTS_CREATE, P.PAYMENTS_POST])) {
      throw forbidden();
    }
    return sales.postSale(db, operationContext(req), saleId(req.params), input, viewer(req));
  });
  app.post("/sales/:id/cancel", { preHandler: requirePermission(P.SALES_UPDATE) }, (req) =>
    sales.cancelSale(
      db,
      operationContext(req),
      saleId(req.params),
      parseInput(cancelSaleSchema, req.body),
      viewer(req),
    ),
  );
}
