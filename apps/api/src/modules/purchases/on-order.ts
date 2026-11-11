import { D, type DecimalValue } from "@bakery/domain";
import { purchaseLines, purchases, type Database, type Transaction } from "@bakery/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { OperationContext } from "../../lib/context.js";

type Db = Database | Transaction;

/**
 * Materia prima "en camino": lo pedido al proveedor y todavía no recibido, en
 * unidad base, sumando las compras pedidas o recibidas en parte. Sirve para no
 * volver a comprar lo que ya está pedido. Consulta: no reserva ni escribe.
 */
export async function rawMaterialOnOrder(
  db: Db,
  ctx: OperationContext,
  ids: readonly string[] | null,
): Promise<Map<string, InstanceType<typeof D>>> {
  if (ids !== null && ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: purchaseLines.rawMaterialId,
      pending: sql<string>`sum((${purchaseLines.orderedQuantity} - ${purchaseLines.receivedQuantity}) * ${purchaseLines.baseQuantityPerUnit})`,
    })
    .from(purchaseLines)
    .innerJoin(
      purchases,
      and(
        eq(purchases.companyId, purchaseLines.companyId),
        eq(purchases.id, purchaseLines.purchaseId),
      ),
    )
    .where(
      and(
        eq(purchaseLines.companyId, ctx.companyId),
        inArray(purchases.status, ["ORDERED", "PARTIALLY_RECEIVED"]),
        ids ? inArray(purchaseLines.rawMaterialId, [...new Set(ids)]) : undefined,
      ),
    )
    .groupBy(purchaseLines.rawMaterialId);
  return new Map(rows.map((r) => [r.id, D.max(new D(r.pending ?? 0), 0)]));
}

/** Lo que falta pedir después de descontar lo que ya está en camino (nunca negativo). */
export const stillToOrder = (shortage: DecimalValue, onOrder: DecimalValue | undefined) =>
  D.max(new D(shortage).minus(onOrder ?? 0), 0);
