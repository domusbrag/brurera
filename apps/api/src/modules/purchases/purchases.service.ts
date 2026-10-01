import {
  acquisitionUnitCost,
  baseQuantityPerPurchaseUnit,
  calculatePurchaseLineAmounts,
  calculatePurchaseTotals,
  D,
  InventoryError,
  toBaseQuantity,
} from "@bakery/domain";
import {
  allocateCode,
  purchaseLines,
  purchaseReceiptLines,
  purchaseReceipts,
  purchases,
  rawMaterialPresentations,
  rawMaterials,
  suppliers,
  warehouses,
  type Database,
  type Transaction,
} from "@bakery/database";
import {
  PURCHASE_ALWAYS_EDITABLE,
  type CreatePurchaseInput,
  type Page,
  type PurchaseDto,
  type PurchaseLineDto,
  type PurchaseLineInput,
  type PurchaseListItemDto,
  type PurchaseReceiptSummaryDto,
  type UpdatePurchaseInput,
  type cancelPurchaseSchema,
  type purchaseListQuerySchema,
} from "@bakery/shared";
import { and, asc, count, desc, eq, exists, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { likePattern, pageWindow, toPage } from "../../lib/listing.js";
import { loadPeople, personOf } from "../../lib/people.js";
import { recordAudit } from "../audit/audit.service.js";
import { fixedMoney, fixedQty } from "../inventory/ledger.js";
import { companyCurrency, loadUnits, unitOrThrow, type UnitRow } from "../recipes/recipes.data.js";

/*
 * Compras (Fase 3). Una compra NO mueve stock: sólo las recepciones confirmadas
 * (purchase-receipts.service) lo hacen. Aquí: alta y edición del borrador con
 * sus líneas, confirmación del pedido, cancelación y consultas.
 */

type Db = Database | Transaction;
type ListQuery = z.infer<typeof purchaseListQuerySchema>;
type CancelInput = z.infer<typeof cancelPurchaseSchema>;
export type PurchaseRow = typeof purchases.$inferSelect;
export type PurchaseLineRow = typeof purchaseLines.$inferSelect;

/* ---------- Errores ---------- */

export const purchaseNotEditable = (status: string) =>
  new AppError(
    409,
    "PURCHASE_NOT_EDITABLE",
    status === "DRAFT"
      ? "La compra no se puede editar."
      : "La compra ya fue pedida: sus líneas no se modifican. Sólo podés cambiar notas, fecha esperada y documento del proveedor.",
  );

const ref = (u: UnitRow) => ({ id: u.id, code: u.code, symbol: u.symbol });
const ownedPurchase = (ctx: OperationContext, id: string): SQL | undefined =>
  and(eq(purchases.companyId, ctx.companyId), eq(purchases.id, id));

export async function findPurchase(db: Db, ctx: OperationContext, id: string, lock = false) {
  const query = db.select().from(purchases).where(ownedPurchase(ctx, id));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Compra");
  return row;
}

export async function loadPurchaseLines(
  db: Db,
  ctx: OperationContext,
  purchaseId: string,
  lock = false,
) {
  const query = db
    .select()
    .from(purchaseLines)
    .where(
      and(eq(purchaseLines.companyId, ctx.companyId), eq(purchaseLines.purchaseId, purchaseId)),
    )
    .orderBy(asc(purchaseLines.lineNumber));
  return lock ? query.for("update") : query;
}

export interface MaterialRow {
  id: string;
  code: string;
  name: string;
  baseUnitId: string;
  active: boolean;
}

export async function loadMaterials(
  db: Db,
  ctx: OperationContext,
  ids: readonly string[],
): Promise<Map<string, MaterialRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: rawMaterials.id,
      code: rawMaterials.internalCode,
      name: rawMaterials.name,
      baseUnitId: rawMaterials.baseUnitId,
      active: rawMaterials.active,
    })
    .from(rawMaterials)
    .where(
      and(eq(rawMaterials.companyId, ctx.companyId), inArray(rawMaterials.id, [...new Set(ids)])),
    );
  return new Map(rows.map((r) => [r.id, r]));
}

