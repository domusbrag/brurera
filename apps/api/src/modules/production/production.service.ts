import {
  D,
  ProductionError,
  actualMaterialCost,
  actualUnitMaterialCost,
  assertTransition,
  consumptionVariance,
  formatBatchCode,
  normalizeConsumption,
  normalizeOutput,
  type ProductionStatus,
} from "@bakery/domain";
import {
  allocateCode,
  employees,
  productionMaterialLines,
  productionOrders,
  products,
  recipeVersions,
  stockMovements,
  unitsOfMeasure,
  type Database,
  type Transaction,
} from "@bakery/database";
import {
  PRODUCTION_OPERATIONAL_FIELDS,
  listItemWithoutCosts,
  type CompleteProductionInput,
  type CreateProductionOrderInput,
  type ExtraMaterialInput,
  type Page,
  type ProductionActualsInput,
  type ProductionCostComparisonDto,
  type ProductionOrderDto,
  type ProductionOrderListItemDto,
  type ResponsibleOptionDto,
  type StockMovementDto,
  type UpdateProductionOrderInput,
  type productionListQuerySchema,
} from "@bakery/shared";
import { and, asc, count, desc, eq, gte, ilike, inArray, like, lte, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { invalidReference, mapUniqueViolations } from "../../lib/db-errors.js";
import { AppError } from "../../lib/errors.js";
import { likePattern, pageWindow, toPage } from "../../lib/listing.js";
import { recordAudit } from "../audit/audit.service.js";
import { createProductionLot } from "../lots/lots.service.js";
import { selectMovements } from "../inventory/inventory.service.js";
import {
  fixedMoney,
  lockMaterialBalances,
  lockMaterialCosts,
  postProductMovement,
  postStockMovement,
} from "../inventory/ledger.js";
import {
  companyCurrency,
  loadRawMaterials,
  loadUnits,
  unitOrThrow,
  type UnitRow,
} from "../recipes/recipes.data.js";
import {
  availabilityOf,
  computePlan,
  effectiveVersionFor,
  findActiveRecipe,
  findEmployee,
  findOrder,
  findProduct,
  getOrder,
  inactiveMaterials,
  loadLines,
  loadVersions,
  loadWarehouses,
  money,
  pct,
  qty,
  shortageDetails,
  warehouseQuantities,
  type Db,
  type OrderRow,
} from "./production.data.js";

/*
 * Órdenes de producción (Fase 4). La orden es también el lote (ADR-039).
 * DRAFT → PLANNED → IN_PROGRESS → COMPLETED, o CANCELLED antes de completar.
 * Sólo completar mueve stock (ADR-041), en UNA transacción con locks en orden
 * fijo (ADR-042): orden → líneas → costos de materias primas (por id) → saldos
 * de materias primas (por id) → costo del producto → saldo del producto.
 */

export { getOrder };

/* ---------- Errores ---------- */

const immutable = (order: OrderRow) =>
  new AppError(
    409,
    "PRODUCTION_IMMUTABLE",
    order.status === "COMPLETED"
      ? `La orden ${order.internalCode} está completada: no se modifica ni se cancela (no hay reversión de producción).`
      : `La orden ${order.internalCode} está cancelada y no se modifica.`,
  );

const alreadyCompleted = (order: OrderRow) =>
  new AppError(
    409,
    "PRODUCTION_ALREADY_COMPLETED",
    `La orden ${order.internalCode} ya fue completada: el stock no se vuelve a mover.`,
  );

const planLocked = (fields: string[]) =>
  new AppError(
    409,
    "PRODUCTION_PLAN_LOCKED",
    "La orden ya está planificada: producto, receta, fecha, cantidad y depósitos no cambian. Cancelala y creá otra si hace falta.",
    fields.map((path) => ({ path, message: "Bloqueado desde la planificación" })),
  );

const batchTaken = () =>
  new AppError(409, "BATCH_CODE_TAKEN", "Ese código de lote ya está en uso.", [
    { path: "batchCode", message: "Código de lote en uso" },
  ]);

const UNIQUE = { production_orders_company_batch_uq: batchTaken };

/** COMPLETED / CANCELLED no aceptan cambios; una transición inválida da 409. */
function assertMutable(order: OrderRow) {
  if (order.status === "COMPLETED" || order.status === "CANCELLED") throw immutable(order);
}

function transition(order: OrderRow, to: ProductionStatus) {
  try {
    assertTransition(order.status, to);
  } catch (err) {
    if (err instanceof ProductionError) {
      throw new AppError(409, err.code, transitionMessage(order, to));
    }
    throw err;
  }
}

function transitionMessage(order: OrderRow, to: ProductionStatus) {
  const verbs: Record<ProductionStatus, string> = {
    DRAFT: "volver a borrador",
    PLANNED: "planificar",
    IN_PROGRESS: "iniciar",
    COMPLETED: "completar",
    CANCELLED: "cancelar",
  };
  const states: Record<ProductionStatus, string> = {
    DRAFT: "en borrador",
    PLANNED: "planificada",
    IN_PROGRESS: "en curso",
    COMPLETED: "completada",
    CANCELLED: "cancelada",
  };
  return `No se puede ${verbs[to]} una orden ${states[order.status]}.`;
}

function orderMeta(order: OrderRow) {
  return { code: order.internalCode, productId: order.productId };
}

/* ---------- Validaciones de referencias ---------- */

async function resolveProduct(db: Db, ctx: OperationContext, productId: string) {
  const product = await findProduct(db, ctx, productId);
  if (!product) throw invalidReference("productId", "Producto inexistente");
  if (!product.active) {
    throw new AppError(
      422,
      "PRODUCT_INACTIVE",
      `${product.name} está desactivado: no admite órdenes nuevas.`,
      [{ path: "productId", message: "Producto desactivado" }],
    );
  }
  if (!product.controlsStock) {
    throw new AppError(
      422,
      "PRODUCT_NOT_STOCK_CONTROLLED",
      `${product.name} no controla stock: no puede producirse a inventario. Activá el control de stock en el producto.`,
      [{ path: "productId", message: "El producto no controla stock" }],
    );
  }
  const recipe = await findActiveRecipe(db, ctx, productId);
  if (!recipe) {
    throw new AppError(
      422,
      "PRODUCT_WITHOUT_RECIPE",
      `${product.name} no tiene una receta activa.`,
      [{ path: "productId", message: "Sin receta activa" }],
    );
  }
  return { product, recipe };
}

async function resolveVersion(
  db: Db,
  ctx: OperationContext,
  recipeId: string,
  scheduledFor: string,
  explicitId: string | null | undefined,
) {
  if (explicitId) {
    const versions = await loadVersions(db, ctx, recipeId);
    const chosen = versions.find((v) => v.id === explicitId);
    if (!chosen)
      throw invalidReference("recipeVersionId", "La versión no es de la receta del producto");
    if (chosen.effectiveFrom === null) {
      throw invalidReference(
        "recipeVersionId",
        "La versión todavía es un borrador: publicala antes de producir",
      );
    }
    return chosen;
  }
  const effective = await effectiveVersionFor(db, ctx, recipeId, scheduledFor);
  if (!effective) {
    throw new AppError(
      422,
      "NO_EFFECTIVE_VERSION",
      "La receta no tiene una versión vigente para la fecha programada.",
      [{ path: "scheduledFor", message: "Sin versión vigente" }],
    );
  }
  return effective;
}

async function assertWarehouses(db: Db, ctx: OperationContext, sourceId: string, outputId: string) {
  const whs = await loadWarehouses(db, ctx, [sourceId, outputId]);
  for (const [field, id] of [
    ["sourceWarehouseId", sourceId],
    ["outputWarehouseId", outputId],
  ] as const) {
    const wh = whs.get(id);
    if (!wh || !wh.active) throw invalidReference(field, "Depósito inexistente o inactivo");
  }
  return whs;
}

async function assertResponsible(db: Db, ctx: OperationContext, id: string | null | undefined) {
  if (!id) return null;
  const employee = await findEmployee(db, ctx, id);
  if (!employee || employee.status !== "ACTIVE") {
    throw invalidReference("responsibleEmployeeId", "Empleado inexistente o inactivo");
  }
  return employee;
}

function assertUnit(units: Map<string, UnitRow>, id: string, field: string) {
  if (!units.has(id)) throw invalidReference(field, "Unidad inexistente");
  return units.get(id)!;
}

/** Normaliza la cantidad a producir y valida que la receta se pueda escalar. */
async function draftFigures(
  db: Db,
  ctx: OperationContext,
  args: {
    versionId: string;
    plannedOutputQuantity: string;
    plannedOutputUnitId: string;
    saleUnitId: string;
  },
) {
  const units = await loadUnits(db, ctx);
  assertUnit(units, args.plannedOutputUnitId, "plannedOutputUnitId");
  const { plan } = await computePlan(db, ctx, args, { units });
  return { plannedOutputNormalized: qty(plan.plannedOutputNormalized) };
}

async function isCodeTaken(db: Db, ctx: OperationContext, code: string) {
  const rows = await db
    .select({ id: productionOrders.id })
    .from(productionOrders)
    .where(
      and(eq(productionOrders.companyId, ctx.companyId), eq(productionOrders.internalCode, code)),
    )
    .limit(1);
  return rows.length > 0;
}

/* ---------- Listado ---------- */

export async function listOrders(
  db: Database,
  ctx: OperationContext,
  query: z.infer<typeof productionListQuerySchema>,
  canSeeCosts: boolean,
): Promise<Page<ProductionOrderListItemDto>> {
  const status =
    query.status === "all"
      ? undefined
      : query.status === "open"
        ? inArray(productionOrders.status, ["DRAFT", "PLANNED", "IN_PROGRESS"])
        : eq(productionOrders.status, query.status);
  const pattern = query.search ? likePattern(query.search) : undefined;
  const where = and(
    eq(productionOrders.companyId, ctx.companyId),
    status,
    query.productId ? eq(productionOrders.productId, query.productId) : undefined,
    query.responsibleEmployeeId
      ? eq(productionOrders.responsibleEmployeeId, query.responsibleEmployeeId)
      : undefined,
    query.from ? gte(productionOrders.scheduledFor, query.from) : undefined,
    query.to ? lte(productionOrders.scheduledFor, query.to) : undefined,
    pattern
      ? or(
          ilike(productionOrders.internalCode, pattern),
          ilike(productionOrders.batchCode, pattern),
          ilike(products.name, pattern),
          ilike(products.internalCode, pattern),
        )
      : undefined,
  );
  const { limit, offset } = pageWindow(query);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        o: productionOrders,
        product: { id: products.id, code: products.internalCode, name: products.name },
        unit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
        version: { id: recipeVersions.id, versionNumber: recipeVersions.versionNumber },
        employee: { id: employees.id, first: employees.firstName, last: employees.lastName },
      })
      .from(productionOrders)
      .innerJoin(products, eq(products.id, productionOrders.productId))
      .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, productionOrders.saleUnitId))
      .innerJoin(recipeVersions, eq(recipeVersions.id, productionOrders.recipeVersionId))
      .leftJoin(employees, eq(employees.id, productionOrders.responsibleEmployeeId))
      .where(where)
      .orderBy(desc(productionOrders.scheduledFor), desc(productionOrders.internalCode))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: count() })
      .from(productionOrders)
      .innerJoin(products, eq(products.id, productionOrders.productId))
      .where(where),
  ]);
  const currency = await companyCurrency(db, ctx);
  const items = rows.map(({ o, product, unit, version, employee }): ProductionOrderListItemDto => {
    const item: ProductionOrderListItemDto = {
      id: o.id,
      code: o.internalCode,
      status: o.status,
      product,
      scheduledFor: o.scheduledFor,
      plannedOutputNormalized: o.plannedOutputNormalized,
      actualOutputNormalized: o.actualOutputNormalized,
      saleUnit: unit,
      responsible: employee?.id
        ? { id: employee.id, name: `${employee.first} ${employee.last}` }
        : null,
      recipeVersion: version,
      batchCode: o.batchCode,
      currency: o.currencyCode ?? currency,
      actualMaterialCost: o.actualMaterialCost,
    };
    return canSeeCosts ? item : listItemWithoutCosts(item);
  });
  return toPage(items, total?.n ?? 0, query);
}

