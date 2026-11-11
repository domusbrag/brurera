"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./icons";

/*
 * Selector con búsqueda (patrón combobox de ARIA 1.2) para listas que pueden
 * crecer: productos, clientes, proveedores, materias primas, recetas. Se escribe
 * parte del nombre o del código y se elige con flechas + Enter o con el mouse.
 * Reemplaza a los <select> gigantes; las listas cortas y fijas (unidad, medio de
 * pago, motivo) siguen siendo <select>.
 */

export interface ComboOption {
  value: string;
  label: string;
  /** Texto secundario a la derecha (precio, código, stock). */
  detail?: string;
  /** Palabras extra para buscar (código, CUIT…). */
  keywords?: string;
}

const normalize = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Todas las palabras escritas deben aparecer en el rótulo o las palabras clave. */
export function matchOption(option: ComboOption, query: string): boolean {
  const haystack = normalize(`${option.label} ${option.keywords ?? ""} ${option.detail ?? ""}`);
  return normalize(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

const MAX_VISIBLE = 50;

export function Combobox({
  id,
  options,
  value,
  onChange,
  placeholder = "Buscar…",
  ariaLabel,
  invalid,
  disabled,
  describedBy,
  required,
  emptyText = "Sin coincidencias",
  autoFocus,
}: {
  id?: string;
  options: ComboOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Sin <label htmlFor> visible, el nombre accesible. */
  ariaLabel?: string;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
  required?: boolean;
  emptyText?: string;
  autoFocus?: boolean;
}) {
  const autoId = useId();
  const inputId = id ?? `combo-${autoId}`;
  const listId = `${inputId}-list`;
  const selected = options.find((o) => o.value === value) ?? null;
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    const q = query?.trim() ?? "";
    const all = q ? options.filter((o) => matchOption(o, q)) : options;
    return all.slice(0, MAX_VISIBLE);
  }, [options, query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(option: ComboOption | undefined) {
    if (!option) return;
    onChange(option.value);
    setQuery(null);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (open && results.length > 0) {
        e.preventDefault();
        choose(results[active]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setQuery(null);
      }
    } else if (e.key === "Tab" && open && query && results.length > 0) {
      // Tab con texto escrito elige la coincidencia resaltada (carga rápida por teclado).
      choose(results[active]);
    }
  }

  const shown = query ?? selected?.label ?? "";
  const activeId = open && results[active] ? `${listId}-${active}` : undefined;

  return (
    <div className="combobox">
      <input
        id={inputId}
        className="combobox__input control"
        type="text"
        role="combobox"
        autoComplete="off"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy}
        placeholder={placeholder}
        value={shown}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={(e) => e.target.select()}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setQuery(null);
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="combobox__toggle"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        onMouseDown={(e) => {
          e.preventDefault();
          (e.currentTarget.previousElementSibling as HTMLInputElement | null)?.focus();
          setOpen((o) => !o);
        }}
      >
        <Icon name="chevron-down" size="sm" />
      </button>
      {open && (
        <ul className="combobox__list" id={listId} role="listbox" ref={listRef}>
          {results.length === 0 ? (
            <li className="combobox__empty" role="presentation">
              {emptyText}
            </li>
          ) : (
            results.map((o, i) => (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.value === value}
                className={`combobox__option ${i === active ? "combobox__option--active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span>{o.label}</span>
                {o.detail && <span className="combobox__option-detail">{o.detail}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
