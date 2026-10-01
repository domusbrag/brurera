import type { Database } from "@bakery/database";
import { PERMISSIONS, createPresentationSchema, updatePresentationSchema } from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as service from "./presentations.service.js";

const listQuery = z.object({ status: z.enum(["active", "inactive", "all"]).default("all") });

/** Presentaciones de compra por materia prima (Fase 3). */
export async function presentationRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const presentationId = (params: unknown) => idParam(params, "Presentación");

  app.get(
    "/raw-materials/:id/presentations",
    { preHandler: requirePermission(P.PRESENTATIONS_READ) },
    (req) =>
      service.listPresentations(
        db,
        operationContext(req),
        idParam(req.params, "Materia prima"),
        parseInput(listQuery, req.query).status,
      ),
  );
  app.post(
    "/raw-materials/:id/presentations",
    { preHandler: requirePermission(P.PRESENTATIONS_MANAGE) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await service.createPresentation(
            db,
            operationContext(req),
            idParam(req.params, "Materia prima"),
            parseInput(createPresentationSchema, req.body),
          ),
        ),
  );
  app.patch(
    "/raw-material-presentations/:id",
    { preHandler: requirePermission(P.PRESENTATIONS_MANAGE) },
    (req) =>
      service.renamePresentation(
        db,
        operationContext(req),
        presentationId(req.params),
        parseInput(updatePresentationSchema, req.body).name,
      ),
  );
  app.post(
    "/raw-material-presentations/:id/deactivate",
    { preHandler: requirePermission(P.PRESENTATIONS_MANAGE) },
    (req) =>
      service.setPresentationActive(db, operationContext(req), presentationId(req.params), false),
  );
  app.post(
    "/raw-material-presentations/:id/activate",
    { preHandler: requirePermission(P.PRESENTATIONS_MANAGE) },
    (req) =>
      service.setPresentationActive(db, operationContext(req), presentationId(req.params), true),
  );
}
