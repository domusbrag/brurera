import { PERMISSIONS as P, type PermissionCode } from "@bakery/shared";

/**
 * Menú principal. `phase` indica la etapa del roadmap en la que el módulo se
 * implementa; mientras no exista, la ruta muestra "Disponible en próxima etapa".
 * Los módulos ya implementados declaran los permisos que habilitan verlos
 * (alcanza con uno); sin ninguno, el ítem no se muestra.
 */
export interface NavItem {
  slug: string;
  label: string;
  phase: number;
  anyOf?: PermissionCode[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Última fase implementada: los módulos de fases posteriores son "próxima etapa". */
export const CURRENT_PHASE = 2;

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
    description: "Lugares donde se guardará el stock.",
    permission: P.WAREHOUSES_READ,
  },
  {
    slug: "roles",
    label: "Roles y permisos",
    description: "Qué puede hacer cada rol (solo lectura).",
    permission: P.ROLES_READ,
  },
];

export const NAVIGATION: NavGroup[] = [
  {
    label: "Operaciones",
    items: [
      { slug: "ventas", label: "Ventas", phase: 5 },
      { slug: "compras", label: "Compras", phase: 3 },
    ],
  },
  {
    label: "Producción",
    items: [
      { slug: "recetas", label: "Recetas", phase: 2, anyOf: [P.RECIPES_READ] },
      { slug: "produccion", label: "Órdenes de producción", phase: 4 },
    ],
  },
  {
    label: "Inventario",
    items: [
      { slug: "stock", label: "Stock", phase: 3 },
      {
        slug: "materias-primas",
        label: "Materias primas",
        phase: 1,
        anyOf: [P.RAW_MATERIALS_READ],
      },
      { slug: "productos", label: "Productos", phase: 1, anyOf: [P.PRODUCTS_READ] },
    ],
  },
  {
    label: "Comercial",
    items: [
      { slug: "clientes", label: "Clientes", phase: 1, anyOf: [P.CUSTOMERS_READ] },
      { slug: "proveedores", label: "Proveedores", phase: 1, anyOf: [P.SUPPLIERS_READ] },
    ],
  },
  {
    label: "Finanzas",
    items: [
      { slug: "caja", label: "Caja", phase: 6 },
      { slug: "cuentas-a-cobrar", label: "Cuentas a cobrar", phase: 5 },
      { slug: "cuentas-a-pagar", label: "Cuentas a pagar", phase: 6 },
      { slug: "gastos", label: "Gastos", phase: 6 },
      { slug: "facturacion", label: "Facturación", phase: 7 },
    ],
  },
  {
    label: "Equipo",
    items: [
      { slug: "empleados", label: "Empleados", phase: 1, anyOf: [P.EMPLOYEES_READ] },
      { slug: "usuarios", label: "Usuarios", phase: 1, anyOf: [P.USERS_READ] },
    ],
  },
  { label: "Análisis", items: [{ slug: "reportes", label: "Reportes", phase: 8 }] },
  {
    label: "Sistema",
    items: [
      {
        slug: "configuracion",
        label: "Configuración",
        phase: 1,
        anyOf: CONFIG_SECTIONS.map((s) => s.permission),
      },
      { slug: "auditoria", label: "Auditoría", phase: 1, anyOf: [P.AUDIT_READ] },
    ],
  },
];

/** Menú visible para un usuario: módulos futuros siempre; implementados solo con permiso. */
export function visibleNavigation(permissions: readonly string[]): NavGroup[] {
  const granted = new Set(permissions);
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => item.phase > CURRENT_PHASE || !item.anyOf || item.anyOf.some((p) => granted.has(p)),
    ),
  })).filter((group) => group.items.length > 0);
}

export function findNavItem(slug: string): NavItem | undefined {
  for (const group of NAVIGATION) {
    const item = group.items.find((i) => i.slug === slug);
    if (item) return item;
  }
  return undefined;
}

/** Solo acepta rutas internas relativas (evita open redirects tras el login). */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\"))
    return "/";
  return value;
}
