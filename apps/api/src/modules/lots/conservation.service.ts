import {
  productConservationProfiles,
  productConservationSettings,
  unitsOfMeasure,
  users,
  type Database,
} from "@bakery/database";
import type { ConservationProfileDto, ConservationProfileInput } from "@bakery/shared";
import { eq } from "drizzle-orm";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { notFound } from "../../lib/db-errors.js";
import { recordAudit } from "../audit/audit.service.js";
import { findProduct } from "../production/production.data.js";
import { loadProfile, type Db } from "./lots.data.js";

/*
 * Perfil de conservación del producto (Fase 4.5): qué estados admite, con qué
 * vida útil (minutos) y con cuál nace un lote. Lo define cada empresa: el
 * sistema no trae valores por defecto ni reglas sanitarias.
 */

async function productOrThrow(db: Db, ctx: OperationContext, productId: string) {
  const product = await findProduct(db, ctx, productId);
  if (!product) throw notFound("Producto");
  return product;
}

export async function getConservation(
  db: Db,
  ctx: OperationContext,
  productId: string,
): Promise<ConservationProfileDto> {
  const product = await productOrThrow(db, ctx, productId);
  const profile = await loadProfile(db, ctx, productId);
  const [unit] = await db
    .select({ id: unitsOfMeasure.id, code: unitsOfMeasure.code, symbol: unitsOfMeasure.symbol })
    .from(unitsOfMeasure)
    .where(eq(unitsOfMeasure.id, product.saleUnitId));
  const [updatedBy] = profile.updatedByUserId
    ? await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, profile.updatedByUserId))
    : [];
  return {
    product: {
      id: product.id,
      code: product.internalCode,
      name: product.name,
      active: product.active,
    },
    saleUnit: unit!,
    configured: profile.configured,
    defaultInitialState: profile.defaultInitialState,
    nearExpiryMinutes: profile.nearExpiryMinutes,
    states: profile.entries.map((e) => ({
      state: e.state,
      enabled: e.enabled,
      shelfLifeMinutes: e.shelfLifeMinutes,
      allowedAsInitial: e.allowedAsInitial,
      notes: e.notes,
    })),
    updatedAt: profile.updatedAt?.toISOString() ?? null,
    updatedBy: updatedBy ?? null,
  };
}

/**
 * Guarda la configuración completa. Los estados no enviados quedan
 * deshabilitados. No modifica lotes existentes: su vida útil se fijó al nacer.
 */
export async function updateConservation(
  db: Database,
  ctx: OperationContext,
  productId: string,
  input: ConservationProfileInput,
): Promise<ConservationProfileDto> {
  return db.transaction(async (tx) => {
    const product = await productOrThrow(tx, ctx, productId);
    const before = await loadProfile(tx, ctx, productId);
    const entries = before.entries.map((current) => {
      const sent = input.states.find((s) => s.state === current.state);
      return sent
        ? {
            state: current.state,
            enabled: sent.enabled,
            shelfLifeMinutes: sent.shelfLifeMinutes,
            allowedAsInitial: sent.allowedAsInitial,
            notes: sent.notes,
          }
        : { ...current, enabled: false, allowedAsInitial: false };
    });

    await tx
      .insert(productConservationSettings)
      .values({
        companyId: ctx.companyId,
        productId,
        defaultInitialState: input.defaultInitialState,
        nearExpiryMinutes: input.nearExpiryMinutes,
        updatedByUserId: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [productConservationSettings.companyId, productConservationSettings.productId],
        set: {
          defaultInitialState: input.defaultInitialState,
          nearExpiryMinutes: input.nearExpiryMinutes,
          updatedByUserId: ctx.userId,
          updatedAt: new Date(),
        },
      });
    for (const e of entries) {
      await tx
        .insert(productConservationProfiles)
        .values({
          companyId: ctx.companyId,
          productId,
          state: e.state,
          enabled: e.enabled,
          shelfLifeMinutes: e.shelfLifeMinutes,
          allowedAsInitial: e.allowedAsInitial,
          notes: e.notes,
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .onConflictDoUpdate({
          target: [
            productConservationProfiles.companyId,
            productConservationProfiles.productId,
            productConservationProfiles.state,
          ],
          set: {
            enabled: e.enabled,
            shelfLifeMinutes: e.shelfLifeMinutes,
            allowedAsInitial: e.allowedAsInitial,
            notes: e.notes,
            updatedByUserId: ctx.userId,
            updatedAt: new Date(),
          },
        });
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (!before.configured || before.defaultInitialState !== input.defaultInitialState) {
      changes.defaultInitialState = {
        from: before.configured ? before.defaultInitialState : null,
        to: input.defaultInitialState,
      };
    }
    if (!before.configured || before.nearExpiryMinutes !== input.nearExpiryMinutes) {
      changes.nearExpiryMinutes = {
        from: before.configured ? before.nearExpiryMinutes : null,
        to: input.nearExpiryMinutes,
      };
    }
    for (const e of entries) {
      const old = before.entries.find((b) => b.state === e.state)!;
      for (const key of ["enabled", "shelfLifeMinutes", "allowedAsInitial", "notes"] as const) {
        if (old[key] !== e[key]) changes[`${e.state}.${key}`] = { from: old[key], to: e[key] };
      }
    }
    if (!before.configured || Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: before.configured
          ? "PRODUCT_CONSERVATION_PROFILE_UPDATED"
          : "PRODUCT_CONSERVATION_PROFILE_CREATED",
        entityType: "product",
        entityId: productId,
        metadata: {
          code: product.internalCode,
          name: product.name,
          enabledStates: entries.filter((e) => e.enabled).map((e) => e.state),
          changes,
        },
      });
    }
    return getConservation(tx, ctx, productId);
  });
}
