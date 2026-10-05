import { PERMISSIONS as P, type PermissionCode } from "@bakery/shared";
import type { IconName } from "@/components/ui/icons";

/*
 * Arquitectura de información (UX/DESIGN OPTIMIZATION, ver docs/UX_AUDIT.md §IA).
 *
 * El menú se ordena por tarea y frecuencia, no por tabla: primero lo comercial
 * diario, después producción, inventario y compras; lo administrativo al final.
 * Cada ítem declara los permisos que lo habilitan (alcanza con uno): un usuario
 * sólo ve lo que puede usar. Es comodidad de UI: la API vuelve a autorizar.
 * Los módulos todavía no implementados no ocupan lugar en el menú
 * (ver UPCOMING_SECTIONS).
 */

export interface NavItem {
  /** Ruta del ítem. */
  href: string;
  label: string;
  icon: IconName;
  anyOf: PermissionCode[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const CONFIG_SECTIONS: {
  slug: string;
  label: string;
  description: string;
  permission: PermissionCode;
}[] = [
  {
    slug: "empresa",
    label: "Empresa",
    description: "Razón social, datos fiscales, moneda y zona horaria.",
    permission: P.COMPANY_READ,
  },
  {
    slug: "unidades",
    label: "Unidades de medida",
    description: "Kilos, litros, unidades y sus conversiones.",
    permission: P.UNITS_READ,
  },
  {
    slug: "categorias",
    label: "Categorías",
    description: "Agrupan materias primas y productos.",
    permission: P.CATEGORIES_READ,
  },
  {
    slug: "depositos",
    label: "Depósitos",
    description: "Lugares donde se guarda el stock.",
    permission: P.WAREHOUSES_READ,
  },
  {
    slug: "roles",
    label: "Roles y permisos",
    description: "Qué puede hacer cada rol (sólo lectura).",
    permission: P.ROLES_READ,
  },
];

/** Inicio: siempre visible para un usuario con sesión. */
export const HOME_ITEM: NavItem = { href: "/", label: "Inicio", icon: "home", anyOf: [] };

export const NAVIGATION: NavGroup[] = [
  {
    label: "Comercial",
    items: [
      { href: "/pedidos", label: "Pedidos", icon: "clipboard", anyOf: [P.ORDERS_READ] },
      { href: "/ventas", label: "Ventas", icon: "cart", anyOf: [P.SALES_READ] },
      { href: "/clientes", label: "Clientes", icon: "users", anyOf: [P.CUSTOMERS_READ] },
      {
        href: "/listas-de-precios",
        label: "Listas de precios",
        icon: "tag",
        anyOf: [P.PRICE_LISTS_READ],
      },
    ],
  },
  {
    label: "Producción",
    items: [
      {
        href: "/necesidades",
        label: "Planificación",
        icon: "calendar",
        anyOf: [P.ORDER_PLANNING_READ],
      },
      {
        href: "/produccion",
        label: "Órdenes de producción",
        icon: "factory",
        anyOf: [P.PRODUCTION_ORDERS_READ],
      },
      { href: "/recetas", label: "Recetas", icon: "book", anyOf: [P.RECIPES_READ] },
    ],
  },
  {
    label: "Inventario",
    items: [
      {
        href: "/stock",
        label: "Stock de materias primas",
        icon: "box",
        anyOf: [P.INVENTORY_READ],
      },
      {
        href: "/stock/productos",
        label: "Productos terminados",
        icon: "package",
        anyOf: [P.INVENTORY_READ],
      },
      {
        href: "/stock/productos/por-vencer",
        label: "Próximos a vencer",
        icon: "clock",
        anyOf: [P.INVENTORY_EXPIRY_READ],
      },
      {
        href: "/stock/movimientos",
        label: "Movimientos",
        icon: "arrows",
        anyOf: [P.INVENTORY_READ],
      },
    ],
  },
  {
    label: "Compras",
    items: [
      { href: "/compras", label: "Compras", icon: "truck", anyOf: [P.PURCHASES_READ] },
      { href: "/proveedores", label: "Proveedores", icon: "building", anyOf: [P.SUPPLIERS_READ] },
    ],
  },
  {
    label: "Finanzas",
    items: [
      {
        href: "/cuentas-a-cobrar",
        label: "Cuentas a cobrar",
        icon: "wallet",
        anyOf: [P.CUSTOMER_ACCOUNTS_READ],
      },
    ],
  },
  {
    label: "Catálogo",
    items: [
      { href: "/productos", label: "Productos", icon: "package", anyOf: [P.PRODUCTS_READ] },
      {
        href: "/materias-primas",
        label: "Materias primas",
        icon: "wheat",
        anyOf: [P.RAW_MATERIALS_READ],
      },
    ],
  },
  {
    label: "Organización",
    items: [
      { href: "/empleados", label: "Empleados", icon: "badge", anyOf: [P.EMPLOYEES_READ] },
      { href: "/usuarios", label: "Usuarios", icon: "user", anyOf: [P.USERS_READ] },
      {
        href: "/configuracion",
        label: "Configuración",
        icon: "settings",
        // Unidades, categorías y depósitos los leen todos los roles (selectores), pero
        // configurarlos es tarea de administración: el menú sólo lo ofrece a quien
        // administra algo. La ruta sigue accesible por enlace directo.
        anyOf: [
          P.COMPANY_READ,
          P.UNITS_MANAGE,
          P.CATEGORIES_MANAGE,
          P.WAREHOUSES_MANAGE,
          P.ROLES_READ,
        ],
      },
      { href: "/auditoria", label: "Auditoría", icon: "history", anyOf: [P.AUDIT_READ] },
    ],
  },
];

/**
 * Módulos del roadmap todavía no implementados. No aparecen en el menú; su ruta
 * directa muestra "Disponible en próxima etapa".
 */
export const UPCOMING_SECTIONS: { slug: string; label: string; phase: number }[] = [
  { slug: "caja", label: "Caja", phase: 6 },
  { slug: "cuentas-a-pagar", label: "Cuentas a pagar", phase: 6 },
  { slug: "gastos", label: "Gastos", phase: 6 },
  { slug: "facturacion", label: "Facturación", phase: 7 },
  { slug: "reportes", label: "Reportes", phase: 8 },
];

/** Menú visible para un usuario: sólo módulos implementados para los que tiene permiso. */
export function visibleNavigation(permissions: readonly string[]): NavGroup[] {
  const granted = new Set(permissions);
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.anyOf.some((p) => granted.has(p))),
  })).filter((group) => group.items.length > 0);
}

/**
 * Ítem activo para una ruta: el de href más largo que la contiene (así
 * /stock/productos/por-vencer activa "Próximos a vencer" y no "Stock").
 */
export function activeNavHref(pathname: string, items: readonly NavItem[]): string | null {
  if (pathname === "/") return "/";
  let best: string | null = null;
  for (const { href } of items) {
    if (href === "/") continue;
    if ((pathname === href || pathname.startsWith(`${href}/`)) && href.length > (best?.length ?? 0))
      best = href;
  }
  return best;
}

export function findUpcomingSection(slug: string) {
  return UPCOMING_SECTIONS.find((s) => s.slug === slug);
}

/** Solo acepta rutas internas relativas (evita open redirects tras el login). */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\"))
    return "/";
  return value;
}
