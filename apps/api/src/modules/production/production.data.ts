import {
  COST_SCALE,
  D,
  NORMALIZED_QUANTITY_SCALE,
  PERCENTAGE_SCALE,
  ProductionError,
  consumptionVariance,
  findEffectiveVersion,
  findShortages,
  outputPerformance,
  planProduction,
  toFixedString,
  type ProductionPlan,
} from "@bakery/domain";
import {
  employees,
  productionMaterialLines,
  productionOrders,
  productLots,
  products,
  rawMaterials,
  recipeVersions,
  recipes,
  stockBalances,
  warehouses,
  type Database,
  type Transaction,
} from "@bakery/database";
import {
  withoutProductionCosts,
  type AvailabilityLineDto,
  type ProductionAvailabilityDto,
  type ProductionCostsDto,
  type ProductionIssueDto,
  type ProductionMaterialLineDto,
  type ProductionOrderDto,
} from "@bakery/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { todayIn, type OperationContext } from "../../lib/context.js";
import { notFound } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { loadPeople, personOf } from "../../lib/people.js";
import {
  companyCurrency,
  loadIngredients,
  loadRawMaterials,
  loadUnits,
  unitOrThrow,
  type RawMaterialRow,
  type UnitRow,
} from "../recipes/recipes.data.js";

/*
 * Lecturas de producción: orden, receta y versión, plan calculado, líneas,
 * disponibilidad y armado del DTO. Todo filtrado por la empresa de la sesión.
 */

export type Db = Database | Transaction;
export type OrderRow = typeof productionOrders.$inferSelect;
export type LineRow = typeof productionMaterialLines.$inferSelect;

type Num = Parameters<typeof toFixedString>[0];
export const qty = (v: Num) => toFixedString(v, NORMALIZED_QUANTITY_SCALE);
export const money = (v: Num) => toFixedString(v, COST_SCALE);
export const pct = (v: Num) => toFixedString(v, PERCENTAGE_SCALE);
const nullableMoney = (v: Num | null) => (v === null ? null : money(v));
const unitRef = (u: { id: string; code: string; symbol: string }) => ({
  id: u.id,
  code: u.code,
  symbol: u.symbol,
});

/** Traduce un error de regla de producción del dominio a HTTP con el mismo código. */
export function productionError(err: unknown): never {
  if (err instanceof ProductionError) {
    const status = err.code === "INVALID_PRODUCTION_TRANSITION" ? 409 : 422;
    throw new AppError(status, err.code, err.message);
  }
  throw err;
}

/* ---------- Búsquedas ---------- */

export async function findOrder(db: Db, ctx: OperationContext, id: string, lock = false) {
  const query = db
    .select()
    .from(productionOrders)
    .where(and(eq(productionOrders.companyId, ctx.companyId), eq(productionOrders.id, id)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Orden de producción");
  return row;
}

export async function loadLines(db: Db, ctx: OperationContext, orderId: string, lock = false) {
  const query = db
    .select()
    .from(productionMaterialLines)
    .where(
      and(
        eq(productionMaterialLines.companyId, ctx.companyId),
        eq(productionMaterialLines.productionOrderId, orderId),
      ),
    )
    .orderBy(asc(productionMaterialLines.lineNumber));
  return lock ? query.for("update") : query;
}

export async function findProduct(db: Db, ctx: OperationContext, productId: string) {
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.companyId, ctx.companyId), eq(products.id, productId)));
  return row ?? null;
}

/** Receta ACTIVA del producto (una por producto en el MVP). */
export async function findActiveRecipe(db: Db, ctx: OperationContext, productId: string) {
  const [row] = await db
    .select()
    .from(recipes)
    .where(
      and(
        eq(recipes.companyId, ctx.companyId),
        eq(recipes.productId, productId),
        eq(recipes.active, true),
      ),
    );
  return row ?? null;
}

export async function loadVersions(db: Db, ctx: OperationContext, recipeId: string) {
  return db
    .select()
    .from(recipeVersions)
    .where(and(eq(recipeVersions.companyId, ctx.companyId), eq(recipeVersions.recipeId, recipeId)));
}

/**
 * Instante con que se busca la versión vigente para una fecha programada: hoy o
 * futuro → ahora (la vigente); una fecha pasada → el final de ese día (UTC).
 */
