"use client";

import type { CurrentUser } from "@bakery/shared";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { visibleNavigation } from "@/lib/navigation";
import { UserProvider } from "./user-context";

export function AppShell({ user, children }: { user: CurrentUser; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // El menú móvil queda abierto solo para la ruta en la que se abrió: al navegar se cierra.
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null);
  // Al cambiar de ruta se olvida dónde se abrió: volver a esa ruta no lo reabre.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMenuOpenAt(null);
  }
  const menuOpen = menuOpenAt === pathname;
  const setMenuOpen = (open: boolean) => setMenuOpenAt(open ? pathname : null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

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

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div className={`shell ${menuOpen ? "shell--menu-open" : ""}`}>
      <aside className="sidebar" aria-label="Menú principal">
        <div className="sidebar__brand">Panificadora ERP</div>
        <nav>
          <Link className={`nav__link ${isActive("/") ? "nav__link--active" : ""}`} href="/">
            Inicio
          </Link>
          {visibleNavigation(user.permissions).map((group) => (
            <div className="nav__group" key={group.label}>
              <div className="nav__group-label">{group.label}</div>
              {group.items.map((item) => {
                const href = `/${item.slug}`;
                return (
                  <Link
                    key={item.slug}
                    href={href}
                    className={`nav__link ${isActive(href) ? "nav__link--active" : ""}`}
                    aria-current={isActive(href) ? "page" : undefined}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      <div className="shell__backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />

      <div className="shell__main">
        <header className="topbar">
          <button
            type="button"
            className="topbar__menu button"
            aria-label="Abrir menú"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            ☰
          </button>
          <div className="topbar__company">{user.company.tradeName}</div>
          <div className="topbar__user" data-testid="current-user">
            <div className="topbar__user-name">{user.displayName}</div>
            <div className="topbar__user-roles">{user.roles.map((r) => r.name).join(", ")}</div>
          </div>
          <button type="button" className="button" onClick={logout} disabled={loggingOut}>
            Salir
          </button>
        </header>
        {logoutError && (
          <p className="form__error content__alert" role="alert">
            {logoutError}
          </p>
        )}
        <main className="content">
          <UserProvider user={user}>{children}</UserProvider>
        </main>
      </div>
    </div>
  );
}
