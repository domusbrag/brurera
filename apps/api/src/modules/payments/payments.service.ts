import { D, accountBalanceView, debitCredit, saleBalanceDue } from "@bakery/domain";
import {
  customerAccountBalances,
  customerAccountMovements,
  customerOrders,
  customerPaymentApplications,
  customerPayments,
  customers,
  sales,
  type Database,
  type Transaction,
} from "@bakery/database";
import {
  ACCOUNT_MOVEMENT_TYPE_LABELS,
  PAYMENT_KIND_LABELS,
  PAYMENT_METHOD_LABELS,
  PERMISSIONS,
  hasPermissions,
  instantToZonedLocal,
  zonedLocalToInstant,
  type AccountAdjustmentInput,
  type ApplyPaymentInput,
  type CustomerAccountDto,
  type CustomerPaymentDto,
  type OnAccountPaymentInput,
  type OrderAdvanceInput,
  type Page,
  type PaymentResultDto,
  type ReceivableDto,
  type SalePaymentInput,
  type accountMovementsQuerySchema,
  type paymentListQuerySchema,
  type receivablesQuerySchema,
} from "@bakery/shared";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { likePattern, pageWindow, toPage } from "../../lib/listing.js";
import { loadPeople, personOf } from "../../lib/people.js";
import { recordAudit } from "../audit/audit.service.js";
import { companyCurrency } from "../recipes/recipes.data.js";
import { customerName, findSale } from "../sales/sales.data.js";
import {
  allocatePaymentCode,
  applyToSale,
  lockAccount,
  paymentApplied,
  postAccountMovement,
} from "./account.js";
import { qualified } from "../../lib/sql.js";

/*
 * Cobros, señas y cuenta corriente (Fase 5B, ADR-061).
 * - Un cobro nace REGISTRADO: genera un PAYMENT_CREDIT en la cuenta del cliente.
 * - Aplicarlo a una venta NO mueve la cuenta (eso ya ocurrió): sólo cambia lo
 *   cobrado de la venta y su estado de cobro.
 * - Un cobro mal cargado no se anula: se corrige con un ajuste autorizado
 *   (política B).
 * - Idempotencia: operationId único por empresa; reintentar devuelve el mismo
 *   cobro (replayed) y un id usado para otra cosa es OPERATION_ID_REUSED.
 *
 * Locks (ADR-062): cobro de una venta: venta → cuenta; seña: pedido (FOR SHARE)
 * → cuenta; imputación manual: venta → pago; cobro a cuenta y ajuste: cuenta.
 */

type Db = Database | Transaction;
type PaymentRow = typeof customerPayments.$inferSelect;

const operationReused = () =>
  new AppError(
    409,
    "OPERATION_ID_REUSED",
    "Ese identificador de operación ya se usó para otro cobro. Reintentá desde la pantalla.",
  );

async function findPayment(db: Db, ctx: OperationContext, id: string, lock = false) {
  const query = db
    .select()
    .from(customerPayments)
    .where(and(eq(customerPayments.companyId, ctx.companyId), eq(customerPayments.id, id)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Cobro");
  return row;
}

async function byOperation(tx: Db, ctx: OperationContext, operationId: string) {
  const [row] = await tx
    .select()
    .from(customerPayments)
    .where(
      and(
        eq(customerPayments.companyId, ctx.companyId),
        eq(customerPayments.operationId, operationId),
      ),
    );
  return row ?? null;
}

/**
 * ¿El reintento corresponde a este mismo cobro (destino, monto y medio)? Si no,
 * el id está reusado.
 */
function sameOperation(
  row: PaymentRow,
  expected: Partial<PaymentRow>,
  input: { amount: string; paymentMethod: string },
) {
  for (const [k, v] of Object.entries(expected)) {
    if ((row as Record<string, unknown>)[k] !== v) throw operationReused();
  }
  if (!new D(row.amount).eq(input.amount) || row.paymentMethod !== input.paymentMethod) {
    throw operationReused();
  }
  return true;
}

async function assertCustomer(db: Db, ctx: OperationContext, id: string) {
  const [row] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, id)));
  if (!row) throw notFound("Cliente");
  return row;
}

const paymentDate = (ctx: OperationContext, local: string | undefined) =>
  local ? zonedLocalToInstant(local, ctx.timezone) : new Date();

