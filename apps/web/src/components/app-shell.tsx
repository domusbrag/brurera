"use client";

import { PERMISSIONS as P, type CurrentUser } from "@bakery/shared";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HOME_ITEM, activeNavHref, canOpenRoute, visibleNavigation } from "@/lib/navigation";
import { CommandPalette, usePaletteShortcut } from "./ui/command-palette";
import { FlashProvider } from "./ui/flash";
import { Icon } from "./ui/icons";
import { UserProvider } from "./user-context";

type Theme = "dark" | "light";

/** Tema del navegador: oscuro por defecto, claro a elección (se recuerda en este equipo). */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    // El script del layout ya aplicó el tema guardado antes de pintar; acá sólo se sincroniza el botón.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (document.documentElement.dataset.theme === "light") setTheme("light");
  }, []);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      aria-label={next === "light" ? "Usar tema claro" : "Usar tema oscuro"}
      title={next === "light" ? "Tema claro" : "Tema oscuro"}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("tema", next);
        } catch {
          /* sin almacenamiento: vale sólo para esta pestaña */
        }
        setTheme(next);
      }}
    >
      <Icon name={next === "light" ? "sun" : "moon"} />
    </button>
  );
}

const COLLAPSED_KEY = "menu-grupos-plegados";

/** Grupos del menú que la persona plegó (se recuerdan en este equipo). */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Array.isArray(saved)) setCollapsed(saved.filter((g) => typeof g === "string"));
    } catch {
      /* sin almacenamiento o dato roto: todo desplegado */
    }
  }, []);
  const toggle = (group: string) =>
    setCollapsed((prev) => {
      const next = prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        /* vale sólo para esta pestaña */
      }
      return next;
    });
  return { collapsed, toggle };
}

/**
 * Cáscara de la aplicación: menú lateral estable en escritorio, panel
 * desplegable en tablet, barra superior con la empresa, accesos rápidos según
 * permisos y el usuario. Un solo patrón para todos los módulos.
 */
