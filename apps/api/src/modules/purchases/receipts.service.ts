import { acquisitionUnitCost, D, toBaseQuantity } from "@bakery/domain";
import {
  allocateCode,
  purchaseLines,
  purchaseReceiptLines,
  purchaseReceipts,
  purchases,
  rawMaterialPresentations,
  suppliers,
  warehouses,
  type Database,
  type Transaction,
} from "@bakery/database";
import type {
  CreateReceiptInput,
  ReceiptDto,
  ReceiptLineDto,
  UpdateReceiptInput,
} from "@bakery/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { loadPeople, personOf } from "../../lib/people.js";
import { recordAudit } from "../audit/audit.service.js";
import { fixedMoney, fixedQty, lockMaterialCosts, postStockMovement } from "../inventory/ledger.js";
import { loadUnits, unitOrThrow } from "../recipes/recipes.data.js";
import {
  findPurchase,
  loadMaterials,
  loadPurchaseLines,
  type PurchaseLineRow,
  type PurchaseRow,
} from "./purchases.service.js";

/*
 * Recepciones de mercadería. Crear una compra NO es recibir: la recepción
 * (borrador → confirmada) es lo único que mueve stock y costo. Confirmar es UNA
 * transacción con locks en orden fijo (compra → recepción → costos de materia
 * prima por id); cualquier falla revierte todo.
 */

type Db = Database | Transaction;
type ReceiptRow = typeof purchaseReceipts.$inferSelect;

const RECEIVABLE = new Set(["ORDERED", "PARTIALLY_RECEIVED"]);

const notReceivable = (status: string) =>
  new AppError(
    409,
    "PURCHASE_NOT_RECEIVABLE",
    status === "DRAFT"
      ? "Confirmá el pedido antes de registrar recepciones."
      : status === "CANCELLED"
        ? "La compra está cancelada: no puede recibir mercadería."
        : "La compra ya fue recibida completa.",
  );
const alreadyPosted = () =>
  new AppError(409, "ALREADY_POSTED", "La recepción ya fue confirmada: no se vuelve a aplicar.");
const receiptNotDraft = (status: string) =>
  status === "POSTED"
    ? new AppError(409, "RECEIPT_IMMUTABLE", "La recepción ya fue confirmada y no se modifica.")
    : new AppError(409, "RECEIPT_CANCELLED", "La recepción fue descartada.");

