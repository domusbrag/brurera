import { D, aggregateMaterialDemand } from "@bakery/domain";
import {
  customerOrders,
  customers,
  orderMaterialRequirements,
  orderProductionRequirements,
  productionOrders,
  products,
  recipeVersions,
  type Database,
} from "@bakery/database";
import {
  instantToZonedLocal,
  zonedLocalToInstant,
  type MaterialDemandDto,
  type OrderIssueDto,
  type OrderRequirementDto,
  type OrderRiskDto,
  type Page,
  type ProductionNeedDto,
  type materialDemandQuerySchema,
  type planningQuerySchema,
} from "@bakery/shared";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { z } from "zod";
import type { OperationContext } from "../../lib/context.js";
import { notFound } from "../../lib/db-errors.js";
import { toPage } from "../../lib/listing.js";
import { loadUnits, unitOrThrow } from "../recipes/recipes.data.js";
import {
  DEMAND,
  OPEN_REQUIREMENT,
  effectiveCoverage,
  qty,
  rawMaterialInfo,
  rawMaterialStock,
  unitRef,
} from "./orders.data.js";

/*
 * Planificación (Fase 5A): qué hay que producir, qué materias primas faltan
 * sumando TODOS los pedidos con demanda (con horizonte temporal) y qué pedidos
 * están en riesgo. Consultas: nada se reserva ni se escribe.
 */

type Dec = InstanceType<typeof D>;
type PlanningQuery = z.infer<typeof planningQuerySchema>;
type MaterialQuery = z.infer<typeof materialDemandQuerySchema>;

const horizon = (until: string | undefined, ctx: OperationContext) =>
  until ? lte(customerOrders.requestedAt, zonedLocalToInstant(until, ctx.timezone)) : undefined;

function paginate<T>(items: T[], query: { page: number; pageSize: number }): Page<T> {
  const start = (query.page - 1) * query.pageSize;
  return toPage(items.slice(start, start + query.pageSize), items.length, query);
}

/** Necesidades abiertas (pendientes o con producción en curso) de pedidos con demanda. */
async function openRequirementRows(db: Database, ctx: OperationContext, until?: string) {
  return db
    .select({
      r: orderProductionRequirements,
      order: {
        id: customerOrders.id,
        code: customerOrders.internalCode,
        requestedAt: customerOrders.requestedAt,
      },
      product: { id: products.id, code: products.internalCode, name: products.name },
      productionOrder: { id: productionOrders.id, code: productionOrders.internalCode },
    })
    .from(orderProductionRequirements)
    .innerJoin(customerOrders, eq(customerOrders.id, orderProductionRequirements.customerOrderId))
    .innerJoin(products, eq(products.id, orderProductionRequirements.productId))
    .leftJoin(
      productionOrders,
      eq(productionOrders.id, orderProductionRequirements.linkedProductionOrderId),
    )
    .where(
      and(
        eq(orderProductionRequirements.companyId, ctx.companyId),
        inArray(orderProductionRequirements.status, [...OPEN_REQUIREMENT]),
        inArray(customerOrders.status, [...DEMAND]),
        horizon(until, ctx),
      ),
    )
    .orderBy(asc(customerOrders.requestedAt), asc(customerOrders.internalCode));
}

