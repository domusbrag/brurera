import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  convertQuerySchema,
  createUnitSchema,
  listQuerySchema,
  updateUnitSchema,
} from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as service from "./units.service.js";

export async function unitRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const read = { preHandler: requirePermission(P.UNITS_READ) };
  const manage = { preHandler: requirePermission(P.UNITS_MANAGE) };
  app.get("/units", read, (req) =>
    service.listUnits(db, operationContext(req), parseInput(listQuerySchema, req.query)),
  );
  // Declarada antes de /units/:id para que "convert" no se tome como id.
  app.get("/units/convert", read, (req) =>
    service.convert(db, operationContext(req), parseInput(convertQuerySchema, req.query)),
  );
  app.get("/units/:id", read, (req) =>
    service.getUnit(db, operationContext(req), idParam(req.params, "Unidad")),
  );
  app.post("/units", manage, async (req, reply) =>
    reply
      .status(201)
      .send(
        await service.createUnit(db, operationContext(req), parseInput(createUnitSchema, req.body)),
      ),
  );
  app.patch("/units/:id", manage, (req) =>
    service.updateUnit(
      db,
      operationContext(req),
      idParam(req.params, "Unidad"),
      parseInput(updateUnitSchema, req.body),
    ),
  );
}