export function effectiveInstant(scheduledFor: string, timezone: string, now = new Date()): Date {
  if (scheduledFor >= todayIn(timezone, now)) return now;
  return new Date(`${scheduledFor}T23:59:59.999Z`);
}

export async function effectiveVersionFor(
  db: Db,
  ctx: OperationContext,
  recipeId: string,
  scheduledFor: string,
) {
  const versions = await loadVersions(db, ctx, recipeId);
  return findEffectiveVersion(versions, effectiveInstant(scheduledFor, ctx.timezone));
}

export async function loadWarehouses(db: Db, ctx: OperationContext, ids: readonly string[]) {
  const rows = await db
    .select({
      id: warehouses.id,
      code: warehouses.code,
      name: warehouses.name,
      active: warehouses.active,
    })
    .from(warehouses)
    .where(and(eq(warehouses.companyId, ctx.companyId), inArray(warehouses.id, [...ids])));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function findEmployee(db: Db, ctx: OperationContext, id: string) {
  const [row] = await db
    .select({
      id: employees.id,
      firstName: employees.firstName,
      lastName: employees.lastName,
      status: employees.status,
    })
    .from(employees)
    .where(and(eq(employees.companyId, ctx.companyId), eq(employees.id, id)));
  return row ? { ...row, name: `${row.firstName} ${row.lastName}` } : null;
}

/** Existencia de varias materias primas en un depósito (sin lock: consulta). */
export async function warehouseQuantities(
  db: Db,
  ctx: OperationContext,
  warehouseId: string,
  rawMaterialIds: readonly string[],
): Promise<Map<string, string>> {
  if (rawMaterialIds.length === 0) return new Map();
  const rows = await db
    .select({ id: stockBalances.rawMaterialId, quantity: stockBalances.quantity })
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.companyId, ctx.companyId),
        eq(stockBalances.warehouseId, warehouseId),
        inArray(stockBalances.rawMaterialId, [...new Set(rawMaterialIds)]),
      ),
    );
  return new Map(rows.map((r) => [r.id!, r.quantity]));
}

/* ---------- Plan ---------- */

export interface PlanContext {
  plan: ProductionPlan;
  materials: Map<string, RawMaterialRow>;
  units: Map<string, UnitRow>;
}

/**
 * Plan de consumo de una orden con la versión indicada y el costo efectivo de
 * HOY (promedio de inventario → referencia manual → incompleto).
 */
export async function computePlan(
  db: Db,
  ctx: OperationContext,
  args: {
    versionId: string;
    plannedOutputQuantity: string;
    plannedOutputUnitId: string;
    saleUnitId: string;
  },
  cache?: { units?: Map<string, UnitRow> },
): Promise<PlanContext> {
  const units = cache?.units ?? (await loadUnits(db, ctx));
  const [version] = await db
    .select()
    .from(recipeVersions)
    .where(and(eq(recipeVersions.companyId, ctx.companyId), eq(recipeVersions.id, args.versionId)));
  if (!version) throw notFound("Versión de receta");
  const ingredients = await loadIngredients(db, ctx, [version.id]);
  const materials = await loadRawMaterials(
    db,
    ctx,
    ingredients.map((i) => i.rawMaterialId),
  );
  let plan: ProductionPlan;
  try {
    plan = planProduction({
      plannedOutputQuantity: args.plannedOutputQuantity,
      plannedOutputUnit: unitOrThrow(units, args.plannedOutputUnitId),
      saleUnit: unitOrThrow(units, args.saleUnitId),
      recipeYieldQuantity: version.yieldQuantity,
      recipeYieldUnit: unitOrThrow(units, version.yieldUnitId),
      ingredients: ingredients.map((ing) => {
        const m = materials.get(ing.rawMaterialId);
        if (!m) throw new Error(`Materia prima ${ing.rawMaterialId} fuera de la empresa`);
        return {
          recipeIngredientId: ing.id,
          rawMaterialId: m.id,
          rawMaterialCode: m.code,
          rawMaterialName: m.name,
          quantity: ing.quantity,
          unit: unitOrThrow(units, ing.unitId),
          baseUnit: unitOrThrow(units, m.baseUnitId),
          effectiveCost: m.effectiveCost,
          costSource: m.effectiveCostSource,
        };
      }),
    });
  } catch (err) {
    productionError(err);
  }
  return { plan, materials, units };
}

