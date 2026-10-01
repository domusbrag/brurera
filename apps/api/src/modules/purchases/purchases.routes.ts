import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  cancelPurchaseSchema,
  createPurchaseSchema,
  createReceiptSchema,
  purchaseListQuerySchema,
  updatePurchaseSchema,
  updateReceiptSchema,
} from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as purchasesService from "./purchases.service.js";
import * as receipts from "./receipts.service.js";

/** Compras y recepciones (Fase 3). Sólo una recepción confirmada mueve stock. */
export async function purchaseRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const purchaseId = (params: unknown) => idParam(params, "Compra");
  const receiptId = (params: unknown) => idParam(params, "Recepción");

  app.get("/purchases", { preHandler: requirePermission(P.PURCHASES_READ) }, (req) =>
    purchasesService.listPurchases(
      db,
      operationContext(req),
      parseInput(purchaseListQuerySchema, req.query),
    ),
  );
  app.post(
    "/purchases",
    { preHandler: requirePermission(P.PURCHASES_CREATE) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await purchasesService.createPurchase(
            db,
            operationContext(req),
            parseInput(createPurchaseSchema, req.body),
          ),
        ),
  );
  app.get("/purchases/:id", { preHandler: requirePermission(P.PURCHASES_READ) }, (req) =>
    purchasesService.getPurchase(db, operationContext(req), purchaseId(req.params)),
  );
  app.patch("/purchases/:id", { preHandler: requirePermission(P.PURCHASES_UPDATE) }, (req) =>
    purchasesService.updatePurchase(
      db,
      operationContext(req),
      purchaseId(req.params),
      parseInput(updatePurchaseSchema, req.body),
    ),
  );
  app.post("/purchases/:id/order", { preHandler: requirePermission(P.PURCHASES_ORDER) }, (req) =>
    purchasesService.orderPurchase(db, operationContext(req), purchaseId(req.params)),
  );
  app.post("/purchases/:id/cancel", { preHandler: requirePermission(P.PURCHASES_CANCEL) }, (req) =>
    purchasesService.cancelPurchase(
      db,
      operationContext(req),
      purchaseId(req.params),
      parseInput(cancelPurchaseSchema, req.body ?? {}),
    ),
  );

  /* ---- Recepciones ---- */
  app.get("/purchases/:id/receipts", { preHandler: requirePermission(P.PURCHASES_READ) }, (req) =>
    receipts.listReceiptsOf(db, operationContext(req), purchaseId(req.params)),
  );
  app.post(
    "/purchases/:id/receipts",
    { preHandler: requirePermission(P.PURCHASES_RECEIVE) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await receipts.createReceipt(
            db,
            operationContext(req),
            purchaseId(req.params),
            parseInput(createReceiptSchema, req.body),
          ),
        ),
  );
  app.get("/purchase-receipts/:id", { preHandler: requirePermission(P.PURCHASES_READ) }, (req) =>
    receipts.getReceipt(db, operationContext(req), receiptId(req.params)),
  );
  app.patch(
    "/purchase-receipts/:id",
    { preHandler: requirePermission(P.PURCHASES_RECEIVE) },
    (req) =>
      receipts.updateReceipt(
        db,
        operationContext(req),
        receiptId(req.params),
        parseInput(updateReceiptSchema, req.body),
      ),
  );
  app.post(
    "/purchase-receipts/:id/post",
    { preHandler: requirePermission(P.PURCHASES_RECEIVE) },
    (req) => receipts.postReceipt(db, operationContext(req), receiptId(req.params)),
  );
  app.post(
    "/purchase-receipts/:id/cancel",
    { preHandler: requirePermission(P.PURCHASES_RECEIVE) },
    (req) => receipts.cancelReceipt(db, operationContext(req), receiptId(req.params)),
  );
}
