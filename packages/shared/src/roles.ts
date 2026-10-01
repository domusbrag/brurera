import { ALL_PERMISSION_CODES, PERMISSIONS as P, type PermissionCode } from "./permissions";

/**
 * Roles de sistema iniciales. Son datos (filas en `roles` por empresa), no lógica
 * hardcodeada: la autorización siempre se evalúa por permisos, nunca por código
 * de rol. La matriz documentada en docs/PERMISSIONS.md se genera de aquí y se
 * verifica con tests contra la API.
 */
export const SYSTEM_ROLE_CODES = [
  "ADMIN",
  "OWNER",
  "ADMINISTRATION",
  "SALES",
  "PURCHASING",
  "PRODUCTION",
  "WAREHOUSE",
] as const;

export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

export interface SystemRoleDefinition {
  code: SystemRoleCode;
  name: string;
  description: string;
  permissions: readonly PermissionCode[];
}

/** Lectura de catálogos que casi todos los roles operativos necesitan. */
const CATALOG_READ = [P.UNITS_READ, P.CATEGORIES_READ] as const;

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    code: "ADMIN",
    name: "Administrador del sistema",
    description: "Acceso global, incluida la administración técnica.",
    permissions: ALL_PERMISSION_CODES,
  },
  {
    code: "OWNER",
    name: "Dueño",
    description: "Acceso global al negocio.",
    permissions: ALL_PERMISSION_CODES,
  },
  {
    code: "ADMINISTRATION",
    name: "Administración",
    description: "Gestión administrativa y comercial.",
    permissions: [
      P.DASHBOARD_VIEW,
      P.AUDIT_READ,
      P.COMPANY_READ,
      P.EMPLOYEES_READ,
      P.EMPLOYEES_CREATE,
      P.EMPLOYEES_UPDATE,
      P.EMPLOYEES_DEACTIVATE,
      P.USERS_READ,
      P.ROLES_READ,
      P.CUSTOMERS_READ,
      P.CUSTOMERS_CREATE,
      P.CUSTOMERS_UPDATE,
      P.CUSTOMERS_DEACTIVATE,
      P.SUPPLIERS_READ,
      P.SUPPLIERS_CREATE,
      P.SUPPLIERS_UPDATE,
      P.SUPPLIERS_DEACTIVATE,
      ...CATALOG_READ,
      P.CATEGORIES_MANAGE,
      P.RAW_MATERIALS_READ,
      P.RAW_MATERIALS_UPDATE_COST,
      P.PRODUCTS_READ,
      P.PRODUCTS_UPDATE,
      P.WAREHOUSES_READ,
      P.RECIPES_READ,
      // Lectura de compras y costos; el stock inicial es una decisión de valorización.
      P.PURCHASES_READ,
      P.INVENTORY_READ,
      P.INVENTORY_COST_READ,
      P.INVENTORY_INITIAL_STOCK,
      P.PRESENTATIONS_READ,
    ],
  },
  {
    code: "SALES",
    name: "Ventas",
    description: "Clientes, ventas y cobros.",
    permissions: [
      P.DASHBOARD_VIEW,
      P.CUSTOMERS_READ,
      P.CUSTOMERS_CREATE,
      P.CUSTOMERS_UPDATE,
      ...CATALOG_READ,
      P.PRODUCTS_READ,
    ],
  },
  {
    code: "PURCHASING",
    name: "Compras",
    description: "Proveedores y compras.",
    permissions: [
      P.DASHBOARD_VIEW,
      P.SUPPLIERS_READ,
      P.SUPPLIERS_CREATE,
      P.SUPPLIERS_UPDATE,
      ...CATALOG_READ,
      P.RAW_MATERIALS_READ,
      P.RAW_MATERIALS_CREATE,
      P.RAW_MATERIALS_UPDATE,
      P.RAW_MATERIALS_UPDATE_COST,
      P.WAREHOUSES_READ,
      P.PURCHASES_READ,
      P.PURCHASES_CREATE,
      P.PURCHASES_UPDATE,
      P.PURCHASES_ORDER,
      P.PURCHASES_RECEIVE,
      P.PURCHASES_CANCEL,
      P.PRESENTATIONS_READ,
      P.PRESENTATIONS_MANAGE,
      P.INVENTORY_READ,
      P.INVENTORY_COST_READ,
    ],
  },
  {
    code: "PRODUCTION",
    name: "Producción",
    description: "Recetas y órdenes de producción.",
    permissions: [
      P.DASHBOARD_VIEW,
      ...CATALOG_READ,
      P.RAW_MATERIALS_READ,
      P.PRODUCTS_READ,
      P.WAREHOUSES_READ,
      // Formula y edita borradores; publicar (volver vigente) queda para ADMIN/OWNER.
      P.RECIPES_READ,
      P.RECIPES_CREATE,
      P.RECIPES_UPDATE,
      P.INVENTORY_READ,
    ],
  },
  {
    code: "WAREHOUSE",
    name: "Depósito",
    description: "Stock, recepción y ajustes autorizados.",
    permissions: [
      P.DASHBOARD_VIEW,
      ...CATALOG_READ,
      P.RAW_MATERIALS_READ,
      P.PRODUCTS_READ,
      P.WAREHOUSES_READ,
      // Recibe mercadería contra compras; no ve la valorización del inventario.
      P.PURCHASES_READ,
      P.PURCHASES_RECEIVE,
      P.PRESENTATIONS_READ,
      P.INVENTORY_READ,
      P.INVENTORY_ADJUST,
      P.INVENTORY_WASTE,
    ],
  },
];