/* ---------- Disponibilidad ---------- */

interface Requirement {
  rawMaterialId: string;
  code: string;
  name: string;
  baseUnit: UnitRow;
  required: string;
}

export function availabilityOf(
  warehouse: { id: string; code: string; name: string },
  basis: "PLANNED" | "ACTUAL",
  requirements: readonly Requirement[],
  available: Map<string, string>,
): ProductionAvailabilityDto {
  const byMaterial = new Map<string, Requirement & { total: InstanceType<typeof D> }>();
  for (const r of requirements) {
    const prev = byMaterial.get(r.rawMaterialId);
    byMaterial.set(r.rawMaterialId, {
      ...r,
      total: (prev?.total ?? new D(0)).plus(r.required),
    });
  }
  const shortages = new Set(
    findShortages(
      requirements.map((r) => ({
        rawMaterialId: r.rawMaterialId,
        rawMaterialName: r.name,
        required: r.required,
      })),
      available,
    ).map((s) => s.rawMaterialId),
  );
  const lines: AvailabilityLineDto[] = [...byMaterial.values()].map((r) => {
    const have = new D(available.get(r.rawMaterialId) ?? 0);
    const difference = have.minus(r.total);
    return {
      rawMaterial: { id: r.rawMaterialId, code: r.code, name: r.name },
      baseUnit: unitRef(r.baseUnit),
      required: qty(r.total),
      available: qty(have),
      difference: qty(difference),
      missing: qty(difference.lt(0) ? difference.negated() : 0),
      status: shortages.has(r.rawMaterialId) ? "SHORT" : "OK",
    };
  });
  return {
    warehouse: { id: warehouse.id, code: warehouse.code, name: warehouse.name },
    basis,
    lines,
    sufficient: shortages.size === 0,
  };
}

/** Detalle de faltantes para los errores 409 (qué falta, cuánto hay y cuánto se necesita). */
export function shortageDetails(availability: ProductionAvailabilityDto) {
  return availability.lines
    .filter((l) => l.status === "SHORT")
    .map((l) => ({
      path: `materials.${l.rawMaterial.id}`,
      rawMaterialId: l.rawMaterial.id,
      rawMaterial: l.rawMaterial.name,
      unit: l.baseUnit.symbol,
      required: l.required,
      available: l.available,
      missing: l.missing,
      message: `${l.rawMaterial.name}: faltan ${new D(l.missing).toFixed()} ${l.baseUnit.symbol}`,
    }));
}

/* ---------- DTO ---------- */

function lineDto(
  line: LineRow,
  material: { id: string; code: string; name: string; active: boolean },
  units: Map<string, UnitRow>,
  live: boolean,
): ProductionMaterialLineDto {
  const variance =
    line.actualNormalizedQuantity === null
      ? null
      : live || line.varianceQuantity === null
        ? (() => {
            const v = consumptionVariance(
              line.plannedNormalizedQuantity,
              line.actualNormalizedQuantity,
            );
            return {
              quantity: qty(v.quantity),
              percentage: v.percentage === null ? null : pct(v.percentage),
            };
          })()
        : { quantity: line.varianceQuantity, percentage: line.variancePercentage };
  return {
    id: line.id,
    lineNumber: line.lineNumber,
    lineType: line.lineType,
    rawMaterial: material,
    baseUnit: unitRef(unitOrThrow(units, line.baseUnitId)),
    plannedQuantity: line.plannedQuantity,
    plannedUnit: line.plannedUnitId ? unitRef(unitOrThrow(units, line.plannedUnitId)) : null,
    plannedNormalized: line.plannedNormalizedQuantity,
    actualQuantity: line.actualQuantity,
    actualUnit: line.actualUnitId ? unitRef(unitOrThrow(units, line.actualUnitId)) : null,
    actualNormalized: line.actualNormalizedQuantity,
    variance,
    plannedUnitCost: line.plannedUnitCost,
    plannedCostSource: line.plannedCostSource,
    plannedCost: line.plannedCost,
    actualUnitCost: line.actualUnitCost,
    actualCost: line.actualCost,
    notes: line.notes,
    consumptionMovementId: line.consumptionMovementId,
  };
}

