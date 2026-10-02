import { D, findEffectiveVersion, availabilityForOrder, type CoverageStatus } from "@bakery/domain";
import {
  customerOrderLines,
  customerOrders,
  customers,
  orderMaterialRequirements,
  orderProductionRequirements,
  productLotReservations,
  productLots,
  productionOrders,
  products,
  rawMaterials,
  stockBalances,
  suppliers,
  type Database,
  type Transaction,
} from "@bakery/database";
import {
  type ORDER_ISSUE_LABELS,
  PERMISSIONS,
  formatLocalDateTime,
  hasPermissions,
  instantToZonedLocal,
  type CoverageStatusDto,
  type MaterialProjectionDto,
  type OrderDetailDto,
  type OrderIssueDto,
  type OrderLineDto,
  type OrderProductionRequirementDto,
  type OrderReservationDto,
} from "@bakery/shared";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { OperationContext } from "../../lib/context.js";
import { notFound } from "../../lib/db-errors.js";
import { loadPeople, personOf } from "../../lib/people.js";
import { forAvailability, selectLots } from "../lots/lots.data.js";
import { loadVersions } from "../production/production.data.js";
import { companyCurrency, loadUnits, unitOrThrow, type UnitRow } from "../recipes/recipes.data.js";
import { fixedQty } from "../inventory/ledger.js";
import { committedByLot } from "./reservations.js";

/*
 * Lecturas de pedidos (Fase 5A). Ninguna escribe: la cobertura que se muestra
 * es la del plan vigente más lo que se deriva en el momento (NEEDS_REPLAN por
 * reservas invalidadas, stock nuevo disponible). "Actualizar cobertura" es un
 * REPLAN explícito.
 */

export type Db = Database | Transaction;
export type OrderRow = typeof customerOrders.$inferSelect;
export type LineRow = typeof customerOrderLines.$inferSelect;
type Dec = InstanceType<typeof D>;

export const DEMAND = ["CONFIRMED", "IN_PREPARATION", "READY"] as const;
export const isDemand = (status: OrderRow["status"]) =>
  (DEMAND as readonly string[]).includes(status);
export const OPEN_REQUIREMENT = ["OPEN", "PRODUCTION_CREATED"] as const;

export const unitRef = (u: { id: string; code: string; symbol: string }) => ({
  id: u.id,
  code: u.code,
  symbol: u.symbol,
});
export const qty = (v: Dec | string | number) => fixedQty(v);
const show = (v: Dec | string) => new D(v).toDecimalPlaces(6).toString();

/**
 * Cobertura efectiva (SQL): un pedido con demanda y alguna reserva de su plan
 * vigente invalidada por calidad o merma NECESITA RECALCULAR, sin que la
 * operación del lote haya tocado la fila del pedido (ADR-052/053).
 */
// Columnas calificadas a mano: en un select de una sola tabla Drizzle las
// emite sin tabla y dentro del subquery se resolverían contra `r`.
export const effectiveCoverage = sql<CoverageStatus | null>`case
  when "customer_orders"."status" in ('CONFIRMED', 'IN_PREPARATION', 'READY') and exists (
    select 1 from product_lot_reservations r
    where r.company_id = "customer_orders"."company_id"
      and r.customer_order_id = "customer_orders"."id"
      and r.status = 'INVALIDATED'
      and r.plan_revision = "customer_orders"."plan_revision"
  ) then 'NEEDS_REPLAN'
  else "customer_orders"."coverage_status"::text end`;

