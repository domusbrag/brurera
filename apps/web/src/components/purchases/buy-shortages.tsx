"use client";

import { D } from "@bakery/domain";
import { PERMISSIONS as P } from "@bakery/shared";
import Link from "next/link";
import { listPath } from "@/lib/api-client";
import { useCan } from "../user-context";

/*
 * "Armar compras": agrupa lo que falta pedir por proveedor preferido y ofrece un
 * borrador de compra por proveedor con todas sus materias primas precargadas
 * (cantidad sugerida = falta pedir, ya descontado lo que está en camino). Nada se
 * crea hasta que el usuario guarda el borrador.
 */

export interface ShortageItem {
  rawMaterialId: string;
  /** Unidad base; > 0 para entrar en la compra. */
  toOrder: string;
  supplier: { id: string; name: string } | null;
}

/** Ruta del alta de compra con las líneas precargadas. */
export function purchaseDraftHref(supplierId: string | undefined, items: ShortageItem[]): string {
  return listPath("/compras/nueva", {
    supplierId,
    items: items.map((i) => `${i.rawMaterialId}:${new D(i.toOrder).toString()}`).join(","),
  });
}

export function BuyShortagesPanel({
  items,
  complete,
}: {
  items: ShortageItem[];
  /** false si la lista no trae todos los faltantes (hay más de una página). */
  complete: boolean;
}) {
  const can = useCan();
  if (!can(P.PURCHASES_CREATE)) return null;
  const pending = items.filter((i) => new D(i.toOrder).gt(0));
  if (pending.length === 0) return null;
  const groups = new Map<string, { name: string | null; items: ShortageItem[] }>();
  for (const item of pending) {
    const key = item.supplier?.id ?? "";
    const group = groups.get(key) ?? { name: item.supplier?.name ?? null, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const ordered = [...groups.entries()].sort(([a, ga], [b, gb]) =>
    a === "" ? 1 : b === "" ? -1 : (ga.name ?? "").localeCompare(gb.name ?? "", "es"),
  );
  return (
    <section className="panel" aria-labelledby="buy-shortages-title">
      <h2 id="buy-shortages-title" className="section-title">
        Armar compras
      </h2>
      <p className="muted small">
        Un borrador por proveedor con lo que falta pedir (ya descontado lo que está en camino).
        Revisás cantidades y precios antes de guardarlo.
        {!complete && " Sólo incluye las materias primas de esta lista."}
      </p>
      <div className="toolbar">
        {ordered.map(([supplierId, group]) => (
          <Link
            key={supplierId || "none"}
            className="button button--small"
            href={purchaseDraftHref(supplierId || undefined, group.items)}
          >
            {group.name ? `Comprar a ${group.name}` : "Comprar (sin proveedor preferido)"} (
            {group.items.length})
          </Link>
        ))}
      </div>
    </section>
  );
}