function costVariance(planned: string | null, actual: string | null) {
  if (planned === null || actual === null) return null;
  const amount = new D(actual).minus(planned);
  return {
    amount,
    percentage: new D(planned).isZero() ? null : amount.dividedBy(planned).times(100),
  };
}

/**
 * Orden completa para la UI. En DRAFT las líneas son el plan calculado en vivo
 * (no persistido); desde PLANNED, las líneas guardadas. Sin
 * production.cost.read se quitan todos los importes (withoutProductionCosts).
 */
export async function getOrder(
  db: Db,
  ctx: OperationContext,
  id: string,
  canSeeCosts: boolean,
): Promise<ProductionOrderDto> {
  const order = await findOrder(db, ctx, id);
  const units = await loadUnits(db, ctx);
  const product = (await findProduct(db, ctx, order.productId))!;
  const [recipe] = await db.select().from(recipes).where(eq(recipes.id, order.recipeId));
  const versions = await loadVersions(db, ctx, order.recipeId);
  const version = versions.find((v) => v.id === order.recipeVersionId)!;
  const whs = await loadWarehouses(db, ctx, [order.sourceWarehouseId, order.outputWarehouseId]);
  const source = whs.get(order.sourceWarehouseId)!;
  const output = whs.get(order.outputWarehouseId)!;
  const responsible = order.responsibleEmployeeId
    ? await findEmployee(db, ctx, order.responsibleEmployeeId)
    : null;
  const people = await loadPeople(db, [
    order.createdByUserId,
    order.plannedByUserId,
    order.startedByUserId,
    order.completedByUserId,
    order.cancelledByUserId,
  ]);
  const currency = order.currencyCode ?? (await companyCurrency(db, ctx));
  const issues: ProductionIssueDto[] = [];
  const open = order.status === "DRAFT" || order.status === "PLANNED";

  let estimated: ProductionCostsDto["estimated"] = null;
  let materials: ProductionMaterialLineDto[] = [];
  let preview: ProductionPlan | null = null;
  let requirements: Requirement[] = [];
  let basis: "PLANNED" | "ACTUAL" = "PLANNED";

  if (order.status === "DRAFT") {
    try {
      const ctxPlan = await computePlan(
        db,
        ctx,
        {
          versionId: order.recipeVersionId,
          plannedOutputQuantity: order.plannedOutputQuantity,
          plannedOutputUnitId: order.plannedOutputUnitId,
          saleUnitId: order.saleUnitId,
        },
        { units },
      );
      preview = ctxPlan.plan;
      materials = preview.lines.map((l, i) => {
        const m = ctxPlan.materials.get(l.rawMaterialId)!;
        return {
          id: null,
          lineNumber: i + 1,
          lineType: "RECIPE",
          rawMaterial: { id: m.id, code: m.code, name: m.name, active: m.active },
          baseUnit: unitRef(l.baseUnit),
          plannedQuantity: qty(l.plannedQuantity),
          plannedUnit: unitRef(l.unit),
          plannedNormalized: qty(l.plannedNormalized),
          actualQuantity: null,
          actualUnit: null,
          actualNormalized: null,
          variance: null,
          plannedUnitCost: nullableMoney(l.unitCost),
          plannedCostSource: l.costSource,
          plannedCost: nullableMoney(l.plannedCost),
          actualUnitCost: null,
          actualCost: null,
          notes: null,
          consumptionMovementId: null,
        };
      });
      requirements = preview.lines.map((l) => ({
        rawMaterialId: l.rawMaterialId,
        code: l.rawMaterialCode,
        name: l.rawMaterialName,
        baseUnit: l.baseUnit as UnitRow,
        required: qty(l.plannedNormalized),
      }));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      issues.push({ code: err.code, message: err.message });
    }
  } else {
    const lines = await loadLines(db, ctx, order.id);
    const mats = await loadRawMaterials(
      db,
      ctx,
      lines.map((l) => l.rawMaterialId),
    );
    const live = order.status === "IN_PROGRESS" || order.status === "PLANNED";
    materials = lines.map((l) => {
      const m = mats.get(l.rawMaterialId)!;
      return lineDto(l, { id: m.id, code: m.code, name: m.name, active: m.active }, units, live);
    });
    basis = order.status === "IN_PROGRESS" ? "ACTUAL" : "PLANNED";
    if (order.status === "IN_PROGRESS") {
      // Cada consumo saldrá al promedio vigente: estimación de lo que costará completar.
      let total = new D(0);
      let complete = true;
      for (const l of lines) {
        const average = mats.get(l.rawMaterialId)?.movingAverageCost ?? null;
        if (l.actualNormalizedQuantity === null || new D(l.actualNormalizedQuantity).isZero())
          continue;
        if (average === null) complete = false;
        else total = total.plus(money(new D(l.actualNormalizedQuantity).times(average)));
      }
      estimated = {
        status: complete ? "COMPLETE" : "INCOMPLETE",
        total: complete ? money(total) : null,
        unit:
          complete && order.actualOutputNormalized !== null
            ? money(total.dividedBy(order.actualOutputNormalized))
            : null,
      };
    }
    requirements = lines.flatMap((l) => {
      const required =
        basis === "ACTUAL" ? l.actualNormalizedQuantity : l.plannedNormalizedQuantity;
      if (required === null) return [];
      const m = mats.get(l.rawMaterialId)!;
      return [
        {
          rawMaterialId: m.id,
          code: m.code,
          name: m.name,
          baseUnit: unitOrThrow(units, l.baseUnitId),
          required,
        },
      ];
    });
  }

  let availability: ProductionAvailabilityDto | null = null;
  if (order.status === "DRAFT" || order.status === "PLANNED" || order.status === "IN_PROGRESS") {
    const available = await warehouseQuantities(
      db,
      ctx,
      order.sourceWarehouseId,
      requirements.map((r) => r.rawMaterialId),
    );
    availability = availabilityOf(source, basis, requirements, available);
  }

  if (open || order.status === "IN_PROGRESS") {
    if (!product.active)
      issues.push({ code: "PRODUCT_INACTIVE", message: `${product.name} está desactivado.` });
    if (!product.controlsStock)
      issues.push({
        code: "PRODUCT_NOT_STOCK_CONTROLLED",
        message: `${product.name} no controla stock: no puede producirse a inventario.`,
      });
  }
  if (open) {
    if (recipe && !recipe.active)
      issues.push({ code: "RECIPE_INACTIVE", message: "La receta está desactivada." });
    const inactive = materials.filter((m) => !m.rawMaterial.active);
    if (inactive.length > 0)
      issues.push({
        code: "RAW_MATERIAL_INACTIVE",
        message: `Materia prima dada de baja: ${inactive.map((m) => m.rawMaterial.name).join(", ")}. Actualizá la receta antes de producir.`,
      });
    if (!source.active || !output.active)
      issues.push({ code: "WAREHOUSE_INACTIVE", message: "Uno de los depósitos está inactivo." });
  }

  let suggestedVersion: ProductionOrderDto["suggestedVersion"] = null;
  if (order.status === "DRAFT") {
    const effective = findEffectiveVersion(
      versions,
      effectiveInstant(order.scheduledFor, ctx.timezone),
    );
    if (effective && effective.id !== version.id)
      suggestedVersion = { id: effective.id, versionNumber: effective.versionNumber };
  }

  const performance =
    order.actualOutputNormalized === null
      ? null
      : outputPerformance(order.plannedOutputNormalized, order.actualOutputNormalized);

  const plannedStatus = order.plannedCostStatus ?? preview?.costStatus ?? null;
  const plannedTotal =
    order.status === "DRAFT"
      ? nullableMoney(preview?.plannedMaterialCost ?? null)
      : order.plannedMaterialCost;
  const plannedUnit =
    order.status === "DRAFT"
      ? nullableMoney(preview?.plannedUnitMaterialCost ?? null)
      : order.plannedUnitMaterialCost;
  const variance = costVariance(plannedTotal, order.actualMaterialCost);
  const unitVariance = costVariance(plannedUnit, order.actualUnitMaterialCost);
  const costs: ProductionCostsDto = {
    currency,
    planned: plannedStatus
      ? {
          status: plannedStatus,
          total: plannedTotal,
          unit: plannedUnit,
          missing:
            order.status === "DRAFT"
              ? (preview?.missingCosts.map((m) => m.rawMaterialName) ?? [])
              : materials
                  .filter((m) => m.lineType === "RECIPE" && m.plannedCost === null)
                  .map((m) => m.rawMaterial.name),
        }
      : null,
    actual:
      order.actualMaterialCost !== null && order.actualUnitMaterialCost !== null
        ? { total: order.actualMaterialCost, unit: order.actualUnitMaterialCost }
        : null,
    estimated,
    variance:
      variance && unitVariance
        ? {
            total: money(variance.amount),
            unit: money(unitVariance.amount),
            percentage: variance.percentage === null ? null : pct(variance.percentage),
          }
        : null,
  };

  const [rootLot] =
    order.status === "COMPLETED"
      ? await db
          .select({
            id: productLots.id,
            code: productLots.lotCode,
            conservationState: productLots.conservationState,
            usableUntil: productLots.usableUntil,
          })
          .from(productLots)
          .where(
            and(
              eq(productLots.companyId, ctx.companyId),
              eq(productLots.productionOrderId, order.id),
              isNull(productLots.parentLotId),
            ),
          )
      : [];

  const dto: ProductionOrderDto = {
    id: order.id,
    code: order.internalCode,
    status: order.status,
    product: {
      id: product.id,
      code: product.internalCode,
      name: product.name,
      active: product.active,
      controlsStock: product.controlsStock,
    },
    recipe: { id: order.recipeId, name: recipe?.name ?? "" },
    recipeVersion: {
      id: version.id,
      versionNumber: version.versionNumber,
      status: version.status,
      yieldQuantity: version.yieldQuantity,
      yieldUnit: unitRef(unitOrThrow(units, version.yieldUnitId)),
    },
    suggestedVersion,
    sourceWarehouse: { id: source.id, code: source.code, name: source.name },
    outputWarehouse: { id: output.id, code: output.code, name: output.name },
    scheduledFor: order.scheduledFor,
    plannedOutputQuantity: order.plannedOutputQuantity,
    plannedOutputUnit: unitRef(unitOrThrow(units, order.plannedOutputUnitId)),
    plannedOutputNormalized: order.plannedOutputNormalized,
    saleUnit: unitRef(unitOrThrow(units, order.saleUnitId)),
    scaleFactor: order.scaleFactor ?? (preview ? qty(preview.scaleFactor) : null),
    theoreticalWastePercentage: order.theoreticalWastePercentage ?? version.wastePercentage,
    actualOutputQuantity: order.actualOutputQuantity,
    actualOutputUnit: order.actualOutputUnitId
      ? unitRef(unitOrThrow(units, order.actualOutputUnitId))
      : null,
    actualOutputNormalized: order.actualOutputNormalized,
    output: performance
      ? {
          variance: qty(performance.variance),
          variancePercentage: pct(performance.variancePercentage),
          yieldPerformance: pct(performance.yieldPerformance),
        }
      : null,
    batchCode: order.batchCode,
    productLot: rootLot
      ? { ...rootLot, usableUntil: rootLot.usableUntil?.toISOString() ?? null }
      : null,
    responsible: responsible ? { id: responsible.id, name: responsible.name } : null,
    notes: order.notes,
    cancelReason: order.cancelReason,
    materials,
    materialsArePreview: order.status === "DRAFT",
    availability,
    costs,
    issues,
    createdAt: order.createdAt.toISOString(),
    createdBy: personOf(people, order.createdByUserId),
    plannedAt: order.plannedAt?.toISOString() ?? null,
    plannedBy: personOf(people, order.plannedByUserId),
    startedAt: order.startedAt?.toISOString() ?? null,
    startedBy: personOf(people, order.startedByUserId),
    completedAt: order.completedAt?.toISOString() ?? null,
    completedBy: personOf(people, order.completedByUserId),
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    cancelledBy: personOf(people, order.cancelledByUserId),
    canSeeCosts: true,
  };
  return canSeeCosts ? dto : withoutProductionCosts(dto);
}

/** Materias primas inactivas en un conjunto de ids (para bloquear planificar/iniciar). */
export async function inactiveMaterials(db: Db, ctx: OperationContext, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return db
    .select({ id: rawMaterials.id, name: rawMaterials.name })
    .from(rawMaterials)
    .where(
      and(
        eq(rawMaterials.companyId, ctx.companyId),
        inArray(rawMaterials.id, [...new Set(ids)]),
        eq(rawMaterials.active, false),
      ),
    );
}
