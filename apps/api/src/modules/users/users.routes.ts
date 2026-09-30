import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  assignRolesSchema,
  createUserSchema,
  listQuerySchema,
  updateUserSchema,
} from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as service from "./users.service.js";

export async function userRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  app.get("/users", { preHandler: requirePermission(P.USERS_READ) }, (req) =>
    service.listUsers(db, operationContext(req), parseInput(listQuerySchema, req.query)),
  );
  app.get("/users/:id", { preHandler: requirePermission(P.USERS_READ) }, (req) =>
    service.getUser(db, operationContext(req), idParam(req.params, "Usuario")),
  );
  // Crear un acceso incluye su rol inicial: exige ambos permisos.
  app.post(
    "/users",
    { preHandler: requirePermission(P.USERS_CREATE, P.USERS_ASSIGN_ROLES) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await service.createUser(
            db,
            operationContext(req),
            parseInput(createUserSchema, req.body),
          ),
        ),
  );
  app.patch("/users/:id", { preHandler: requirePermission(P.USERS_UPDATE) }, (req) =>
    service.updateUser(
      db,
      operationContext(req),
      idParam(req.params, "Usuario"),
      parseInput(updateUserSchema, req.body),
    ),
  );
  app.put("/users/:id/roles", { preHandler: requirePermission(P.USERS_ASSIGN_ROLES) }, (req) =>
    service.setUserRoles(
      db,
      operationContext(req),
      idParam(req.params, "Usuario"),
      parseInput(assignRolesSchema, req.body).roleIds,
    ),
  );
  app.post("/users/:id/deactivate", { preHandler: requirePermission(P.USERS_DEACTIVATE) }, (req) =>
    service.setUserActive(db, operationContext(req), idParam(req.params, "Usuario"), false),
  );
  app.post("/users/:id/activate", { preHandler: requirePermission(P.USERS_DEACTIVATE) }, (req) =>
    service.setUserActive(db, operationContext(req), idParam(req.params, "Usuario"), true),
  );
}