/** Productos a producir para pedidos, agrupados por producto (lo más urgente primero). */
export async function productionNeeds(
  db: Database,
  ctx: OperationContext,
  query: PlanningQuery,
): Promise<Page<ProductionNeedDto>> {
  const units = await loadUnits(db, ctx);
  const rows = await openRequirementRows(db, ctx, query.until);
  const byProduct = new Map<string, ProductionNeedDto & { q: Dec; w: Dec }>();
  for (const row of rows) {
    const current =
      byProduct.get(row.product.id) ??
      ({
        product: row.product,
        unit: unitRef(unitOrThrow(units, row.r.outputUnitId)),
        quantity: "",
        withoutRecipe: "",
        earliestRequestedAt: row.order.requestedAt.toISOString(),
        orders: [],
        q: new D(0),
        w: new D(0),
      } satisfies ProductionNeedDto & { q: Dec; w: Dec });
    if (row.r.problem) current.w = current.w.plus(row.r.requiredOutputQuantity);
    else current.q = current.q.plus(row.r.requiredOutputQuantity);
    current.orders.push({
      orderId: row.order.id,
      orderCode: row.order.code,
      requestedAt: row.order.requestedAt.toISOString(),
      requirementId: row.r.id,
      quantity: row.r.requiredOutputQuantity,
      status: row.r.status,
      productionOrder: row.productionOrder?.id ? row.productionOrder : null,
      problem: row.r.problem,
    });
    byProduct.set(row.product.id, current);
  }
  const items = [...byProduct.values()]
    .sort((a, b) => a.earliestRequestedAt.localeCompare(b.earliestRequestedAt))
    .map(({ q, w, ...rest }) => ({ ...rest, quantity: qty(q), withoutRecipe: qty(w) }));
  return paginate(items, query);
}

interface DemandRow {
  rawMaterialId: string;
  quantity: string;
  orderId: string;
  orderCode: string;
  requestedAt: Date;
}

async function materialDemandRows(
  db: Database,
  ctx: OperationContext,
  until?: string,
): Promise<DemandRow[]> {
  return db
    .select({
      rawMaterialId: orderMaterialRequirements.rawMaterialId,
      quantity: orderMaterialRequirements.requiredQuantity,
      orderId: customerOrders.id,
      orderCode: customerOrders.internalCode,
      requestedAt: customerOrders.requestedAt,
    })
    .from(orderMaterialRequirements)
    .innerJoin(
      orderProductionRequirements,
      eq(orderProductionRequirements.id, orderMaterialRequirements.orderProductionRequirementId),
    )
    .innerJoin(customerOrders, eq(customerOrders.id, orderMaterialRequirements.customerOrderId))
    .where(
      and(
        eq(orderMaterialRequirements.companyId, ctx.companyId),
        inArray(orderProductionRequirements.status, [...OPEN_REQUIREMENT]),
        inArray(customerOrders.status, [...DEMAND]),
        horizon(until, ctx),
      ),
    )
    .orderBy(asc(customerOrders.requestedAt));
}

/**
 * calculateMaterialDemand(horizonte): suma la necesidad de materias primas de
 * todos los pedidos con demanda hasta `until` y la compara con el stock de la
 * empresa. A 7 kg + B 5 kg con 10 kg en stock → demanda 12, faltante 2.
 */
export async function calculateMaterialDemand(
  db: Database,
  ctx: OperationContext,
  query: MaterialQuery,
): Promise<Page<MaterialDemandDto>> {
  const rows = await materialDemandRows(db, ctx, query.until);
  const ids = [...new Set(rows.map((r) => r.rawMaterialId))];
  const [stock, info, units] = await Promise.all([
    rawMaterialStock(db, ctx, ids),
    rawMaterialInfo(db, ctx, ids),
    loadUnits(db, ctx),
  ]);
  const lines = aggregateMaterialDemand(
    stock,
    rows.map((r) => ({ rawMaterialId: r.rawMaterialId, quantity: r.quantity })),
  );
  const items: MaterialDemandDto[] = lines
    .filter((l) => !query.shortageOnly || l.shortage.gt(0))
    .map((l) => {
      const m = info.get(l.rawMaterialId)!;
      const mine = rows.filter((r) => r.rawMaterialId === l.rawMaterialId);
      const perOrder = new Map<string, { orderCode: string; requestedAt: Date; q: Dec }>();
      for (const r of mine) {
        const cur = perOrder.get(r.orderId) ?? {
          orderCode: r.orderCode,
          requestedAt: r.requestedAt,
          q: new D(0),
        };
        cur.q = cur.q.plus(r.quantity);
        perOrder.set(r.orderId, cur);
      }
      return {
        rawMaterial: { id: m.id, code: m.code, name: m.name },
        unit: unitRef(unitOrThrow(units, m.baseUnitId)),
        currentStock: qty(l.currentStock),
        openOrderDemand: qty(l.openOrderDemand),
        availableAfterDemand: qty(l.availableAfterDemand),
        shortage: qty(l.shortage),
        preferredSupplier: m.supplierId ? { id: m.supplierId, name: m.supplierName ?? "" } : null,
        earliestRequestedAt: mine[0]!.requestedAt.toISOString(),
        orders: [...perOrder.entries()].map(([orderId, v]) => ({
          orderId,
          orderCode: v.orderCode,
          requestedAt: v.requestedAt.toISOString(),
          quantity: qty(v.q),
        })),
      };
    })
    .sort(
      (a, b) =>
        Number(new D(b.shortage).gt(0)) - Number(new D(a.shortage).gt(0)) ||
        a.earliestRequestedAt.localeCompare(b.earliestRequestedAt) ||
        a.rawMaterial.name.localeCompare(b.rawMaterial.name, "es"),
    );
  return paginate(items, query);
}