export async function listResponsibles(
  db: Database,
  ctx: OperationContext,
): Promise<ResponsibleOptionDto[]> {
  const rows = await db
    .select({ id: employees.id, first: employees.firstName, last: employees.lastName })
    .from(employees)
    .where(and(eq(employees.companyId, ctx.companyId), eq(employees.status, "ACTIVE")))
    .orderBy(asc(employees.lastName), asc(employees.firstName));
  return rows.map((r) => ({ id: r.id, name: `${r.first} ${r.last}` }));
}

/* ---------- Alta y edición (DRAFT) ---------- */

export async function createOrder(
  db: Database,
  ctx: OperationContext,
  input: CreateProductionOrderInput,
  canSeeCosts: boolean,
) {
  return db.transaction((tx) => insertOrder(tx, ctx, input, canSeeCosts));
}

class PreviewRollback extends Error {
  constructor(readonly order: ProductionOrderDto) {
    super("vista previa");
  }
}

/**
 * Vista previa de una orden nueva (receta sugerida, plan, disponibilidad y costo
 * esperado) con EXACTAMENTE las mismas reglas que el alta: se crea dentro de una
 * transacción que siempre se revierte. No deja rastro (ni código ni auditoría).
 */
export async function previewOrder(
  db: Database,
  ctx: OperationContext,
  input: CreateProductionOrderInput,
  canSeeCosts: boolean,
): Promise<ProductionOrderDto> {
  try {
    await db.transaction(async (tx) => {
      throw new PreviewRollback(await insertOrder(tx, ctx, input, canSeeCosts));
    });
  } catch (err) {
    if (err instanceof PreviewRollback) return err.order;
    throw err;
  }
  throw new Error("La vista previa debía revertirse");
}

