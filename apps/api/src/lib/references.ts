import { categories, suppliers, unitsOfMeasure, type Transaction } from "@bakery/database";
import { and, eq } from "drizzle-orm";
import type { OperationContext } from "./context.js";
import { invalidReference } from "./db-errors.js";

/*
 * Validación de referencias entre maestros. Siempre dentro de la empresa de la
 * sesión: un id de otra empresa se informa igual que uno inexistente, sin
 * revelar que existe. Además, las FKs compuestas (company_id, id) de la base lo
 * impiden aunque la aplicación fallara.
 */

export async function assertCategory(
  tx: Transaction,
  ctx: OperationContext,
  id: string,
  type: "RAW_MATERIAL" | "PRODUCT",
  field = "categoryId",
) {
  const [row] = await tx
    .select({ type: categories.type, active: categories.active })
    .from(categories)
    .where(and(eq(categories.companyId, ctx.companyId), eq(categories.id, id)));
  if (!row || !row.active) throw invalidReference(field, "Categoría inexistente o inactiva");
  if (row.type !== type) {
    throw invalidReference(
      field,
      type === "RAW_MATERIAL"
        ? "La categoría no es de materias primas"
        : "La categoría no es de productos",
    );
  }
}

export async function assertUnit(
  tx: Transaction,
  ctx: OperationContext,
  id: string,
  opts: { field: string; rootOnly?: boolean },
) {
  const [row] = await tx
    .select({ active: unitsOfMeasure.active, baseUnitId: unitsOfMeasure.baseUnitId })
    .from(unitsOfMeasure)
    .where(and(eq(unitsOfMeasure.companyId, ctx.companyId), eq(unitsOfMeasure.id, id)));
  if (!row || !row.active) throw invalidReference(opts.field, "Unidad inexistente o inactiva");
  if (opts.rootOnly && row.baseUnitId !== null) {
    throw invalidReference(
      opts.field,
      "La unidad base de una materia prima debe ser una unidad raíz (kg, l, unidad…)",
    );
  }
}

export async function assertSupplier(
  tx: Transaction,
  ctx: OperationContext,
  id: string,
  field = "preferredSupplierId",
) {
  const [row] = await tx
    .select({ active: suppliers.active })
    .from(suppliers)
    .where(and(eq(suppliers.companyId, ctx.companyId), eq(suppliers.id, id)));
  if (!row || !row.active) throw invalidReference(field, "Proveedor inexistente o inactivo");
}
