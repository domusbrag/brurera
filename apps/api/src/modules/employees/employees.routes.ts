import type { Database } from "@bakery/database";
import {
  PERMISSIONS,
  createEmployeeSchema,
  deactivateEmployeeSchema,
  listQuerySchema,
  updateEmployeeSchema,
} from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { idParam } from "../../lib/params.js";
import { requirePermission } from "../auth/auth.plugin.js";
import * as service from "./employees.service.js";

export async function employeeRoutes(app: FastifyInstance, { db }: { db: Database }) {
  const P = PERMISSIONS;
  app.get("/employees", { preHandler: requirePermission(P.EMPLOYEES_READ) }, (req) =>
    service.listEmployees(db, operationContext(req), parseInput(listQuerySchema, req.query)),
  );
  app.get("/employees/:id", { preHandler: requirePermission(P.EMPLOYEES_READ) }, (req) =>
    service.getEmployee(db, operationContext(req), idParam(req.params, "Empleado")),
  );
  app.post(
    "/employees",
    { preHandler: requirePermission(P.EMPLOYEES_CREATE) },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await service.createEmployee(
            db,
            operationContext(req),
            parseInput(createEmployeeSchema, req.body),
          ),
        ),
  );
  app.patch("/employees/:id", { preHandler: requirePermission(P.EMPLOYEES_UPDATE) }, (req) =>
    service.updateEmployee(
      db,
      operationContext(req),
      idParam(req.params, "Empleado"),
      parseInput(updateEmployeeSchema, req.body),
    ),
  );
  app.post(
    "/employees/:id/deactivate",
    { preHandler: requirePermission(P.EMPLOYEES_DEACTIVATE) },
    (req) =>
      service.deactivateEmployee(
        db,
        operationContext(req),
        idParam(req.params, "Empleado"),
        parseInput(deactivateEmployeeSchema, req.body ?? {}).terminationDate,
      ),
  );
  app.post(
    "/employees/:id/activate",
    { preHandler: requirePermission(P.EMPLOYEES_DEACTIVATE) },
    (req) => service.reactivateEmployee(db, operationContext(req), idParam(req.params, "Empleado")),
  );
}
