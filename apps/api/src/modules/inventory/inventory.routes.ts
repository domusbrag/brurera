import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  adjustmentSchema,
  costHistoryQuerySchema,
  hasPermissions,
  initialStockSchema,
  inventoryListQuerySchema,
  lowStockQuerySchema,
  movementListQuerySchema,
  wasteSchema,
} from "@bakery/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as inventory from "./inventory.service.js";

/**
 * Inventario de materias primas (Fase 3). El stock sólo cambia con movimientos;
 * la valorización (valor total, historial de costo) exige inventory.cost.read.
 */
export async function inventoryRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const materialId = (params: unknown) => idParam(params, "Materia prima");
  const canSeeCosts = (req: FastifyRequest) =>
    hasPermissions(req.auth?.permissions ?? [], [P.INVENTORY_COST_READ]);

  app.get("/inventory", { preHandler: requirePermission(P.INVENTORY_READ) }, (req) =>
    inventory.listInventory(
      db,
      operationContext(req),
      parseInput(inventoryListQuerySchema, req.query),
      canSeeCosts(req),
    ),
  );
  app.get(
    "/inventory/raw-materials/:id",
    { preHandler: requirePermission(P.INVENTORY_READ) },
    (req) =>
      inventory.getInventoryDetail(
        db,
        operationContext(req),
        materialId(req.params),
        canSeeCosts(req),
      ),
  );
  app.get("/inventory/movements", { preHandler: requirePermission(P.INVENTORY_READ) }, (req) =>
    inventory.listMovements(
      db,
      operationContext(req),
      parseInput(movementListQuerySchema, req.query),
      canSeeCosts(req),
    ),
  );
  app.get("/inventory/low-stock", { preHandler: requirePermission(P.INVENTORY_READ) }, (req) =>
    inventory.listLowStock(db, operationContext(req), parseInput(lowStockQuerySchema, req.query)),
  );
  app.get(
    "/inventory/costs/:id",
    { preHandler: requirePermission(P.INVENTORY_READ, P.INVENTORY_COST_READ) },
    (req) =>
      inventory.getInventoryCost(
        db,
        operationContext(req),
        materialId(req.params),
        parseInput(costHistoryQuerySchema, req.query),
      ),
  );
  app.post(
    "/inventory/initial-stock",
    { preHandler: requirePermission(P.INVENTORY_INITIAL_STOCK) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await inventory.postInitialStock(
            db,
            operationContext(req),
            parseInput(initialStockSchema, req.body),
            canSeeCosts(req),
          ),
        ),
  );
  app.post(
    "/inventory/adjustments",
    { preHandler: requirePermission(P.INVENTORY_ADJUST) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await inventory.postAdjustment(
            db,
            operationContext(req),
            parseInput(adjustmentSchema, req.body),
            canSeeCosts(req),
          ),
        ),
  );
  app.post(
    "/inventory/waste",
    { preHandler: requirePermission(P.INVENTORY_WASTE) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await inventory.postWaste(
            db,
            operationContext(req),
            parseInput(wasteSchema, req.body),
            canSeeCosts(req),
          ),
        ),
  );
}
