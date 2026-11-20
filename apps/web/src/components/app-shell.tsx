"use client";

import { PERMISSIONS as P, type CurrentUser } from "@bakery/shared";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  HOME_ITEM,
  activeNavHref,
  canOpenRoute,
  visibleNavigation,
  type NavGroup,
} from "@/lib/navigation";
import { Brand } from "./shell/brand";
import {
  DayTotalsBar,
  StockAlertsBlock,
  TodayOrdersBlock,
  companyToday,
  useDayTotals,
  useTodayOrders,
} from "./shell/day-panel";
import { CommandPalette, usePaletteShortcut } from "./ui/command-palette";
import { FlashProvider } from "./ui/flash";
import { Icon } from "./ui/icons";
import { UserProvider } from "./user-context";

type Theme = "dark" | "light";

/** Tema del navegador: oscuro por defecto, claro a elección (se recuerda en este equipo). */
function ThemeToggle({ className = "" }: { className?: string }) {
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
      className={`inline-flex size-9 shrink-0 cursor-pointer border-0 bg-transparent items-center justify-center rounded-lg text-current hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-primary ${className}`}
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

/** ¿La ventana es de escritorio (≥ 1024 px)? Falso hasta montar, igual que en el servidor. */
function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 64rem)");
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return desktop;
}

/** Id estable de un grupo del menú, para enlazar la pestaña con su lista. */
function groupId(label: string): string {
  return `menu-${label.toLowerCase().replace(/\W+/g, "-")}`;
}

const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/**
 * Pestañas de escritorio (diseño La Espiga): Inicio y una por área. Cada área
 * despliega sus pantallas; la del área actual queda subrayada en naranja.
 */
