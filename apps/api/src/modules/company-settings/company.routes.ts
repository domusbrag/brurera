import type { Database } from "@bakery/database";
import { PERMISSIONS, updateCompanySchema } from "@bakery/shared";
import type { FastifyInstance } from "fastify";
import { operationContext } from "../../lib/context.js";
import { parseInput } from "../../lib/errors.js";
import { requirePermission } from "../auth/auth.plugin.js";
import { getCompany, updateCompany } from "./company.service.js";

export async function companyRoutes(app: FastifyInstance, { db }: { db: Database }) {
  app.get("/company", { preHandler: requirePermission(PERMISSIONS.COMPANY_READ) }, (request) =>
    getCompany(db, operationContext(request)),
  );
  app.patch("/company", { preHandler: requirePermission(PERMISSIONS.COMPANY_UPDATE) }, (request) =>
    updateCompany(db, operationContext(request), parseInput(updateCompanySchema, request.body)),
  );
}