/** Inserta el cobro y su crédito en cuenta (la cuenta ya está bloqueada o se bloquea acá). */
async function insertPayment(
  tx: Transaction,
  ctx: OperationContext,
  args: {
    customerId: string;
    kind: PaymentRow["kind"];
    sourceOrderId?: string | null;
    sourceSaleId?: string | null;
    input: SalePaymentInput;
  },
) {
  const now = new Date();
  const code = await allocatePaymentCode(tx, ctx);
  const [payment] = await tx
    .insert(customerPayments)
    .values({
      companyId: ctx.companyId,
      internalCode: code,
      customerId: args.customerId,
      kind: args.kind,
      sourceOrderId: args.sourceOrderId ?? null,
      sourceSaleId: args.sourceSaleId ?? null,
      paymentDate: paymentDate(ctx, args.input.paymentDate),
      amount: new D(args.input.amount).toFixed(2),
      paymentMethod: args.input.paymentMethod,
      reference: args.input.reference,
      notes: args.input.notes,
      operationId: args.input.operationId,
      createdByUserId: ctx.userId,
      postedByUserId: ctx.userId,
      postedAt: now,
    })
    .returning();
  const account = await postAccountMovement(tx, ctx, {
    customerId: args.customerId,
    movementType: "PAYMENT_CREDIT",
    amount: payment!.amount,
    occurredAt: payment!.paymentDate,
    paymentId: payment!.id,
  });
  const metadata = {
    code,
    kind: args.kind,
    amount: payment!.amount,
    method: PAYMENT_METHOD_LABELS[payment!.paymentMethod],
    reference: payment!.reference,
    balanceBefore: account.before.toFixed(2),
    balanceAfter: account.after.toFixed(2),
  };
  await recordAudit(tx, {
    ...auditBase(ctx),
    action: "CUSTOMER_PAYMENT_CREATED",
    entityType: "customer_payment",
    entityId: payment!.id,
    metadata,
  });
  await recordAudit(tx, {
    ...auditBase(ctx),
    action:
      args.kind === "ORDER_ADVANCE" ? "ORDER_ADVANCE_PAYMENT_POSTED" : "CUSTOMER_PAYMENT_POSTED",
    entityType: "customer_payment",
    entityId: payment!.id,
    metadata,
  });
  return payment!;
}

/* ---------- Cobro desde una venta ---------- */

export async function registerSalePayment(
  db: Database,
  ctx: OperationContext,
  saleId: string,
  input: SalePaymentInput,
): Promise<PaymentResultDto> {
  const result = await db.transaction(async (tx) => {
    const sale = await findSale(tx, ctx, saleId, true);
    const existing = await byOperation(tx, ctx, input.operationId);
    if (
      existing &&
      sameOperation(existing, { kind: "SALE_PAYMENT", sourceSaleId: sale.id }, input)
    ) {
      return { id: existing.id, replayed: true };
    }
    if (sale.status !== "POSTED") {
      throw new AppError(409, "SALE_NOT_POSTED", "Sólo se cobra una venta confirmada.");
    }
    const amount = new D(input.amount);
    const due = saleBalanceDue(sale.total, sale.paidAmount);
    if (amount.gt(due)) {
      throw new AppError(
        422,
        "PAYMENT_EXCEEDS_SALE_BALANCE",
        `El pendiente de la venta es $ ${due.toFixed(2)}: no se puede cobrar $ ${amount.toFixed(2)} en ella. Registrá el excedente como cobro a cuenta.`,
        [{ path: "amount", message: `Pendiente: $ ${due.toFixed(2)}` }],
      );
    }
    await lockAccount(tx, ctx, sale.customerId);
    const payment = await insertPayment(tx, ctx, {
      customerId: sale.customerId,
      kind: "SALE_PAYMENT",
      sourceSaleId: sale.id,
      input,
    });
    await applyToSale(tx, ctx, {
      sale: {
        id: sale.id,
        customerId: sale.customerId,
        total: sale.total,
        paidAmount: sale.paidAmount,
      },
      paymentId: payment.id,
      amount,
      origin: "SALE_PAYMENT",
    });
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PAYMENT_APPLIED",
      entityType: "sale",
      entityId: sale.id,
      metadata: {
        code: sale.internalCode,
        payment: payment.internalCode,
        amount: amount.toFixed(2),
        origin: "SALE_PAYMENT",
      },
    });
    return { id: payment.id, replayed: false };
  });
  return { payment: await getPayment(db, ctx, result.id), replayed: result.replayed, warnings: [] };
}

/* ---------- Seña de un pedido ---------- */

