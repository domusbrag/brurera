import type { Database } from "@bakery/database";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

export type CheckStatus = "ok" | "error";

export interface HealthResponse {
  status: CheckStatus;
  checks: { api: CheckStatus; database: CheckStatus };
  time: string;
}

/** Health check: API arriba + base accesible. 503 si alguna dependencia falla. */
export async function healthRoutes(app: FastifyInstance, opts: { db: Database }) {
  app.get("/health", async (request, reply) => {
    let database: CheckStatus = "ok";
    try {
      await opts.db.execute(sql`select 1`);
    } catch (err) {
      database = "error";
      request.log.error({ err }, "health: base de datos inaccesible");
    }
    const body: HealthResponse = {
      status: database === "ok" ? "ok" : "error",
      checks: { api: "ok", database },
      time: new Date().toISOString(),
    };
    return reply.status(body.status === "ok" ? 200 : 503).send(body);
  });
}
