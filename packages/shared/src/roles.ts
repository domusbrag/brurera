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
      // Seguimiento de producción con sus costos; no opera la planta.
      P.PRODUCTION_ORDERS_READ,
      P.PRODUCTION_COST_READ,
      // Lotes y vencimientos: sólo lectura.
      P.PRODUCT_LOTS_READ,
      P.PRODUCT_CONSERVATION_READ,
      P.INVENTORY_EXPIRY_READ,
      // Pedidos: seguimiento, recálculo de cobertura y planificación; no los carga.
      P.ORDERS_READ,
      P.ORDERS_REPLAN,
      P.ORDER_PLANNING_READ,
      // Finanzas comerciales completas: ventas con costo y margen, precios, cobros y ajustes.
      P.SALES_READ,
      P.SALES_CREATE,
      P.SALES_UPDATE,
      P.SALES_POST,
      P.SALES_PRICE_OVERRIDE,
      P.SALES_COST_READ,
      P.SALES_MARGIN_READ,
      P.PRICE_LISTS_READ,
      P.PRICE_LISTS_MANAGE,
      P.PAYMENTS_READ,
      P.PAYMENTS_CREATE,
      P.PAYMENTS_POST,
      P.CUSTOMER_ACCOUNTS_READ,
      P.CUSTOMER_ACCOUNTS_ADJUST,
      P.ORDER_ADVANCES_CREATE,
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
      // Carga, confirma, modifica y cancela pedidos de clientes.
      P.ORDERS_READ,
      P.ORDERS_CREATE,
      P.ORDERS_UPDATE,
      P.ORDERS_CONFIRM,
      P.ORDERS_REPLAN,
      P.ORDERS_CANCEL,
      // Vende y cobra con los precios vigentes; sin costos, márgenes ni cambios de precio.
      P.WAREHOUSES_READ,
      P.SALES_READ,
      P.SALES_CREATE,
      P.SALES_UPDATE,
      P.SALES_POST,
      P.PRICE_LISTS_READ,
      P.PAYMENTS_READ,
      P.PAYMENTS_CREATE,
      P.PAYMENTS_POST,
      P.CUSTOMER_ACCOUNTS_READ,
      P.ORDER_ADVANCES_CREATE,
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
      // Opera las órdenes completas; los costos monetarios quedan para ADMIN/OWNER/ADMINISTRACIÓN.
      P.PRODUCTION_ORDERS_READ,
      P.PRODUCTION_ORDERS_CREATE,
      P.PRODUCTION_ORDERS_UPDATE,
      P.PRODUCTION_ORDERS_PLAN,
      P.PRODUCTION_ORDERS_START,
      P.PRODUCTION_ORDERS_COMPLETE,
      P.PRODUCTION_ORDERS_CANCEL,
      P.PRODUCTION_ORDERS_ADD_EXTRA_MATERIAL,
      // Ve lotes y vencimientos y puede congelar/descongelar lo que produce.
      P.PRODUCT_LOTS_READ,
      P.PRODUCT_LOTS_TRANSFORM,
      P.PRODUCT_CONSERVATION_READ,
      P.INVENTORY_EXPIRY_READ,
      // Ve los pedidos (sin datos de contacto del cliente) y lo que hay que producir.
      P.ORDERS_READ,
      P.ORDERS_PREPARE,
      P.ORDER_PLANNING_READ,
      P.ORDER_PRODUCTION_CREATE,
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
      // Opera la conservación de producto terminado: congelar, descongelar, merma y bloqueo.
      P.PRODUCT_LOTS_READ,
      P.PRODUCT_LOTS_TRANSFORM,
      P.PRODUCT_LOTS_WASTE,
      P.PRODUCT_LOTS_QUALITY,
      P.PRODUCT_CONSERVATION_READ,
      P.INVENTORY_EXPIRY_READ,
      // Ve reservas y lotes comprometidos; marca listos los pedidos cubiertos.
      P.ORDERS_READ,
      P.ORDERS_READY,
      // Ve las salidas físicas por venta (sin precios ni costos).
      P.SALES_READ,
    ],
  },
];