export async function registerOrderAdvance(
  db: Database,
  ctx: OperationContext,
  orderId: string,
  input: OrderAdvanceInput,
): Promise<PaymentResultDto> {
  const result = await db.transaction(async (tx) => {
    // FOR SHARE: la seña no cambia el pedido pero no corre en paralelo con su cancelación.
    const [order] = await tx
      .select()
      .from(customerOrders)
      .where(and(eq(customerOrders.companyId, ctx.companyId), eq(customerOrders.id, orderId)))
      .for("share");
    if (!order) throw notFound("Pedido");
    const existing = await byOperation(tx, ctx, input.operationId);
    if (
      existing &&
      sameOperation(existing, { kind: "ORDER_ADVANCE", sourceOrderId: order.id }, input)
    ) {
      return { id: existing.id, replayed: true };
    }
    if (order.status === "CANCELLED" || order.status === "DELIVERED") {
      throw new AppError(
        409,
        "ORDER_CLOSED",
        `El pedido ${order.internalCode} está ${order.status === "CANCELLED" ? "cancelado" : "entregado"}: no admite señas.`,
      );
    }
    await lockAccount(tx, ctx, order.customerId);
    const payment = await insertPayment(tx, ctx, {
      customerId: order.customerId,
      kind: "ORDER_ADVANCE",
      sourceOrderId: order.id,
      input,
    });
    return { id: payment.id, replayed: false };
  });
  return { payment: await getPayment(db, ctx, result.id), replayed: result.replayed, warnings: [] };
}

/* ---------- Cobro a cuenta (sin imputar) ---------- */

export async function registerOnAccountPayment(
  db: Database,
  ctx: OperationContext,
  customerId: string,
  input: OnAccountPaymentInput,
): Promise<PaymentResultDto> {
  const result = await db.transaction(async (tx) => {
    await assertCustomer(tx, ctx, customerId);
    await lockAccount(tx, ctx, customerId);
    const existing = await byOperation(tx, ctx, input.operationId);
    if (existing && sameOperation(existing, { kind: "ON_ACCOUNT", customerId }, input)) {
      return { id: existing.id, replayed: true };
    }
    const payment = await insertPayment(tx, ctx, { customerId, kind: "ON_ACCOUNT", input });
    return { id: payment.id, replayed: false };
  });
  return {
    payment: await getPayment(db, ctx, result.id),
    replayed: result.replayed,
    warnings: result.replayed
      ? []
      : [
          "El cobro queda como crédito a favor: imputalo a las ventas pendientes desde la cuenta corriente.",
        ],
  };
}

/* ---------- Imputación manual ---------- */

export async function applyPayment(
  db: Database,
  ctx: OperationContext,
  paymentId: string,
  input: ApplyPaymentInput,
): Promise<PaymentResultDto> {
  await db.transaction(async (tx) => {
    // Venta → pago (ADR-062).
    const sale = await findSale(tx, ctx, input.saleId, true).catch(() => {
      throw invalidReference("saleId", "Venta inexistente");
    });
    const payment = await findPayment(tx, ctx, paymentId, true);
    if (payment.customerId !== sale.customerId) {
      throw invalidReference("saleId", "La venta es de otro cliente");
    }
    if (sale.status !== "POSTED") {
      throw new AppError(409, "SALE_NOT_POSTED", "Sólo se imputa a una venta confirmada.");
    }
    const amount = new D(input.amount);
    const due = saleBalanceDue(sale.total, sale.paidAmount);
    if (amount.gt(due)) {
      throw new AppError(
        422,
        "PAYMENT_EXCEEDS_SALE_BALANCE",
        `El pendiente de la venta es $ ${due.toFixed(2)}.`,
        [{ path: "amount", message: `Pendiente: $ ${due.toFixed(2)}` }],
      );
    }
    const unapplied = new D(payment.amount).minus(await paymentApplied(tx, ctx, payment.id));
    if (amount.gt(unapplied)) {
      throw new AppError(
        422,
        "PAYMENT_EXCEEDS_UNAPPLIED",
        `Al cobro ${payment.internalCode} le quedan $ ${unapplied.toFixed(2)} sin imputar.`,
        [{ path: "amount", message: `Sin imputar: $ ${unapplied.toFixed(2)}` }],
      );
    }
    await applyToSale(tx, ctx, {
      sale: {
        id: sale.id,
        customerId: sale.customerId,
        total: sale.total,
        paidAmount: sale.paidAmount,
      },
      paymentId: payment.id,
      amount,
      origin: "MANUAL",
    });
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PAYMENT_APPLIED",
      entityType: "sale",
      entityId: sale.id,
      metadata: {
        code: sale.internalCode,
        payment: payment.internalCode,
        amount: amount.toFixed(2),
        origin: "MANUAL",
      },
    });
  });
  return { payment: await getPayment(db, ctx, paymentId), replayed: false, warnings: [] };
}

