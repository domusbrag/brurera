import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  createRecipeSchema,
  createRecipeVersionSchema,
  effectiveVersionQuerySchema,
  publishRecipeVersionSchema,
  recipeListQuerySchema,
  updateRecipeSchema,
  updateRecipeVersionSchema,
  versionDiffQuerySchema,
} from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as service from "./recipes.service.js";

/**
 * Recetas versionadas y costo teórico. La lógica de cálculo vive en
 * @bakery/domain; aquí sólo se cargan datos de la empresa de la sesión.
 */
export async function recipeRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  const recipeId = (params: unknown) => idParam(params, "Receta");
  const versionId = (params: unknown) => idParam(params, "Versión");

  /* ---- Recetas ---- */
  app.get("/recipes", { preHandler: requirePermission(P.RECIPES_READ) }, (req) =>
    service.listRecipes(db, operationContext(req), parseInput(recipeListQuerySchema, req.query)),
  );
  app.post("/recipes", { preHandler: requirePermission(P.RECIPES_CREATE) }, async (req, reply) =>
    reply
      .status(201)
      .send(
        await service.createRecipe(
          db,
          operationContext(req),
          parseInput(createRecipeSchema, req.body),
        ),
      ),
  );
  app.get("/recipes/:id", { preHandler: requirePermission(P.RECIPES_READ) }, (req) =>
    service.getRecipe(db, operationContext(req), recipeId(req.params)),
  );
  app.patch("/recipes/:id", { preHandler: requirePermission(P.RECIPES_UPDATE) }, (req) =>
    service.updateRecipe(
      db,
      operationContext(req),
      recipeId(req.params),
      parseInput(updateRecipeSchema, req.body),
    ),
  );
  app.post("/recipes/:id/deactivate", { preHandler: requirePermission(P.RECIPES_ARCHIVE) }, (req) =>
    service.setRecipeActive(db, operationContext(req), recipeId(req.params), false),
  );
  app.post("/recipes/:id/activate", { preHandler: requirePermission(P.RECIPES_ARCHIVE) }, (req) =>
    service.setRecipeActive(db, operationContext(req), recipeId(req.params), true),
  );
  app.get("/recipes/:id/versions", { preHandler: requirePermission(P.RECIPES_READ) }, (req) =>
    service.listVersions(db, operationContext(req), recipeId(req.params)),
  );
  app.post(
    "/recipes/:id/versions",
    { preHandler: requirePermission(P.RECIPES_CREATE) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await service.createVersion(
            db,
            operationContext(req),
            recipeId(req.params),
            parseInput(createRecipeVersionSchema, req.body ?? {}),
          ),
        ),
  );
  app.get("/recipes/:id/current-cost", { preHandler: requirePermission(P.RECIPES_READ) }, (req) =>
    service.getRecipeCurrentCost(db, operationContext(req), recipeId(req.params)),
  );
  app.get(
    "/recipes/:id/effective-version",
    { preHandler: requirePermission(P.RECIPES_READ) },
    (req) =>
      service.getEffectiveVersion(
        db,
        operationContext(req),
        recipeId(req.params),
        new Date(parseInput(effectiveVersionQuerySchema, req.query).at),
      ),
  );

  /* ---- Versiones ---- */
  app.get("/recipe-versions/:id", { preHandler: requirePermission(P.RECIPES_READ) }, (req) =>
    service.getVersion(db, operationContext(req), versionId(req.params)),
  );
  app.patch("/recipe-versions/:id", { preHandler: requirePermission(P.RECIPES_UPDATE) }, (req) =>
    service.updateVersion(
      db,
      operationContext(req),
      versionId(req.params),
      parseInput(updateRecipeVersionSchema, req.body),
    ),
  );
  app.post(
    "/recipe-versions/:id/publish",
    { preHandler: requirePermission(P.RECIPES_PUBLISH) },
    (req) =>
      service.publishVersion(
        db,
        operationContext(req),
        versionId(req.params),
        parseInput(publishRecipeVersionSchema, req.body ?? {}),
      ),
  );
  app.post(
    "/recipe-versions/:id/duplicate",
    { preHandler: requirePermission(P.RECIPES_CREATE) },
    async (req, reply) =>
      reply
        .status(201)
        .send(await service.duplicateVersion(db, operationContext(req), versionId(req.params))),
  );
  app.post(
    "/recipe-versions/:id/discard",
    { preHandler: requirePermission(P.RECIPES_UPDATE) },
    (req) => service.discardVersion(db, operationContext(req), versionId(req.params)),
  );
  app.post(
    "/recipe-versions/:id/archive",
    { preHandler: requirePermission(P.RECIPES_ARCHIVE) },
    (req) => service.archiveVersion(db, operationContext(req), versionId(req.params)),
  );
  app.get("/recipe-versions/:id/cost", { preHandler: requirePermission(P.RECIPES_READ) }, (req) =>
    service.getVersionCost(db, operationContext(req), versionId(req.params)),
  );
  app.get("/recipe-versions/:id/diff", { preHandler: requirePermission(P.RECIPES_READ) }, (req) =>
    service.getVersionDiff(
      db,
      operationContext(req),
      versionId(req.params),
      parseInput(versionDiffQuerySchema, req.query).against,
    ),
  );
}