export async function findOrder(db: Db, ctx: OperationContext, id: string, lock = false) {
  const query = db
    .select()
    .from(customerOrders)
    .where(and(eq(customerOrders.companyId, ctx.companyId), eq(customerOrders.id, id)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Pedido");
  return row;
}

/** Cobertura efectiva de un pedido (dentro de la transacción si hace falta). */
export async function orderEffectiveCoverage(db: Db, ctx: OperationContext, id: string) {
  const [row] = await db
    .select({ coverage: effectiveCoverage })
    .from(customerOrders)
    .where(and(eq(customerOrders.companyId, ctx.companyId), eq(customerOrders.id, id)));
  return (row?.coverage ?? null) as CoverageStatusDto | null;
}

/** Líneas vigentes (sin las quitadas por una replanificación), en orden. */
export async function loadLines(db: Db, ctx: OperationContext, orderId: string, lock = false) {
  const query = db
    .select()
    .from(customerOrderLines)
    .where(
      and(
        eq(customerOrderLines.companyId, ctx.companyId),
        eq(customerOrderLines.customerOrderId, orderId),
        isNull(customerOrderLines.removedAt),
      ),
    )
    .orderBy(asc(customerOrderLines.sortOrder), asc(customerOrderLines.id));
  return lock ? query.for("update") : query;
}

export async function activeReservations(
  db: Db,
  ctx: OperationContext,
  orderId: string,
  lock = false,
) {
  const query = db
    .select()
    .from(productLotReservations)
    .where(
      and(
        eq(productLotReservations.companyId, ctx.companyId),
        eq(productLotReservations.customerOrderId, orderId),
        eq(productLotReservations.status, "ACTIVE"),
      ),
    )
    .orderBy(asc(productLotReservations.id));
  return lock ? query.for("update") : query;
}

/** Necesidades que todavía son demanda (pendientes o con orden de producción en curso). */
export async function openRequirements(
  db: Db,
  ctx: OperationContext,
  orderId: string,
  lock = false,
) {
  const query = db
    .select()
    .from(orderProductionRequirements)
    .where(
      and(
        eq(orderProductionRequirements.companyId, ctx.companyId),
        eq(orderProductionRequirements.customerOrderId, orderId),
        inArray(orderProductionRequirements.status, [...OPEN_REQUIREMENT]),
      ),
    )
    .orderBy(asc(orderProductionRequirements.id));
  return lock ? query.for("update") : query;
}

/* ---------- Materias primas: proyección global ---------- */

/** Stock de materias primas de TODA la empresa (todos los depósitos), en unidad base. */
export async function rawMaterialStock(
  db: Db,
  ctx: OperationContext,
  ids: readonly string[] | null,
): Promise<Map<string, string>> {
  if (ids !== null && ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: stockBalances.rawMaterialId,
      quantity: sql<string>`sum(${stockBalances.quantity})`,
    })
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.companyId, ctx.companyId),
        eq(stockBalances.itemType, "RAW_MATERIAL"),
        ids ? inArray(stockBalances.rawMaterialId, [...new Set(ids)]) : undefined,
      ),
    )
    .groupBy(stockBalances.rawMaterialId);
  return new Map(rows.filter((r) => r.id).map((r) => [r.id!, r.quantity]));
}

/** Condición de demanda de materias primas: necesidad abierta de un pedido con demanda. */
export const materialDemandCondition = (ctx: OperationContext) =>
  and(
    eq(orderMaterialRequirements.companyId, ctx.companyId),
    inArray(orderProductionRequirements.status, [...OPEN_REQUIREMENT]),
    inArray(customerOrders.status, [...DEMAND]),
  );

/** Demanda de materias primas de los pedidos con demanda (opcionalmente sin uno). */
export async function otherOrdersMaterialDemand(
  db: Db,
  ctx: OperationContext,
  ids: readonly string[],
  excludeOrderId: string | null,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: orderMaterialRequirements.rawMaterialId,
      quantity: sql<string>`sum(${orderMaterialRequirements.requiredQuantity})`,
    })
    .from(orderMaterialRequirements)
    .innerJoin(
      orderProductionRequirements,
      eq(orderProductionRequirements.id, orderMaterialRequirements.orderProductionRequirementId),
    )
    .innerJoin(customerOrders, eq(customerOrders.id, orderMaterialRequirements.customerOrderId))
    .where(
      and(
        materialDemandCondition(ctx),
        inArray(orderMaterialRequirements.rawMaterialId, [...new Set(ids)]),
        excludeOrderId ? ne(orderMaterialRequirements.customerOrderId, excludeOrderId) : undefined,
      ),
    )
    .groupBy(orderMaterialRequirements.rawMaterialId);
  return new Map(rows.map((r) => [r.id, r.quantity]));
}

