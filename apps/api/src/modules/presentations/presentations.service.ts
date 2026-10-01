import { baseQuantityPerPurchaseUnit, InventoryError, trimDecimal } from "@bakery/domain";
import {
  rawMaterialPresentations,
  rawMaterials,
  type Database,
  type Transaction,
} from "@bakery/database";
import type { CreatePresentationInput, PresentationDto } from "@bakery/shared";
import { and, asc, eq } from "drizzle-orm";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { recordAudit } from "../audit/audit.service.js";
import { loadUnits, unitOrThrow, type UnitRow } from "../recipes/recipes.data.js";

/*
 * Presentaciones de compra por materia prima ("Bolsa 25 kg" de ESTA harina).
 * La conversión (unidad de compra, contenido, unidad del contenido) es
 * inmutable una vez creada: sólo se renombra o se desactiva.
 */

type Db = Database | Transaction;
type PresentationRow = typeof rawMaterialPresentations.$inferSelect;

const ref = (u: UnitRow) => ({ id: u.id, code: u.code, symbol: u.symbol });

export function toPresentationDto(
  row: PresentationRow,
  baseUnitId: string,
  units: Map<string, UnitRow>,
): PresentationDto {
  const baseUnit = unitOrThrow(units, baseUnitId);
  const containedUnit = unitOrThrow(units, row.containedUnitId);
  const baseQuantity = baseQuantityPerPurchaseUnit({
    baseUnit,
    purchaseUnit: unitOrThrow(units, row.purchaseUnitId),
    presentation: { containedQuantity: row.containedQuantity, containedUnit },
  });
  return {
    id: row.id,
    rawMaterialId: row.rawMaterialId,
    name: row.name,
    purchaseUnit: ref(unitOrThrow(units, row.purchaseUnitId)),
    containedQuantity: trimDecimal(row.containedQuantity),
    containedUnit: ref(containedUnit),
    baseQuantity: baseQuantity.toFixed(),
    baseUnit: ref(baseUnit),
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findMaterial(db: Db, ctx: OperationContext, id: string) {
  const [row] = await db
    .select({
      id: rawMaterials.id,
      code: rawMaterials.internalCode,
      name: rawMaterials.name,
      baseUnitId: rawMaterials.baseUnitId,
      active: rawMaterials.active,
    })
    .from(rawMaterials)
    .where(and(eq(rawMaterials.companyId, ctx.companyId), eq(rawMaterials.id, id)));
  if (!row) throw notFound("Materia prima");
  return row;
}

export async function listPresentations(
  db: Db,
  ctx: OperationContext,
  rawMaterialId: string,
  status: "active" | "inactive" | "all",
): Promise<PresentationDto[]> {
  const material = await findMaterial(db, ctx, rawMaterialId);
  const units = await loadUnits(db, ctx);
  const rows = await db
    .select()
    .from(rawMaterialPresentations)
    .where(
      and(
        eq(rawMaterialPresentations.companyId, ctx.companyId),
        eq(rawMaterialPresentations.rawMaterialId, rawMaterialId),
        status === "all" ? undefined : eq(rawMaterialPresentations.active, status === "active"),
      ),
    )
    .orderBy(asc(rawMaterialPresentations.name));
  return rows.map((r) => toPresentationDto(r, material.baseUnitId, units));
}

const nameTaken = () =>
  new AppError(
    409,
    "PRESENTATION_NAME_TAKEN",
    "Esa materia prima ya tiene una presentación con ese nombre",
    [{ path: "name", message: "Nombre en uso" }],
  );

export async function createPresentation(
  db: Database,
  ctx: OperationContext,
  rawMaterialId: string,
  input: CreatePresentationInput,
): Promise<PresentationDto> {
  return db.transaction(async (tx) => {
    const material = await findMaterial(tx, ctx, rawMaterialId);
    if (!material.active) {
      throw new AppError(409, "RAW_MATERIAL_INACTIVE", "La materia prima está desactivada.");
    }
    const units = await loadUnits(tx, ctx);
    const purchaseUnit = units.get(input.purchaseUnitId);
    if (!purchaseUnit?.active) {
      throw invalidReference("purchaseUnitId", "Unidad inexistente o inactiva");
    }
    const containedUnit = units.get(input.containedUnitId);
    if (!containedUnit?.active) {
      throw invalidReference("containedUnitId", "Unidad inexistente o inactiva");
    }
    try {
      baseQuantityPerPurchaseUnit({
        baseUnit: unitOrThrow(units, material.baseUnitId),
        purchaseUnit,
        presentation: { containedQuantity: input.containedQuantity, containedUnit },
      });
    } catch (err) {
      if (err instanceof InventoryError) {
        throw new AppError(422, err.code, err.message, [
          { path: "containedUnitId", message: err.message },
        ]);
      }
      throw err;
    }
    const [row] = await mapUniqueViolations(
      tx
        .insert(rawMaterialPresentations)
        .values({ ...input, companyId: ctx.companyId, rawMaterialId })
        .returning(),
      { raw_material_presentations_material_name_uq: nameTaken },
    );
    if (!row) throw new Error("Alta de presentación sin fila");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "RAW_MATERIAL_PRESENTATION_CREATED",
      entityType: "raw_material",
      entityId: rawMaterialId,
      metadata: {
        code: material.code,
        presentationId: row.id,
        presentation: row.name,
        containedQuantity: trimDecimal(row.containedQuantity),
        containedUnit: containedUnit.code,
        purchaseUnit: purchaseUnit.code,
      },
    });
    return toPresentationDto(row, material.baseUnitId, units);
  });
}

async function updatePresentationRow(
  db: Database,
  ctx: OperationContext,
  id: string,
  change: { name?: string; active?: boolean },
): Promise<PresentationDto> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(rawMaterialPresentations)
      .where(
        and(
          eq(rawMaterialPresentations.companyId, ctx.companyId),
          eq(rawMaterialPresentations.id, id),
        ),
      )
      .for("update");
    if (!before) throw notFound("Presentación");
    const material = await findMaterial(tx, ctx, before.rawMaterialId);
    const [after] = await mapUniqueViolations(
      tx
        .update(rawMaterialPresentations)
        .set(change)
        .where(eq(rawMaterialPresentations.id, id))
        .returning(),
      { raw_material_presentations_material_name_uq: nameTaken },
    );
    if (!after) throw notFound("Presentación");
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (change.name !== undefined && change.name !== before.name)
      changes.name = { from: before.name, to: after.name };
    if (change.active !== undefined && change.active !== before.active)
      changes.active = { from: before.active, to: after.active };
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "RAW_MATERIAL_PRESENTATION_UPDATED",
        entityType: "raw_material",
        entityId: before.rawMaterialId,
        metadata: { code: material.code, presentationId: id, presentation: after.name, changes },
      });
    }
    return toPresentationDto(after, material.baseUnitId, await loadUnits(tx, ctx));
  });
}

export const renamePresentation = (db: Database, ctx: OperationContext, id: string, name: string) =>
  updatePresentationRow(db, ctx, id, { name });

export const setPresentationActive = (
  db: Database,
  ctx: OperationContext,
  id: string,
  active: boolean,
) => updatePresentationRow(db, ctx, id, { active });