/* ---------- Ajuste de cuenta (política B) ---------- */

export async function adjustAccount(
  db: Database,
  ctx: OperationContext,
  customerId: string,
  input: AccountAdjustmentInput,
  permissions: Iterable<string>,
  query: z.infer<typeof accountMovementsQuerySchema>,
): Promise<CustomerAccountDto> {
  await db.transaction(async (tx) => {
    const customer = await assertCustomer(tx, ctx, customerId);
    const result = await postAccountMovement(tx, ctx, {
      customerId,
      movementType: input.direction === "DEBIT" ? "ADJUSTMENT_DEBIT" : "ADJUSTMENT_CREDIT",
      amount: new D(input.amount).toFixed(2),
      occurredAt: new Date(),
      reason: input.reason,
      notes: input.notes,
    });
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "CUSTOMER_ACCOUNT_ADJUSTED",
      entityType: "customer",
      entityId: customerId,
      metadata: {
        code: customer.internalCode,
        direction: input.direction,
        amount: new D(input.amount).toFixed(2),
        reason: input.reason,
        balanceBefore: result.before.toFixed(2),
        balanceAfter: result.after.toFixed(2),
      },
    });
  });
  return getCustomerAccount(db, ctx, customerId, query, permissions);
}

/* ---------- Lecturas ---------- */

export async function getPayment(
  db: Db,
  ctx: OperationContext,
  id: string,
): Promise<CustomerPaymentDto> {
  const p = await findPayment(db, ctx, id);
  const [customer] = await db.select().from(customers).where(eq(customers.id, p.customerId));
  const [order] = p.sourceOrderId
    ? await db
        .select({ id: customerOrders.id, code: customerOrders.internalCode })
        .from(customerOrders)
        .where(eq(customerOrders.id, p.sourceOrderId))
    : [];
  const [sale] = p.sourceSaleId
    ? await db
        .select({ id: sales.id, code: sales.internalCode })
        .from(sales)
        .where(eq(sales.id, p.sourceSaleId))
    : [];
  const apps = await db
    .select({
      app: customerPaymentApplications,
      sale: { id: sales.id, code: sales.internalCode },
    })
    .from(customerPaymentApplications)
    .innerJoin(sales, eq(sales.id, customerPaymentApplications.saleId))
    .where(
      and(
        eq(customerPaymentApplications.companyId, ctx.companyId),
        eq(customerPaymentApplications.paymentId, p.id),
      ),
    )
    .orderBy(asc(customerPaymentApplications.createdAt));
  const applied = apps.reduce((s, a) => s.plus(a.app.amount), new D(0));
  const people = await loadPeople(db, [p.createdByUserId]);
  return {
    id: p.id,
    code: p.internalCode,
    kind: p.kind,
    customer: { id: customer!.id, code: customer!.internalCode, name: customerName(customer!) },
    order: order ?? null,
    sale: sale ?? null,
    paymentDate: p.paymentDate.toISOString(),
    paymentDateLocal: instantToZonedLocal(p.paymentDate, ctx.timezone),
    method: p.paymentMethod,
    reference: p.reference,
    notes: p.notes,
    amount: p.amount,
    applied: applied.toFixed(2),
    unapplied: new D(p.amount).minus(applied).toFixed(2),
    applications: apps.map(({ app, sale: s }) => ({
      sale: s,
      amount: app.amount,
      origin: app.origin,
      createdAt: app.createdAt.toISOString(),
    })),
    createdBy: personOf(people, p.createdByUserId),
    createdAt: p.createdAt.toISOString(),
  };
}

const appliedSql = sql<string>`(select coalesce(sum(a.amount), 0) from customer_payment_applications a where a.company_id = ${qualified(customerPayments.companyId)} and a.payment_id = ${qualified(customerPayments.id)})`;