async function findReceipt(db: Db, ctx: OperationContext, id: string, lock = false) {
  const query = db
    .select()
    .from(purchaseReceipts)
    .where(and(eq(purchaseReceipts.companyId, ctx.companyId), eq(purchaseReceipts.id, id)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Recepción");
  return row;
}

async function assertWarehouse(tx: Transaction, ctx: OperationContext, id: string) {
  const [row] = await tx
    .select({ active: warehouses.active })
    .from(warehouses)
    .where(and(eq(warehouses.companyId, ctx.companyId), eq(warehouses.id, id)));
  if (!row || !row.active) throw invalidReference("warehouseId", "Depósito inexistente o inactivo");
}

interface ComputedLine {
  purchaseLine: PurchaseLineRow;
  received: string;
  normalized: string;
  unitCost: string;
  value: string;
}

/** Cantidad base, costo de adquisición por unidad base y valor de una línea recibida. */
function computeLine(
  purchaseLine: PurchaseLineRow,
  received: string,
): Omit<ComputedLine, "purchaseLine"> {
  const normalized = fixedQty(toBaseQuantity(received, purchaseLine.baseQuantityPerUnit));
  const unitCost = fixedMoney(
    acquisitionUnitCost(purchaseLine.netAmount, purchaseLine.orderedBaseQuantity),
  );
  return { received, normalized, unitCost, value: fixedMoney(new D(normalized).times(unitCost)) };
}

/**
 * Valida las cantidades contra lo pendiente de cada línea (pedido − recibido en
 * recepciones confirmadas). No se recibe más de lo pendiente.
 */
function validateLines(
  input: CreateReceiptInput["lines"],
  lines: readonly PurchaseLineRow[],
): ComputedLine[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const computed: ComputedLine[] = [];
  input.forEach((line, index) => {
    const path = `lines.${index}.quantity`;
    const purchaseLine = byId.get(line.purchaseLineId);
    if (!purchaseLine) {
      throw invalidReference(
        `lines.${index}.purchaseLineId`,
        "La línea no pertenece a esta compra",
      );
    }
    if (seen.has(line.purchaseLineId)) {
      throw invalidReference(`lines.${index}.purchaseLineId`, "Línea repetida");
    }
    seen.add(line.purchaseLineId);
    const quantity = new D(line.quantity);
    if (quantity.isZero()) return;
    const pending = new D(purchaseLine.orderedQuantity).minus(purchaseLine.receivedQuantity);
    if (quantity.gt(pending)) {
      throw new AppError(
        409,
        "RECEIPT_EXCEEDS_PENDING",
        `Se intenta recibir ${quantity.toFixed()} y sólo quedan ${pending.toFixed()} pendientes en la línea ${purchaseLine.lineNumber}.`,
        [{ path, message: `Pendiente: ${pending.toFixed()}` }],
      );
    }
    computed.push({ purchaseLine, ...computeLine(purchaseLine, quantity.toFixed(4)) });
  });
  if (computed.length === 0) {
    throw new AppError(422, "RECEIPT_EMPTY", "Indicá la cantidad recibida de al menos una línea.", [
      { path: "lines", message: "Sin cantidades" },
    ]);
  }
  return computed;
}

async function writeLines(
  tx: Transaction,
  ctx: OperationContext,
  receipt: Pick<ReceiptRow, "id" | "purchaseId">,
  computed: ComputedLine[],
) {
  const materials = await loadMaterials(
    tx,
    ctx,
    computed.map((c) => c.purchaseLine.rawMaterialId),
  );
  await tx
    .delete(purchaseReceiptLines)
    .where(
      and(
        eq(purchaseReceiptLines.companyId, ctx.companyId),
        eq(purchaseReceiptLines.receiptId, receipt.id),
      ),
    );
  await tx.insert(purchaseReceiptLines).values(
    computed.map((c) => ({
      companyId: ctx.companyId,
      purchaseId: receipt.purchaseId,
      receiptId: receipt.id,
      purchaseLineId: c.purchaseLine.id,
      rawMaterialId: c.purchaseLine.rawMaterialId,
      presentationId: c.purchaseLine.presentationId,
      purchaseUnitId: c.purchaseLine.purchaseUnitId,
      baseUnitId: materials.get(c.purchaseLine.rawMaterialId)!.baseUnitId,
      orderedQuantity: c.purchaseLine.orderedQuantity,
      previouslyReceivedQuantity: c.purchaseLine.receivedQuantity,
      receivedQuantity: c.received,
      normalizedBaseQuantity: c.normalized,
      acquisitionUnitCostBase: c.unitCost,
      lineInventoryValue: c.value,
    })),
  );
}

async function isNumberTaken(tx: Transaction, ctx: OperationContext, code: string) {
  const rows = await tx
    .select({ id: purchaseReceipts.id })
    .from(purchaseReceipts)
    .where(
      and(eq(purchaseReceipts.companyId, ctx.companyId), eq(purchaseReceipts.internalNumber, code)),
    )
    .limit(1);
  return rows.length > 0;
}

/* ---------- Consultas ---------- */

export async function getReceipt(db: Db, ctx: OperationContext, id: string): Promise<ReceiptDto> {
  const receipt = await findReceipt(db, ctx, id);
  const purchase = await findPurchase(db, ctx, receipt.purchaseId);
  const [supplier] = await db
    .select({ legal: suppliers.legalName, trade: suppliers.tradeName })
    .from(suppliers)
    .where(eq(suppliers.id, purchase.supplierId));
  const [warehouse] = await db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
    .from(warehouses)
    .where(eq(warehouses.id, receipt.warehouseId));
  const lines = await db
    .select()
    .from(purchaseReceiptLines)
    .where(
      and(
        eq(purchaseReceiptLines.companyId, ctx.companyId),
        eq(purchaseReceiptLines.receiptId, id),
      ),
    )
    .orderBy(asc(purchaseReceiptLines.createdAt));
  const purchaseLineRows = await loadPurchaseLines(db, ctx, receipt.purchaseId);
  const purchaseLineById = new Map(purchaseLineRows.map((l) => [l.id, l]));
  const units = await loadUnits(db, ctx);
  const materials = await loadMaterials(
    db,
    ctx,
    lines.map((l) => l.rawMaterialId),
  );
  const presentationIds = lines.flatMap((l) => (l.presentationId ? [l.presentationId] : []));
  const presentationNames = new Map(
    presentationIds.length === 0
      ? []
      : (
          await db
            .select({ id: rawMaterialPresentations.id, name: rawMaterialPresentations.name })
            .from(rawMaterialPresentations)
            .where(inArray(rawMaterialPresentations.id, presentationIds))
        ).map((p) => [p.id, p.name]),
  );
  const people = await loadPeople(db, [receipt.createdByUserId, receipt.postedByUserId]);
  const ref = (unitId: string) => {
    const u = unitOrThrow(units, unitId);
    return { id: u.id, code: u.code, symbol: u.symbol };
  };
  const ordered = lines
    .map((l) => ({ l, line: purchaseLineById.get(l.purchaseLineId)! }))
    .sort((a, b) => a.line.lineNumber - b.line.lineNumber);
  return {
    id: receipt.id,
    number: receipt.internalNumber,
    status: receipt.status,
    purchase: {
      id: purchase.id,
      number: purchase.internalNumber,
      status: purchase.status,
      supplierName: supplier?.trade ?? supplier?.legal ?? "",
    },
    warehouse: warehouse ?? { id: receipt.warehouseId, code: "", name: "" },
    receivedAt: receipt.receivedAt.toISOString(),
    documentNumber: receipt.documentNumber,
    notes: receipt.notes,
    currency: purchase.currencyCode,
    inventoryValue: fixedMoney(lines.reduce((s, l) => s.plus(l.lineInventoryValue), new D(0))),
    lines: ordered.map(({ l, line }): ReceiptLineDto => {
      const m = materials.get(l.rawMaterialId)!;
      // En borrador, "recibido antes" y "pendiente" se muestran con lo confirmado hasta hoy.
      const previously =
        receipt.status === "POSTED" ? l.previouslyReceivedQuantity : line.receivedQuantity;
      return {
        id: l.id,
        purchaseLineId: l.purchaseLineId,
        rawMaterial: { id: m.id, code: m.code, name: m.name },
        presentation: l.presentationId
          ? { id: l.presentationId, name: presentationNames.get(l.presentationId) ?? "" }
          : null,
        purchaseUnit: ref(l.purchaseUnitId),
        baseUnit: ref(l.baseUnitId),
        orderedQuantity: l.orderedQuantity,
        previouslyReceivedQuantity: previously,
        pendingQuantity: new D(l.orderedQuantity).minus(previously).toFixed(4),
        receivedQuantity: l.receivedQuantity,
        normalizedBaseQuantity: l.normalizedBaseQuantity,
        acquisitionUnitCost: l.acquisitionUnitCostBase,
        lineInventoryValue: l.lineInventoryValue,
      };
    }),
    createdBy: personOf(people, receipt.createdByUserId),
    createdAt: receipt.createdAt.toISOString(),
    postedAt: receipt.postedAt?.toISOString() ?? null,
    postedBy: personOf(people, receipt.postedByUserId),
  };
}

/* ---------- Borrador ---------- */

export async function createReceipt(
  db: Database,
  ctx: OperationContext,
  purchaseId: string,
  input: CreateReceiptInput,
) {
  return db.transaction(async (tx) => {
    const purchase = await findPurchase(tx, ctx, purchaseId, true);
    if (!RECEIVABLE.has(purchase.status)) throw notReceivable(purchase.status);
    await assertWarehouse(tx, ctx, input.warehouseId);
    const computed = validateLines(input.lines, await loadPurchaseLines(tx, ctx, purchaseId));
    const number = await allocateCode(tx, ctx.companyId, "PURCHASE_RECEIPT", (c) =>
      isNumberTaken(tx, ctx, c),
    );
    const [receipt] = await tx
      .insert(purchaseReceipts)
      .values({
        companyId: ctx.companyId,
        purchaseId,
        internalNumber: number,
        warehouseId: input.warehouseId,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
        status: "DRAFT",
        documentNumber: input.documentNumber,
        notes: input.notes,
        createdByUserId: ctx.userId,
      })
      .returning();
    if (!receipt) throw new Error("Alta de recepción sin fila");
    await writeLines(tx, ctx, receipt, computed);
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PURCHASE_RECEIPT_CREATED",
      entityType: "purchase",
      entityId: purchaseId,
      metadata: { number: purchase.internalNumber, receiptId: receipt.id, receipt: number },
    });
    return getReceipt(tx, ctx, receipt.id);
  });
}

