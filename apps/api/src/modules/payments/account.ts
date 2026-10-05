import { D } from "@bakery/domain";
import {
  allocateCode,
  customerAccountBalances,
  customerAccountMovements,
  customerPaymentApplications,
  customerPayments,
  sales,
  type Database,
  type Transaction,
} from "@bakery/database";
import { and, eq, sql } from "drizzle-orm";
import type { OperationContext } from "../../lib/context.js";

/*
 * Cuenta corriente del cliente (Fase 5B, ADR-061). El ledger
 * customer_account_movements es la fuente de verdad (append-only); el saldo es
 * su proyección (trigger: saldo = anterior + movimiento = balance_after).
 * Signo: positivo = el cliente debe; negativo = crédito a favor.
 *
 * Locks (ADR-062): el saldo de cuenta del cliente se toma DESPUÉS de venta,
 * lotes y costos, y ANTES que cualquier pago (por id).
 */

type Db = Database | Transaction;

/** Bloquea (creándolo en cero si falta) el saldo de cuenta del cliente. */
export async function lockAccount(tx: Transaction, ctx: OperationContext, customerId: string) {
  await tx
    .insert(customerAccountBalances)
    .values({ companyId: ctx.companyId, customerId })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(customerAccountBalances)
    .where(
      and(
        eq(customerAccountBalances.companyId, ctx.companyId),
        eq(customerAccountBalances.customerId, customerId),
      ),
    )
    .for("update");
  if (!row) throw new Error("Saldo de cuenta no encontrado tras crearlo");
  return row;
}

export async function accountBalance(db: Db, ctx: OperationContext, customerId: string) {
  const [row] = await db
    .select({ balance: customerAccountBalances.balance })
    .from(customerAccountBalances)
    .where(
      and(
        eq(customerAccountBalances.companyId, ctx.companyId),
        eq(customerAccountBalances.customerId, customerId),
      ),
    );
  return new D(row?.balance ?? 0);
}

export interface AccountMovementRequest {
  customerId: string;
  movementType: "SALE_DEBIT" | "PAYMENT_CREDIT" | "ADJUSTMENT_DEBIT" | "ADJUSTMENT_CREDIT";
  /** Importe POSITIVO; el signo lo pone el tipo. */
  amount: string;
  occurredAt: Date;
  saleId?: string | null;
  paymentId?: string | null;
  reason?: string | null;
  notes?: string | null;
  /** Sólo ajustes: id del intento (idempotencia). */
  operationId?: string | null;
}

/**
 * Inserta un movimiento de cuenta y actualiza el saldo (que el llamador ya
 * bloqueó con lockAccount o se bloquea acá).
 */
export async function postAccountMovement(
  tx: Transaction,
  ctx: OperationContext,
  req: AccountMovementRequest,
) {
  const balance = await lockAccount(tx, ctx, req.customerId);
  const debit = req.movementType === "SALE_DEBIT" || req.movementType === "ADJUSTMENT_DEBIT";
  const signed = new D(req.amount).times(debit ? 1 : -1);
  const after = new D(balance.balance).plus(signed);
  const [movement] = await tx
    .insert(customerAccountMovements)
    .values({
      companyId: ctx.companyId,
      customerId: req.customerId,
      movementType: req.movementType,
      signedAmount: signed.toFixed(2),
      balanceAfter: after.toFixed(2),
      occurredAt: req.occurredAt,
      saleId: req.saleId ?? null,
      paymentId: req.paymentId ?? null,
      reason: req.reason ?? null,
      notes: req.notes ?? null,
      operationId: req.operationId ?? null,
      actorUserId: ctx.userId,
    })
    .returning();
  await tx
    .update(customerAccountBalances)
    .set({ balance: after.toFixed(2), lastMovementId: movement!.id, updatedAt: new Date() })
    .where(
      and(
        eq(customerAccountBalances.companyId, ctx.companyId),
        eq(customerAccountBalances.customerId, req.customerId),
      ),
    );
  return { movement: movement!, before: new D(balance.balance), after };
}

export async function allocatePaymentCode(tx: Transaction, ctx: OperationContext) {
  return allocateCode(tx, ctx.companyId, "CUSTOMER_PAYMENT", async (c) => {
    const taken = await tx
      .select({ id: customerPayments.id })
      .from(customerPayments)
      .where(
        and(eq(customerPayments.companyId, ctx.companyId), eq(customerPayments.internalCode, c)),
      )
      .limit(1);
    return taken.length > 0;
  });
}

/** Lo aplicado de un pago (dentro de la transacción que lo bloqueó). */
export async function paymentApplied(db: Db, ctx: OperationContext, paymentId: string) {
  const [row] = await db
    .select({ applied: sql<string>`coalesce(sum(${customerPaymentApplications.amount}), 0)` })
    .from(customerPaymentApplications)
    .where(
      and(
        eq(customerPaymentApplications.companyId, ctx.companyId),
        eq(customerPaymentApplications.paymentId, paymentId),
      ),
    );
  return new D(row?.applied ?? 0);
}

/**
 * Aplica `amount` de un pago a una venta ya bloqueada (FOR UPDATE) y
 * recalcula lo cobrado y el estado de cobro (trigger: paid = Σ aplicaciones).
 */
export async function applyToSale(
  tx: Transaction,
  ctx: OperationContext,
  args: {
    sale: { id: string; customerId: string; total: string; paidAmount: string };
    paymentId: string;
    amount: InstanceType<typeof D>;
    origin: "ADVANCE_AUTO" | "SALE_PAYMENT" | "MANUAL";
    /** Sólo imputación manual: id del intento (idempotencia). */
    operationId?: string;
  },
) {
  await tx.insert(customerPaymentApplications).values({
    companyId: ctx.companyId,
    paymentId: args.paymentId,
    saleId: args.sale.id,
    customerId: args.sale.customerId,
    amount: args.amount.toFixed(2),
    origin: args.origin,
    operationId: args.operationId ?? null,
    createdByUserId: ctx.userId,
  });
  const paid = new D(args.sale.paidAmount).plus(args.amount);
  const total = new D(args.sale.total);
  const paymentStatus = !paid.lt(total) ? "PAID" : paid.isZero() ? "UNPAID" : "PARTIALLY_PAID";
  await tx
    .update(sales)
    .set({ paidAmount: paid.toFixed(2), paymentStatus, updatedAt: new Date() })
    .where(eq(sales.id, args.sale.id));
  args.sale.paidAmount = paid.toFixed(2);
  return { paid, paymentStatus };
}
