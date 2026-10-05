import type { ReactNode, SVGProps } from "react";

/*
 * Íconos de la aplicación: un único estilo (trazo de 1,75 sobre grilla de 24,
 * sin relleno). Son decorativos (`aria-hidden`): toda acción lleva además su
 * texto visible o un `aria-label`; el ícono nunca es la única pista.
 */

export type IconName =
  | "home"
  | "cart"
  | "clipboard"
  | "users"
  | "tag"
  | "calendar"
  | "factory"
  | "book"
  | "box"
  | "clock"
  | "arrows"
  | "truck"
  | "building"
  | "wallet"
  | "badge"
  | "user"
  | "settings"
  | "history"
  | "package"
  | "wheat"
  | "menu"
  | "close"
  | "plus"
  | "search"
  | "chevron-down"
  | "trash"
  | "copy"
  | "check"
  | "alert"
  | "info"
  | "logout"
  | "cash";

const PATHS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M10 21v-6h4v6" />
    </>
  ),
  cart: (
    <>
      <path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6.2" />
      <circle cx="9" cy="20" r="1.3" />
      <circle cx="17" cy="20" r="1.3" />
    </>
  ),
  clipboard: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V3h6v1" />
      <path d="M9 10h6M9 14h6M9 18h3" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16 4.5a3 3 0 0 1 0 6M18 14.5c1.8.8 3 2.6 3 4.5" />
    </>
  ),
  tag: (
    <>
      <path d="M3 12V4h8l10 10-8 8L3 12Z" />
      <circle cx="7.5" cy="8" r="1.4" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="16" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  factory: (
    <>
      <path d="M3 21V10l5 3V10l5 3V7l8 4v10H3Z" />
      <path d="M7 17h2M12 17h2M17 17h1" />
    </>
  ),
  book: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" />
      <path d="M4 19a2 2 0 0 1 2-2h13v4H6" />
    </>
  ),
  box: (
    <>
      <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z" />
      <path d="M3 7.5 12 12l9-4.5M12 12v9" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  arrows: (
    <>
      <path d="M7 4 3 8l4 4M3 8h13" />
      <path d="m17 12 4 4-4 4M21 16H8" />
    </>
  ),
  truck: (
    <>
      <path d="M2.5 6h11v10h-11zM13.5 9.5h4l3 3.5V16h-7" />
      <circle cx="6.5" cy="17.5" r="1.6" />
      <circle cx="17" cy="17.5" r="1.6" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V4h10v17M14 9h6v12" />
      <path d="M7.5 8h3M7.5 12h3M7.5 16h3M2.5 21h19" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H18v4" />
      <rect x="4" y="8" width="17" height="12" rx="2" />
      <circle cx="16.5" cy="14" r="1.2" />
    </>
  ),
  badge: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <circle cx="12" cy="10" r="2.6" />
      <path d="M8 17c.6-1.9 2.2-3 4-3s3.4 1.1 4 3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20.5c.8-3.6 3.9-6 7.5-6s6.7 2.4 7.5 6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M4.2 6.2l2.1 2.1M17.7 15.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 17.8l2.1-2.1M17.7 8.3l2.1-2.1" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3 4v4h4M12 8v4.5l3 1.5" />
    </>
  ),
  package: (
    <>
      <path d="M4 8h16v12H4z" />
      <path d="M2.5 4.5h19V8h-19zM10 12h4" />
    </>
  ),
  wheat: (
    <>
      <path d="M12 21V8" />
      <path d="M12 12c-3 0-4.5-2-4.5-4.5C10.5 7.5 12 9.5 12 12ZM12 12c3 0 4.5-2 4.5-4.5-3 0-4.5 2-4.5 4.5ZM12 17c-3 0-4.5-2-4.5-4.5 3 0 4.5 2 4.5 4.5ZM12 17c3 0 4.5-2 4.5-4.5-3 0-4.5 2-4.5 4.5ZM12 8c0-2 1-3.5 0-5-1 1.5 0 3 0 5Z" />
    </>
  ),
  menu: <path d="M4 6.5h16M4 12h16M4 17.5h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: (
    <>
      <path d="M12 3.5 2.5 20h19L12 3.5Z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8v.3" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
      <path d="M9 16l-4-4 4-4M5 12h11" />
    </>
  ),
  cash: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 9.5v5M18 9.5v5" />
    </>
  ),
};

export function Icon({
  name,
  size = "md",
  ...props
}: { name: IconName; size?: "sm" | "md" } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`icon ${size === "sm" ? "icon--sm" : ""}`}
      {...props}
    >
      {PATHS[name]}
    </svg>
  );
}