/**
 * Pedidos en riesgo: con demanda (dentro del horizonte) y sin cobertura completa,
 * a recalcular, o con alguna materia prima en faltante global.
 */
export async function ordersAtRisk(
  db: Database,
  ctx: OperationContext,
  query: PlanningQuery,
): Promise<Page<OrderRiskDto>> {
  const orders = await db
    .select({
      order: customerOrders,
      coverage: effectiveCoverage,
      customer: sql<string>`coalesce(${customers.tradeName}, ${customers.legalName})`,
    })
    .from(customerOrders)
    .innerJoin(customers, eq(customers.id, customerOrders.customerId))
    .where(
      and(
        eq(customerOrders.companyId, ctx.companyId),
        inArray(customerOrders.status, [...DEMAND]),
        horizon(query.until, ctx),
      ),
    )
    .orderBy(asc(customerOrders.requestedAt));
  const requirements = await openRequirementRows(db, ctx, query.until);
  const demand = await materialDemandRows(db, ctx, query.until);
  const ids = [...new Set(demand.map((r) => r.rawMaterialId))];
  const [stock, info] = await Promise.all([
    rawMaterialStock(db, ctx, ids),
    rawMaterialInfo(db, ctx, ids),
  ]);
  const short = new Set(
    aggregateMaterialDemand(
      stock,
      demand.map((r) => ({ rawMaterialId: r.rawMaterialId, quantity: r.quantity })),
    )
      .filter((l) => l.shortage.gt(0))
      .map((l) => l.rawMaterialId),
  );
  const items: OrderRiskDto[] = [];
  for (const { order, coverage, customer } of orders) {
    const problems: OrderIssueDto[] = [];
    if (coverage === "NEEDS_REPLAN") {
      problems.push({
        code: "NEEDS_REPLAN",
        message: "Un lote reservado se bloqueó o tuvo merma: recalcular cobertura.",
      });
    }
    const mine = requirements.filter((r) => r.order.id === order.id);
    const toProduce = mine.filter((r) => !r.r.problem && r.r.status === "OPEN");
    if (toProduce.length > 0) {
      problems.push({
        code: "TO_PRODUCE",
        message: `Falta producir ${toProduce.map((r) => `${new D(r.r.requiredOutputQuantity).toString()} de ${r.product.name}`).join(", ")} (sin orden de producción).`,
      });
    }
    const noRecipe = mine.filter((r) => r.r.problem);
    if (noRecipe.length > 0) {
      problems.push({
        code: "NO_RECIPE",
        message: `Sin receta utilizable: ${noRecipe.map((r) => r.product.name).join(", ")}.`,
      });
    }
    const materials = [
      ...new Set(
        demand
          .filter((d) => d.orderId === order.id && short.has(d.rawMaterialId))
          .map((d) => d.rawMaterialId),
      ),
    ];
    if (materials.length > 0) {
      problems.push({
        code: "MATERIAL_SHORTAGE",
        message: `Falta materia prima: ${materials.map((m) => info.get(m)!.name).join(", ")}.`,
      });
    }
    if (problems.length === 0) continue;
    items.push({
      order: {
        id: order.id,
        code: order.internalCode,
        requestedAt: order.requestedAt.toISOString(),
        requestedAtLocal: instantToZonedLocal(order.requestedAt, ctx.timezone),
        priority: order.priority,
        status: order.status,
        coverageStatus: coverage,
      },
      customer,
      problems,
    });
  }
  return paginate(items, query);
}