async function loadPresentations(db: Db, ctx: OperationContext, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, typeof rawMaterialPresentations.$inferSelect>();
  const rows = await db
    .select()
    .from(rawMaterialPresentations)
    .where(
      and(
        eq(rawMaterialPresentations.companyId, ctx.companyId),
        inArray(rawMaterialPresentations.id, [...new Set(ids)]),
      ),
    );
  return new Map(rows.map((r) => [r.id, r]));
}

async function assertSupplierActive(tx: Transaction, ctx: OperationContext, id: string) {
  const [row] = await tx
    .select({ active: suppliers.active })
    .from(suppliers)
    .where(and(eq(suppliers.companyId, ctx.companyId), eq(suppliers.id, id)));
  if (!row || !row.active) throw invalidReference("supplierId", "Proveedor inexistente o inactivo");
}

/* ---------- Líneas: validación, conversión e importes ---------- */

type NewLine = Omit<typeof purchaseLines.$inferInsert, "purchaseId" | "companyId">;

/**
 * Valida y calcula las líneas: materia prima de la empresa y activa, presentación
 * de ESA materia prima (si se indica), unidad de compra coherente, conversión a
 * unidad base e importes con decimal.js.
 */
async function buildLines(
  tx: Transaction,
  ctx: OperationContext,
  lines: readonly PurchaseLineInput[],
): Promise<{ rows: NewLine[]; totals: ReturnType<typeof calculatePurchaseTotals> }> {
  const units = await loadUnits(tx, ctx);
  const materials = await loadMaterials(
    tx,
    ctx,
    lines.map((l) => l.rawMaterialId),
  );
  const presentations = await loadPresentations(
    tx,
    ctx,
    lines.flatMap((l) => (l.presentationId ? [l.presentationId] : [])),
  );
  const rows: NewLine[] = [];
  const amounts: { gross: InstanceType<typeof D>; discount: InstanceType<typeof D> }[] = [];
  lines.forEach((line, index) => {
    const path = (field: string) => `lines.${index}.${field}`;
    const material = materials.get(line.rawMaterialId);
    if (!material || !material.active) {
      throw invalidReference(path("rawMaterialId"), "Materia prima inexistente o inactiva");
    }
    let purchaseUnitId = line.purchaseUnitId;
    let presentation: { containedQuantity: string; containedUnit: UnitRow } | null = null;
    if (line.presentationId) {
      const p = presentations.get(line.presentationId);
      // Una presentación de otra materia prima se informa igual que una inexistente.
      if (!p || p.rawMaterialId !== material.id) {
        throw invalidReference(
          path("presentationId"),
          `La presentación no corresponde a ${material.name}`,
        );
      }
      if (!p.active)
        throw invalidReference(path("presentationId"), "La presentación está desactivada");
      if (purchaseUnitId && purchaseUnitId !== p.purchaseUnitId) {
        throw invalidReference(path("purchaseUnitId"), "La unidad no coincide con la presentación");
      }
      purchaseUnitId = p.purchaseUnitId;
      presentation = {
        containedQuantity: p.containedQuantity,
        containedUnit: unitOrThrow(units, p.containedUnitId),
      };
    }
    const purchaseUnit = purchaseUnitId ? units.get(purchaseUnitId) : undefined;
    if (!purchaseUnit) throw invalidReference(path("purchaseUnitId"), "Unidad inexistente");
    let perUnit;
    let lineAmounts;
    try {
      perUnit = baseQuantityPerPurchaseUnit({
        baseUnit: unitOrThrow(units, material.baseUnitId),
        purchaseUnit,
        presentation,
      });
      lineAmounts = calculatePurchaseLineAmounts({
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: line.discountAmount,
      });
    } catch (err) {
      if (err instanceof InventoryError) {
        const field =
          err.code === "DISCOUNT_EXCEEDS_GROSS"
            ? "discountAmount"
            : err.code === "INCOMPATIBLE_PURCHASE_UNIT"
              ? "purchaseUnitId"
              : "quantity";
        throw new AppError(422, err.code, err.message, [
          { path: path(field), message: err.message },
        ]);
      }
      throw err;
    }
    amounts.push(lineAmounts);
    rows.push({
      lineNumber: index + 1,
      rawMaterialId: material.id,
      presentationId: line.presentationId,
      purchaseUnitId: purchaseUnit.id,
      orderedQuantity: line.quantity,
      unitPrice: line.unitPrice,
      grossAmount: fixedMoney(lineAmounts.gross),
      discountAmount: fixedMoney(lineAmounts.discount),
      netAmount: fixedMoney(lineAmounts.net),
      baseQuantityPerUnit: fixedQty(perUnit),
      orderedBaseQuantity: fixedQty(toBaseQuantity(line.quantity, perUnit)),
      notes: line.notes,
    });
  });
  return { rows, totals: calculatePurchaseTotals(amounts) };
}

