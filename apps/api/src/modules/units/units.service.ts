import { unitsOfMeasure, type Database, type Transaction } from "@bakery/database";
import {
  IncompatibleUnitsError,
  InvalidUnitDefinitionError,
  convertQuantity,
  validateDerivedUnit,
} from "@bakery/domain";
import type { ListQuery, Page, UnitDto } from "@bakery/shared";
import { type createUnitSchema, type updateUnitSchema } from "@bakery/shared";
import { and, asc, count, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference, mapUniqueViolations, notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { activeCondition, pageWindow, searchCondition, toPage } from "../../lib/listing.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";

const base = alias(unitsOfMeasure, "base_unit");
type Row = typeof unitsOfMeasure.$inferSelect;

function selectUnits(db: Database | Transaction) {
  return db
    .select({ unit: unitsOfMeasure, base: { id: base.id, code: base.code, symbol: base.symbol } })
    .from(unitsOfMeasure)
    .leftJoin(base, eq(base.id, unitsOfMeasure.baseUnitId));
}

function toDto({
  unit,
  base: b,
}: {
  unit: Row;
  base: { id: string; code: string; symbol: string } | null;
}): UnitDto {
  return {
    id: unit.id,
    code: unit.code,
    name: unit.name,
    symbol: unit.symbol,
    dimension: unit.dimension,
    baseUnit: b,
    conversionFactor: unit.conversionFactor,
    decimals: unit.decimals,
    isSystem: unit.isSystem,
    active: unit.active,
  };
}

const owned = (ctx: OperationContext, id: string) =>
  and(eq(unitsOfMeasure.companyId, ctx.companyId), eq(unitsOfMeasure.id, id));

const codeTakenError = (code: string) =>
  new AppError(409, "CODE_TAKEN", `Ya existe una unidad con código ${code}`, [
    { path: "code", message: "Código en uso" },
  ]);

export async function listUnits(
  db: Database,
  ctx: OperationContext,
  query: ListQuery,
): Promise<Page<UnitDto>> {
  const where = and(
    eq(unitsOfMeasure.companyId, ctx.companyId),
    activeCondition(unitsOfMeasure.active, query.status),
    searchCondition(query.search, [unitsOfMeasure.code, unitsOfMeasure.name]),
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    selectUnits(db)
      .where(where)
      .orderBy(
        asc(unitsOfMeasure.dimension),
        asc(unitsOfMeasure.baseUnitId),
        asc(unitsOfMeasure.code),
      )
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(unitsOfMeasure).where(where),
  ]);
  return toPage(rows.map(toDto), total?.n ?? 0, query);
}

export async function getUnit(db: Database | Transaction, ctx: OperationContext, id: string) {
  const [row] = await selectUnits(db).where(owned(ctx, id));
  if (!row) throw notFound("Unidad");
  return toDto(row);
}

export async function createUnit(
  db: Database,
  ctx: OperationContext,
  input: z.infer<typeof createUnitSchema>,
) {
  return db.transaction(async (tx) => {
    if (input.baseUnitId && input.conversionFactor) {
      const [baseUnit] = await tx.select().from(unitsOfMeasure).where(owned(ctx, input.baseUnitId));
      if (!baseUnit || !baseUnit.active) {
        throw invalidReference("baseUnitId", "Unidad base inexistente o inactiva");
      }
      try {
        validateDerivedUnit(input.dimension, baseUnit, input.conversionFactor);
      } catch (err) {
        if (err instanceof InvalidUnitDefinitionError) {
          throw new AppError(422, "INVALID_UNIT_DEFINITION", err.message, [
            { path: "baseUnitId", message: err.message },
          ]);
        }
        throw err;
      }
    }
    const [row] = await mapUniqueViolations(
      tx
        .insert(unitsOfMeasure)
        .values({ ...input, companyId: ctx.companyId, isSystem: false })
        .returning(),
      { units_company_code_uq: () => codeTakenError(input.code) },
    );
    if (!row) throw new Error("Alta de unidad sin fila");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "UNIT_CREATED",
      entityType: "unit",
      entityId: row.id,
      metadata: {
        code: row.code,
        dimension: row.dimension,
        baseUnitId: row.baseUnitId,
        conversionFactor: row.conversionFactor,
      },
    });
    return getUnit(tx, ctx, row.id);
  });
}

/** Solo nombre, símbolo, decimales y estado: la definición de conversión es inmutable. */
export async function updateUnit(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: z.infer<typeof updateUnitSchema>,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(unitsOfMeasure).where(owned(ctx, id)).for("update");
    if (!before) throw notFound("Unidad");
    const [after] = await tx.update(unitsOfMeasure).set(input).where(owned(ctx, id)).returning();
    if (!after) throw notFound("Unidad");
    const changes = diffChanges(before, after, Object.keys(input));
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "UNIT_UPDATED",
        entityType: "unit",
        entityId: id,
        metadata: { code: after.code, changes },
      });
    }
    return getUnit(tx, ctx, id);
  });
}

/** Conversión explícita entre dos unidades de la empresa. 422 si son incompatibles. */
export async function convert(
  db: Database,
  ctx: OperationContext,
  input: { from: string; to: string; quantity: string },
) {
  const [from] = await db.select().from(unitsOfMeasure).where(owned(ctx, input.from));
  const [to] = await db.select().from(unitsOfMeasure).where(owned(ctx, input.to));
  if (!from) throw invalidReference("from", "Unidad de origen inexistente");
  if (!to) throw invalidReference("to", "Unidad de destino inexistente");
  try {
    const result = convertQuantity(input.quantity, from, to);
    return { quantity: input.quantity, from: from.code, to: to.code, result: result.toString() };
  } catch (err) {
    if (err instanceof IncompatibleUnitsError) {
      throw new AppError(422, "INCOMPATIBLE_UNITS", err.message);
    }
    throw err;
  }
}
