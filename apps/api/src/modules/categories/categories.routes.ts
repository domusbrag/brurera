import type { Database } from "@bakery/database";
import {
  CATEGORY_TYPES,
  PERMISSIONS,
  createCategorySchema,
  listQuerySchema,
  updateCategorySchema,
} from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as service from "./categories.service.js";

const categoryListQuery = listQuerySchema.extend({ type: z.enum(CATEGORY_TYPES).optional() });

export async function categoryRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const read = { preHandler: requirePermission(P.CATEGORIES_READ) };
  const manage = { preHandler: requirePermission(P.CATEGORIES_MANAGE) };
  app.get("/categories", read, (req) =>
    service.listCategories(db, operationContext(req), parseInput(categoryListQuery, req.query)),
  );
  app.get("/categories/:id", read, (req) =>
    service.getCategory(db, operationContext(req), idParam(req.params, "Categoría")),
  );
  app.post("/categories", manage, async (req, reply) =>
    reply
      .status(201)
      .send(
        await service.createCategory(
          db,
          operationContext(req),
          parseInput(createCategorySchema, req.body),
        ),
      ),
  );
  app.patch("/categories/:id", manage, (req) =>
    service.updateCategory(
      db,
      operationContext(req),
      idParam(req.params, "Categoría"),
      parseInput(updateCategorySchema, req.body),
    ),
  );
}
