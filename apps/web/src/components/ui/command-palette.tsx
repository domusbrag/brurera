"use client";

import { PERMISSIONS as P, type CurrentUser, type Page } from "@bakery/shared";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { apiFetch, listPath } from "@/lib/api-client";
import {
  CONFIG_SECTIONS,
  HOME_ITEM,
  MORE_CREATE_ACTIONS,
  QUICK_ACTIONS,
  allowedActions,
  visibleNavigation,
} from "@/lib/navigation";
import { Icon, type IconName } from "./icons";

/*
 * Buscador global (Ctrl+K o «/»): un solo lugar para ir a cualquier pantalla,
 * empezar una tarea («Nueva venta», «Nuevo cliente»…) o abrir un registro
 * (cliente, producto, pedido, venta, compra…) sin pasar por el menú.
 *
 * Sólo ofrece lo que el rol puede abrir: las pantallas salen del mismo menú
 * filtrado por permisos y cada fuente de registros declara su permiso de
 * lectura. La API vuelve a autorizar cada consulta.
 */

export interface PaletteEntry {
  id: string;
  group: "Acciones" | "Ir a" | "Registros";
  label: string;
  detail?: string;
  href: string;
  icon: IconName;
  /** Palabras extra para encontrarlo (sinónimos). */
  keywords?: string;
}

/** Minúsculas y sin tildes: «produccion» encuentra «Producción». */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Todas las palabras de la búsqueda tienen que aparecer (en cualquier orden). */
export function matches(entry: PaletteEntry, query: string): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalize(`${entry.label} ${entry.detail ?? ""} ${entry.keywords ?? ""}`);
  return words.every((w) => haystack.includes(w));
}

/** Sinónimos de uso diario para las pantallas del menú. */
const NAV_KEYWORDS: Record<string, string> = {
  "/pedidos": "encargos",
  "/ventas": "mostrador facturas tickets",
  "/cuentas-a-cobrar": "cobros deudas saldos cuenta corriente",
  "/listas-de-precios": "precios",
  "/necesidades": "necesidades faltantes riesgo",
  "/produccion": "hornear elaborar lotes",
  "/stock": "inventario insumos",
  "/stock/productos": "inventario stock",
  "/stock/productos/por-vencer": "vencimientos lotes",
  "/stock/movimientos": "kardex historial stock",
  "/compras": "ordenes de compra",
  "/auditoria": "historial cambios",
};

/** Pantallas y acciones que el usuario puede usar, según sus permisos. */
export function staticEntries(permissions: readonly string[]): PaletteEntry[] {
  const granted = new Set(permissions);
  const actions = allowedActions([...QUICK_ACTIONS, ...MORE_CREATE_ACTIONS], permissions).map(
    (a): PaletteEntry => ({
      id: `action:${a.href}:${a.label}`,
      group: "Acciones",
      label: a.label,
      detail: a.hint,
      href: a.href,
      icon: a.icon,
      keywords: "nuevo nueva crear alta agregar",
    }),
  );
  const screens: PaletteEntry[] = [
    HOME_ITEM,
    ...visibleNavigation(permissions).flatMap((g) =>
      g.items.map((i) => ({ ...i, group: g.label })),
    ),
  ].map((item) => ({
    id: `nav:${item.href}`,
    group: "Ir a",
    label: item.label,
    detail: "group" in item ? String(item.group) : undefined,
    href: item.href,
    icon: item.icon,
    keywords: NAV_KEYWORDS[item.href],
  }));
  const config: PaletteEntry[] = CONFIG_SECTIONS.filter((s) => granted.has(s.permission)).map(
    (s) => ({
      id: `config:${s.slug}`,
      group: "Ir a",
      label: s.label,
      detail: "Configuración",
      href: `/configuracion/${s.slug}`,
      icon: "settings",
      keywords: s.description,
    }),
  );
  return [...actions, ...screens, ...config];
}

interface Source {
  permission: string;
  endpoint: string;
  params?: Record<string, string>;
  icon: IconName;
  kind: string;
  toEntry: (item: Record<string, unknown>) => { label: string; detail?: string; href: string };
}

