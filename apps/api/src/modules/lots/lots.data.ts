import {
  CONSERVATION_STATES,
  CONSERVATION_TRANSITIONS,
  D,
  lotEligibilityAt,
  type ConservationProfileEntry,
  type ConservationState,
} from "@bakery/domain";
import {
  productConservationProfiles,
  productConservationSettings,
  productLotBalances,
  productLots,
  productionOrders,
  products,
  unitsOfMeasure,
  warehouses,
  type Database,
  type Transaction,
} from "@bakery/database";
import type { LotStatusDto, ProductLotDto } from "@bakery/shared";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { OperationContext } from "../../lib/context.js";
import { notFound } from "../../lib/db-errors.js";
import { fixedMoney, fixedQty } from "../inventory/ledger.js";
import { qualified } from "../../lib/sql.js";

/*
 * Lecturas compartidas de lotes y perfiles de conservación (Fase 4.5).
 */

export type Db = Database | Transaction;

/** Umbral de "próximo a vencer" cuando el producto no tiene configuración: 24 h. */
export const DEFAULT_NEAR_EXPIRY_MINUTES = 1440;

export interface ProductProfile {
  configured: boolean;
  defaultInitialState: ConservationState;
  nearExpiryMinutes: number;
  entries: (ConservationProfileEntry & { notes: string | null })[];
  updatedAt: Date | null;
  updatedByUserId: string | null;
}

/** Perfiles de conservación de varios productos (los cuatro estados siempre presentes). */
export async function loadProfiles(
  db: Db,
  ctx: OperationContext,
  productIds: readonly string[],
): Promise<Map<string, ProductProfile>> {
  const ids = [...new Set(productIds)];
  const result = new Map<string, ProductProfile>();
  if (ids.length === 0) return result;
  const [settings, rows] = await Promise.all([
    db
      .select()
      .from(productConservationSettings)
      .where(
        and(
          eq(productConservationSettings.companyId, ctx.companyId),
          inArray(productConservationSettings.productId, ids),
        ),
      ),
    db
      .select()
      .from(productConservationProfiles)
      .where(
        and(
          eq(productConservationProfiles.companyId, ctx.companyId),
          inArray(productConservationProfiles.productId, ids),
        ),
      ),
  ]);
  for (const productId of ids) {
    const s = settings.find((x) => x.productId === productId);
    const mine = rows.filter((r) => r.productId === productId);
    result.set(productId, {
      configured: s !== undefined,
      defaultInitialState: s?.defaultInitialState ?? "FRESH",
      nearExpiryMinutes: s?.nearExpiryMinutes ?? DEFAULT_NEAR_EXPIRY_MINUTES,
      entries: CONSERVATION_STATES.map((state) => {
        const r = mine.find((x) => x.state === state);
        return {
          state,
          enabled: r?.enabled ?? false,
          shelfLifeMinutes: r?.shelfLifeMinutes ?? null,
          allowedAsInitial: r?.allowedAsInitial ?? false,
          notes: r?.notes ?? null,
        };
      }),
      updatedAt: s?.updatedAt ?? null,
      updatedByUserId: s?.updatedByUserId ?? null,
    });
  }
  return result;
}

export async function loadProfile(db: Db, ctx: OperationContext, productId: string) {
  return (await loadProfiles(db, ctx, [productId])).get(productId)!;
}

/** Lotes con su saldo (empresa entera: un lote vive en un solo depósito). */
export function selectLots(db: Db, ctx: OperationContext, where: SQL | undefined) {
  return (db as Database)
    .select({
      lot: productLots,
      quantity: sql<string>`coalesce(${productLotBalances.quantity}, 0)`,
      value: sql<string>`coalesce(${productLotBalances.inventoryValue}, 0)`,
      product: { id: products.id, code: products.internalCode, name: products.name },
      order: { id: productionOrders.id, code: productionOrders.internalCode },
      parentCode: sql<
        string | null
      >`(select pl.lot_code from product_lots pl where pl.id = ${qualified(productLots.parentLotId)})`,
      warehouse: { id: warehouses.id, code: warehouses.code, name: warehouses.name },
      unit: { id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol },
    })
    .from(productLots)
    .innerJoin(products, eq(products.id, productLots.productId))
    .innerJoin(productionOrders, eq(productionOrders.id, productLots.productionOrderId))
    .innerJoin(warehouses, eq(warehouses.id, productLots.warehouseId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, productLots.unitId))
    .leftJoin(
      productLotBalances,
      and(
        eq(productLotBalances.productLotId, productLots.id),
        eq(productLotBalances.warehouseId, productLots.warehouseId),
      ),
    )
    .where(and(eq(productLots.companyId, ctx.companyId), where));
}

