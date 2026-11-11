import { PERMISSION_CATALOG } from "./permissions";
import { SYSTEM_ROLES } from "./roles";

/** Nombre visible de cada módulo del catálogo de permisos. */
export const PERMISSION_MODULE_LABELS: Record<string, string> = {
  dashboard: "Inicio",
  audit: "Auditoría",
  company: "Empresa",
  employees: "Empleados",
  users: "Usuarios",
  roles: "Roles",
  customers: "Clientes",
  suppliers: "Proveedores",
  units: "Unidades de medida",
  categories: "Categorías",
  raw_materials: "Materias primas",
  products: "Productos",
  warehouses: "Depósitos",
  recipes: "Recetas",
  purchases: "Compras",
  inventory: "Inventario",
  presentations: "Presentaciones de compra",
  sales: "Ventas",
  price_lists: "Listas de precios",
  payments: "Cobros",
  customer_accounts: "Cuenta corriente",
  production: "Producción",
  product_lots: "Lotes",
  product_conservation: "Conservación de productos",
  orders: "Pedidos",
  order_planning: "Planificación de pedidos",
};

/**
 * Matriz permiso → roles en Markdown. docs/PERMISSIONS.md incluye exactamente
 * esta tabla (un test lo verifica), así la documentación no puede quedar
 * desalineada de los roles que la API realmente aplica.
 */
export function permissionMatrixMarkdown(): string {
  const header = `| Módulo | Permiso | Descripción | ${SYSTEM_ROLES.map((r) => r.code).join(" | ")} |`;
  const divider = `| --- | --- | --- | ${SYSTEM_ROLES.map(() => ":-:").join(" | ")} |`;
  const rows = PERMISSION_CATALOG.map((p) => {
    const cells = SYSTEM_ROLES.map((r) => (r.permissions.includes(p.code) ? "✅" : "—"));
    return `| ${PERMISSION_MODULE_LABELS[p.module] ?? p.module} | \`${p.code}\` | ${p.description} | ${cells.join(" | ")} |`;
  });
  const legend = SYSTEM_ROLES.map((r) => `- **${r.code}** — ${r.name}: ${r.description}`);
  return [header, divider, ...rows, "", ...legend].join("\n");
}