export async function updateReceipt(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: UpdateReceiptInput,
) {
  return db.transaction(async (tx) => {
    const peek = await findReceipt(tx, ctx, id);
    const purchase = await findPurchase(tx, ctx, peek.purchaseId, true);
    const receipt = await findReceipt(tx, ctx, id, true);
    if (receipt.status !== "DRAFT") throw receiptNotDraft(receipt.status);
    if (!RECEIVABLE.has(purchase.status)) throw notReceivable(purchase.status);
    if (input.warehouseId && input.warehouseId !== receipt.warehouseId) {
      await assertWarehouse(tx, ctx, input.warehouseId);
    }
    if (input.lines) {
      const computed = validateLines(input.lines, await loadPurchaseLines(tx, ctx, purchase.id));
      await writeLines(tx, ctx, receipt, computed);
    }
    await tx
      .update(purchaseReceipts)
      .set({
        warehouseId: input.warehouseId,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : undefined,
        documentNumber: input.documentNumber,
        notes: input.notes,
      })
      .where(eq(purchaseReceipts.id, id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PURCHASE_RECEIPT_UPDATED",
      entityType: "purchase",
      entityId: purchase.id,
      metadata: { number: purchase.internalNumber, receiptId: id, receipt: receipt.internalNumber },
    });
    return getReceipt(tx, ctx, id);
  });
}