export function AppShell({ user, children }: { user: CurrentUser; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // El menú desplegable queda abierto sólo para la ruta en la que se abrió: al navegar se cierra.
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null);
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMenuOpenAt(null);
  }
  const menuOpen = menuOpenAt === pathname;
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => {
    setMenuOpenAt(null);
    setPaletteOpen(true);
  }, []);
  usePaletteShortcut(openPalette);
  const { collapsed, toggle: toggleGroup } = useCollapsedGroups();
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const setMenuOpen = (open: boolean) => {
    setMenuOpenAt(open ? pathname : null);
    if (!open) menuButtonRef.current?.focus();
  };

  // Panel desplegable: Escape lo cierra y el foco entra al menú al abrirlo.
  useEffect(() => {
    if (!menuOpen) return;
    sidebarRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpenAt(null);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  async function logout() {
    setLoggingOut(true);
    setLogoutError(null);
    const res = await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    if (!res?.ok) {
      setLoggingOut(false);
      setLogoutError("No se pudo cerrar la sesión. Reintentá.");
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  const groups = visibleNavigation(user.permissions);
  const active = activeNavHref(pathname, [HOME_ITEM, ...groups.flatMap((g) => g.items)]);
  const granted = new Set(user.permissions);
  const canSell = granted.has(P.SALES_CREATE);
  const canOrder = granted.has(P.ORDERS_CREATE);
  const canSeeOrders = granted.has(P.ORDERS_READ);
  const activeGroup = groups.find((g) => g.items.some((i) => i.href === active))?.label;

  // El ítem actual siempre a la vista: con el menú largo, «Compras» quedaba debajo del borde.
  // Se mueve sólo el scroll del menú (sin scrollIntoView), y sólo si el ítem está fuera de vista.
  useEffect(() => {
    const sidebar = sidebarRef.current;
    const link = sidebar?.querySelector<HTMLElement>(".nav__link--active");
    if (!sidebar || !link) return;
    const box = sidebar.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    if (item.bottom > box.bottom) sidebar.scrollTop += item.bottom - box.bottom + 24;
    else if (item.top < box.top) sidebar.scrollTop -= box.top - item.top + 24;
  }, [active, collapsed]);

  const navLink = (href: string, label: string, icon: Parameters<typeof Icon>[0]["name"]) => (
    <Link
      key={href}
      href={href}
      className={`nav__link ${active === href ? "nav__link--active" : ""}`}
      aria-current={active === href ? "page" : undefined}
    >
      <Icon name={icon} />
      {label}
    </Link>
  );

  return (
    <div className={`shell ${menuOpen ? "shell--menu-open" : ""}`}>
      <a className="skip-link" href="#contenido">
        Saltar al contenido
      </a>
      <aside className="sidebar" ref={sidebarRef} aria-label="Menú">
        <div className="sidebar__brand">
          <span className="sidebar__brand-mark" aria-hidden="true">
            {user.company.tradeName.trim().charAt(0).toUpperCase() || "P"}
          </span>
          <div className="sidebar__brand-text">
            <span className="sidebar__company">{user.company.tradeName}</span>
            <span className="sidebar__product">Panificadora ERP</span>
          </div>
          <button
            type="button"
            className="icon-button sidebar__close"
            aria-label="Cerrar menú"
            onClick={() => setMenuOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <nav aria-label="Menú principal">
          {navLink(HOME_ITEM.href, HOME_ITEM.label, HOME_ITEM.icon)}
          {groups.map((group) => {
            // El grupo de la pantalla actual no se puede plegar: siempre se ve dónde se está.
            const isActiveGroup = group.label === activeGroup;
            const expanded = isActiveGroup || !collapsed.includes(group.label);
            const listId = `menu-${group.label.toLowerCase().replace(/\W+/g, "-")}`;
            return (
              <div className="nav__group" key={group.label}>
                <button
                  type="button"
                  className="nav__group-toggle"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  disabled={isActiveGroup}
                  title={isActiveGroup ? "Estás en esta sección" : undefined}
                  onClick={() => toggleGroup(group.label)}
                >
                  <span>{group.label}</span>
                  <Icon name="chevron-down" size="sm" />
                </button>
                <div id={listId} hidden={!expanded}>
                  {group.items.map((item) => navLink(item.href, item.label, item.icon))}
                </div>
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="shell__backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />

      <div className="shell__main">
        <header className="topbar">
          <button
            type="button"
            ref={menuButtonRef}
            className="topbar__menu icon-button"
            aria-label="Abrir menú"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <Icon name="menu" />
          </button>
          <div className="topbar__company">{user.company.tradeName}</div>
          <button
            type="button"
            className="topbar__search"
            onClick={openPalette}
            aria-keyshortcuts="Control+K"
            aria-label="Buscar (Ctrl+K)"
          >
            <Icon name="search" size="sm" />
            <span className="topbar__search-text">Buscar…</span>
            <kbd className="topbar__search-kbd">Ctrl K</kbd>
          </button>
          {(canSell || canOrder) && (
            <div className="topbar__quick" aria-label="Accesos rápidos" role="group">
              {canOrder && (
                <Link className="button button--small" href="/pedidos/nuevo">
                  <Icon name="plus" size="sm" />
                  Tomar pedido
                </Link>
              )}
              {canSell && (
                <Link className="button button--small button--primary" href="/ventas/nueva">
                  <Icon name="cash" size="sm" />
                  Vender
                </Link>
              )}
            </div>
          )}
          <ThemeToggle />
          <div className="topbar__user" data-testid="current-user">
            <div className="topbar__user-text">
              <div className="topbar__user-name">{user.displayName}</div>
              <div className="topbar__user-roles">{user.roles.map((r) => r.name).join(", ")}</div>
            </div>
            <button
              type="button"
              className="button button--small button--tertiary"
              onClick={logout}
              disabled={loggingOut}
            >
              <Icon name="logout" size="sm" />
              Salir
            </button>
          </div>
        </header>
        {logoutError && (
          <p className="form__error content__alert" role="alert">
            {logoutError}
          </p>
        )}
        <main className="content" id="contenido" tabIndex={-1}>
          <UserProvider user={user}>
            <FlashProvider>
              {canOpenRoute(pathname, user.permissions) ? (
                children
              ) : (
                <div className="page">
                  <section className="panel panel--empty" role="alert">
                    <p className="upcoming">No tenés acceso a esta sección</p>
                    <p className="muted">
                      Tu rol no incluye este módulo. Si lo necesitás, pedile a un administrador que
                      te asigne el permiso.
                    </p>
                    <div className="alert__actions" style={{ justifyContent: "center" }}>
                      <Link className="button" href="/">
                        Ir al inicio
                      </Link>
                    </div>
                  </section>
                </div>
              )}
            </FlashProvider>
          </UserProvider>
        </main>
      </div>

      {/* Celular: lo de todos los días al alcance del pulgar. */}
      <nav className="bottom-bar" aria-label="Accesos del celular">
        <Link
          href="/"
          className="bottom-bar__item"
          aria-current={active === "/" ? "page" : undefined}
        >
          <Icon name="home" />
          <span>Inicio</span>
        </Link>
        {canSeeOrders && (
          <Link
            href="/pedidos"
            className="bottom-bar__item"
            aria-current={active === "/pedidos" ? "page" : undefined}
          >
            <Icon name="clipboard" />
            <span>Pedidos</span>
          </Link>
        )}
        {canSell && (
          <Link href="/ventas/nueva" className="bottom-bar__item bottom-bar__item--primary">
            <Icon name="cash" />
            <span>Vender</span>
          </Link>
        )}
        <button type="button" className="bottom-bar__item" onClick={openPalette}>
          <Icon name="search" />
          <span>Buscar</span>
        </button>
        <button
          type="button"
          className="bottom-bar__item"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <Icon name="menu" />
          <span>Menú</span>
        </button>
      </nav>

      <CommandPalette user={user} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