async function insertOrder(
  tx: Transaction,
  ctx: OperationContext,
  input: CreateProductionOrderInput,
  canSeeCosts: boolean,
) {
  {
    const { product, recipe } = await resolveProduct(tx, ctx, input.productId);
    const version = await resolveVersion(
      tx,
      ctx,
      recipe.id,
      input.scheduledFor,
      input.recipeVersionId,
    );
    await assertWarehouses(tx, ctx, input.sourceWarehouseId, input.outputWarehouseId);
    await assertResponsible(tx, ctx, input.responsibleEmployeeId);
    const plannedOutputUnitId = input.plannedOutputUnitId ?? product.saleUnitId;
    const figures = await draftFigures(tx, ctx, {
      versionId: version.id,
      plannedOutputQuantity: input.plannedOutputQuantity,
      plannedOutputUnitId,
      saleUnitId: product.saleUnitId,
    });
    const code = await allocateCode(tx, ctx.companyId, "PRODUCTION_ORDER", (c) =>
      isCodeTaken(tx, ctx, c),
    );
    const [order] = await mapUniqueViolations(
      tx
        .insert(productionOrders)
        .values({
          companyId: ctx.companyId,
          internalCode: code,
          productId: product.id,
          recipeId: recipe.id,
          recipeVersionId: version.id,
          sourceWarehouseId: input.sourceWarehouseId,
          outputWarehouseId: input.outputWarehouseId,
          status: "DRAFT",
          scheduledFor: input.scheduledFor,
          plannedOutputQuantity: input.plannedOutputQuantity,
          plannedOutputUnitId,
          saleUnitId: product.saleUnitId,
          plannedOutputNormalized: figures.plannedOutputNormalized,
          batchCode: input.batchCode,
          responsibleEmployeeId: input.responsibleEmployeeId,
          notes: input.notes,
          createdByUserId: ctx.userId,
        })
        .returning(),
      UNIQUE,
    );
    if (!order) throw new Error("Alta de orden sin fila");
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRODUCTION_ORDER_CREATED",
      entityType: "production_order",
      entityId: order.id,
      metadata: {
        code,
        product: product.name,
        productId: product.id,
        recipeVersionId: version.id,
        versionNumber: version.versionNumber,
        scheduledFor: order.scheduledFor,
        plannedOutputQuantity: order.plannedOutputQuantity,
        plannedOutputNormalized: order.plannedOutputNormalized,
      },
    });
    return getOrder(tx, ctx, order.id, canSeeCosts);
  }
}

const STRUCTURAL = [
  "productId",
  "scheduledFor",
  "plannedOutputQuantity",
  "plannedOutputUnitId",
  "recipeVersionId",
  "sourceWarehouseId",
  "outputWarehouseId",
] as const;