function headerTotals(totals: ReturnType<typeof calculatePurchaseTotals>, taxTotal: string | null) {
  const tax = new D(taxTotal ?? 0);
  return {
    subtotal: fixedMoney(totals.subtotal),
    discountTotal: fixedMoney(totals.discountTotal),
    taxTotal: fixedMoney(tax),
    total: fixedMoney(totals.subtotal.minus(totals.discountTotal).plus(tax)),
  };
}

async function replaceLines(
  tx: Transaction,
  ctx: OperationContext,
  purchaseId: string,
  rows: NewLine[],
) {
  await tx
    .delete(purchaseLines)
    .where(
      and(eq(purchaseLines.companyId, ctx.companyId), eq(purchaseLines.purchaseId, purchaseId)),
    );
  if (rows.length > 0) {
    await tx
      .insert(purchaseLines)
      .values(rows.map((r) => ({ ...r, companyId: ctx.companyId, purchaseId })));
  }
}

/* ---------- Consultas ---------- */

/** Valor neto recibido y pendiente: Σ neto × recibido / pedido (por línea). */
function receivedAmounts(lines: readonly PurchaseLineRow[]) {
  let received = new D(0);
  let net = new D(0);
  for (const l of lines) {
    net = net.plus(l.netAmount);
    received = received.plus(
      new D(l.netAmount).times(l.receivedQuantity).dividedBy(l.orderedQuantity),
    );
  }
  return { receivedAmount: fixedMoney(received), pendingAmount: fixedMoney(net.minus(received)) };
}

export async function getPurchase(db: Db, ctx: OperationContext, id: string): Promise<PurchaseDto> {
  const purchase = await findPurchase(db, ctx, id);
  const [supplier] = await db
    .select({
      id: suppliers.id,
      code: suppliers.internalCode,
      legal: suppliers.legalName,
      trade: suppliers.tradeName,
    })
    .from(suppliers)
    .where(eq(suppliers.id, purchase.supplierId));
  const lines = await loadPurchaseLines(db, ctx, id);
  const units = await loadUnits(db, ctx);
  const materials = await loadMaterials(
    db,
    ctx,
    lines.map((l) => l.rawMaterialId),
  );
  const presentations = await loadPresentations(
    db,
    ctx,
    lines.flatMap((l) => (l.presentationId ? [l.presentationId] : [])),
  );
  const receipts = await listReceiptSummaries(db, ctx, id);
  const people = await loadPeople(db, [
    purchase.createdByUserId,
    purchase.orderedByUserId,
    purchase.cancelledByUserId,
  ]);
  return {
    id: purchase.id,
    number: purchase.internalNumber,
    status: purchase.status,
    supplier: {
      id: supplier?.id ?? purchase.supplierId,
      code: supplier?.code ?? "",
      name: supplier?.trade ?? supplier?.legal ?? "",
    },
    supplierDocumentNumber: purchase.supplierDocumentNumber,
    purchaseDate: purchase.purchaseDate,
    expectedDate: purchase.expectedDate,
    currency: purchase.currencyCode,
    notes: purchase.notes,
    subtotal: purchase.subtotal,
    discountTotal: purchase.discountTotal,
    taxTotal: purchase.taxTotal,
    total: purchase.total,
    ...receivedAmounts(lines),
    lines: lines.map((l): PurchaseLineDto => {
      const m = materials.get(l.rawMaterialId)!;
      const p = l.presentationId ? presentations.get(l.presentationId) : undefined;
      return {
        id: l.id,
        lineNumber: l.lineNumber,
        rawMaterial: {
          id: m.id,
          code: m.code,
          name: m.name,
          baseUnit: ref(unitOrThrow(units, m.baseUnitId)),
        },
        presentation: p ? { id: p.id, name: p.name } : null,
        purchaseUnit: ref(unitOrThrow(units, l.purchaseUnitId)),
        orderedQuantity: l.orderedQuantity,
        receivedQuantity: l.receivedQuantity,
        pendingQuantity: new D(l.orderedQuantity).minus(l.receivedQuantity).toFixed(4),
        unitPrice: l.unitPrice,
        grossAmount: l.grossAmount,
        discountAmount: l.discountAmount,
        netAmount: l.netAmount,
        baseQuantityPerUnit: l.baseQuantityPerUnit,
        orderedBaseQuantity: l.orderedBaseQuantity,
        acquisitionUnitCost: fixedMoney(acquisitionUnitCost(l.netAmount, l.orderedBaseQuantity)),
        notes: l.notes,
      };
    }),
    receipts,
    createdBy: personOf(people, purchase.createdByUserId),
    createdAt: purchase.createdAt.toISOString(),
    updatedAt: purchase.updatedAt.toISOString(),
    orderedAt: purchase.orderedAt?.toISOString() ?? null,
    orderedBy: personOf(people, purchase.orderedByUserId),
    cancelledAt: purchase.cancelledAt?.toISOString() ?? null,
    cancelledBy: personOf(people, purchase.cancelledByUserId),
    cancelReason: purchase.cancelReason,
  };
}

