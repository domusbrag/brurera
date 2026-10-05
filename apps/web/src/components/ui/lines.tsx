"use client";

import type { ReactNode } from "react";
import { Icon } from "./icons";

/*
 * Editor de líneas único (venta, pedido, compra, lista de precios): una línea
 * por producto con campos rotulados. En escritorio es una fila con encabezado;
 * en tablet (≤1024 px) cada línea pasa a dos filas: el producto ocupa todo el
 * ancho y debajo van cantidad, precio, descuento e importe, cada uno con su
 * rótulo. Así el selector de producto nunca queda comprimido (deuda F5B).
 */

export type LinesVariant = "full" | "no-discount" | "no-price";

export function LineList({
  label,
  head,
  variant = "full",
  children,
}: {
  /** Nombre accesible del grupo de líneas. */
  label: string;
  /** Encabezados de columna (escritorio). El último (quitar) se agrega solo. */
  head: string[];
  variant?: LinesVariant;
  children: ReactNode;
}) {
  return (
    <div
      className={`lines ${variant === "full" ? "" : `lines--${variant}`}`}
      role="group"
      aria-label={label}
    >
      <div className="lines__head" aria-hidden="true">
        {head.map((h, i) => (
          <span key={h} className={i > 0 && /importe|subtotal/i.test(h) ? "num" : undefined}>
            {h}
          </span>
        ))}
        <span />
      </div>
      {children}
    </div>
  );
}

export function LineRow({
  children,
  meta,
  onRemove,
  removeLabel,
  canRemove = true,
  testId,
}: {
  children: ReactNode;
  /** Información o campos secundarios a lo ancho, debajo de la línea. */
  meta?: ReactNode;
  onRemove?: () => void;
  removeLabel: string;
  canRemove?: boolean;
  testId?: string;
}) {
  return (
    <div className="line" data-testid={testId}>
      {children}
      {onRemove ? (
        <button
          type="button"
          className="icon-button line__remove"
          aria-label={removeLabel}
          title={canRemove ? removeLabel : "Tiene que quedar al menos una línea"}
          disabled={!canRemove}
          onClick={onRemove}
        >
          <Icon name="trash" />
        </button>
      ) : (
        <span />
      )}
      {meta && <div className="line__meta">{meta}</div>}
    </div>
  );
}

/** Campo de una línea: el rótulo es visible en tablet y accesible siempre. */
export function LineField({
  label,
  htmlFor,
  product,
  amount,
  children,
}: {
  label: string;
  htmlFor?: string;
  /** Campo de producto: ocupa todo el ancho en tablet. */
  product?: boolean;
  /** Importe calculado (texto alineado a la derecha). */
  amount?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`line__field ${product ? "line__field--product" : ""} ${amount ? "line__amount" : ""}`}
    >
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <label aria-hidden="true">{label}</label>}
      {children}
    </div>
  );
}