type Ref = { id: string; code: string };
export interface LotRow {
  lot: typeof productLots.$inferSelect;
  quantity: string;
  value: string;
  product: Ref & { name: string };
  order: Ref;
  parentCode: string | null;
  warehouse: Ref & { name: string };
  unit: { id: string; code: string; symbol: string };
}

export async function findLotRow(db: Db, ctx: OperationContext, lotId: string) {
  const [row] = await selectLots(db, ctx, eq(productLots.id, lotId));
  if (!row) throw notFound("Lote");
  return row;
}

/** Estado operativo derivado en `now`: agotado > bloqueado > vencido > próximo a vencer > utilizable. */
export function lotStatus(row: LotRow, now: Date, nearExpiryMinutes: number): LotStatusDto {
  const lot = forAvailability(row);
  const eligibility = lotEligibilityAt(lot, now);
  if (!eligibility.eligible) return eligibility.reason!;
  if (
    lot.usableUntil !== null &&
    lot.usableUntil.getTime() - now.getTime() <= nearExpiryMinutes * 60_000
  ) {
    return "NEAR_EXPIRY";
  }
  return "AVAILABLE";
}

export function forAvailability(row: LotRow) {
  return {
    id: row.lot.id,
    code: row.lot.lotCode,
    conservationState: row.lot.conservationState,
    qualityStatus: row.lot.qualityStatus,
    quantity: row.quantity,
    producedAt: row.lot.producedAt,
    usableUntil: row.lot.usableUntil,
  };
}

/** Estados destino posibles hoy: transición válida, estado habilitado y lote operable. */
export function transformTargets(
  row: LotRow,
  profile: ProductProfile | undefined,
  now: Date,
): ConservationState[] {
  if (!lotEligibilityAt(forAvailability(row), now).eligible) return [];
  return CONSERVATION_TRANSITIONS[row.lot.conservationState].filter(
    (to) => profile?.entries.find((e) => e.state === to)?.enabled ?? false,
  );
}

export function toLotDto(
  row: LotRow,
  opts: { now: Date; canSeeCosts: boolean; profile: ProductProfile | undefined },
): ProductLotDto {
  const { now, canSeeCosts, profile } = opts;
  const usableUntil = row.lot.usableUntil;
  return {
    id: row.lot.id,
    code: row.lot.lotCode,
    product: row.product,
    productionOrder: row.order,
    parentLot:
      row.lot.parentLotId && row.parentCode
        ? { id: row.lot.parentLotId, code: row.parentCode }
        : null,
    warehouse: row.warehouse,
    conservationState: row.lot.conservationState,
    qualityStatus: row.lot.qualityStatus,
    qualityReason: row.lot.qualityReason,
    status: lotStatus(row, now, profile?.nearExpiryMinutes ?? DEFAULT_NEAR_EXPIRY_MINUTES),
    producedAt: row.lot.producedAt.toISOString(),
    stateChangedAt: row.lot.stateChangedAt.toISOString(),
    usableUntil: usableUntil?.toISOString() ?? null,
    shelfLifeMinutes: row.lot.shelfLifeMinutes,
    minutesRemaining:
      usableUntil === null ? null : Math.floor((usableUntil.getTime() - now.getTime()) / 60_000),
    initialQuantity: fixedQty(row.lot.initialQuantity),
    quantity: fixedQty(row.quantity),
    unit: row.unit,
    unitMaterialCost: canSeeCosts ? row.lot.unitMaterialCost : null,
    value: canSeeCosts ? fixedMoney(row.value) : null,
    transformTargets: transformTargets(row, profile, now),
    createdAt: row.lot.createdAt.toISOString(),
  };
}

/** Lotes → DTO cargando los perfiles de sus productos en una sola consulta. */
export async function toLotDtos(
  db: Db,
  ctx: OperationContext,
  rows: LotRow[],
  canSeeCosts: boolean,
  now = new Date(),
): Promise<ProductLotDto[]> {
  const profiles = await loadProfiles(
    db,
    ctx,
    rows.map((r) => r.lot.productId),
  );
  return rows.map((row) =>
    toLotDto(row, { now, canSeeCosts, profile: profiles.get(row.lot.productId) }),
  );
}

export const zero = () => new D(0);