export async function listReceiptSummaries(
  db: Db,
  ctx: OperationContext,
  purchaseId: string,
): Promise<PurchaseReceiptSummaryDto[]> {
  const rows = await db
    .select({
      r: purchaseReceipts,
      warehouse: { id: warehouses.id, code: warehouses.code, name: warehouses.name },
      lineCount: sql<number>`(select count(*)::int from ${purchaseReceiptLines} where ${purchaseReceiptLines.receiptId} = ${purchaseReceipts.id})`,
      value: sql<string>`(select coalesce(sum(${purchaseReceiptLines.lineInventoryValue}), 0)::text from ${purchaseReceiptLines} where ${purchaseReceiptLines.receiptId} = ${purchaseReceipts.id})`,
    })
    .from(purchaseReceipts)
    .innerJoin(warehouses, eq(warehouses.id, purchaseReceipts.warehouseId))
    .where(
      and(
        eq(purchaseReceipts.companyId, ctx.companyId),
        eq(purchaseReceipts.purchaseId, purchaseId),
      ),
    )
    .orderBy(asc(purchaseReceipts.createdAt));
  const people = await loadPeople(
    db,
    rows.map((r) => r.r.postedByUserId),
  );
  return rows.map(({ r, warehouse, lineCount, value }) => ({
    id: r.id,
    number: r.internalNumber,
    status: r.status,
    warehouse,
    receivedAt: r.receivedAt.toISOString(),
    documentNumber: r.documentNumber,
    postedAt: r.postedAt?.toISOString() ?? null,
    postedBy: personOf(people, r.postedByUserId),
    lineCount,
    inventoryValue: fixedMoney(value),
  }));
}

export async function listPurchases(
  db: Database,
  ctx: OperationContext,
  query: ListQuery,
): Promise<Page<PurchaseListItemDto>> {
  const pattern = query.search ? likePattern(query.search) : undefined;
  const status =
    query.status === "all"
      ? undefined
      : query.status === "open"
        ? inArray(purchases.status, ["ORDERED", "PARTIALLY_RECEIVED"])
        : eq(purchases.status, query.status);
  const where = and(
    eq(purchases.companyId, ctx.companyId),
    status,
    query.supplierId ? eq(purchases.supplierId, query.supplierId) : undefined,
    query.rawMaterialId
      ? exists(
          db
            .select({ one: sql`1` })
            .from(purchaseLines)
            .where(
              and(
                eq(purchaseLines.purchaseId, purchases.id),
                eq(purchaseLines.rawMaterialId, query.rawMaterialId),
              ),
            ),
        )
      : undefined,
    pattern
      ? or(
          ilike(purchases.internalNumber, pattern),
          ilike(purchases.supplierDocumentNumber, pattern),
          ilike(suppliers.legalName, pattern),
          ilike(suppliers.tradeName, pattern),
        )
      : undefined,
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        p: purchases,
        supplier: {
          id: suppliers.id,
          code: suppliers.internalCode,
          legal: suppliers.legalName,
          trade: suppliers.tradeName,
        },
      })
      .from(purchases)
      .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
      .where(where)
      .orderBy(desc(purchases.purchaseDate), desc(purchases.internalNumber))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: count() })
      .from(purchases)
      .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
      .where(where),
  ]);
  const ids = rows.map((r) => r.p.id);
  const lines =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(purchaseLines)
          .where(
            and(eq(purchaseLines.companyId, ctx.companyId), inArray(purchaseLines.purchaseId, ids)),
          );
  const items = rows.map(({ p, supplier }): PurchaseListItemDto => {
    const own = lines.filter((l) => l.purchaseId === p.id);
    return {
      id: p.id,
      number: p.internalNumber,
      status: p.status,
      supplier: { id: supplier.id, code: supplier.code, name: supplier.trade ?? supplier.legal },
      purchaseDate: p.purchaseDate,
      expectedDate: p.expectedDate,
      currency: p.currencyCode,
      total: p.total,
      ...receivedAmounts(own),
      lineCount: own.length,
    };
  });
  return toPage(items, total?.n ?? 0, query);
}