export async function updateOrder(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: UpdateProductionOrderInput,
  canSeeCosts: boolean,
) {
  return db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    assertMutable(order);
    const before = { ...order };
    const set: Partial<typeof productionOrders.$inferInsert> = {};

    if (order.status !== "DRAFT") {
      // Desde PLANNED sólo responsable, lote y notas (el resto está fijado).
      const blocked = STRUCTURAL.filter((field) => {
        const value = input[field];
        if (value === undefined) return false;
        const current: Record<(typeof STRUCTURAL)[number], unknown> = {
          productId: order.productId,
          scheduledFor: order.scheduledFor,
          plannedOutputQuantity: order.plannedOutputQuantity,
          plannedOutputUnitId: order.plannedOutputUnitId,
          recipeVersionId: order.recipeVersionId,
          sourceWarehouseId: order.sourceWarehouseId,
          outputWarehouseId: order.outputWarehouseId,
        };
        if (field === "plannedOutputQuantity" && value !== null) {
          return !new D(value as string).eq(order.plannedOutputQuantity);
        }
        return value !== current[field];
      });
      if (blocked.length > 0) throw planLocked(blocked);
    } else {
      const productId = input.productId ?? order.productId;
      const productChanged = productId !== order.productId;
      const scheduledFor = input.scheduledFor ?? order.scheduledFor;
      const { product, recipe } = await resolveProduct(tx, ctx, productId);
      // Cambiar producto o fecha recalcula la versión vigente, salvo que se elija una.
      const explicit =
        input.recipeVersionId !== undefined
          ? input.recipeVersionId
          : productChanged || scheduledFor !== order.scheduledFor
            ? null
            : order.recipeVersionId;
      const version = await resolveVersion(tx, ctx, recipe.id, scheduledFor, explicit);
      const sourceWarehouseId = input.sourceWarehouseId ?? order.sourceWarehouseId;
      const outputWarehouseId = input.outputWarehouseId ?? order.outputWarehouseId;
      await assertWarehouses(tx, ctx, sourceWarehouseId, outputWarehouseId);
      const plannedOutputQuantity = input.plannedOutputQuantity ?? order.plannedOutputQuantity;
      const plannedOutputUnitId =
        input.plannedOutputUnitId ??
        (productChanged ? product.saleUnitId : order.plannedOutputUnitId);
      const figures = await draftFigures(tx, ctx, {
        versionId: version.id,
        plannedOutputQuantity,
        plannedOutputUnitId,
        saleUnitId: product.saleUnitId,
      });
      Object.assign(set, {
        productId,
        recipeId: recipe.id,
        recipeVersionId: version.id,
        scheduledFor,
        sourceWarehouseId,
        outputWarehouseId,
        plannedOutputQuantity,
        plannedOutputUnitId,
        saleUnitId: product.saleUnitId,
        plannedOutputNormalized: figures.plannedOutputNormalized,
      });
    }

    if (input.responsibleEmployeeId !== undefined) {
      if (input.responsibleEmployeeId !== order.responsibleEmployeeId) {
        await assertResponsible(tx, ctx, input.responsibleEmployeeId);
      }
      set.responsibleEmployeeId = input.responsibleEmployeeId;
    }
    if (input.batchCode !== undefined) set.batchCode = input.batchCode;
    if (input.notes !== undefined) set.notes = input.notes;

    const [after] =
      Object.keys(set).length === 0
        ? [order]
        : await mapUniqueViolations(
            tx.update(productionOrders).set(set).where(eq(productionOrders.id, id)).returning(),
            UNIQUE,
          );
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const tracked = [...STRUCTURAL, ...PRODUCTION_OPERATIONAL_FIELDS] as const;
    for (const key of tracked) {
      const from = before[key as keyof OrderRow] ?? null;
      const to = after![key as keyof OrderRow] ?? null;
      if (String(from) !== String(to)) changes[key] = { from, to };
    }
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "PRODUCTION_ORDER_UPDATED",
        entityType: "production_order",
        entityId: id,
        metadata: { ...orderMeta(order), status: order.status, changes },
      });
    }
    return getOrder(tx, ctx, id, canSeeCosts);
  });
}

/* ---------- Planificar ---------- */