export async function rawMaterialInfo(db: Db, ctx: OperationContext, ids: readonly string[]) {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: rawMaterials.id,
      code: rawMaterials.internalCode,
      name: rawMaterials.name,
      baseUnitId: rawMaterials.baseUnitId,
      supplierId: suppliers.id,
      supplierName: sql<string | null>`coalesce(${suppliers.tradeName}, ${suppliers.legalName})`,
    })
    .from(rawMaterials)
    .leftJoin(
      suppliers,
      and(
        eq(suppliers.companyId, rawMaterials.companyId),
        eq(suppliers.id, rawMaterials.preferredSupplierId),
      ),
    )
    .where(
      and(eq(rawMaterials.companyId, ctx.companyId), inArray(rawMaterials.id, [...new Set(ids)])),
    );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Proyección de las materias primas que necesita un pedido contra el stock de
 * la empresa y la demanda de los DEMÁS pedidos: faltante = max(0, necesidad +
 * otros − stock). No reserva nada.
 */
export async function materialProjection(
  db: Db,
  ctx: OperationContext,
  needs: ReadonlyMap<string, Dec>,
  excludeOrderId: string | null,
  units: Map<string, UnitRow>,
): Promise<MaterialProjectionDto[]> {
  const ids = [...needs.keys()];
  if (ids.length === 0) return [];
  const [info, stock, others] = await Promise.all([
    rawMaterialInfo(db, ctx, ids),
    rawMaterialStock(db, ctx, ids),
    otherOrdersMaterialDemand(db, ctx, ids, excludeOrderId),
  ]);
  return ids
    .map((id) => {
      const m = info.get(id)!;
      const required = needs.get(id)!;
      const current = new D(stock.get(id) ?? 0);
      const other = new D(others.get(id) ?? 0);
      return {
        rawMaterial: { id, code: m.code, name: m.name },
        unit: unitRef(unitOrThrow(units, m.baseUnitId)),
        required: qty(required),
        currentStock: qty(current),
        otherOrdersDemand: qty(other),
        projectedShortage: qty(D.max(required.plus(other).minus(current), 0)),
        preferredSupplier: m.supplierId ? { id: m.supplierId, name: m.supplierName ?? "" } : null,
      };
    })
    .sort((a, b) => a.rawMaterial.name.localeCompare(b.rawMaterial.name, "es"));
}

/* ---------- Detalle ---------- */

export interface OrderViewer {
  permissions: Iterable<string>;
}

const customerName = (c: { legalName: string; tradeName: string | null }) =>
  c.tradeName ?? c.legalName;

/**
 * Pedido completo para la UI. Sin customers.read no se muestran contacto,
 * teléfono ni direcciones (Producción ve el nombre del cliente y la fecha).
 */
