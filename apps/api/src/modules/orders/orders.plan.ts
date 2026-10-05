import {
  D,
  ProductionError,
  allocateFefo,
  availabilityForOrder,
  expandRecipe,
  findEffectiveVersion,
  normalizeOutput,
  planCoverage,
  requestedConservationLabel,
  type Allocation,
  type LotWithCommitment,
  type OrderAvailability,
  type RequestedConservation,
} from "@bakery/domain";
import {
  productLotBalances,
  productLots,
  products,
  type Database,
  type Transaction,
} from "@bakery/database";
import {
  ORDER_INELIGIBILITY_LABELS,
  formatLocalDateTime,
  instantToZonedLocal,
  type OrderLineInput,
  type RequirementProblemDto,
} from "@bakery/shared";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { OperationContext } from "../../lib/context.js";
import { invalidReference } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { forAvailability, selectLots, type LotRow } from "../lots/lots.data.js";
import { findActiveRecipe, loadVersions } from "../production/production.data.js";
import {
  loadIngredients,
  loadRawMaterials,
  unitOrThrow,
  type UnitRow,
} from "../recipes/recipes.data.js";
import { committedByLot, lockLots } from "./reservations.js";

/*
 * Planificador de un pedido (Fase 5A): resuelve las líneas, toma los lotes de
 * los productos (bloqueados si se va a reservar), descuenta lo comprometido por
 * OTROS pedidos, asigna FEFO y, para lo que falta, expande la receta vigente.
 * Lo usan la vista previa, confirmar y replanificar: las mismas reglas siempre.
 */

type Db = Database | Transaction;

export interface ResolvedLine {
  index: number;
  /** Línea existente (replanificación) o null si es nueva. */
  id: string | null;
  product: {
    id: string;
    code: string;
    name: string;
    saleUnitId: string;
    salePrice: string;
    controlsStock: boolean;
  };
  quantity: string;
  unit: UnitRow;
  saleUnit: UnitRow;
  /** Cantidad en la unidad de venta (la del stock y los lotes). */
  normalized: InstanceType<typeof D>;
  requestedConservation: RequestedConservation;
  notes: string | null;
  /** Precio pedido para la línea (sin precio = vigente / acordado). */
  price: { unitPrice?: string; discountAmount?: string; priceOverrideReason?: string | null };
}

