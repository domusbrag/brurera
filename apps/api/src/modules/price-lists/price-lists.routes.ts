import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  priceListItemSchema,
  priceListQuerySchema,
  priceListSchema,
  resolvePricesQuerySchema,
  updatePriceListSchema,
} from "@bakery/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { operationContext } from "../../lib/context.js";
import { notFound } from "../../lib/db-errors.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as service from "./price-lists.service.js";

const itemParams = z.object({ id: z.string().uuid(), productId: z.string().uuid() });

/** Listas de precios (Fase 5B). Ver precios exige price_lists.read. */
export async function priceListRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const perms = (req: FastifyRequest) => req.auth?.permissions ?? [];
  const listId = (params: unknown) => idParam(params, "Lista de precios");
  const manage = { preHandler: requirePermission(P.PRICE_LISTS_MANAGE) };

  app.get("/price-lists", { preHandler: requirePermission(P.PRICE_LISTS_READ) }, (req) =>
    service.listPriceLists(db, operationContext(req), parseInput(priceListQuerySchema, req.query)),
  );
  app.get("/price-lists/resolve", { preHandler: requirePermission(P.PRICE_LISTS_READ) }, (req) => {
    const q = parseInput(resolvePricesQuerySchema, req.query);
    return service.resolveForCustomer(db, operationContext(req), q.customerId ?? null, q.productIds);
  });
  app.get("/price-lists/:id", { preHandler: requirePermission(P.PRICE_LISTS_READ) }, (req) =>
    service.getPriceList(db, operationContext(req), listId(req.params), perms(req)),
  );
  app.post("/price-lists", manage, async (req, reply) =>
    reply
      .status(201)
      .send(
        await service.createPriceList(
          db,
          operationContext(req),
          parseInput(priceListSchema, req.body),
          perms(req),
        ),
      ),
  );
  app.patch("/price-lists/:id", manage, (req) =>
    service.updatePriceList(
      db,
      operationContext(req),
      listId(req.params),
      parseInput(updatePriceListSchema, req.body),
      perms(req),
    ),
  );
  app.put("/price-lists/:id/items/:productId", manage, (req) => {
    const params = itemParams.safeParse(req.params);
    if (!params.success) throw notFound("Lista de precios");
    return service.setPriceListItem(
      db,
      operationContext(req),
      params.data.id,
      params.data.productId,
      parseInput(priceListItemSchema, req.body),
      perms(req),
    );
  });
}