/* ---------- Alta, edición, pedido y cancelación ---------- */

async function isNumberTaken(tx: Transaction, ctx: OperationContext, code: string) {
  const rows = await tx
    .select({ id: purchases.id })
    .from(purchases)
    .where(and(eq(purchases.companyId, ctx.companyId), eq(purchases.internalNumber, code)))
    .limit(1);
  return rows.length > 0;
}

export async function createPurchase(
  db: Database,
  ctx: OperationContext,
  input: CreatePurchaseInput,
) {
  return db.transaction(async (tx) => {
    await assertSupplierActive(tx, ctx, input.supplierId);
    const { rows, totals } = await buildLines(tx, ctx, input.lines);
    const number = await allocateCode(tx, ctx.companyId, "PURCHASE", (c) =>
      isNumberTaken(tx, ctx, c),
    );
    const [purchase] = await mapUniqueViolations(
      tx
        .insert(purchases)
        .values({
          companyId: ctx.companyId,
          supplierId: input.supplierId,
          internalNumber: number,
          supplierDocumentNumber: input.supplierDocumentNumber,
          purchaseDate: input.purchaseDate as string,
          expectedDate: input.expectedDate,
          status: "DRAFT",
          currencyCode: await companyCurrency(tx, ctx),
          notes: input.notes,
          ...headerTotals(totals, input.taxTotal),
          createdByUserId: ctx.userId,
        })
        .returning(),
      {
        purchases_company_number_uq: () =>
          new AppError(409, "CODE_TAKEN", `El número ${number} ya está en uso`),
      },
    );
    if (!purchase) throw new Error("Alta de compra sin fila");
    await replaceLines(tx, ctx, purchase.id, rows);
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PURCHASE_CREATED",
      entityType: "purchase",
      entityId: purchase.id,
      metadata: {
        number,
        lines: rows.length,
        total: purchase.total,
        currency: purchase.currencyCode,
      },
    });
    return getPurchase(tx, ctx, purchase.id);
  });
}

export async function updatePurchase(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: UpdatePurchaseInput,
) {
  return db.transaction(async (tx) => {
    const before = await findPurchase(tx, ctx, id, true);
    const fields = Object.keys(input).filter(
      (k) => input[k as keyof UpdatePurchaseInput] !== undefined,
    );
    if (before.status !== "DRAFT") {
      const blocked = fields.filter(
        (f) => !(PURCHASE_ALWAYS_EDITABLE as readonly string[]).includes(f),
      );
      if (blocked.length > 0 || before.status === "CANCELLED")
        throw purchaseNotEditable(before.status);
    }
    if (input.supplierId && input.supplierId !== before.supplierId) {
      await assertSupplierActive(tx, ctx, input.supplierId);
    }
    let totals = {};
    let lineCount: number | undefined;
    if (input.lines) {
      const built = await buildLines(tx, ctx, input.lines);
      await replaceLines(tx, ctx, id, built.rows);
      totals = headerTotals(
        built.totals,
        input.taxTotal !== undefined ? input.taxTotal : before.taxTotal,
      );
      lineCount = built.rows.length;
    } else if (input.taxTotal !== undefined) {
      const lines = await loadPurchaseLines(tx, ctx, id);
      totals = headerTotals(
        calculatePurchaseTotals(
          lines.map((l) => ({ gross: new D(l.grossAmount), discount: new D(l.discountAmount) })),
        ),
        input.taxTotal,
      );
    }
    const { lines: _lines, taxTotal: _tax, ...header } = input;
    const [after] = await tx
      .update(purchases)
      .set({ ...header, ...totals })
      .where(ownedPurchase(ctx, id))
      .returning();
    if (!after) throw notFound("Compra");
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of [
      "supplierId",
      "purchaseDate",
      "expectedDate",
      "supplierDocumentNumber",
      "notes",
      "total",
    ] as const) {
      if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
    }
    if (Object.keys(changes).length > 0 || lineCount !== undefined) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "PURCHASE_UPDATED",
        entityType: "purchase",
        entityId: id,
        metadata: { number: after.internalNumber, changes, lines: lineCount },
      });
    }
    return getPurchase(tx, ctx, id);
  });
}

