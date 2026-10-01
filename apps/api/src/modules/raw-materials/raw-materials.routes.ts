import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  createRawMaterialSchema,
  listQuerySchema,
  updateRawMaterialSchema,
} from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as service from "./raw-materials.service.js";

const itemListQuery = listQuerySchema.extend({ categoryId: z.string().uuid().optional() });

export async function rawMaterialRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  app.get("/raw-materials", { preHandler: requirePermission(P.RAW_MATERIALS_READ) }, (req) =>
    service.listRawMaterials(db, operationContext(req), parseInput(itemListQuery, req.query)),
  );
  app.get("/raw-materials/:id", { preHandler: requirePermission(P.RAW_MATERIALS_READ) }, (req) =>
    service.getRawMaterial(db, operationContext(req), idParam(req.params, "Materia prima")),
  );
  app.post(
    "/raw-materials",
    { preHandler: requirePermission(P.RAW_MATERIALS_CREATE) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await service.createRawMaterial(
            db,
            operationContext(req),
            parseInput(createRawMaterialSchema, req.body),
          ),
        ),
  );
  app.patch(
    "/raw-materials/:id",
    { preHandler: requirePermission(P.RAW_MATERIALS_UPDATE) },
    (req) =>
      service.updateRawMaterial(
        db,
        operationContext(req),
        idParam(req.params, "Materia prima"),
        parseInput(updateRawMaterialSchema, req.body),
      ),
  );
  app.post(
    "/raw-materials/:id/deactivate",
    { preHandler: requirePermission(P.RAW_MATERIALS_DEACTIVATE) },
    (req) =>
      service.setRawMaterialActive(
        db,
        operationContext(req),
        idParam(req.params, "Materia prima"),
        false,
      ),
  );
  app.post(
    "/raw-materials/:id/activate",
    { preHandler: requirePermission(P.RAW_MATERIALS_DEACTIVATE) },
    (req) =>
      service.setRawMaterialActive(
        db,
        operationContext(req),
        idParam(req.params, "Materia prima"),
        true,
      ),
  );
}