/** Próximo código de lote del día (LOT-AAAAMMDD-NNN), serializado por empresa y fecha. */
async function nextBatchCode(tx: Transaction, ctx: OperationContext, scheduledFor: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`${ctx.companyId}:production-batch:${scheduledFor}`}))`,
  );
  const prefix = formatBatchCode(scheduledFor, 1).slice(0, -3);
  const rows = await tx
    .select({ code: productionOrders.batchCode })
    .from(productionOrders)
    .where(
      and(
        eq(productionOrders.companyId, ctx.companyId),
        like(productionOrders.batchCode, `${prefix}%`),
      ),
    );
  const used = rows
    .map((r) => Number.parseInt(r.code!.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n));
  return formatBatchCode(scheduledFor, (used.length === 0 ? 0 : Math.max(...used)) + 1);
}

/**
 * DRAFT → PLANNED: fija la versión de receta, calcula y persiste el plan de
 * consumo y congela el costo esperado (promedio → referencia → incompleto).
 * Se puede planificar aunque falte stock (se informa); no mueve stock.
 */
export async function planOrder(
  db: Database,
  ctx: OperationContext,
  id: string,
  canSeeCosts: boolean,
) {
  return db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    assertMutable(order);
    transition(order, "PLANNED");
    const product = (await findProduct(tx, ctx, order.productId))!;
    if (!product.active) {
      throw new AppError(
        409,
        "PRODUCT_INACTIVE",
        `${product.name} está desactivado: no admite producción nueva.`,
      );
    }
    if (!product.controlsStock) {
      throw new AppError(
        409,
        "PRODUCT_NOT_STOCK_CONTROLLED",
        `${product.name} no controla stock: no puede producirse a inventario.`,
      );
    }
    const versions = await loadVersions(tx, ctx, order.recipeId);
    const version = versions.find((v) => v.id === order.recipeVersionId)!;
    if (version.effectiveFrom === null) {
      throw new AppError(
        409,
        "RECIPE_VERSION_NOT_PUBLISHED",
        "La versión de receta elegida todavía es un borrador.",
      );
    }
    const whs = await loadWarehouses(tx, ctx, [order.sourceWarehouseId, order.outputWarehouseId]);
    if (![...whs.values()].every((w) => w.active)) {
      throw new AppError(
        409,
        "WAREHOUSE_INACTIVE",
        "Uno de los depósitos de la orden está inactivo.",
      );
    }
    const { plan, materials } = await computePlan(tx, ctx, {
      versionId: version.id,
      plannedOutputQuantity: order.plannedOutputQuantity,
      plannedOutputUnitId: order.plannedOutputUnitId,
      saleUnitId: order.saleUnitId,
    });
    const inactive = [...materials.values()].filter((m) => !m.active);
    if (inactive.length > 0) {
      throw new AppError(
        409,
        "RAW_MATERIAL_INACTIVE",
        `Materia prima dada de baja en la receta: ${inactive.map((m) => m.name).join(", ")}.`,
        inactive.map((m) => ({
          path: `materials.${m.id}`,
          message: `${m.name} está dada de baja`,
        })),
      );
    }
    const currency = await companyCurrency(tx, ctx);
    await tx.insert(productionMaterialLines).values(
      plan.lines.map((l, i) => ({
        companyId: ctx.companyId,
        productionOrderId: order.id,
        lineNumber: i + 1,
        lineType: "RECIPE" as const,
        recipeIngredientId: l.recipeIngredientId,
        rawMaterialId: l.rawMaterialId,
        baseUnitId: materials.get(l.rawMaterialId)!.baseUnitId,
        plannedQuantity: qty(l.plannedQuantity),
        plannedUnitId: l.unit.id,
        plannedNormalizedQuantity: qty(l.plannedNormalized),
        plannedUnitCost: l.unitCost === null ? null : money(l.unitCost),
        plannedCostSource: l.costSource,
        plannedCost: l.plannedCost === null ? null : money(l.plannedCost),
        createdByUserId: ctx.userId,
      })),
    );
    const batchCode = order.batchCode ?? (await nextBatchCode(tx, ctx, order.scheduledFor));
    await mapUniqueViolations(
      tx
        .update(productionOrders)
        .set({
          status: "PLANNED",
          scaleFactor: qty(plan.scaleFactor),
          plannedOutputNormalized: qty(plan.plannedOutputNormalized),
          theoreticalWastePercentage: version.wastePercentage,
          currencyCode: currency,
          plannedCostStatus: plan.costStatus,
          plannedMaterialCost:
            plan.plannedMaterialCost === null ? null : money(plan.plannedMaterialCost),
          plannedUnitMaterialCost:
            plan.plannedUnitMaterialCost === null ? null : money(plan.plannedUnitMaterialCost),
          batchCode,
          plannedAt: new Date(),
          plannedByUserId: ctx.userId,
        })
        .where(eq(productionOrders.id, id)),
      UNIQUE,
    );
    const available = await warehouseQuantities(
      tx,
      ctx,
      order.sourceWarehouseId,
      plan.lines.map((l) => l.rawMaterialId),
    );
    const source = whs.get(order.sourceWarehouseId)!;
    const availability = availabilityOf(
      source,
      "PLANNED",
      plan.lines.map((l) => ({
        rawMaterialId: l.rawMaterialId,
        code: l.rawMaterialCode,
        name: l.rawMaterialName,
        baseUnit: l.baseUnit as UnitRow,
        required: qty(l.plannedNormalized),
      })),
      available,
    );
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRODUCTION_ORDER_PLANNED",
      entityType: "production_order",
      entityId: id,
      metadata: {
        ...orderMeta(order),
        product: product.name,
        recipeVersionId: version.id,
        versionNumber: version.versionNumber,
        batchCode,
        scaleFactor: qty(plan.scaleFactor),
        plannedOutputNormalized: qty(plan.plannedOutputNormalized),
        currency,
        plannedCostStatus: plan.costStatus,
        plannedMaterialCost:
          plan.plannedMaterialCost === null ? null : money(plan.plannedMaterialCost),
        lines: plan.lines.length,
        shortages: shortageDetails(availability).map((s) => s.message),
      },
    });
    return getOrder(tx, ctx, id, canSeeCosts);
  });
}

/* ---------- Iniciar ---------- */

/**
 * PLANNED → IN_PROGRESS. Revalida materias primas activas y stock suficiente en
 * el depósito (no reserva: deuda INVENTORY_RESERVATIONS). Propone real = plan.
 */
export async function startOrder(
  db: Database,
  ctx: OperationContext,
  id: string,
  canSeeCosts: boolean,
) {
  return db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    assertMutable(order);
    transition(order, "IN_PROGRESS");
    const product = (await findProduct(tx, ctx, order.productId))!;
    if (!product.active) {
      throw new AppError(
        409,
        "PRODUCT_INACTIVE",
        `${product.name} está desactivado: no admite producción nueva.`,
      );
    }
    const whs = await loadWarehouses(tx, ctx, [order.sourceWarehouseId, order.outputWarehouseId]);
    if (![...whs.values()].every((w) => w.active)) {
      throw new AppError(
        409,
        "WAREHOUSE_INACTIVE",
        "Uno de los depósitos de la orden está inactivo.",
      );
    }
    const lines = await loadLines(tx, ctx, id, true);
    const inactive = await inactiveMaterials(
      tx,
      ctx,
      lines.map((l) => l.rawMaterialId),
    );
    if (inactive.length > 0) {
      throw new AppError(
        409,
        "RAW_MATERIAL_INACTIVE",
        `Materia prima dada de baja: ${inactive.map((m) => m.name).join(", ")}.`,
        inactive.map((m) => ({
          path: `materials.${m.id}`,
          message: `${m.name} está dada de baja`,
        })),
      );
    }
    const units = await loadUnits(tx, ctx);
    const materials = await loadRawMaterials(
      tx,
      ctx,
      lines.map((l) => l.rawMaterialId),
    );
    const available = await warehouseQuantities(
      tx,
      ctx,
      order.sourceWarehouseId,
      lines.map((l) => l.rawMaterialId),
    );
    const availability = availabilityOf(
      whs.get(order.sourceWarehouseId)!,
      "PLANNED",
      lines.map((l) => {
        const m = materials.get(l.rawMaterialId)!;
        return {
          rawMaterialId: m.id,
          code: m.code,
          name: m.name,
          baseUnit: unitOrThrow(units, l.baseUnitId),
          required: l.plannedNormalizedQuantity!,
        };
      }),
      available,
    );
    if (!availability.sufficient) {
      throw new AppError(
        409,
        "INSUFFICIENT_MATERIALS_FOR_PRODUCTION",
        "No hay stock suficiente en el depósito para iniciar la producción.",
        shortageDetails(availability),
      );
    }
    await tx
      .update(productionOrders)
      .set({ status: "IN_PROGRESS", startedAt: new Date(), startedByUserId: ctx.userId })
      .where(eq(productionOrders.id, id));
    for (const line of lines) {
      await tx
        .update(productionMaterialLines)
        .set({
          actualQuantity: line.plannedQuantity,
          actualUnitId: line.plannedUnitId,
          actualNormalizedQuantity: line.plannedNormalizedQuantity,
        })
        .where(eq(productionMaterialLines.id, line.id));
    }
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRODUCTION_ORDER_STARTED",
      entityType: "production_order",
      entityId: id,
      metadata: { ...orderMeta(order), batchCode: order.batchCode },
    });
    return getOrder(tx, ctx, id, canSeeCosts);
  });
}

/* ---------- Consumos reales, extras y salida (IN_PROGRESS) ---------- */

function assertInProgress(order: OrderRow) {
  assertMutable(order);
  if (order.status !== "IN_PROGRESS") {
    throw new AppError(
      409,
      "PRODUCTION_NOT_IN_PROGRESS",
      "Los consumos reales y la cantidad obtenida se registran con la producción en curso.",
    );
  }
}

function normalizeActual(
  quantity: string,
  unit: UnitRow,
  baseUnit: UnitRow,
  name: string,
  path: string,
) {
  try {
    return normalizeConsumption(quantity, unit, baseUnit, name);
  } catch (err) {
    if (err instanceof ProductionError) {
      throw new AppError(422, err.code, err.message, [{ path, message: err.message }]);
    }
    throw err;
  }
}

export async function updateActuals(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: ProductionActualsInput,
  canSeeCosts: boolean,
) {
  return db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    assertInProgress(order);
    const lines = await loadLines(tx, ctx, id, true);
    const byId = new Map(lines.map((l) => [l.id, l]));
    const units = await loadUnits(tx, ctx);
    const materials = await loadRawMaterials(
      tx,
      ctx,
      lines.map((l) => l.rawMaterialId),
    );
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    for (const [index, entry] of (input.lines ?? []).entries()) {
      const line = byId.get(entry.lineId);
      if (!line) throw invalidReference(`lines.${index}.lineId`, "La línea no es de esta orden");
      const unit = assertUnit(units, entry.unitId, `lines.${index}.unitId`);
      const material = materials.get(line.rawMaterialId)!;
      const normalized = normalizeActual(
        entry.quantity,
        unit,
        unitOrThrow(units, line.baseUnitId),
        material.name,
        `lines.${index}.quantity`,
      );
      if (line.lineType === "EXTRA" && !normalized.gt(0)) {
        throw new AppError(
          422,
          "QUANTITY_NOT_POSITIVE",
          "Un consumo extra debe ser mayor que cero; quitá la línea si no se usó.",
          [{ path: `lines.${index}.quantity`, message: "Debe ser mayor que cero" }],
        );
      }
      const next = qty(normalized);
      if (
        line.actualNormalizedQuantity === null ||
        !new D(line.actualNormalizedQuantity).eq(next) ||
        line.actualUnitId !== unit.id
      ) {
        changes[material.name] = { from: line.actualNormalizedQuantity, to: next };
      }
      await tx
        .update(productionMaterialLines)
        .set({
          actualQuantity: qty(entry.quantity),
          actualUnitId: unit.id,
          actualNormalizedQuantity: next,
        })
        .where(eq(productionMaterialLines.id, line.id));
    }

    const set: Partial<typeof productionOrders.$inferInsert> = {};
    if (input.actualOutputQuantity !== undefined && input.actualOutputUnitId !== undefined) {
      const unit = assertUnit(units, input.actualOutputUnitId, "actualOutputUnitId");
      let normalized: InstanceType<typeof D>;
      try {
        normalized = normalizeOutput(
          input.actualOutputQuantity,
          unit,
          unitOrThrow(units, order.saleUnitId),
        );
      } catch (err) {
        if (err instanceof ProductionError) {
          throw new AppError(422, err.code, err.message, [
            { path: "actualOutputQuantity", message: err.message },
          ]);
        }
        throw err;
      }
      set.actualOutputQuantity = input.actualOutputQuantity;
      set.actualOutputUnitId = unit.id;
      set.actualOutputNormalized = qty(normalized);
      if (
        order.actualOutputNormalized === null ||
        !new D(order.actualOutputNormalized).eq(normalized)
      ) {
        changes.actualOutput = { from: order.actualOutputNormalized, to: qty(normalized) };
      }
    }
    if (input.notes !== undefined && input.notes !== order.notes) {
      set.notes = input.notes;
      changes.notes = { from: order.notes, to: input.notes };
    }
    if (Object.keys(set).length > 0) {
      await tx.update(productionOrders).set(set).where(eq(productionOrders.id, id));
    }
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "PRODUCTION_ORDER_ACTUALS_UPDATED",
        entityType: "production_order",
        entityId: id,
        metadata: { ...orderMeta(order), changes },
      });
    }
    return getOrder(tx, ctx, id, canSeeCosts);
  });
}

export async function addExtraMaterial(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: ExtraMaterialInput,
  canSeeCosts: boolean,
) {
  return db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    assertInProgress(order);
    const materials = await loadRawMaterials(tx, ctx, [input.rawMaterialId]);
    const material = materials.get(input.rawMaterialId);
    if (!material) throw invalidReference("rawMaterialId", "Materia prima inexistente");
    if (!material.active)
      throw invalidReference("rawMaterialId", `${material.name} está dada de baja`);
    const units = await loadUnits(tx, ctx);
    const unit = assertUnit(units, input.unitId, "unitId");
    const normalized = normalizeActual(
      input.quantity,
      unit,
      unitOrThrow(units, material.baseUnitId),
      material.name,
      "quantity",
    );
    const lines = await loadLines(tx, ctx, id, true);
    const lineNumber = lines.reduce((max, l) => Math.max(max, l.lineNumber), 0) + 1;
    const [line] = await tx
      .insert(productionMaterialLines)
      .values({
        companyId: ctx.companyId,
        productionOrderId: id,
        lineNumber,
        lineType: "EXTRA",
        rawMaterialId: material.id,
        baseUnitId: material.baseUnitId,
        actualQuantity: qty(input.quantity),
        actualUnitId: unit.id,
        actualNormalizedQuantity: qty(normalized),
        notes: input.notes,
        createdByUserId: ctx.userId,
      })
      .returning();
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRODUCTION_EXTRA_MATERIAL_ADDED",
      entityType: "production_order",
      entityId: id,
      metadata: {
        ...orderMeta(order),
        lineId: line!.id,
        rawMaterialId: material.id,
        rawMaterial: material.name,
        quantity: qty(normalized),
        unit: unitOrThrow(units, material.baseUnitId).symbol,
        notes: input.notes,
      },
    });
    return getOrder(tx, ctx, id, canSeeCosts);
  });
}

export async function removeExtraMaterial(
  db: Database,
  ctx: OperationContext,
  id: string,
  lineId: string,
  canSeeCosts: boolean,
) {
  return db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    assertInProgress(order);
    const lines = await loadLines(tx, ctx, id, true);
    const line = lines.find((l) => l.id === lineId);
    if (!line) throw invalidReference("lineId", "La línea no es de esta orden");
    if (line.lineType !== "EXTRA") {
      throw new AppError(
        409,
        "PRODUCTION_PLAN_LOCKED",
        "Sólo se quitan consumos extra; para no usar un ingrediente cargá consumo 0.",
      );
    }
    await tx.delete(productionMaterialLines).where(eq(productionMaterialLines.id, lineId));
    const materials = await loadRawMaterials(tx, ctx, [line.rawMaterialId]);
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRODUCTION_EXTRA_MATERIAL_REMOVED",
      entityType: "production_order",
      entityId: id,
      metadata: {
        ...orderMeta(order),
        lineId,
        rawMaterialId: line.rawMaterialId,
        rawMaterial: materials.get(line.rawMaterialId)?.name ?? null,
        quantity: line.actualNormalizedQuantity,
        notes: line.notes,
      },
    });
    return getOrder(tx, ctx, id, canSeeCosts);
  });
}

/* ---------- Cancelar ---------- */

export async function cancelOrder(
  db: Database,
  ctx: OperationContext,
  id: string,
  reason: string | null | undefined,
  canSeeCosts: boolean,
) {
  return db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    assertMutable(order);
    transition(order, "CANCELLED");
    await tx
      .update(productionOrders)
      .set({
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledByUserId: ctx.userId,
        cancelReason: reason ?? null,
      })
      .where(eq(productionOrders.id, id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRODUCTION_ORDER_CANCELLED",
      entityType: "production_order",
      entityId: id,
      metadata: { ...orderMeta(order), previousStatus: order.status, reason: reason ?? null },
    });
    return getOrder(tx, ctx, id, canSeeCosts);
  });
}

/* ---------- Completar ---------- */

/**
 * IN_PROGRESS → COMPLETED en UNA transacción (ver docs/reports/FASE_4_IMPLEMENTATION_PLAN.md):
 *  1-2  bloquea la orden y valida el estado (409 PRODUCTION_ALREADY_COMPLETED);
 *  3-4  bloquea las líneas y valida consumos y salida reales;
 *  5-7  bloquea costos y saldos de las materias primas (por id) y revalida el
 *       stock agregado (409 INSUFFICIENT_STOCK con detalle);
 *  8-12 un PRODUCTION_CONSUMPTION por línea con consumo; costo real = Σ |valor|;
 * 13-18 PRODUCTION_OUTPUT valorizado con el costo real exacto; promedio del producto;
 * 19-21 congela costos reales, COMPLETED y auditoría.
 * Cualquier error revierte todo.
 */
export async function completeOrder(
  db: Database,
  ctx: OperationContext,
  id: string,
  input: CompleteProductionInput,
  canSeeCosts: boolean,
) {
  return db.transaction(async (tx) => {
    const order = await findOrder(tx, ctx, id, true);
    if (order.status === "COMPLETED") throw alreadyCompleted(order);
    assertMutable(order);
    transition(order, "COMPLETED");
    if (order.actualOutputNormalized === null || order.actualOutputUnitId === null) {
      throw new AppError(
        422,
        "ACTUAL_OUTPUT_REQUIRED",
        "Indicá la cantidad realmente obtenida antes de completar.",
        [{ path: "actualOutputQuantity", message: "Obligatorio" }],
      );
    }
    const product = (await findProduct(tx, ctx, order.productId))!;
    if (!product.controlsStock) {
      throw new AppError(
        409,
        "PRODUCT_NOT_STOCK_CONTROLLED",
        `${product.name} no controla stock: no puede producirse a inventario.`,
      );
    }
    const whs = await loadWarehouses(tx, ctx, [order.sourceWarehouseId, order.outputWarehouseId]);
    if (![...whs.values()].every((w) => w.active)) {
      throw new AppError(
        409,
        "WAREHOUSE_INACTIVE",
        "Uno de los depósitos de la orden está inactivo.",
      );
    }

    const lines = await loadLines(tx, ctx, id, true);
    const missing = lines.filter((l) => l.actualNormalizedQuantity === null);
    if (missing.length > 0) {
      throw new AppError(
        422,
        "ACTUAL_CONSUMPTION_REQUIRED",
        "Falta el consumo real de algunas materias primas.",
      );
    }
    const consumed = lines.filter((l) => new D(l.actualNormalizedQuantity!).gt(0));
    if (consumed.length === 0) {
      throw new AppError(
        422,
        "NO_CONSUMPTION",
        "La producción no registra consumo de materias primas.",
      );
    }

    const units = await loadUnits(tx, ctx);
    const materials = await loadRawMaterials(
      tx,
      ctx,
      lines.map((l) => l.rawMaterialId),
    );
    const costs = await lockMaterialCosts(
      tx,
      ctx,
      consumed.map((l) => l.rawMaterialId),
    );
    const balances = await lockMaterialBalances(
      tx,
      ctx,
      order.sourceWarehouseId,
      consumed.map((l) => ({ rawMaterialId: l.rawMaterialId, baseUnitId: l.baseUnitId })),
    );
    const availability = availabilityOf(
      whs.get(order.sourceWarehouseId)!,
      "ACTUAL",
      consumed.map((l) => {
        const m = materials.get(l.rawMaterialId)!;
        return {
          rawMaterialId: m.id,
          code: m.code,
          name: m.name,
          baseUnit: unitOrThrow(units, l.baseUnitId),
          required: l.actualNormalizedQuantity!,
        };
      }),
      new Map([...balances].map(([rawMaterialId, b]) => [rawMaterialId, b.quantity])),
    );
    if (!availability.sufficient) {
      throw new AppError(
        409,
        "INSUFFICIENT_STOCK",
        "No hay stock suficiente en el depósito para registrar el consumo real.",
        shortageDetails(availability),
      );
    }

    const now = new Date();
    const posted = new Map<
      string,
      { movementId: string; unitCost: string; value: InstanceType<typeof D> }
    >();
    const ordered = [...consumed].sort(
      (a, b) => a.rawMaterialId.localeCompare(b.rawMaterialId) || a.lineNumber - b.lineNumber,
    );
    for (const line of ordered) {
      const m = materials.get(line.rawMaterialId)!;
      const result = await postStockMovement(tx, ctx, {
        rawMaterialId: m.id,
        rawMaterialCode: m.code,
        rawMaterialName: m.name,
        warehouseId: order.sourceWarehouseId,
        baseUnitId: line.baseUnitId,
        baseUnitSymbol: unitOrThrow(units, line.baseUnitId).symbol,
        movementType: "PRODUCTION_CONSUMPTION",
        quantity: line.actualNormalizedQuantity!,
        occurredAt: now,
        referenceType: "PRODUCTION_ORDER",
        referenceId: order.id,
        sourceLineId: line.id,
        notes: line.lineType === "EXTRA" ? line.notes : null,
        currency: order.currencyCode!,
      });
      posted.set(line.id, {
        movementId: result.movement.id,
        unitCost: result.movement.unitCost ?? "0",
        value: new D(result.movement.totalValue ?? 0).abs(),
      });
    }

    const totalCost = actualMaterialCost([...posted.values()].map((p) => p.value));
    const unitCost = actualUnitMaterialCost(totalCost, order.actualOutputNormalized);
    const total = fixedMoney(totalCost);
    const perUnit = fixedMoney(unitCost);
    const saleUnit = unitOrThrow(units, order.saleUnitId);
    // Fase 4.5: la orden origina un lote identificable (código = lote de la orden).
    const batchCode = order.batchCode ?? (await nextBatchCode(tx, ctx, order.scheduledFor));
    const lot = await createProductionLot(tx, ctx, {
      order,
      productId: product.id,
      warehouseId: order.outputWarehouseId,
      saleUnitId: order.saleUnitId,
      lotCode: batchCode,
      quantity: order.actualOutputNormalized,
      unitCost: perUnit,
      totalValue: total,
      requestedState: input.conservationState ?? null,
      producedAt: now,
    });
    const output = await postProductMovement(tx, ctx, {
      productId: product.id,
      productCode: product.internalCode,
      productName: product.name,
      warehouseId: order.outputWarehouseId,
      saleUnitId: order.saleUnitId,
      saleUnitSymbol: saleUnit.symbol,
      movementType: "PRODUCTION_OUTPUT",
      quantity: order.actualOutputNormalized,
      unitCost: perUnit,
      totalValue: total,
      occurredAt: now,
      referenceType: "PRODUCTION_ORDER",
      referenceId: order.id,
      sourceLineId: order.id,
      productionOrderId: order.id,
      productionOrderCode: order.internalCode,
      productLotId: lot.id,
      notes: `Lote ${batchCode}`,
      currency: order.currencyCode!,
    });

    for (const line of lines) {
      const p = posted.get(line.id);
      const variance = consumptionVariance(
        line.plannedNormalizedQuantity,
        line.actualNormalizedQuantity!,
      );
      const cost = costs.get(line.rawMaterialId);
      await tx
        .update(productionMaterialLines)
        .set({
          actualUnitCost: p ? p.unitCost : fixedMoney(cost?.movingAverageCost ?? 0),
          actualCost: p ? fixedMoney(p.value) : fixedMoney(0),
          varianceQuantity: qty(variance.quantity),
          variancePercentage: variance.percentage === null ? null : pct(variance.percentage),
          consumptionMovementId: p?.movementId ?? null,
        })
        .where(eq(productionMaterialLines.id, line.id));
    }
    await tx
      .update(productionOrders)
      .set({
        status: "COMPLETED",
        batchCode,
        completedAt: now,
        completedByUserId: ctx.userId,
        actualMaterialCost: total,
        actualUnitMaterialCost: perUnit,
        outputMovementId: output.movement.id,
      })
      .where(eq(productionOrders.id, id));
    await recordAudit(tx, {
      ...auditBase(ctx),
      action: "PRODUCTION_ORDER_COMPLETED",
      entityType: "production_order",
      entityId: id,
      metadata: {
        ...orderMeta(order),
        product: product.name,
        batchCode,
        productLotId: lot.id,
        conservationState: lot.conservationState,
        currency: order.currencyCode,
        plannedOutput: order.plannedOutputNormalized,
        actualOutput: order.actualOutputNormalized,
        unit: saleUnit.symbol,
        plannedMaterialCost: order.plannedMaterialCost,
        actualMaterialCost: total,
        actualUnitMaterialCost: perUnit,
        outputMovementId: output.movement.id,
        consumptions: ordered.map((l) => ({
          rawMaterial: materials.get(l.rawMaterialId)!.name,
          quantity: l.actualNormalizedQuantity,
          movementId: posted.get(l.id)!.movementId,
        })),
      },
    });
    return getOrder(tx, ctx, id, canSeeCosts);
  });
}

/* ---------- Consultas auxiliares ---------- */

export async function getAvailability(db: Database, ctx: OperationContext, id: string) {
  const order = await getOrder(db, ctx, id, false);
  return order.availability;
}

export async function getCostComparison(
  db: Database,
  ctx: OperationContext,
  id: string,
): Promise<ProductionCostComparisonDto> {
  const order = await getOrder(db, ctx, id, true);
  return {
    currency: order.costs!.currency,
    output: {
      planned: order.plannedOutputNormalized,
      actual: order.actualOutputNormalized,
      unit: order.saleUnit,
      variance: order.output?.variance ?? null,
      variancePercentage: order.output?.variancePercentage ?? null,
      yieldPerformance: order.output?.yieldPerformance ?? null,
    },
    materials: order.materials.map((m) => ({
      lineType: m.lineType,
      rawMaterial: { id: m.rawMaterial.id, code: m.rawMaterial.code, name: m.rawMaterial.name },
      baseUnit: m.baseUnit,
      plannedQuantity: m.plannedNormalized,
      actualQuantity: m.actualNormalized,
      variance: m.variance,
      plannedCost: m.plannedCost,
      actualCost: m.actualCost,
    })),
    costs: order.costs!,
  };
}

export async function listOrderMovements(
  db: Database,
  ctx: OperationContext,
  id: string,
  canSeeCosts: boolean,
): Promise<StockMovementDto[]> {
  const order = await findOrder(db, ctx, id);
  return selectMovements(
    db,
    ctx,
    and(
      eq(stockMovements.referenceType, "PRODUCTION_ORDER"),
      eq(stockMovements.referenceId, order.id),
    ),
    canSeeCosts,
    { limit: 500, offset: 0 },
  );
}