export async function cancelReceipt(db: Database, ctx: OperationContext, id: string) {
  return db.transaction(async (tx) => {
    const peek = await findReceipt(tx, ctx, id);
    const purchase = await findPurchase(tx, ctx, peek.purchaseId, true);
    const receipt = await findReceipt(tx, ctx, id, true);
    if (receipt.status !== "DRAFT") throw receiptNotDraft(receipt.status);
    await tx
      .update(purchaseReceipts)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(eq(purchaseReceipts.id, id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PURCHASE_RECEIPT_CANCELLED",
      entityType: "purchase",
      entityId: purchase.id,
      metadata: { number: purchase.internalNumber, receiptId: id, receipt: receipt.internalNumber },
    });
    return getReceipt(tx, ctx, id);
  });
}

/* ---------- Confirmación ---------- */

/**
 * Confirma (POST) una recepción en UNA transacción:
 *  1. bloquea compra y recepción (en ese orden);
 *  2. valida estados (409 ALREADY_POSTED si ya se confirmó);
 *  3. bloquea las líneas de compra y valida lo pendiente;
 *  4-5. convierte a unidad base y calcula el costo de adquisición;
 *  6-9. bloquea los costos de las materias primas (orden por id) y, por línea,
 *       crea el movimiento, actualiza saldo, costo de empresa y promedio;
 *  10. actualiza lo recibido y el estado de la compra;
 *  11. marca la recepción POSTED y audita.
 * Cualquier error revierte todo: sin movimientos, saldos, costos ni auditoría.
 */
