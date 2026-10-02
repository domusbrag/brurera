import { randomUUID } from "node:crypto";
import { instantToZonedLocal } from "@bakery/shared";
import type { ApiClient } from "./helpers.js";
import { ok } from "./inventory-fixtures.js";
import { DAY, MEDIALUNA, configureConservation, freeze, produce } from "./lot-fixtures.js";
import { buildProductionWorld, type ProductionWorld } from "./production-fixtures.js";

/*
 * Datos de partida para pedidos (Fase 5A), creados por la API. Pan francés
 * (receta 100 kg → 75 kg harina + 0,8 kg sal) con la conservación de la
 * medialuna: fresco 2 días, congelado 30 días, descongelado 12 horas.
 */

export const TZ = "America/Argentina/Buenos_Aires";

/** Hora de pared de la empresa dentro de `days` días, redondeada a la hora ("AAAA-MM-DDTHH:00"). */
export function localIn(days: number, hour?: number): string {
  const local = instantToZonedLocal(new Date(Date.now() + days * DAY * 60_000), TZ);
  return hour === undefined
    ? `${local.slice(0, 13)}:00`
    : `${local.slice(0, 10)}T${String(hour).padStart(2, "0")}:00`;
}

export interface OrderWorld extends ProductionWorld {
  customerId: string;
  otherCustomerId: string;
}

export async function buildOrderWorld(api: ApiClient, suffix: string): Promise<OrderWorld> {
  const w = await buildProductionWorld(api, suffix);
  await ok(configureConservation(api, w.panFrances, MEDIALUNA));
  const customerId = (
    await ok(
      api.post("/api/customers", {
        type: "RETAILER",
        legalName: `Hotel Central${suffix}`,
        phone: "11-5555-0000",
        address: "Av. Siempreviva 742",
      }),
      201,
    )
  ).id;
  const otherCustomerId = (
    await ok(api.post("/api/customers", { type: "CONSUMER", legalName: `Juana${suffix}` }), 201)
  ).id;
  return { ...w, customerId, otherCustomerId };
}

/**
 * 700 kg físicos: 300 frescos (vencen en 2 días) + 400 congelados (30 días).
 * Devuelve los dos lotes.
 */
export async function freshAndFrozen(api: ApiClient, w: OrderWorld) {
  const { lot } = await produce(api, w, "700");
  const child = await ok(freeze(api, lot.id, "400"), 201);
  return { fresh: lot.id as string, frozen: child.childLot.id as string };
}

export interface LineSpec {
  productId: string;
  quantity: string;
  requestedConservation?: string;
  unitId?: string;
}

export const draft = (
  api: ApiClient,
  w: OrderWorld,
  lines: LineSpec[],
  extra: Record<string, unknown> = {},
) =>
  api.post("/api/orders", {
    customerId: w.customerId,
    // Mañana: el lote fresco (2 días) todavía sirve.
    requestedAt: localIn(1),
    lines,
    ...extra,
  });

export const confirm = (api: ApiClient, orderId: string, operationId = randomUUID()) =>
  api.post(`/api/orders/${orderId}/confirm`, { operationId });

export const replan = (
  api: ApiClient,
  orderId: string,
  body: Record<string, unknown> = {},
  operationId = randomUUID(),
) => api.post(`/api/orders/${orderId}/replan`, { ...body, operationId });

export const cancel = (
  api: ApiClient,
  orderId: string,
  body: Record<string, unknown> = {},
  operationId = randomUUID(),
) =>
  api.post(`/api/orders/${orderId}/cancel`, {
    reason: "Lo pidió el cliente",
    ...body,
    operationId,
  });

/** Borrador + confirmación; devuelve el pedido confirmado. */
export async function confirmedOrder(
  api: ApiClient,
  w: OrderWorld,
  lines: LineSpec[],
  extra: Record<string, unknown> = {},
) {
  const created = await ok(draft(api, w, lines, extra), 201);
  return (await ok(confirm(api, created.id))).order;
}

export const orderOf = (api: ApiClient, id: string) => ok(api.get(`/api/orders/${id}`));

/** Σ reservas ACTIVAS de un pedido. */
export function reservedOf(order: { reservations: { status: string; quantity: string }[] }) {
  return order.reservations
    .filter((r) => r.status === "ACTIVE")
    .reduce((s, r) => s + Number(r.quantity), 0);
}