type Ref = { name?: string; code?: string } | null;
const refName = (value: unknown) => (value as Ref)?.name ?? "";

/** Fuentes de registros: listados de la API que ya aceptan `search`. */
const SOURCES: Source[] = [
  {
    permission: P.CUSTOMERS_READ,
    endpoint: "/api/customers",
    icon: "users",
    kind: "Cliente",
    toEntry: (c) => ({
      label: String(c.tradeName || c.legalName),
      detail: String(c.code),
      href: `/clientes/${String(c.id)}`,
    }),
  },
  {
    permission: P.PRODUCTS_READ,
    endpoint: "/api/products",
    icon: "package",
    kind: "Producto",
    toEntry: (p) => ({
      label: String(p.name),
      detail: String(p.code),
      href: `/productos/${String(p.id)}`,
    }),
  },
  {
    permission: P.ORDERS_READ,
    endpoint: "/api/orders",
    params: { status: "all" },
    icon: "clipboard",
    kind: "Pedido",
    toEntry: (o) => ({
      label: `${String(o.code)} · ${refName(o.customer)}`,
      href: `/pedidos/${String(o.id)}`,
    }),
  },
  {
    permission: P.SALES_READ,
    endpoint: "/api/sales",
    icon: "cart",
    kind: "Venta",
    toEntry: (s) => ({
      label: `${String(s.code)} · ${refName(s.customer)}`,
      href: `/ventas/${String(s.id)}`,
    }),
  },
  {
    permission: P.RAW_MATERIALS_READ,
    endpoint: "/api/raw-materials",
    icon: "wheat",
    kind: "Materia prima",
    toEntry: (m) => ({
      label: String(m.name),
      detail: String(m.code),
      href: `/materias-primas/${String(m.id)}`,
    }),
  },
  {
    permission: P.RECIPES_READ,
    endpoint: "/api/recipes",
    icon: "book",
    kind: "Receta",
    toEntry: (r) => ({ label: String(r.name), href: `/recetas/${String(r.id)}` }),
  },
  {
    permission: P.PRODUCTION_ORDERS_READ,
    endpoint: "/api/production-orders",
    icon: "factory",
    kind: "Orden de producción",
    toEntry: (o) => ({
      label: `${String(o.code)} · ${refName(o.product)}`,
      href: `/produccion/${String(o.id)}`,
    }),
  },
  {
    permission: P.PURCHASES_READ,
    endpoint: "/api/purchases",
    icon: "truck",
    kind: "Compra",
    toEntry: (c) => ({
      label: `${String(c.number)} · ${refName(c.supplier)}`,
      href: `/compras/${String(c.id)}`,
    }),
  },
  {
    permission: P.SUPPLIERS_READ,
    endpoint: "/api/suppliers",
    icon: "building",
    kind: "Proveedor",
    toEntry: (s) => ({
      label: String(s.tradeName || s.legalName),
      detail: String(s.code),
      href: `/proveedores/${String(s.id)}`,
    }),
  },
];

const PER_SOURCE = 3;
const MIN_REMOTE_QUERY = 2;

