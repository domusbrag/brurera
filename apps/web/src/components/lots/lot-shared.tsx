"use client";

import { describeShelfLife } from "@bakery/domain";
import {
  CONSERVATION_STATE_LABELS,
  LOT_STATUS_LABELS,
  type ConservationStateDto,
  type LotStatusDto,
} from "@bakery/shared";

/*
 * Piezas compartidas de lotes (Fase 4.5): estados, vida útil y vencimiento
 * expresados en palabras, nunca en minutos.
 */

export const LOTS_BASE = "/stock/lotes";
export const EXPIRING_PATH = "/stock/productos/por-vencer";

const STATUS_BADGE: Record<LotStatusDto, string> = {
  AVAILABLE: "",
  NEAR_EXPIRY: "badge--warn",
  EXPIRED: "badge--danger",
  BLOCKED: "badge--danger",
  DEPLETED: "badge--off",
};

export function LotStatusBadge({ status }: { status: LotStatusDto }) {
  return <span className={`badge ${STATUS_BADGE[status]}`}>{LOT_STATUS_LABELS[status]}</span>;
}

const STATE_BADGE: Record<ConservationStateDto, string> = {
  FRESH: "",
  REFRIGERATED: "badge--draft",
  FROZEN: "badge--draft",
  THAWED: "badge--info",
};

export function ConservationBadge({ state }: { state: ConservationStateDto }) {
  return <span className={`badge ${STATE_BADGE[state]}`}>{CONSERVATION_STATE_LABELS[state]}</span>;
}

const plural = (n: string, one: string, many: string) => `${n} ${n === "1" ? one : many}`;

/** 2880 → "2 días"; 720 → "12 horas"; 90 → "1,5 horas". */
export function formatShelfLife(minutes: number | null): string {
  if (minutes === null) return "Sin configurar";
  const { value, unit } = describeShelfLife(minutes);
  const text = value.replace(".", ",");
  return unit === "DAYS" ? plural(text, "día", "días") : plural(text, "hora", "horas");
}

/** Tiempo restante en palabras: "vence en 1 día y 3 h", "venció hace 2 h". */
export function formatRemaining(minutes: number | null): string {
  if (minutes === null) return "Vida útil sin configurar";
  const abs = Math.abs(minutes);
  const days = Math.floor(abs / 1440);
  const hours = Math.floor((abs % 1440) / 60);
  const mins = abs % 60;
  const parts =
    days > 0
      ? `${days} ${days === 1 ? "día" : "días"}${hours > 0 ? ` y ${hours} h` : ""}`
      : hours > 0
        ? `${hours} h${mins > 0 ? ` ${mins} min` : ""}`
        : `${mins} min`;
  return minutes >= 0 ? `vence en ${parts}` : `venció hace ${parts}`;
}