export async function listPayments(
  db: Database,
  ctx: OperationContext,
  query: z.infer<typeof paymentListQuerySchema>,
): Promise<Page<CustomerPaymentDto>> {
  const where = and(
    eq(customerPayments.companyId, ctx.companyId),
    query.customerId ? eq(customerPayments.customerId, query.customerId) : undefined,
    query.orderId ? eq(customerPayments.sourceOrderId, query.orderId) : undefined,
    query.kind ? eq(customerPayments.kind, query.kind) : undefined,
    query.unappliedOnly ? sql`${customerPayments.amount} > ${appliedSql}` : undefined,
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select({ id: customerPayments.id })
      .from(customerPayments)
      .where(where)
      .orderBy(desc(customerPayments.paymentDate), desc(customerPayments.internalCode))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(customerPayments)
      .where(where),
  ]);
  const items: CustomerPaymentDto[] = [];
  for (const r of rows) items.push(await getPayment(db, ctx, r.id));
  return toPage(items, total?.n ?? 0, query);
}

function movementDescription(m: {
  movementType: keyof typeof ACCOUNT_MOVEMENT_TYPE_LABELS;
  saleCode: string | null;
  paymentCode: string | null;
  paymentKind: keyof typeof PAYMENT_KIND_LABELS | null;
  reason: string | null;
}) {
  switch (m.movementType) {
    case "SALE_DEBIT":
      return `Venta ${m.saleCode ?? ""}`.trim();
    case "PAYMENT_CREDIT":
      return `${m.paymentKind ? PAYMENT_KIND_LABELS[m.paymentKind] : "Cobro"} ${m.paymentCode ?? ""}`.trim();
    default:
      return `${ACCOUNT_MOVEMENT_TYPE_LABELS[m.movementType]}${m.reason ? `: ${m.reason}` : ""}`;
  }
}

export async function getCustomerAccount(
  db: Db,
  ctx: OperationContext,
  customerId: string,
  query: z.infer<typeof accountMovementsQuerySchema>,
  permissions: Iterable<string>,
): Promise<CustomerAccountDto> {
  const customer = await assertCustomer(db, ctx, customerId);
  const [bal] = await db
    .select({ balance: customerAccountBalances.balance })
    .from(customerAccountBalances)
    .where(
      and(
        eq(customerAccountBalances.companyId, ctx.companyId),
        eq(customerAccountBalances.customerId, customerId),
      ),
    );
  const balance = new D(bal?.balance ?? 0);
  const view = accountBalanceView(balance);
  const where = and(
    eq(customerAccountMovements.companyId, ctx.companyId),
    eq(customerAccountMovements.customerId, customerId),
  );
  const { limit, offset } = pageWindow(query);
  const [movements, [total]] = await Promise.all([
    db
      .select({
        m: customerAccountMovements,
        saleCode: sales.internalCode,
        paymentCode: customerPayments.internalCode,
        paymentKind: customerPayments.kind,
      })
      .from(customerAccountMovements)
      .leftJoin(sales, eq(sales.id, customerAccountMovements.saleId))
      .leftJoin(customerPayments, eq(customerPayments.id, customerAccountMovements.paymentId))
      .where(where)
      .orderBy(desc(customerAccountMovements.sequence))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(customerAccountMovements)
      .where(where),
  ]);
  const people = await loadPeople(
    db,
    movements.map((x) => x.m.actorUserId),
  );
  const pending = await db
    .select()
    .from(sales)
    .where(
      and(
        eq(sales.companyId, ctx.companyId),
        eq(sales.customerId, customerId),
        eq(sales.status, "POSTED"),
        sql`${sales.paidAmount} < ${sales.total}`,
      ),
    )
    .orderBy(asc(sales.saleDate));
  const unapplied = await db
    .select({
      id: customerPayments.id,
      code: customerPayments.internalCode,
      kind: customerPayments.kind,
      amount: customerPayments.amount,
      applied: appliedSql,
    })
    .from(customerPayments)
    .where(
      and(
        eq(customerPayments.companyId, ctx.companyId),
        eq(customerPayments.customerId, customerId),
        sql`${customerPayments.amount} > ${appliedSql}`,
      ),
    )
    .orderBy(asc(customerPayments.paymentDate));
  const unappliedCredit = unapplied.reduce((s, p) => s.plus(p.amount).minus(p.applied), new D(0));
  const can = (code: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) =>
    hasPermissions(permissions, [code]);
  return {
    customer: {
      id: customer.id,
      code: customer.internalCode,
      name: customerName(customer),
      creditLimit: customer.creditLimit,
      walkIn: customer.isWalkIn,
    },
    currency: await companyCurrency(db, ctx),
    balance: balance.toFixed(2),
    balanceKind: view.kind,
    balanceAmount: view.amount.toFixed(2),
    unappliedCredit: unappliedCredit.toFixed(2),
    pendingSales: pending.map((s) => ({
      id: s.id,
      code: s.internalCode,
      saleDate: s.saleDate!.toISOString(),
      total: s.total,
      paid: s.paidAmount,
      pending: saleBalanceDue(s.total, s.paidAmount).toFixed(2),
      paymentStatus: s.paymentStatus,
    })),
    unappliedPayments: unapplied.map((p) => ({
      id: p.id,
      code: p.code,
      kind: p.kind,
      unapplied: new D(p.amount).minus(p.applied).toFixed(2),
    })),
    movements: {
      items: movements.map(({ m, saleCode, paymentCode, paymentKind }) => {
        const dc = debitCredit(m.signedAmount);
        return {
          id: m.id,
          sequence: m.sequence,
          occurredAt: m.occurredAt.toISOString(),
          occurredAtLocal: instantToZonedLocal(m.occurredAt, ctx.timezone),
          type: m.movementType,
          description: movementDescription({
            movementType: m.movementType,
            saleCode,
            paymentCode,
            paymentKind,
            reason: m.reason,
          }),
          debit: dc.debit?.toFixed(2) ?? null,
          credit: dc.credit?.toFixed(2) ?? null,
          balanceAfter: m.balanceAfter,
          sale: m.saleId && saleCode ? { id: m.saleId, code: saleCode } : null,
          payment: m.paymentId && paymentCode ? { id: m.paymentId, code: paymentCode } : null,
          reason: m.reason,
          actor: personOf(people, m.actorUserId),
        };
      }),
      total: total?.n ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    },
    canAdjust: can(PERMISSIONS.CUSTOMER_ACCOUNTS_ADJUST),
    canRegisterPayment: can(PERMISSIONS.PAYMENTS_CREATE) && can(PERMISSIONS.PAYMENTS_POST),
  };
}

