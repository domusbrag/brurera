"use client";

import { PERMISSIONS as P, type CurrentUser } from "@bakery/shared";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { HOME_ITEM, activeNavHref, visibleNavigation } from "@/lib/navigation";
import { FlashProvider } from "./ui/flash";
import { Icon } from "./ui/icons";
import { UserProvider } from "./user-context";

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
          {groups.map((group) => (
            <div className="nav__group" key={group.label}>
              <div className="nav__group-label" aria-hidden="true">
                {group.label}
              </div>
              {group.items.map((item) => navLink(item.href, item.label, item.icon))}
            </div>
          ))}
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
            <FlashProvider>{children}</FlashProvider>
          </UserProvider>
        </main>
      </div>
    </div>
  );
}