/** Necesidad de un pedido para prellenar una orden de producción. */
export async function getRequirement(
  db: Database,
  ctx: OperationContext,
  id: string,
): Promise<OrderRequirementDto> {
  const [row] = await db
    .select({
      r: orderProductionRequirements,
      order: {
        id: customerOrders.id,
        code: customerOrders.internalCode,
        requestedAt: customerOrders.requestedAt,
        status: customerOrders.status,
      },
      product: { id: products.id, code: products.internalCode, name: products.name },
      versionNumber: recipeVersions.versionNumber,
      productionOrder: {
        id: productionOrders.id,
        code: productionOrders.internalCode,
        status: productionOrders.status,
      },
    })
    .from(orderProductionRequirements)
    .innerJoin(customerOrders, eq(customerOrders.id, orderProductionRequirements.customerOrderId))
    .innerJoin(products, eq(products.id, orderProductionRequirements.productId))
    .leftJoin(recipeVersions, eq(recipeVersions.id, orderProductionRequirements.recipeVersionId))
    .leftJoin(
      productionOrders,
      eq(productionOrders.id, orderProductionRequirements.linkedProductionOrderId),
    )
    .where(
      and(
        eq(orderProductionRequirements.companyId, ctx.companyId),
        eq(orderProductionRequirements.id, id),
      ),
    );
  if (!row) throw notFound("Necesidad");
  const units = await loadUnits(db, ctx);
  // Depósitos sugeridos: los de la última orden de producción del mismo producto.
  const [last] = await db
    .select({
      source: productionOrders.sourceWarehouseId,
      output: productionOrders.outputWarehouseId,
    })
    .from(productionOrders)
    .where(
      and(
        eq(productionOrders.companyId, ctx.companyId),
        eq(productionOrders.productId, row.r.productId),
      ),
    )
    .orderBy(sql`${productionOrders.createdAt} desc`)
    .limit(1);
  const local = instantToZonedLocal(row.order.requestedAt, ctx.timezone);
  const blockedReason = !(DEMAND as readonly string[]).includes(row.order.status)
    ? `El pedido ${row.order.code} no está confirmado.`
    : row.r.status === "PRODUCTION_CREATED"
      ? `Ya existe la orden de producción ${row.productionOrder?.code ?? ""}.`
      : row.r.status !== "OPEN"
        ? "La necesidad ya no está pendiente (el pedido se recalculó o se cumplió)."
        : row.r.problem
          ? "El producto no tiene una receta utilizable."
          : null;
  return {
    id: row.r.id,
    order: {
      id: row.order.id,
      code: row.order.code,
      requestedAt: row.order.requestedAt.toISOString(),
      requestedAtLocal: local,
    },
    product: row.product,
    // Hasta 6 decimales: es lo que acepta la cantidad de una orden de producción.
    quantity: new D(row.r.requiredOutputQuantity).toDecimalPlaces(6).toString(),
    unit: unitRef(unitOrThrow(units, row.r.outputUnitId)),
    recipe:
      row.r.recipeId && row.r.recipeVersionId
        ? {
            id: row.r.recipeId,
            versionId: row.r.recipeVersionId,
            versionNumber: row.versionNumber ?? 0,
          }
        : null,
    status: row.r.status,
    problem: row.r.problem,
    requiredBy: local.slice(0, 10),
    suggestedSourceWarehouseId: last?.source ?? null,
    suggestedOutputWarehouseId: last?.output ?? null,
    productionOrder: row.productionOrder?.id ? row.productionOrder : null,
    blockedReason,
  };
}
