"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Icon } from "./icons";

/*
 * Confirmación de operaciones importantes (pedido confirmado, venta registrada,
 * cobro registrado, producción completada). Un único aviso a la vez, arriba del
 * contenido, que sobrevive a la navegación hacia la página de destino y se va
 * al salir de ella. No se usa para cada interacción menor.
 */

interface Flash {
  message: string;
  /** Ruta en la que ya se mostró (null: todavía no se mostró). */
  shownAt: string | null;
}

type ShowFlash = (message: string, options?: { afterNavigation?: boolean }) => void;

const FlashContext = createContext<ShowFlash>(() => undefined);

export function FlashProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [flash, setFlash] = useState<Flash | null>(null);
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (flash?.shownAt && flash.shownAt !== pathname) setFlash(null);
    else if (flash && !flash.shownAt) setFlash({ ...flash, shownAt: pathname });
  }
  const show = useCallback<ShowFlash>(
    (message, options) =>
      setFlash({ message, shownAt: options?.afterNavigation ? null : pathname }),
    [pathname],
  );
  return (
    <FlashContext.Provider value={show}>
      <div role="status" aria-live="polite" className="flash-region">
        {flash && (
          <div className="flash" data-testid="flash">
            <Icon name="check" />
            <span>{flash.message}</span>
            <button
              type="button"
              className="icon-button flash__close"
              aria-label="Cerrar aviso"
              onClick={() => setFlash(null)}
            >
              <Icon name="close" size="sm" />
            </button>
          </div>
        )}
      </div>
      {children}
    </FlashContext.Provider>
  );
}

/**
 * Muestra una confirmación en la página actual o, con `afterNavigation`, en la
 * página a la que se navega a continuación.
 */
export function useFlash() {
  return useContext(FlashContext);
}
