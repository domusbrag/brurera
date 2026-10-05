import type { ReactNode } from "react";
import type { Tone } from "@/lib/status";

/**
 * Indicador de estado único de la aplicación. El color sigue la semántica de
 * `lib/status.ts`; el texto siempre acompaña al color (nunca sólo color).
 * `tone="tag"` es para atributos que no son estados (conservación, origen).
 */
export function StatusBadge({
  tone,
  children,
  title,
}: {
  tone: Tone | "tag";
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {children}
    </span>
  );
}
