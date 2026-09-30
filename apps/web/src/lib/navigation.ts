/**
 * Menú principal. `phase` indica la etapa del roadmap en la que el módulo se
 * implementa; mientras no exista, la ruta muestra "Disponible en próxima etapa".
 */
export interface NavItem {
  slug: string;
  label: string;
  phase: number;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAVIGATION: NavGroup[] = [
  {
    label: "Operaciones",
    items: [
      { slug: "ventas", label: "Ventas", phase: 5 },
      { slug: "compras", label: "Compras", phase: 3 },
      { slug: "produccion", label: "Producción", phase: 4 },
    ],
  },
  {
    label: "Inventario",
    items: [
      { slug: "stock", label: "Stock", phase: 3 },
      { slug: "materias-primas", label: "Materias primas", phase: 1 },
      { slug: "productos", label: "Productos", phase: 1 },
      { slug: "recetas", label: "Recetas", phase: 2 },
    ],
  },
  {
    label: "Comercial",
    items: [
      { slug: "clientes", label: "Clientes", phase: 1 },
      { slug: "proveedores", label: "Proveedores", phase: 1 },
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
  { label: "Equipo", items: [{ slug: "empleados", label: "Empleados", phase: 1 }] },
  { label: "Análisis", items: [{ slug: "reportes", label: "Reportes", phase: 8 }] },
  { label: "Sistema", items: [{ slug: "configuracion", label: "Configuración", phase: 1 }] },
];

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