function TopTabs({
  groups,
  active,
  activeGroup,
}: {
  groups: NavGroup[];
  active: string | null;
  activeGroup: string | undefined;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const pathname = usePathname();
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(null);
  }

  // Un clic afuera o Escape cierra la lista abierta (Escape devuelve el foco a su pestaña).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      navRef.current?.querySelector<HTMLElement>(`[aria-controls="${groupId(open)}"]`)?.focus();
      setOpen(null);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tab = (isActive: boolean) =>
    `relative inline-flex cursor-pointer items-center gap-1 whitespace-nowrap py-1.5 text-sm transition-colors hover:no-underline ${FOCUS} ${
      isActive
        ? "font-semibold text-fg after:absolute after:inset-x-0 after:-bottom-[17px] after:h-0.5 after:rounded-full after:bg-ember"
        : "font-medium text-muted hover:text-fg"
    }`;

  return (
    <nav
      className="hidden min-w-0 items-center gap-5 lg:flex 2xl:gap-7"
      aria-label="Menú principal"
      ref={navRef}
    >
      <Link
        href={HOME_ITEM.href}
        className={tab(active === "/")}
        aria-current={active === "/" ? "page" : undefined}
      >
        {HOME_ITEM.label}
      </Link>
      {groups.map((group) => {
        const id = groupId(group.label);
        const isOpen = open === group.label;
        return (
          <div className="relative" key={group.label}>
            <button
              type="button"
              className={`${tab(group.label === activeGroup)} border-0 bg-transparent font-[inherit]`}
              aria-expanded={isOpen}
              aria-controls={id}
              onClick={() => setOpen(isOpen ? null : group.label)}
            >
              {group.label}
              <span className={`transition-transform ${isOpen ? "rotate-180" : ""}`}>
                <Icon name="chevron-down" size="sm" />
              </span>
            </button>
            <div
              id={id}
              hidden={!isOpen}
              className="animate-fade-up absolute top-full left-0 z-30 mt-4 min-w-60 rounded-xl border border-line bg-surface p-1.5 shadow-float"
            >
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active === item.href ? "page" : undefined}
                  onClick={() => setOpen(null)}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap hover:no-underline ${FOCUS} ${
                    active === item.href
                      ? "bg-primary-soft font-semibold text-primary"
                      : "text-fg hover:bg-surface-hover"
                  }`}
                >
                  <span className={active === item.href ? "" : "text-subtle"}>
                    <Icon name={item.icon} />
                  </span>
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  );
}

/**
 * Cáscara de la aplicación (diseño La Espiga, 2026-11; Tailwind).
 *
 * Escritorio: panel de papel kraft fijo a la izquierda con la marca, la cuenta,
 * lo de hoy (pedidos por estado y alertas de stock) y las acciones del día;
 * arriba, las pestañas por área sobre la pizarra; abajo, los resultados del día.
 * Tablet y celular: el panel kraft es un cajón que además trae el menú completo.
 * Todo depende de los permisos del usuario.
 */
export function AppShell({ user, children }: { user: CurrentUser; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isDesktop = useIsDesktop();
  // El cajón queda abierto sólo para la ruta en la que se abrió: al navegar se cierra.
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
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const setMenuOpen = (open: boolean) => {
    setMenuOpenAt(open ? pathname : null);
    if (!open) menuButtonRef.current?.focus();
  };
  const closeMenu = () => setMenuOpenAt(null);

  // Cajón: Escape lo cierra y el foco entra al panel al abrirlo.
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
  const canProduce = granted.has(P.PRODUCTION_ORDERS_CREATE);
  const canSeeOrders = granted.has(P.ORDERS_READ);
  const currentGroup = groups.find((g) => g.items.some((i) => i.href === active));
  const roles = user.roles.map((r) => r.name).join(", ");

  // Lo de hoy: se vuelve a pedir al cambiar de pantalla.
  const [today] = useState(() => companyToday(user.company.timezone));
  const todayOrders = useTodayOrders(canSeeOrders, today, pathname);
  const dayTotals = useDayTotals(
    granted.has(P.SALES_READ),
    granted.has(P.SALES_MARGIN_READ),
    today,
    pathname,
  );

  const logoutButton = (className: string) => (
    <button
      type="button"
      onClick={logout}
      disabled={loggingOut}
      className={`inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent font-[inherit] px-2.5 text-xs font-semibold disabled:opacity-50 ${FOCUS} ${className}`}
    >
      <Icon name="logout" size="sm" />
      Salir
    </button>
  );

  const drawerLink = (href: string, label: string, icon: Parameters<typeof Icon>[0]["name"]) => (
    <Link
      key={href}
      href={href}
      aria-current={active === href ? "page" : undefined}
      className={`flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-[0.9375rem] hover:no-underline ${FOCUS} ${
        active === href
          ? "bg-kraft-ink font-semibold text-kraft"
          : "text-kraft-ink hover:bg-kraft-ink/10"
      }`}
    >
      <Icon name={icon} />
      {label}
    </Link>
  );

  return (
    <div className="min-h-screen">
      <a className="skip-link" href="#contenido">
        Saltar al contenido
      </a>

      {/* ───── Panel de papel kraft ───── */}
      <aside
        ref={sidebarRef}
        aria-label="Panel del día"
        className={`bg-kraft-paper fixed inset-y-0 left-0 z-40 flex w-[min(320px,86vw)] flex-col justify-between gap-5 overflow-y-auto p-5 text-kraft-ink shadow-2xl transition-[translate,visibility] duration-200 lg:visible lg:w-72 lg:translate-x-0 lg:pr-7 lg:kraft-torn-edge ${
          menuOpen ? "visible translate-x-0" : "invisible -translate-x-full"
        }`}
      >
        <div className="space-y-5">
          <button
            type="button"
            aria-label="Cerrar menú"
            onClick={() => setMenuOpen(false)}
            className={`ml-auto flex size-9 cursor-pointer border-0 bg-transparent items-center justify-center rounded-lg text-kraft-ink hover:bg-kraft-ink/10 lg:hidden ${FOCUS}`}
          >
            <Icon name="close" />
          </button>
          <Link
            href="/"
            aria-label={`${user.company.tradeName}: inicio`}
            className={`block border-b border-kraft-ink/20 pb-4 hover:no-underline ${FOCUS}`}
          >
            <Brand company={user.company.tradeName} />
          </Link>

          {/* Cuenta (escritorio; en tablet y celular va en la barra superior). */}
          <div
            className="hidden items-center gap-2.5 lg:flex"
            data-testid={isDesktop ? "current-user" : undefined}
          >
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-kraft-ink font-display text-sm font-bold text-kraft"
              aria-hidden="true"
            >
              {initials(user.displayName)}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-semibold">{user.displayName}</div>
              <div className="truncate text-[11px] text-kraft-ink-muted">{roles}</div>
            </div>
            <ThemeToggle className="text-kraft-ink hover:bg-kraft-ink/10" />
            {logoutButton("text-kraft-ink hover:bg-kraft-ink/10")}
          </div>

          {/* El menú completo vive en el cajón (tablet y celular); en escritorio están las pestañas. */}
          <nav className="lg:hidden" aria-label="Menú principal">
            {drawerLink(HOME_ITEM.href, HOME_ITEM.label, HOME_ITEM.icon)}
            {groups.map((group) => (
              <div key={group.label}>
                <p className="mx-3 mt-4 mb-1 text-[11px] font-bold tracking-[0.18em] text-kraft-ink-muted uppercase">
                  {group.label}
                </p>
                {group.items.map((item) => drawerLink(item.href, item.label, item.icon))}
              </div>
            ))}
          </nav>

          {todayOrders && (
            <TodayOrdersBlock state={todayOrders} today={today} onNavigate={closeMenu} />
          )}
          <StockAlertsBlock
            enabled={granted.has(P.INVENTORY_READ)}
            refresh={pathname}
            onNavigate={closeMenu}
          />
        </div>

        {(canSell || canProduce || canOrder) && (
          <div className="space-y-2.5 pt-2" role="group" aria-label="Acciones del día">
            {/* Vender: en escritorio vive acá; en tablet, arriba; en el celular, abajo. */}
            {canSell && (
              <Link
                href="/ventas/nueva"
                className={`hidden w-full items-center justify-center gap-2 rounded-xl bg-ember px-4 py-3 text-sm font-bold text-kraft-ink shadow-md transition-colors hover:bg-ember-text hover:no-underline lg:flex ${FOCUS}`}
              >
                <Icon name="cash" size="sm" />
                Vender
              </Link>
            )}
            {canProduce && (
              <Link
                href="/produccion/nueva"
                onClick={closeMenu}
                className={`flex w-full items-center justify-center gap-2 rounded-xl border border-kraft-ink bg-chalk px-4 py-3 text-xs font-semibold tracking-wide text-chalk-text uppercase shadow-md transition-colors hover:bg-[#141210] hover:no-underline ${FOCUS}`}
              >
                <span className="text-ember-text">
                  <Icon name="factory" size="sm" />
                </span>
                Mandar a producir
              </Link>
            )}
            {canOrder && (
              <Link
                href="/pedidos/nuevo"
                onClick={closeMenu}
                className={`flex w-full items-center justify-center gap-1.5 rounded-xl border border-kraft-ink/30 bg-kraft-deep/60 px-4 py-2.5 text-xs font-bold text-kraft-ink transition-colors hover:bg-kraft-deep hover:no-underline ${FOCUS}`}
              >
                <Icon name="plus" size="sm" />
                Tomar pedido
              </Link>
            )}
          </div>
        )}
      </aside>
      {menuOpen && (
        <div
          className="fixed inset-0 z-35 bg-black/70 lg:hidden"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ───── Pizarra: pestañas, contenido y resultados del día ───── */}
      <div className="flex min-h-screen min-w-0 flex-col lg:pl-72">
        <header className="sticky top-0 z-20 flex min-h-15 items-center gap-3 border-b border-line bg-bg/90 px-3 backdrop-blur-md sm:px-5 lg:gap-6 lg:px-8">
          <button
            type="button"
            ref={menuButtonRef}
            aria-label="Abrir menú"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
            className={`inline-flex min-h-9 min-w-0 shrink cursor-pointer items-center gap-2 rounded-lg border-0 bg-kraft font-[inherit] px-3 text-xs font-bold text-kraft-ink lg:hidden ${FOCUS}`}
          >
            <Icon name="menu" size="sm" />
            <span className="truncate">{user.company.tradeName}</span>
          </button>

          <TopTabs groups={groups} active={active} activeGroup={currentGroup?.label} />

          <button
            type="button"
            onClick={openPalette}
            aria-keyshortcuts="Control+K"
            aria-label="Buscar (Ctrl+K)"
            title="Buscar (Ctrl+K)"
            className={`ml-auto hidden min-h-9 cursor-pointer items-center gap-2 rounded-full font-[inherit] border border-line-strong bg-surface-sunken px-3 text-sm text-muted transition-colors hover:border-line-input hover:text-fg md:inline-flex lg:min-w-9 lg:px-2.5 2xl:min-w-56 2xl:px-3 ${FOCUS}`}
          >
            <Icon name="search" size="sm" />
            <span className="flex-1 text-left lg:hidden 2xl:inline">Buscar…</span>
            <kbd className="hidden rounded border border-line-strong bg-surface px-1.5 py-px font-sans text-[11px] text-subtle 2xl:inline">
              Ctrl K
            </kbd>
          </button>

          {canSell && (
            <Link
              href="/ventas/nueva"
              className="button button--small button--primary hidden md:inline-flex lg:hidden"
            >
              <Icon name="cash" size="sm" />
              Vender
            </Link>
          )}

          {/* Cuenta en tablet y celular. */}
          <div
            className="ml-auto flex items-center gap-1 border-l border-line pl-2 md:ml-0 lg:hidden"
            data-testid={isDesktop ? undefined : "current-user"}
          >
            <ThemeToggle className="text-fg" />
            <div className="hidden min-w-0 text-right leading-tight sm:block">
              <div className="truncate text-sm font-semibold">{user.displayName}</div>
              <div className="hidden truncate text-[11px] text-muted xl:block">{roles}</div>
            </div>
            {logoutButton("text-muted hover:bg-surface-hover hover:text-fg")}
          </div>
        </header>

        {/* Las pantallas del área actual, a un clic (las píldoras del diseño). */}
        {currentGroup && currentGroup.items.length > 1 && (
          <nav
            aria-label="Pantallas de esta área"
            className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 pt-4 sm:px-5 lg:px-8"
          >
            {currentGroup.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active === item.href ? "page" : undefined}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs whitespace-nowrap transition-colors hover:no-underline ${FOCUS} ${
                  active === item.href
                    ? "bg-kraft font-bold text-kraft-ink"
                    : "font-medium text-muted hover:bg-surface-sunken hover:text-fg"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        )}

        {logoutError && (
          <p className="form__error px-5 pt-3" role="alert">
            {logoutError}
          </p>
        )}
        <main className="content flex-1" id="contenido" tabIndex={-1}>
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

        {dayTotals && <DayTotalsBar state={dayTotals} currency={user.company.currencyCode} />}
        {/* Lugar para la barra inferior del celular. */}
        <div className="h-20 md:hidden" aria-hidden="true" />
      </div>

      {/* Celular: lo de todos los días al alcance del pulgar. */}
      <nav
        aria-label="Accesos del celular"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface/92 px-2 pt-1 pb-[calc(0.25rem+env(safe-area-inset-bottom))] backdrop-blur-md md:hidden"
      >
        <BottomItem href="/" icon="home" label="Inicio" current={active === "/"} />
        {canSeeOrders && (
          <BottomItem
            href="/pedidos"
            icon="clipboard"
            label="Pedidos"
            current={active === "/pedidos"}
          />
        )}
        {canSell && <BottomItem href="/ventas/nueva" icon="cash" label="Vender" primary />}
        <BottomItem icon="search" label="Buscar" onClick={openPalette} />
        <BottomItem
          icon="menu"
          label="Menú"
          expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        />
      </nav>

      <CommandPalette user={user} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

function BottomItem({
  href,
  icon,
  label,
  current,
  primary,
  expanded,
  onClick,
}: {
  href?: string;
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  current?: boolean;
  primary?: boolean;
  expanded?: boolean;
  onClick?: () => void;
}) {
  const className = `flex min-h-13 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border-0 text-xs hover:no-underline ${FOCUS} ${
    primary
      ? "mx-1 bg-ember font-semibold text-kraft-ink"
      : current
        ? "bg-transparent font-semibold text-primary"
        : "bg-transparent text-muted hover:text-fg"
  }`;
  const content = (
    <>
      <Icon name={icon} />
      <span>{label}</span>
    </>
  );
  return href ? (
    <Link href={href} className={className} aria-current={current ? "page" : undefined}>
      {content}
    </Link>
  ) : (
    <button
      type="button"
      className={`${className} font-[inherit]`}
      aria-expanded={expanded}
      onClick={onClick}
    >
      {content}
    </button>
  );
}