export async function orderPurchase(db: Database, ctx: OperationContext, id: string) {
  return db.transaction(async (tx) => {
    const purchase = await findPurchase(tx, ctx, id, true);
    if (purchase.status !== "DRAFT") {
      throw new AppError(409, "PURCHASE_NOT_DRAFT", "La compra ya fue pedida o cancelada.");
    }
    const lines = await loadPurchaseLines(tx, ctx, id);
    if (lines.length === 0) {
      throw new AppError(
        422,
        "PURCHASE_WITHOUT_LINES",
        "Agregá al menos una línea antes de confirmar el pedido.",
        [{ path: "lines", message: "Sin líneas" }],
      );
    }
    await assertSupplierActive(tx, ctx, purchase.supplierId);
    await tx
      .update(purchases)
      .set({ status: "ORDERED", orderedAt: new Date(), orderedByUserId: ctx.userId })
      .where(ownedPurchase(ctx, id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PURCHASE_ORDERED",
      entityType: "purchase",
      entityId: id,
      metadata: {
        number: purchase.internalNumber,
        total: purchase.total,
        currency: purchase.currencyCode,
      },
    });
    return getPurchase(tx, ctx, id);
  });
}

/**
 * Cancela una compra sin mercadería recibida. Con recepciones confirmadas no se
 * cancela (las devoluciones a proveedor quedan fuera de esta fase). Las
 * recepciones en borrador se descartan con ella.
 */
export async function cancelPurchase(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: CancelInput,
) {
  return db.transaction(async (tx) => {
    const purchase = await findPurchase(tx, ctx, id, true);
    if (purchase.status === "CANCELLED") {
      throw new AppError(409, "PURCHASE_ALREADY_CANCELLED", "La compra ya está cancelada.");
    }
    const [posted] = await tx
      .select({ id: purchaseReceipts.id })
      .from(purchaseReceipts)
      .where(and(eq(purchaseReceipts.purchaseId, id), eq(purchaseReceipts.status, "POSTED")))
      .limit(1);
    if (posted || purchase.status === "PARTIALLY_RECEIVED" || purchase.status === "RECEIVED") {
      throw new AppError(
        409,
        "PURCHASE_HAS_RECEIPTS",
        "La compra tiene mercadería recibida: no se puede cancelar. Las devoluciones a proveedor todavía no están disponibles; corregí el stock con un ajuste.",
      );
    }
    const now = new Date();
    const drafts = await tx
      .update(purchaseReceipts)
      .set({ status: "CANCELLED", cancelledAt: now })
      .where(and(eq(purchaseReceipts.purchaseId, id), eq(purchaseReceipts.status, "DRAFT")))
      .returning({ id: purchaseReceipts.id });
    await tx
      .update(purchases)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancelledByUserId: ctx.userId,
        cancelReason: input.reason,
      })
      .where(ownedPurchase(ctx, id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PURCHASE_CANCELLED",
      entityType: "purchase",
      entityId: id,
      metadata: {
        number: purchase.internalNumber,
        previousStatus: purchase.status,
        reason: input.reason,
        discardedReceipts: drafts.length,
      },
    });
    return getPurchase(tx, ctx, id);
  });
}