/** Valida productos y unidades y normaliza cada cantidad a la unidad de venta. */
export async function resolveLines(
  db: Db,
  ctx: OperationContext,
  inputs: readonly OrderLineInput[],
  units: Map<string, UnitRow>,
): Promise<ResolvedLine[]> {
  const ids = [...new Set(inputs.map((l) => l.productId))];
  const rows = await db
    .select({
      id: products.id,
      code: products.internalCode,
      name: products.name,
      active: products.active,
      saleUnitId: products.saleUnitId,
      salePrice: products.salePrice,
      controlsStock: products.controlsStock,
    })
    .from(products)
    .where(and(eq(products.companyId, ctx.companyId), inArray(products.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return inputs.map((input, index) => {
    const product = byId.get(input.productId);
    if (!product) throw invalidReference(`lines.${index}.productId`, "Producto inexistente");
    if (!product.active) {
      throw new AppError(
        422,
        "PRODUCT_INACTIVE",
        `${product.name} está desactivado: no admite pedidos nuevos.`,
        [{ path: `lines.${index}.productId`, message: "Producto desactivado" }],
      );
    }
    const saleUnit = unitOrThrow(units, product.saleUnitId);
    const unitId = input.unitId ?? product.saleUnitId;
    const unit = units.get(unitId);
    if (!unit) throw invalidReference(`lines.${index}.unitId`, "Unidad inexistente");
    let normalized: InstanceType<typeof D>;
    try {
      normalized = normalizeOutput(input.quantity, unit, saleUnit);
    } catch (err) {
      if (err instanceof ProductionError) {
        throw new AppError(422, "INCOMPATIBLE_ORDER_UNIT", err.message, [
          { path: `lines.${index}.unitId`, message: err.message },
        ]);
      }
      throw err;
    }
    return {
      index,
      id: input.id ?? null,
      product,
      quantity: input.quantity,
      unit,
      saleUnit,
      normalized,
      requestedConservation: input.requestedConservation,
      notes: input.notes ?? null,
      price: {
        unitPrice: input.unitPrice,
        discountAmount: input.discountAmount,
        priceOverrideReason: input.priceOverrideReason,
      },
    };
  });
}

/* ---------- Plan ---------- */

export type LotCandidate = LotWithCommitment & { row: LotRow };

export interface PlannedRecipe {
  recipeId: string;
  versionId: string;
  versionNumber: number;
}

export interface PlanLine {
  line: ResolvedLine;
  /** Disponibilidad en la fecha pedida descontando lo comprometido por OTROS pedidos. */
  availability: OrderAvailability<LotCandidate>;
  allocations: Allocation<LotCandidate>[];
  reserved: InstanceType<typeof D>;
  /** Falta después de reservar (pedido − reservado). */
  missing: InstanceType<typeof D>;
  /** Ya en producción para esta línea (órdenes en curso que se conservan al replanificar). */
  inFlight: InstanceType<typeof D>;
  /** Necesidad NUEVA de producción (falta − en producción); 0 si hay `problem`. */
  toProduce: InstanceType<typeof D>;
  /** Sin receta usable: queda sin cubrir. */
  uncovered: InstanceType<typeof D>;
  recipe: PlannedRecipe | null;
  /** Receta activa aunque la versión no sea usable (para guardar recipe_id). */
  recipeId: string | null;
  problem: RequirementProblemDto | null;
  materials: { rawMaterialId: string; required: InstanceType<typeof D> }[];
  explanation: string[];
}

export interface OrderPlan {
  requestedAt: Date;
  requestedAtLocal: string;
  lines: PlanLine[];
  coverage: ReturnType<typeof planCoverage>;
}

export interface BuildPlanArgs {
  requestedAt: Date;
  lines: ResolvedLine[];
  /** Pedido cuyas reservas actuales NO cuentan como comprometidas (replanificación). */
  excludeOrderId?: string | null;
  /** true dentro de confirmar / replanificar: bloquea los lotes (FOR UPDATE, por id). */
  lock?: boolean;
  /** Lotes que hay que bloquear además de los que tienen saldo (reservas a liberar). */
  extraLotIds?: readonly string[];
  /** Cantidad ya en producción por línea existente (id de línea → cantidad). */
  inFlightByLine?: ReadonlyMap<string, InstanceType<typeof D>>;
  units: Map<string, UnitRow>;
}

const fmt = (v: InstanceType<typeof D>) => v.toDecimalPlaces(6).toString();

/** Ids de lotes con saldo positivo de los productos dados. */
async function lotIdsWithBalance(db: Db, ctx: OperationContext, productIds: readonly string[]) {
  if (productIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ id: productLotBalances.productLotId })
    .from(productLotBalances)
    .where(
      and(
        eq(productLotBalances.companyId, ctx.companyId),
        inArray(productLotBalances.productId, [...new Set(productIds)]),
        gt(productLotBalances.quantity, "0"),
      ),
    );
  return rows.map((r) => r.id);
}

interface RecipeInfo {
  recipeId: string | null;
  recipe: PlannedRecipe | null;
  problem: RequirementProblemDto | null;
  version: Awaited<ReturnType<typeof loadVersions>>[number] | null;
  ingredients: Awaited<ReturnType<typeof loadIngredients>>;
}

/** Receta activa y versión vigente HOY (la que se fija en la necesidad). */
async function recipeInfo(
  db: Db,
  ctx: OperationContext,
  productId: string,
  now: Date,
): Promise<RecipeInfo> {
  const recipe = await findActiveRecipe(db, ctx, productId);
  if (!recipe) {
    return {
      recipeId: null,
      recipe: null,
      problem: "NO_RECIPE_FOR_PRODUCTION",
      version: null,
      ingredients: [],
    };
  }
  const version = findEffectiveVersion(await loadVersions(db, ctx, recipe.id), now);
  if (!version) {
    return {
      recipeId: recipe.id,
      recipe: null,
      problem: "RECIPE_NOT_USABLE",
      version: null,
      ingredients: [],
    };
  }
  return {
    recipeId: recipe.id,
    recipe: { recipeId: recipe.id, versionId: version.id, versionNumber: version.versionNumber },
    problem: null,
    version,
    ingredients: await loadIngredients(db, ctx, [version.id]),
  };
}

/**
 * Plan de cobertura de un pedido. Con `lock`, los lotes se bloquean ANTES de
 * leer saldos y compromisos (ADR-053), así dos confirmaciones concurrentes no
 * pueden reservar la misma cantidad. Sin `lock` es una consulta (vista previa).
 */
export async function buildPlan(
  db: Db,
  ctx: OperationContext,
  args: BuildPlanArgs,
): Promise<OrderPlan> {
  const { requestedAt, lines, units } = args;
  const now = new Date();
  const productIds = [...new Set(lines.map((l) => l.product.id))];
  const lotIds = [
    ...new Set([...(await lotIdsWithBalance(db, ctx, productIds)), ...(args.extraLotIds ?? [])]),
  ];
  if (args.lock) await lockLots(db as Transaction, ctx, lotIds);
  const rows = lotIds.length > 0 ? await selectLots(db, ctx, inArray(productLots.id, lotIds)) : [];
  const committed = await committedByLot(db, ctx, lotIds, args.excludeOrderId ?? null);
  // Compromiso local: dos líneas del mismo producto no reservan dos veces lo mismo.
  const local = new Map<string, InstanceType<typeof D>>();
  const committedOf = (lotId: string) =>
    new D(committed.get(lotId) ?? 0).plus(local.get(lotId) ?? 0);

  const recipes = new Map<string, RecipeInfo>();
  const allIngredientMaterials: string[] = [];
  for (const productId of productIds) {
    const info = await recipeInfo(db, ctx, productId, now);
    recipes.set(productId, info);
    allIngredientMaterials.push(...info.ingredients.map((i) => i.rawMaterialId));
  }
  const materials = await loadRawMaterials(db, ctx, allIngredientMaterials);
  const local_ = instantToZonedLocal(requestedAt, ctx.timezone);
  const when = formatLocalDateTime(local_);

  const planLines: PlanLine[] = [];
  for (const line of lines) {
    const candidates: LotCandidate[] = rows
      .filter((r) => r.lot.productId === line.product.id)
      .map((row) => ({ ...forAvailability(row), committed: committedOf(row.lot.id), row }));
    // La disponibilidad que se muestra no incluye lo que otras líneas de este mismo pedido toman.
    const shown = availabilityForOrder(
      candidates.map((c) => ({ ...c, committed: new D(committed.get(c.id) ?? 0) })),
      requestedAt,
      line.requestedConservation,
    );
    const fefo = allocateFefo(candidates, line.normalized, requestedAt, line.requestedConservation);
    for (const a of fefo.allocations) {
      local.set(a.lot.id, (local.get(a.lot.id) ?? new D(0)).plus(a.quantity));
    }
    const inFlight = line.id ? (args.inFlightByLine?.get(line.id) ?? new D(0)) : new D(0);
    const need = D.max(fefo.missing.minus(inFlight), 0);
    const info = recipes.get(line.product.id)!;
    let problem = info.problem;
    let expanded: PlanLine["materials"] = [];
    if (need.gt(0) && !problem && info.version) {
      try {
        expanded = expandRecipe({
          quantity: need,
          saleUnit: line.saleUnit,
          recipeYieldQuantity: info.version.yieldQuantity,
          recipeYieldUnit: unitOrThrow(units, info.version.yieldUnitId),
          ingredients: info.ingredients.map((ing) => {
            const m = materials.get(ing.rawMaterialId);
            if (!m) throw new Error(`Materia prima ${ing.rawMaterialId} fuera de la empresa`);
            return {
              rawMaterialId: m.id,
              rawMaterialCode: m.code,
              rawMaterialName: m.name,
              quantity: ing.quantity,
              unit: unitOrThrow(units, ing.unitId),
              baseUnit: unitOrThrow(units, m.baseUnitId),
            };
          }),
        }).materials;
      } catch (err) {
        if (!(err instanceof ProductionError)) throw err;
        problem = "RECIPE_NOT_USABLE";
      }
    }
    const blocked = problem !== null;
    const unit = line.saleUnit.symbol;
    const explanation: string[] = [];
    const conservation =
      line.requestedConservation === "ANY"
        ? ""
        : ` (${requestedConservationLabel(line.requestedConservation).toLowerCase()})`;
    explanation.push(`Pedido: ${fmt(line.normalized)} ${unit}${conservation} para el ${when}.`);
    if (shown.physicalQuantity.isZero()) {
      explanation.push("No hay stock de este producto en lotes.");
    } else {
      explanation.push(`Hay ${fmt(shown.physicalQuantity)} ${unit} en lotes.`);
      for (const [reason, quantity] of Object.entries(shown.ineligibleByReason)) {
        if (quantity.gt(0)) {
          explanation.push(
            `${fmt(quantity)} ${unit} no sirven: ${ORDER_INELIGIBILITY_LABELS[reason as keyof typeof ORDER_INELIGIBILITY_LABELS].toLowerCase()}.`,
          );
        }
      }
      if (shown.committedQuantity.gt(0)) {
        explanation.push(
          `${fmt(shown.committedQuantity)} ${unit} ya están comprometidos con otros pedidos.`,
        );
      }
    }
    if (fefo.reserved.gt(0)) {
      const n = fefo.allocations.length;
      explanation.push(
        `Se reservan ${fmt(fefo.reserved)} ${unit} de ${n} ${n === 1 ? "lote" : "lotes"} (primero el que vence antes).`,
      );
    }
    if (shown.shelfLifeUnknownAvailable.gt(0) && fefo.reserved.gt(0)) {
      explanation.push(
        "Atención: hay lotes sin vida útil configurada; se consideran utilizables pero conviene configurar la conservación del producto.",
      );
    }
    if (inFlight.gt(0)) {
      explanation.push(`${fmt(inFlight)} ${unit} ya están en producción para este pedido.`);
    }
    if (need.gt(0)) {
      if (blocked) {
        explanation.push(
          problem === "NO_RECIPE_FOR_PRODUCTION"
            ? `Faltan ${fmt(need)} ${unit} y el producto no tiene receta activa: no se puede planificar su producción.`
            : `Faltan ${fmt(need)} ${unit} y la receta no se puede usar (sin versión vigente o unidades incompatibles).`,
        );
      } else {
        explanation.push(
          `Faltan producir ${fmt(need)} ${unit} (receta versión ${info.recipe!.versionNumber}).`,
        );
      }
    }
    planLines.push({
      line,
      availability: shown,
      allocations: fefo.allocations,
      reserved: fefo.reserved,
      missing: fefo.missing,
      inFlight,
      toProduce: blocked ? new D(0) : need,
      uncovered: blocked ? need : new D(0),
      recipe: blocked ? null : info.recipe,
      recipeId: info.recipeId,
      problem: need.gt(0) ? problem : null,
      materials: blocked ? [] : expanded,
      explanation,
    });
  }

  return {
    requestedAt,
    requestedAtLocal: local_,
    lines: planLines,
    coverage: planCoverage(
      planLines.map((p) => ({ requested: p.line.normalized, reserved: p.reserved })),
    ),
  };
}

/** Necesidad de materias primas del plan (unidad base), sumada por materia prima. */
export function planMaterialNeeds(plan: OrderPlan): Map<string, InstanceType<typeof D>> {
  const result = new Map<string, InstanceType<typeof D>>();
  for (const line of plan.lines) {
    for (const m of line.materials) {
      result.set(m.rawMaterialId, (result.get(m.rawMaterialId) ?? new D(0)).plus(m.required));
    }
  }
  return result;
}
