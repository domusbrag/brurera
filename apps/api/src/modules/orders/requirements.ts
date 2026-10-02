import { customerOrders, orderProductionRequirements, type Transaction } from "@bakery/database";
import { and, eq } from "drizzle-orm";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { recordAudit } from "../audit/audit.service.js";

/*
 * Vínculo entre necesidades de pedidos y órdenes de producción (Fase 5A).
 * Una necesidad abierta puede originar UNA orden de producción prellenada; si
 * esa orden se cancela, la necesidad vuelve a estar pendiente; si se completa,
 * queda cumplida (el lote nuevo NO se reserva solo: el pedido avisa que hay
 * stock nuevo y se recalcula explícitamente). Sin consolidación entre pedidos
 * todavía (deuda PRODUCTION_CONSOLIDATION).
 */

/**
 * Valida y bloquea la necesidad que origina una orden de producción. Orden de
 * locks: pedido (FOR SHARE) → necesidad (FOR UPDATE), igual que replanificar.
 */
export async function claimRequirement(
  tx: Transaction,
  ctx: OperationContext,
  requirementId: string,
  productId: string,
) {
  const [head] = await tx
    .select({ orderId: orderProductionRequirements.customerOrderId })
    .from(orderProductionRequirements)
    .where(
      and(
        eq(orderProductionRequirements.companyId, ctx.companyId),
        eq(orderProductionRequirements.id, requirementId),
      ),
    );
  if (!head) throw invalidReference("sourceOrderRequirementId", "Necesidad inexistente");
  const [order] = await tx
    .select()
    .from(customerOrders)
    .where(and(eq(customerOrders.companyId, ctx.companyId), eq(customerOrders.id, head.orderId)))
    .for("share");
  const [requirement] = await tx
    .select()
    .from(orderProductionRequirements)
    .where(eq(orderProductionRequirements.id, requirementId))
    .for("update");
  if (!order || !requirement)
    throw invalidReference("sourceOrderRequirementId", "Necesidad inexistente");
  const blocked = (message: string) =>
    new AppError(409, "REQUIREMENT_NOT_OPEN", message, [
      { path: "sourceOrderRequirementId", message },
    ]);
  if (!["CONFIRMED", "IN_PREPARATION", "READY"].includes(order.status)) {
    throw blocked(`El pedido ${order.internalCode} no está confirmado.`);
  }
  if (requirement.status !== "OPEN") {
    throw blocked(
      requirement.status === "PRODUCTION_CREATED"
        ? "Esta necesidad ya tiene una orden de producción."
        : "Esta necesidad ya no está pendiente (se recalculó o se cumplió).",
    );
  }
  if (requirement.problem !== null) {
    throw blocked("El producto no tiene una receta utilizable: no se puede producir todavía.");
  }
  if (requirement.productId !== productId) {
    throw invalidReference("productId", "El producto no es el de la necesidad del pedido");
  }
  return { requirement, order };
}

export async function linkRequirement(
  tx: Transaction,
  ctx: OperationContext,
  claim: Awaited<ReturnType<typeof claimRequirement>>,
  production: { id: string; code: string; quantity: string; scheduledFor: string },
) {
  await tx
    .update(orderProductionRequirements)
    .set({ status: "PRODUCTION_CREATED", linkedProductionOrderId: production.id })
    .where(eq(orderProductionRequirements.id, claim.requirement.id));
  await recordAudit(tx, {
    ...auditBase(ctx),
    action: "PRODUCTION_ORDER_CREATED_FROM_ORDER",
    entityType: "customer_order",
    entityId: claim.order.id,
    metadata: {
      code: claim.order.internalCode,
      requirementId: claim.requirement.id,
      productionOrderId: production.id,
      productionOrder: production.code,
      requiredQuantity: claim.requirement.requiredOutputQuantity,
      plannedQuantity: production.quantity,
      scheduledFor: production.scheduledFor,
    },
  });
}

/** La orden de producción se canceló: su necesidad vuelve a estar pendiente. */
export async function reopenRequirementOf(
  tx: Transaction,
  ctx: OperationContext,
  productionOrderId: string,
) {
  await tx
    .update(orderProductionRequirements)
    .set({ status: "OPEN", linkedProductionOrderId: null })
    .where(
      and(
        eq(orderProductionRequirements.companyId, ctx.companyId),
        eq(orderProductionRequirements.linkedProductionOrderId, productionOrderId),
        eq(orderProductionRequirements.status, "PRODUCTION_CREATED"),
      ),
    );
}

/** La orden de producción se completó: su necesidad queda cumplida. */
export async function satisfyRequirementOf(
  tx: Transaction,
  ctx: OperationContext,
  productionOrderId: string,
) {
  await tx
    .update(orderProductionRequirements)
    .set({ status: "SATISFIED", closedAt: new Date() })
    .where(
      and(
        eq(orderProductionRequirements.companyId, ctx.companyId),
        eq(orderProductionRequirements.linkedProductionOrderId, productionOrderId),
        eq(orderProductionRequirements.status, "PRODUCTION_CREATED"),
      ),
    );
}