/** Busca registros en todas las fuentes permitidas, en paralelo. */
function useRecordSearch(query: string, permissions: readonly string[]) {
  const [state, setState] = useState<{
    query: string;
    entries: PaletteEntry[];
    loading: boolean;
  }>({ query: "", entries: [], loading: false });
  const term = query.trim();
  const permissionKey = permissions.join(",");

  useEffect(() => {
    if (term.length < MIN_REMOTE_QUERY) return;
    const granted = new Set(permissionKey.split(","));
    const sources = SOURCES.filter((s) => granted.has(s.permission));
    let cancelled = false;
    const timer = setTimeout(() => {
      setState({ query: term, entries: [], loading: true });
      void Promise.all(
        sources.map((source) =>
          apiFetch<Page<Record<string, unknown>>>(
            listPath(source.endpoint, {
              ...source.params,
              search: term,
              pageSize: PER_SOURCE,
            }),
          )
            .then((page) =>
              page.items.map((item): PaletteEntry => {
                const e = source.toEntry(item);
                return {
                  id: `record:${e.href}`,
                  group: "Registros",
                  label: e.label,
                  detail: e.detail ? `${source.kind} · ${e.detail}` : source.kind,
                  href: e.href,
                  icon: source.icon,
                };
              }),
            )
            // Una fuente que falla no tapa a las demás.
            .catch(() => [] as PaletteEntry[]),
        ),
      ).then((lists) => {
        if (!cancelled) setState({ query: term, entries: lists.flat(), loading: false });
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, permissionKey]);

  if (term.length < MIN_REMOTE_QUERY) return { entries: [], loading: false };
  // Mientras llega la respuesta de esta búsqueda no se muestran resultados de la anterior.
  if (state.query !== term) return { entries: [], loading: true };
  return { entries: state.entries, loading: state.loading };
}

const GROUP_ORDER: PaletteEntry["group"][] = ["Acciones", "Ir a", "Registros"];

export function CommandPalette({
  user,
  open,
  onClose,
}: {
  user: CurrentUser;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const titleId = useId();

  const all = useMemo(() => staticEntries(user.permissions), [user.permissions]);
  const remote = useRecordSearch(open ? query : "", user.permissions);

  const results = useMemo(() => {
    const local = all.filter((e) => matches(e, query));
    // Sin texto: primero las acciones y después las pantallas, como un índice.
    return [...local, ...remote.entries].sort(
      (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
    );
  }, [all, query, remote.entries]);

  const active = Math.min(activeIndex, Math.max(0, results.length - 1));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const close = () => {
    setQuery("");
    setActiveIndex(0);
    onClose();
  };

  const go = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    close();
    router.push(entry.href);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(results.length ? (active + 1) % results.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(results.length ? (active - 1 + results.length) % results.length : 0);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(Math.max(0, results.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[active]);
    }
  };

  const optionId = (i: number) => `${listId}-op-${i}`;

  return (
    <dialog
      ref={dialogRef}
      className="palette"
      aria-labelledby={titleId}
      onClose={close}
      onClick={(e) => {
        // Clic fuera del recuadro (en el fondo) cierra.
        if (e.target === dialogRef.current) close();
      }}
    >
      <h2 id={titleId} className="sr-only">
        Buscar en el sistema
      </h2>
      <div className="palette__search">
        <Icon name="search" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Buscar pantallas, acciones o registros"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results.length ? optionId(active) : undefined}
          placeholder="Buscar pantallas, acciones, clientes, productos, pedidos…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className="palette__esc">Esc</kbd>
      </div>
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        className="palette__list"
        aria-label="Resultados"
      >
        {results.map((entry, i) => {
          const header = i === 0 || results[i - 1]!.group !== entry.group ? entry.group : null;
          return (
            <li key={entry.id} role="presentation">
              {header && (
                <div className="palette__group" role="presentation">
                  {header}
                </div>
              )}
              <div
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                data-index={i}
                className={`palette__option ${i === active ? "palette__option--active" : ""}`}
                onMouseMove={() => i !== active && setActiveIndex(i)}
                onClick={() => go(entry)}
              >
                <span className="palette__icon" aria-hidden="true">
                  <Icon name={entry.icon} size="sm" />
                </span>
                <span className="palette__label">{entry.label}</span>
                {entry.detail && <span className="palette__detail">{entry.detail}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="palette__status" role="status" aria-live="polite">
        {remote.loading
          ? "Buscando registros…"
          : results.length === 0
            ? query.trim()
              ? `Sin resultados para “${query.trim()}”.`
              : "No hay nada para mostrar."
            : query.trim().length > 0 && query.trim().length < MIN_REMOTE_QUERY
              ? "Escribí al menos 2 letras para buscar también clientes, productos, pedidos…"
              : `${results.length} resultado${results.length === 1 ? "" : "s"} · ↑↓ para elegir, Enter para abrir`}
      </p>
    </dialog>
  );
}

/** Ctrl+K / ⌘K desde cualquier lugar; «/» cuando no se está escribiendo en un campo. */
export function usePaletteShortcut(onOpen: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpen();
        return;
      }
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "") ||
        target?.closest("dialog[open]");
      if (typing) return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
}
