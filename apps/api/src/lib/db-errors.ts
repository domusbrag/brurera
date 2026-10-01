import { AppError } from "./errors.js";

interface PgError {
  code?: string;
  constraint?: string;
}

/** Drizzle envuelve el error del driver en `cause`. */
function pgError(err: unknown): PgError | null {
  if (typeof err !== "object" || err === null) return null;
  const direct = err as PgError;
  if (typeof direct.code === "string") return direct;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null && typeof (cause as PgError).code === "string") {
    return cause as PgError;
  }
  return null;
}

/**
 * Traduce violaciones de unicidad conocidas (por nombre de constraint) a errores
 * de negocio 409. Cualquier otro error se relanza sin tocar.
 */
export async function mapUniqueViolations<T>(
  operation: Promise<T>,
  byConstraint: Record<string, () => AppError>,
): Promise<T> {
  try {
    return await operation;
  } catch (err) {
    const pg = pgError(err);
    if (pg?.code === "23505" && pg.constraint && byConstraint[pg.constraint]) {
      throw byConstraint[pg.constraint]!();
    }
    throw err;
  }
}

export const codeTaken = (code: string) =>
  new AppError(409, "CODE_TAKEN", `El código ${code} ya está en uso`, [
    { path: "code", message: "Código en uso" },
  ]);

export const notFound = (what = "Recurso") => new AppError(404, "NOT_FOUND", `${what} inexistente`);

export const invalidReference = (field: string, message: string) =>
  new AppError(422, "INVALID_REFERENCE", message, [{ path: field, message }]);