export async function postReceipt(db: Database, ctx: OperationContext, id: string) {
  return db.transaction(async (tx) => {
    const peek = await findReceipt(tx, ctx, id);
    const purchase: PurchaseRow = await findPurchase(tx, ctx, peek.purchaseId, true);
    const receipt = await findReceipt(tx, ctx, id, true);
    if (receipt.status === "POSTED") throw alreadyPosted();
    if (receipt.status !== "DRAFT") throw receiptNotDraft(receipt.status);
    if (!RECEIVABLE.has(purchase.status)) throw notReceivable(purchase.status);
    await assertWarehouse(tx, ctx, receipt.warehouseId);

    const draftLines = await tx
      .select()
      .from(purchaseReceiptLines)
      .where(
        and(
          eq(purchaseReceiptLines.companyId, ctx.companyId),
          eq(purchaseReceiptLines.receiptId, id),
        ),
      );
    const purchaseLineRows = await loadPurchaseLines(tx, ctx, purchase.id, true);
    // Revalida contra lo pendiente HOY (otra recepción pudo confirmarse después del borrador).
    const computed = validateLines(
      draftLines.map((l) => ({ purchaseLineId: l.purchaseLineId, quantity: l.receivedQuantity })),
      purchaseLineRows,
    );
    await writeLines(tx, ctx, receipt, computed);
    const frozen = await tx
      .select()
      .from(purchaseReceiptLines)
      .where(
        and(
          eq(purchaseReceiptLines.companyId, ctx.companyId),
          eq(purchaseReceiptLines.receiptId, id),
        ),
      );
    const frozenByLine = new Map(frozen.map((l) => [l.purchaseLineId, l]));

    const materials = await loadMaterials(
      tx,
      ctx,
      computed.map((c) => c.purchaseLine.rawMaterialId),
    );
    const units = await loadUnits(tx, ctx);
    await lockMaterialCosts(
      tx,
      ctx,
      computed.map((c) => c.purchaseLine.rawMaterialId),
    );
    const ordered = [...computed].sort(
      (a, b) =>
        a.purchaseLine.rawMaterialId.localeCompare(b.purchaseLine.rawMaterialId) ||
        a.purchaseLine.lineNumber - b.purchaseLine.lineNumber,
    );
    const movements: {
      material: string;
      quantity: string;
      unitCost: string;
      movementId: string;
    }[] = [];
    for (const line of ordered) {
      const material = materials.get(line.purchaseLine.rawMaterialId)!;
      const posted = await postStockMovement(tx, ctx, {
        rawMaterialId: material.id,
        rawMaterialCode: material.code,
        rawMaterialName: material.name,
        warehouseId: receipt.warehouseId,
        baseUnitId: material.baseUnitId,
        baseUnitSymbol: unitOrThrow(units, material.baseUnitId).symbol,
        movementType: "PURCHASE_RECEIPT",
        quantity: line.normalized,
        unitCost: line.unitCost,
        occurredAt: receipt.receivedAt,
        referenceType: "PURCHASE_RECEIPT",
        referenceId: receipt.id,
        sourceLineId: frozenByLine.get(line.purchaseLine.id)!.id,
        currency: purchase.currencyCode,
      });
      movements.push({
        material: material.name,
        quantity: line.normalized,
        unitCost: line.unitCost,
        movementId: posted.movement.id,
      });
      await tx
        .update(purchaseLines)
        .set({
          receivedQuantity: new D(line.purchaseLine.receivedQuantity)
            .plus(line.received)
            .toFixed(4),
        })
        .where(eq(purchaseLines.id, line.purchaseLine.id));
    }

    const after = await loadPurchaseLines(tx, ctx, purchase.id);
    const complete = after.every((l) => new D(l.receivedQuantity).eq(l.orderedQuantity));
    const newStatus = complete ? "RECEIVED" : "PARTIALLY_RECEIVED";
    await tx.update(purchases).set({ status: newStatus }).where(eq(purchases.id, purchase.id));
    await tx
      .update(purchaseReceipts)
      .set({ status: "POSTED", postedAt: new Date(), postedByUserId: ctx.userId })
      .where(eq(purchaseReceipts.id, id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PURCHASE_RECEIPT_POSTED",
      entityType: "purchase",
      entityId: purchase.id,
      metadata: {
        number: purchase.internalNumber,
        receiptId: id,
        receipt: receipt.internalNumber,
        warehouseId: receipt.warehouseId,
        previousStatus: purchase.status,
        newStatus,
        currency: purchase.currencyCode,
        inventoryValue: fixedMoney(computed.reduce((s, c) => s.plus(c.value), new D(0))),
        movements,
      },
    });
    return getReceipt(tx, ctx, id);
  });
}

export async function listReceiptsOf(db: Db, ctx: OperationContext, purchaseId: string) {
  await findPurchase(db, ctx, purchaseId);
  const rows = await db
    .select({ id: purchaseReceipts.id })
    .from(purchaseReceipts)
    .where(
      and(
        eq(purchaseReceipts.companyId, ctx.companyId),
        eq(purchaseReceipts.purchaseId, purchaseId),
      ),
    )
    .orderBy(asc(purchaseReceipts.createdAt));
  return Promise.all(rows.map((r) => getReceipt(db, ctx, r.id)));
}