export async function getOrderDetail(
  db: Db,
  ctx: OperationContext,
  id: string,
  viewer: OrderViewer,
  now = new Date(),
): Promise<OrderDetailDto> {
  const P = PERMISSIONS;
  const can = (code: (typeof P)[keyof typeof P]) => hasPermissions(viewer.permissions, [code]);
  const order = await findOrder(db, ctx, id);
  const coverage = isDemand(order.status)
    ? await orderEffectiveCoverage(db, ctx, id)
    : order.coverageStatus;
  const units = await loadUnits(db, ctx);
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, order.customerId)));
  const lines = await loadLines(db, ctx, order.id);
  const productRows = await db
    .select({
      id: products.id,
      code: products.internalCode,
      name: products.name,
      salePrice: products.salePrice,
    })
    .from(products)
    .where(
      and(
        eq(products.companyId, ctx.companyId),
        inArray(products.id, lines.length ? lines.map((l) => l.productId) : [order.id]),
      ),
    );
  const productById = new Map(productRows.map((p) => [p.id, p]));

  const reservations = await db
    .select()
    .from(productLotReservations)
    .where(
      and(
        eq(productLotReservations.companyId, ctx.companyId),
        eq(productLotReservations.customerOrderId, order.id),
      ),
    )
    .orderBy(desc(productLotReservations.planRevision), asc(productLotReservations.reservedAt));
  const requirements = await db
    .select({
      r: orderProductionRequirements,
      productionOrder: {
        id: productionOrders.id,
        code: productionOrders.internalCode,
        status: productionOrders.status,
      },
    })
    .from(orderProductionRequirements)
    .leftJoin(
      productionOrders,
      eq(productionOrders.id, orderProductionRequirements.linkedProductionOrderId),
    )
    .where(
      and(
        eq(orderProductionRequirements.companyId, ctx.companyId),
        eq(orderProductionRequirements.customerOrderId, order.id),
      ),
    )
    .orderBy(
      desc(orderProductionRequirements.planRevision),
      asc(orderProductionRequirements.createdAt),
    );
  const materialRows = await db
    .select()
    .from(orderMaterialRequirements)
    .where(
      and(
        eq(orderMaterialRequirements.companyId, ctx.companyId),
        eq(orderMaterialRequirements.customerOrderId, order.id),
      ),
    );
  // Productos de líneas quitadas que aún figuran en reservas o necesidades históricas.
  const extraProducts = [
    ...new Set([
      ...reservations.map((r) => r.productId),
      ...requirements.map((r) => r.r.productId),
    ]),
  ].filter((pid) => !productById.has(pid));
  if (extraProducts.length > 0) {
    const extra = await db
      .select({
        id: products.id,
        code: products.internalCode,
        name: products.name,
        salePrice: products.salePrice,
      })
      .from(products)
      .where(and(eq(products.companyId, ctx.companyId), inArray(products.id, extraProducts)));
    for (const p of extra) productById.set(p.id, p);
  }
  const productRef = (pid: string) => {
    const p = productById.get(pid)!;
    return { id: p.id, code: p.code, name: p.name };
  };

  const rawInfo = await rawMaterialInfo(
    db,
    ctx,
    materialRows.map((m) => m.rawMaterialId),
  );

  // Lotes: los reservados (cualquier estado) y, con demanda, los de sus productos.
  const demand = isDemand(order.status);
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const lotRows = await selectLots(
    db,
    ctx,
    demand && productIds.length > 0
      ? sql`(${inArray(productLots.productId, productIds)} or ${inArray(
          productLots.id,
          reservations.length ? reservations.map((r) => r.productLotId) : [order.id],
        )})`
      : inArray(
          productLots.id,
          reservations.length ? reservations.map((r) => r.productLotId) : [order.id],
        ),
  );
  const lotById = new Map(lotRows.map((r) => [r.lot.id, r]));
  const allCommitted = demand
    ? await committedByLot(
        db,
        ctx,
        lotRows.map((r) => r.lot.id),
      )
    : new Map<string, string>();
  const active = reservations.filter((r) => r.status === "ACTIVE");
  const ownByLot = new Map<string, Dec>();
  for (const r of active) {
    ownByLot.set(r.productLotId, (ownByLot.get(r.productLotId) ?? new D(0)).plus(r.quantity));
  }

  const openReqs = requirements.filter((r) =>
    (OPEN_REQUIREMENT as readonly string[]).includes(r.r.status),
  );
  const lineDtos: OrderLineDto[] = lines.map((line) => {
    const saleUnit = unitOrThrow(units, line.saleUnitId);
    const reserved = active
      .filter((r) => r.orderLineId === line.id)
      .reduce((s, r) => s.plus(r.quantity), new D(0));
    const mine = openReqs.filter((r) => r.r.orderLineId === line.id);
    const toProduce = mine
      .filter((r) => r.r.problem === null)
      .reduce((s, r) => s.plus(r.r.requiredOutputQuantity), new D(0));
    const uncovered = mine
      .filter((r) => r.r.problem !== null)
      .reduce((s, r) => s.plus(r.r.requiredOutputQuantity), new D(0));
    let physical: string | null = null;
    let eligible: string | null = null;
    let committedByOthers: string | null = null;
    let newlyAvailable = new D(0);
    if (demand) {
      const lots = lotRows
        .filter((r) => r.lot.productId === line.productId)
        .map((row) => ({
          ...forAvailability(row),
          committed: new D(allCommitted.get(row.lot.id) ?? 0).minus(ownByLot.get(row.lot.id) ?? 0),
        }));
      const view = availabilityForOrder(lots, order.requestedAt, line.requestedConservation);
      physical = qty(view.physicalQuantity);
      eligible = qty(view.eligibleQuantity);
      committedByOthers = qty(view.committedQuantity);
      // Libre HOY además de lo que ya reservó este pedido: sólo se usa si se recalcula.
      const freeNow = D.max(view.availableQuantity.minus(reserved), 0);
      const pending = D.max(new D(line.normalizedQuantity).minus(reserved), 0);
      newlyAvailable = D.min(freeNow, pending);
    }
    const product = productById.get(line.productId)!;
    return {
      id: line.id,
      sortOrder: line.sortOrder,
      product: productRef(line.productId),
      requestedQuantity: line.requestedQuantity,
      unit: unitRef(unitOrThrow(units, line.unitId)),
      normalizedQuantity: line.normalizedQuantity,
      saleUnit: unitRef(saleUnit),
      requestedConservation: line.requestedConservation,
      notes: line.notes,
      informativePrice: product.salePrice,
      physical,
      eligible,
      committedByOthers,
      reserved: qty(reserved),
      toProduce: qty(toProduce),
      uncovered: qty(uncovered),
      newlyAvailable: qty(newlyAvailable),
    };
  });

  const reservationDtos: OrderReservationDto[] = reservations.map((r) => {
    const lot = lotById.get(r.productLotId)!;
    return {
      id: r.id,
      lineId: r.orderLineId,
      product: productRef(r.productId),
      lot: {
        id: lot.lot.id,
        code: lot.lot.lotCode,
        conservationState: lot.lot.conservationState,
        usableUntil: lot.lot.usableUntil?.toISOString() ?? null,
        warehouse: lot.warehouse,
      },
      quantity: r.quantity,
      unit: unitRef(unitOrThrow(units, r.unitId)),
      planRevision: r.planRevision,
      status: r.status,
      reservedAt: r.reservedAt.toISOString(),
      releasedAt: r.releasedAt?.toISOString() ?? null,
      releaseReason: r.releaseReason,
    };
  });

  const versionsByRecipe = new Map<string, Awaited<ReturnType<typeof loadVersions>>>();
  for (const recipeId of new Set(openReqs.map((r) => r.r.recipeId).filter(Boolean))) {
    versionsByRecipe.set(recipeId!, await loadVersions(db, ctx, recipeId!));
  }
  const requirementDtos: OrderProductionRequirementDto[] = requirements.map(
    ({ r, productionOrder }) => {
      const versions = r.recipeId ? (versionsByRecipe.get(r.recipeId) ?? []) : [];
      const pinned = versions.find((v) => v.id === r.recipeVersionId);
      return {
        id: r.id,
        lineId: r.orderLineId,
        product: productRef(r.productId),
        quantity: r.requiredOutputQuantity,
        unit: unitRef(unitOrThrow(units, r.outputUnitId)),
        recipe:
          r.recipeId && r.recipeVersionId
            ? {
                id: r.recipeId,
                versionId: r.recipeVersionId,
                versionNumber: pinned?.versionNumber ?? 0,
              }
            : null,
        problem: r.problem,
        planRevision: r.planRevision,
        status: r.status,
        productionOrder: productionOrder?.id ? productionOrder : null,
        materials: materialRows
          .filter((m) => m.orderProductionRequirementId === r.id)
          .map((m) => {
            const info = rawInfo.get(m.rawMaterialId)!;
            return {
              rawMaterial: { id: info.id, code: info.code, name: info.name },
              unit: unitRef(unitOrThrow(units, m.baseUnitId)),
              required: m.requiredQuantity,
            };
          }),
        createdAt: r.createdAt.toISOString(),
      };
    },
  );
  // Versión fijada en necesidades viejas: completar el número aunque la receta ya no esté abierta.
  for (const dto of requirementDtos) {
    if (dto.recipe && dto.recipe.versionNumber === 0) {
      const versions = await loadVersions(db, ctx, dto.recipe.id);
      dto.recipe.versionNumber =
        versions.find((v) => v.id === dto.recipe!.versionId)?.versionNumber ?? 0;
    }
  }

  // Materias primas: necesidades abiertas de este pedido contra stock y demás pedidos.
  const needs = new Map<string, Dec>();
  if (demand) {
    const openIds = new Set(openReqs.map((r) => r.r.id));
    for (const m of materialRows) {
      if (!openIds.has(m.orderProductionRequirementId)) continue;
      needs.set(m.rawMaterialId, (needs.get(m.rawMaterialId) ?? new D(0)).plus(m.requiredQuantity));
    }
  }
  const materials = await materialProjection(db, ctx, needs, order.id, units);

  /* Avisos */
  const issues: OrderIssueDto[] = [];
  const issue = (code: keyof typeof ORDER_ISSUE_LABELS, message: string) =>
    issues.push({ code, message });
  if (demand) {
    const invalidated = reservations.filter(
      (r) => r.status === "INVALIDATED" && r.planRevision === order.planRevision,
    );
    for (const r of invalidated) {
      const lot = lotById.get(r.productLotId)!;
      const unit = unitOrThrow(units, r.unitId).symbol;
      if (r.releaseReason === "LOT_BLOCKED") {
        issue(
          "LOT_BLOCKED",
          `El lote ${lot.lot.lotCode} se bloqueó por calidad: se invalidó la reserva de ${show(r.quantity)} ${unit}.`,
        );
      } else {
        const replacement = reservations.find((x) => x.replacesReservationId === r.id);
        issue(
          "LOT_WASTE",
          replacement
            ? `El lote ${lot.lot.lotCode} tuvo merma: la reserva bajó de ${show(r.quantity)} a ${show(replacement.quantity)} ${unit}.`
            : `El lote ${lot.lot.lotCode} tuvo merma: se invalidó la reserva de ${show(r.quantity)} ${unit}.`,
        );
      }
    }
    if (invalidated.length > 0) {
      issue("NEEDS_REPLAN", "La cobertura cambió: recalculá la cobertura del pedido.");
    }
    const toProduce = lineDtos.filter((l) => new D(l.toProduce).gt(0));
    if (toProduce.length > 0) {
      issue(
        "TO_PRODUCE",
        `Falta producir: ${toProduce.map((l) => `${show(l.toProduce)} ${l.saleUnit.symbol} de ${l.product.name}`).join(", ")}.`,
      );
    }
    const noRecipe = lineDtos.filter((l) => new D(l.uncovered).gt(0));
    if (noRecipe.length > 0) {
      issue(
        "NO_RECIPE",
        `Sin receta utilizable: ${noRecipe.map((l) => `${show(l.uncovered)} ${l.saleUnit.symbol} de ${l.product.name}`).join(", ")} quedan sin cubrir.`,
      );
    }
    const short = materials.filter((m) => new D(m.projectedShortage).gt(0));
    if (short.length > 0) {
      issue(
        "MATERIAL_SHORTAGE",
        `Falta materia prima (sumando los demás pedidos): ${short.map((m) => `${show(m.projectedShortage)} ${m.unit.symbol} de ${m.rawMaterial.name}`).join(", ")}.`,
      );
    }
    const fresh = lineDtos.filter((l) => new D(l.newlyAvailable).gt(0));
    if (fresh.length > 0) {
      issue(
        "NEW_STOCK_AVAILABLE",
        `Hay nuevo stock disponible — recalcular cobertura (${fresh.map((l) => `${show(l.newlyAvailable)} ${l.saleUnit.symbol} de ${l.product.name}`).join(", ")}).`,
      );
    }
    for (const { r } of openReqs) {
      if (!r.recipeId || !r.recipeVersionId) continue;
      const effective = findEffectiveVersion(versionsByRecipe.get(r.recipeId) ?? [], now);
      if (effective && effective.id !== r.recipeVersionId) {
        issue(
          "NEWER_RECIPE",
          `${productRef(r.productId).name}: hay una versión nueva de la receta (versión ${effective.versionNumber}). Recalculá la cobertura para usarla.`,
        );
      }
    }
    const unknown = active.filter((r) => lotById.get(r.productLotId)?.lot.usableUntil === null);
    if (unknown.length > 0) {
      issue(
        "SHELF_LIFE_UNKNOWN",
        `Reserva sobre ${unknown.length === 1 ? "un lote" : "lotes"} sin vida útil configurada (${[...new Set(unknown.map((r) => lotById.get(r.productLotId)!.lot.lotCode))].join(", ")}): no se puede asegurar que sigan utilizables.`,
      );
    }
    const cancelledProduction = await db
      .select({
        code: productionOrders.internalCode,
        requirementId: productionOrders.sourceOrderRequirementId,
      })
      .from(productionOrders)
      .where(
        and(
          eq(productionOrders.companyId, ctx.companyId),
          eq(productionOrders.status, "CANCELLED"),
          inArray(
            productionOrders.sourceOrderRequirementId,
            openReqs.length
              ? openReqs.filter((r) => r.r.status === "OPEN").map((r) => r.r.id)
              : [order.id],
          ),
        ),
      );
    for (const c of cancelledProduction) {
      issue(
        "PRODUCTION_CANCELLED",
        `La orden de producción ${c.code} se canceló: la necesidad vuelve a estar pendiente.`,
      );
    }
  }

  const people = await loadPeople(db, [
    order.createdByUserId,
    order.confirmedByUserId,
    order.cancelledByUserId,
  ]);
  const seeCustomer = can(P.CUSTOMERS_READ);
  const fullyCovered = coverage === "FULLY_COVERED";
  const readyBlockedReason =
    order.status === "CONFIRMED" || order.status === "IN_PREPARATION"
      ? fullyCovered
        ? null
        : coverage === "NEEDS_REPLAN"
          ? "Hay reservas invalidadas: recalculá la cobertura antes de marcarlo listo."
          : "Falta reservar producto: sólo un pedido cubierto por completo puede estar listo."
      : null;
  const local = instantToZonedLocal(order.requestedAt, ctx.timezone);

  return {
    id: order.id,
    code: order.internalCode,
    status: order.status,
    coverageStatus: coverage,
    planRevision: order.planRevision,
    customer: {
      id: customer!.id,
      code: customer!.internalCode,
      name: customerName(customer!),
      phone: seeCustomer ? customer!.phone : null,
      address: seeCustomer ? customer!.address : null,
    },
    canSeeCustomerDetails: seeCustomer,
    requestedAt: order.requestedAt.toISOString(),
    requestedAtLocal: local,
    timezone: ctx.timezone,
    fulfillmentType: order.fulfillmentType,
    deliveryAddress: seeCustomer ? order.deliveryAddress : null,
    contactName: seeCustomer ? order.contactName : null,
    contactPhone: seeCustomer ? order.contactPhone : null,
    eventName: order.eventName,
    priority: order.priority,
    notes: order.notes,
    currency: await companyCurrency(db, ctx),
    createdAt: order.createdAt.toISOString(),
    createdBy: personOf(people, order.createdByUserId),
    confirmedAt: order.confirmedAt?.toISOString() ?? null,
    confirmedBy: personOf(people, order.confirmedByUserId),
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    cancelledBy: personOf(people, order.cancelledByUserId),
    cancelReason: order.cancelReason,
    preparationStartedAt: order.preparationStartedAt?.toISOString() ?? null,
    readyAt: order.readyAt?.toISOString() ?? null,
    lines: lineDtos,
    reservations: reservationDtos,
    productionRequirements: requirementDtos,
    materials,
    issues,
    actions: {
      canEdit: order.status !== "CANCELLED" && can(P.ORDERS_UPDATE),
      canConfirm: order.status === "DRAFT" && can(P.ORDERS_CONFIRM),
      canReplan: demand && can(P.ORDERS_REPLAN),
      canCancel: order.status !== "CANCELLED" && can(P.ORDERS_CANCEL),
      canStartPreparation:
        (order.status === "CONFIRMED" || order.status === "READY") && can(P.ORDERS_PREPARE),
      canMarkReady:
        (order.status === "CONFIRMED" || order.status === "IN_PREPARATION") &&
        can(P.ORDERS_READY) &&
        fullyCovered,
      readyBlockedReason,
    },
  };
}

/** "10/10/2026 10:00" en la zona de la empresa. */
export function orderWhen(order: { requestedAt: Date }, ctx: OperationContext) {
  return formatLocalDateTime(instantToZonedLocal(order.requestedAt, ctx.timezone));
}
