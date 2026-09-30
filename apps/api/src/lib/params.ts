import { z } from "zod";
import { parseInput } from "./errors.js";
import { notFound } from "./db-errors.js";

const idParamSchema = z.object({ id: z.string() });

/**
 * Id de ruta. Un valor que no es UUID se trata como inexistente (404), igual que
 * un UUID de otra empresa: la API no distingue "no existe" de "no es tuyo".
 */
export function idParam(params: unknown, what?: string): string {
  const { id } = parseInput(idParamSchema, params);
  if (!z.string().uuid().safeParse(id).success) throw notFound(what);
  return id;
}
