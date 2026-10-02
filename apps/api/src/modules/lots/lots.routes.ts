import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  availabilityQuerySchema,
  blockLotSchema,
  conservationProfileSchema,
  expiringQuerySchema,
  hasPermissions,
  lotWasteSchema,
  productLotsQuerySchema,
  transformLotSchema,
} from "@bakery/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as conservation from "./conservation.service.js";
import * as lots from "./lots.service.js";

/**
 * Lotes de producto terminado, conservación y vida útil (Fase 4.5). Los costos
 * de lote (unitario, valor) siguen inventory.cost.read, como el resto del inventario.
 */
export async function lotRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const productId = (params: unknown) => idParam(params, "Producto");
  const lotId = (params: unknown) => idParam(params, "Lote");
  const canSeeCosts = (req: FastifyRequest) =>
    hasPermissions(req.auth?.permissions ?? [], [P.INVENTORY_COST_READ]);

  /* ---- Conservación del producto ---- */
  app.get(
    "/products/:id/conservation",
    { preHandler: requirePermission(P.PRODUCT_CONSERVATION_READ) },
    (req) => conservation.getConservation(db, operationContext(req), productId(req.params)),
  );
  app.put(
    "/products/:id/conservation",
    { preHandler: requirePermission(P.PRODUCT_CONSERVATION_MANAGE) },
    (req) =>
      conservation.updateConservation(
        db,
        operationContext(req),
        productId(req.params),
        parseInput(conservationProfileSchema, req.body),
      ),
  );

  /* ---- Lotes por producto, disponibilidad y vencimientos ---- */
  app.get(
    "/inventory/products/:id/lots",
    { preHandler: requirePermission(P.PRODUCT_LOTS_READ) },
    (req) =>
      lots.listProductLots(
        db,
        operationContext(req),
        productId(req.params),
        parseInput(productLotsQuerySchema, req.query),
        canSeeCosts(req),
      ),
  );
  app.get(
    "/inventory/products/:id/availability",
    { preHandler: requirePermission(P.PRODUCT_LOTS_READ) },
    (req) => {
      const query = parseInput(availabilityQuerySchema, req.query);
      return lots.calculateProductAvailabilityAt(
        db,
        operationContext(req),
        productId(req.params),
        query.warehouseId ?? null,
        new Date(query.at),
      );
    },
  );
  app.get(
    "/inventory/expiring",
    { preHandler: requirePermission(P.INVENTORY_EXPIRY_READ) },
    (req) =>
      lots.listExpiring(
        db,
        operationContext(req),
        parseInput(expiringQuerySchema, req.query),
        canSeeCosts(req),
      ),
  );

  /* ---- Lote ---- */
  app.get("/product-lots/:id", { preHandler: requirePermission(P.PRODUCT_LOTS_READ) }, (req) =>
    lots.getLot(
      db,
      operationContext(req),
      lotId(req.params),
      canSeeCosts(req),
      req.auth?.permissions ?? [],
    ),
  );
  app.post(
    "/product-lots/:id/transform",
    { preHandler: requirePermission(P.PRODUCT_LOTS_TRANSFORM) },
    async (req, reply) => {
      const result = await lots.transformLot(
        db,
        operationContext(req),
        lotId(req.params),
        parseInput(transformLotSchema, req.body),
        canSeeCosts(req),
      );
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );
  app.post(
    "/product-lots/:id/waste",
    { preHandler: requirePermission(P.PRODUCT_LOTS_WASTE) },
    async (req, reply) => {
      const result = await lots.wasteLot(
        db,
        operationContext(req),
        lotId(req.params),
        parseInput(lotWasteSchema, req.body),
        canSeeCosts(req),
      );
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );
  app.post(
    "/product-lots/:id/block",
    { preHandler: requirePermission(P.PRODUCT_LOTS_QUALITY) },
    (req) =>
      lots.setLotQuality(
        db,
        operationContext(req),
        lotId(req.params),
        true,
        parseInput(blockLotSchema, req.body),
        canSeeCosts(req),
      ),
  );
  app.post(
    "/product-lots/:id/unblock",
    { preHandler: requirePermission(P.PRODUCT_LOTS_QUALITY) },
    (req) =>
      lots.setLotQuality(
        db,
        operationContext(req),
        lotId(req.params),
        false,
        null,
        canSeeCosts(req),
      ),
  );
}