/** Cuentas a cobrar: clientes con saldo (deuda o crédito a favor). */
export async function listReceivables(
  db: Database,
  ctx: OperationContext,
  query: z.infer<typeof receivablesQuerySchema>,
): Promise<Page<ReceivableDto>> {
  const where = and(
    eq(customerAccountBalances.companyId, ctx.companyId),
    query.balance === "debt"
      ? sql`${customerAccountBalances.balance} > 0`
      : query.balance === "credit"
        ? sql`${customerAccountBalances.balance} < 0`
        : undefined,
    query.search
      ? or(
          ilike(customers.legalName, likePattern(query.search)),
          ilike(customers.tradeName, likePattern(query.search)),
          ilike(customers.internalCode, likePattern(query.search)),
        )
      : undefined,
  );
  const pendingCount = sql<number>`(select count(*)::int from sales s where s.company_id = ${qualified(customers.companyId)} and s.customer_id = ${qualified(customers.id)} and s.status = 'POSTED' and s.paid_amount < s.total)`;
  const oldest = sql<Date | null>`(select min(s.sale_date) from sales s where s.company_id = ${qualified(customers.companyId)} and s.customer_id = ${qualified(customers.id)} and s.status = 'POSTED' and s.paid_amount < s.total)`;
  const lastMovement = sql<Date | null>`(select max(m.occurred_at) from customer_account_movements m where m.company_id = ${qualified(customers.companyId)} and m.customer_id = ${qualified(customers.id)})`;
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        customer: customers,
        balance: customerAccountBalances.balance,
        pendingCount,
        oldest,
        lastMovement,
      })
      .from(customerAccountBalances)
      .innerJoin(customers, eq(customers.id, customerAccountBalances.customerId))
      .where(where)
      .orderBy(desc(customerAccountBalances.balance), asc(customers.legalName))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(customerAccountBalances)
      .innerJoin(customers, eq(customers.id, customerAccountBalances.customerId))
      .where(where),
  ]);
  return toPage(
    rows.map((r) => {
      const view = accountBalanceView(r.balance);
      return {
        customer: {
          id: r.customer.id,
          code: r.customer.internalCode,
          name: customerName(r.customer),
        },
        balance: r.balance,
        balanceKind: view.kind,
        balanceAmount: view.amount.toFixed(2),
        creditLimit: r.customer.creditLimit,
        creditLimitExceeded:
          r.customer.creditLimit !== null && new D(r.balance).gt(r.customer.creditLimit),
        pendingSales: r.pendingCount,
        oldestPendingSaleDate: r.oldest ? new Date(r.oldest).toISOString() : null,
        lastMovementAt: r.lastMovement ? new Date(r.lastMovement).toISOString() : null,
      };
    }),
    total?.n ?? 0,
    query,
  );
}
