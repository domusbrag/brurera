/**
 * Catálogo de permisos del sistema.
 *
 * Es la única fuente de verdad de los códigos de permiso. La base de datos se
 * sincroniza desde aquí (`pnpm db:sync-reference`) y la API autoriza contra los
 * códigos persistidos en roles. Cada fase agrega solo los permisos de los
 * módulos que implementa: no se declaran permisos para funcionalidad inexistente.
 */
export const PERMISSIONS = {
  DASHBOARD_VIEW: "dashboard.view",
  AUDIT_READ: "audit.read",

  COMPANY_READ: "company.read",
  COMPANY_UPDATE: "company.update",

  EMPLOYEES_READ: "employees.read",
  EMPLOYEES_CREATE: "employees.create",
  EMPLOYEES_UPDATE: "employees.update",
  EMPLOYEES_DEACTIVATE: "employees.deactivate",

  USERS_READ: "users.read",
  USERS_CREATE: "users.create",
  USERS_UPDATE: "users.update",
  USERS_DEACTIVATE: "users.deactivate",
  USERS_ASSIGN_ROLES: "users.assign_roles",
  ROLES_READ: "roles.read",

  CUSTOMERS_READ: "customers.read",
  CUSTOMERS_CREATE: "customers.create",
  CUSTOMERS_UPDATE: "customers.update",
  CUSTOMERS_DEACTIVATE: "customers.deactivate",

  SUPPLIERS_READ: "suppliers.read",
  SUPPLIERS_CREATE: "suppliers.create",
  SUPPLIERS_UPDATE: "suppliers.update",
  SUPPLIERS_DEACTIVATE: "suppliers.deactivate",

  UNITS_READ: "units.read",
  UNITS_MANAGE: "units.manage",
  CATEGORIES_READ: "categories.read",
  CATEGORIES_MANAGE: "categories.manage",

  RAW_MATERIALS_READ: "raw_materials.read",
  RAW_MATERIALS_CREATE: "raw_materials.create",
  RAW_MATERIALS_UPDATE: "raw_materials.update",
  RAW_MATERIALS_DEACTIVATE: "raw_materials.deactivate",
  RAW_MATERIALS_UPDATE_COST: "raw_materials.update_cost",

  PRODUCTS_READ: "products.read",
  PRODUCTS_CREATE: "products.create",
  PRODUCTS_UPDATE: "products.update",
  PRODUCTS_DEACTIVATE: "products.deactivate",

  WAREHOUSES_READ: "warehouses.read",
  WAREHOUSES_MANAGE: "warehouses.manage",

  RECIPES_READ: "recipes.read",
  RECIPES_CREATE: "recipes.create",
  RECIPES_UPDATE: "recipes.update",
  RECIPES_PUBLISH: "recipes.publish",
  RECIPES_ARCHIVE: "recipes.archive",

  PURCHASES_READ: "purchases.read",
  PURCHASES_CREATE: "purchases.create",
  PURCHASES_UPDATE: "purchases.update",
  PURCHASES_ORDER: "purchases.order",
  PURCHASES_RECEIVE: "purchases.receive",
  PURCHASES_CANCEL: "purchases.cancel",

  INVENTORY_READ: "inventory.read",
  INVENTORY_ADJUST: "inventory.adjust",
  INVENTORY_WASTE: "inventory.waste",
  INVENTORY_INITIAL_STOCK: "inventory.initial_stock",
  INVENTORY_COST_READ: "inventory.cost.read",

  PRESENTATIONS_READ: "presentations.read",
  PRESENTATIONS_MANAGE: "presentations.manage",

  PRODUCTION_ORDERS_READ: "production_orders.read",
  PRODUCTION_ORDERS_CREATE: "production_orders.create",
  PRODUCTION_ORDERS_UPDATE: "production_orders.update",
  PRODUCTION_ORDERS_PLAN: "production_orders.plan",
  PRODUCTION_ORDERS_START: "production_orders.start",
  PRODUCTION_ORDERS_COMPLETE: "production_orders.complete",
  PRODUCTION_ORDERS_CANCEL: "production_orders.cancel",
  PRODUCTION_ORDERS_ADD_EXTRA_MATERIAL: "production_orders.add_extra_material",
  PRODUCTION_COST_READ: "production.cost.read",

  PRODUCT_LOTS_READ: "product_lots.read",
  PRODUCT_LOTS_TRANSFORM: "product_lots.transform",
  PRODUCT_LOTS_WASTE: "product_lots.waste",
  PRODUCT_LOTS_QUALITY: "product_lots.quality",
  PRODUCT_CONSERVATION_READ: "product_conservation.read",
  PRODUCT_CONSERVATION_MANAGE: "product_conservation.manage",
  INVENTORY_EXPIRY_READ: "inventory.expiry.read",

  ORDERS_READ: "orders.read",
  ORDERS_CREATE: "orders.create",
  ORDERS_UPDATE: "orders.update",
  ORDERS_CONFIRM: "orders.confirm",
  ORDERS_REPLAN: "orders.replan",
  ORDERS_CANCEL: "orders.cancel",
  ORDERS_PREPARE: "orders.prepare",
  ORDERS_READY: "orders.ready",
  ORDER_PLANNING_READ: "order_planning.read",
  ORDER_PRODUCTION_CREATE: "order_production.create",
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export interface PermissionDefinition {
  code: PermissionCode;
  module: string;
  description: string;
}

const P = PERMISSIONS;

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  { code: P.DASHBOARD_VIEW, module: "dashboard", description: "Ver el panel de inicio" },
  { code: P.AUDIT_READ, module: "audit", description: "Consultar el registro de auditoría" },

  { code: P.COMPANY_READ, module: "company", description: "Ver los datos de la empresa" },
  { code: P.COMPANY_UPDATE, module: "company", description: "Modificar los datos de la empresa" },

  { code: P.EMPLOYEES_READ, module: "employees", description: "Ver empleados" },
  { code: P.EMPLOYEES_CREATE, module: "employees", description: "Dar de alta empleados" },
  { code: P.EMPLOYEES_UPDATE, module: "employees", description: "Modificar empleados" },
  {
    code: P.EMPLOYEES_DEACTIVATE,
    module: "employees",
    description: "Dar de baja y reactivar empleados",
  },

  { code: P.USERS_READ, module: "users", description: "Ver usuarios y sus permisos" },
  { code: P.USERS_CREATE, module: "users", description: "Crear accesos al sistema" },
  { code: P.USERS_UPDATE, module: "users", description: "Modificar usuarios" },
  { code: P.USERS_DEACTIVATE, module: "users", description: "Desactivar y reactivar accesos" },
  { code: P.USERS_ASSIGN_ROLES, module: "users", description: "Asignar roles a usuarios" },
  { code: P.ROLES_READ, module: "roles", description: "Ver roles y su matriz de permisos" },

  { code: P.CUSTOMERS_READ, module: "customers", description: "Ver clientes" },
  { code: P.CUSTOMERS_CREATE, module: "customers", description: "Dar de alta clientes" },
  { code: P.CUSTOMERS_UPDATE, module: "customers", description: "Modificar clientes" },
  {
    code: P.CUSTOMERS_DEACTIVATE,
    module: "customers",
    description: "Desactivar y reactivar clientes",
  },

  { code: P.SUPPLIERS_READ, module: "suppliers", description: "Ver proveedores" },
  { code: P.SUPPLIERS_CREATE, module: "suppliers", description: "Dar de alta proveedores" },
  { code: P.SUPPLIERS_UPDATE, module: "suppliers", description: "Modificar proveedores" },
  {
    code: P.SUPPLIERS_DEACTIVATE,
    module: "suppliers",
    description: "Desactivar y reactivar proveedores",
  },

  { code: P.UNITS_READ, module: "units", description: "Ver unidades de medida" },
  { code: P.UNITS_MANAGE, module: "units", description: "Crear y modificar unidades de medida" },
  { code: P.CATEGORIES_READ, module: "categories", description: "Ver categorías" },
  { code: P.CATEGORIES_MANAGE, module: "categories", description: "Crear y modificar categorías" },

  { code: P.RAW_MATERIALS_READ, module: "raw_materials", description: "Ver materias primas" },
  {
    code: P.RAW_MATERIALS_CREATE,
    module: "raw_materials",
    description: "Dar de alta materias primas",
  },
  {
    code: P.RAW_MATERIALS_UPDATE,
    module: "raw_materials",
    description: "Modificar materias primas",
  },
  {
    code: P.RAW_MATERIALS_DEACTIVATE,
    module: "raw_materials",
    description: "Desactivar y reactivar materias primas",
  },
  {
    code: P.RAW_MATERIALS_UPDATE_COST,
    module: "raw_materials",
    description: "Cargar y cambiar el costo de referencia de materias primas",
  },

  { code: P.PRODUCTS_READ, module: "products", description: "Ver productos" },
  { code: P.PRODUCTS_CREATE, module: "products", description: "Dar de alta productos" },
  { code: P.PRODUCTS_UPDATE, module: "products", description: "Modificar productos y precios" },
  {
    code: P.PRODUCTS_DEACTIVATE,
    module: "products",
    description: "Desactivar y reactivar productos",
  },

  { code: P.WAREHOUSES_READ, module: "warehouses", description: "Ver depósitos" },
  {
    code: P.WAREHOUSES_MANAGE,
    module: "warehouses",
    description: "Crear, modificar y desactivar depósitos",
  },

  {
    code: P.RECIPES_READ,
    module: "recipes",
    description: "Ver recetas, versiones y costo teórico",
  },
  { code: P.RECIPES_CREATE, module: "recipes", description: "Crear recetas y nuevas versiones" },
  {
    code: P.RECIPES_UPDATE,
    module: "recipes",
    description: "Editar recetas y borradores de versiones (y descartarlos)",
  },
  {
    code: P.RECIPES_PUBLISH,
    module: "recipes",
    description: "Publicar una versión (la vuelve vigente y archiva la anterior)",
  },
  {
    code: P.RECIPES_ARCHIVE,
    module: "recipes",
    description: "Archivar versiones vigentes y desactivar o reactivar recetas",
  },

  { code: P.PURCHASES_READ, module: "purchases", description: "Ver compras y sus recepciones" },
  { code: P.PURCHASES_CREATE, module: "purchases", description: "Crear compras (borrador)" },
  {
    code: P.PURCHASES_UPDATE,
    module: "purchases",
    description: "Editar compras en borrador y datos administrativos",
  },
  {
    code: P.PURCHASES_ORDER,
    module: "purchases",
    description: "Confirmar el pedido de una compra al proveedor",
  },
  {
    code: P.PURCHASES_RECEIVE,
    module: "purchases",
    description: "Registrar y confirmar recepciones de mercadería (mueven stock y costo)",
  },
  {
    code: P.PURCHASES_CANCEL,
    module: "purchases",
    description: "Cancelar compras sin mercadería recibida",
  },

  { code: P.INVENTORY_READ, module: "inventory", description: "Ver stock y movimientos" },
  {
    code: P.INVENTORY_ADJUST,
    module: "inventory",
    description: "Ajustar stock (positivo o negativo) con motivo",
  },
  { code: P.INVENTORY_WASTE, module: "inventory", description: "Registrar mermas" },
  {
    code: P.INVENTORY_INITIAL_STOCK,
    module: "inventory",
    description: "Cargar stock inicial valorizado",
  },
  {
    code: P.INVENTORY_COST_READ,
    module: "inventory",
    description: "Ver costo promedio, valorización e historial de costos del inventario",
  },

  {
    code: P.PRESENTATIONS_READ,
    module: "presentations",
    description: "Ver presentaciones de compra de materias primas",
  },
  {
    code: P.PRESENTATIONS_MANAGE,
    module: "presentations",
    description: "Crear, modificar y desactivar presentaciones de compra",
  },

  {
    code: P.PRODUCTION_ORDERS_READ,
    module: "production",
    description: "Ver órdenes de producción, consumos y disponibilidad",
  },
  {
    code: P.PRODUCTION_ORDERS_CREATE,
    module: "production",
    description: "Crear órdenes de producción (borrador)",
  },
  {
    code: P.PRODUCTION_ORDERS_UPDATE,
    module: "production",
    description: "Editar órdenes en borrador y registrar consumos y salida reales",
  },
  {
    code: P.PRODUCTION_ORDERS_PLAN,
    module: "production",
    description: "Planificar una orden (fija receta, cantidades y costo esperado)",
  },
  {
    code: P.PRODUCTION_ORDERS_START,
    module: "production",
    description: "Iniciar la producción (revalida el stock de materias primas)",
  },
  {
    code: P.PRODUCTION_ORDERS_COMPLETE,
    module: "production",
    description: "Completar la producción (consume materias primas e ingresa producto terminado)",
  },
  {
    code: P.PRODUCTION_ORDERS_CANCEL,
    module: "production",
    description: "Cancelar órdenes de producción no completadas",
  },
  {
    code: P.PRODUCTION_ORDERS_ADD_EXTRA_MATERIAL,
    module: "production",
    description: "Agregar y quitar consumos extra durante la producción",
  },
  {
    code: P.PRODUCTION_COST_READ,
    module: "production",
    description: "Ver costos esperados y reales de producción",
  },

  {
    code: P.PRODUCT_LOTS_READ,
    module: "product_lots",
    description: "Ver lotes de producto terminado, su trazabilidad y disponibilidad a una fecha",
  },
  {
    code: P.PRODUCT_LOTS_TRANSFORM,
    module: "product_lots",
    description: "Congelar y descongelar lotes (transformación de conservación)",
  },
  {
    code: P.PRODUCT_LOTS_WASTE,
    module: "product_lots",
    description: "Registrar mermas de producto terminado sobre un lote",
  },
  {
    code: P.PRODUCT_LOTS_QUALITY,
    module: "product_lots",
    description: "Bloquear y desbloquear lotes por calidad",
  },
  {
    code: P.PRODUCT_CONSERVATION_READ,
    module: "product_conservation",
    description: "Ver la conservación y vida útil configuradas de los productos",
  },
  {
    code: P.PRODUCT_CONSERVATION_MANAGE,
    module: "product_conservation",
    description: "Configurar conservación, vida útil y estado inicial de los productos",
  },
  {
    code: P.INVENTORY_EXPIRY_READ,
    module: "inventory",
    description: "Ver productos terminados próximos a vencer",
  },

  {
    code: P.ORDERS_READ,
    module: "orders",
    description: "Ver pedidos de clientes, su cobertura, reservas y necesidades",
  },
  { code: P.ORDERS_CREATE, module: "orders", description: "Crear pedidos (borrador)" },
  {
    code: P.ORDERS_UPDATE,
    module: "orders",
    description: "Editar borradores y datos no planificados de pedidos (contacto, notas)",
  },
  {
    code: P.ORDERS_CONFIRM,
    module: "orders",
    description: "Confirmar pedidos (reserva lotes y genera necesidades de producción)",
  },
  {
    code: P.ORDERS_REPLAN,
    module: "orders",
    description: "Modificar pedidos confirmados y recalcular su cobertura",
  },
  {
    code: P.ORDERS_CANCEL,
    module: "orders",
    description: "Cancelar pedidos (libera sus reservas)",
  },
  { code: P.ORDERS_PREPARE, module: "orders", description: "Pasar pedidos a preparación" },
  {
    code: P.ORDERS_READY,
    module: "orders",
    description: "Marcar pedidos como listos (sólo con cobertura completa)",
  },
  {
    code: P.ORDER_PLANNING_READ,
    module: "order_planning",
    description: "Ver necesidades: producción y materias primas de pedidos, pedidos en riesgo",
  },
  {
    code: P.ORDER_PRODUCTION_CREATE,
    module: "order_planning",
    description: "Crear órdenes de producción desde la necesidad de un pedido",
  },
];

export const ALL_PERMISSION_CODES: readonly PermissionCode[] = PERMISSION_CATALOG.map(
  (p) => p.code,
);

export function isPermissionCode(value: string): value is PermissionCode {
  return (ALL_PERMISSION_CODES as readonly string[]).includes(value);
}

/** Verdadero si el conjunto de permisos otorgados incluye todos los requeridos. */
export function hasPermissions(
  granted: Iterable<string>,
  required: readonly PermissionCode[],
): boolean {
  const set = granted instanceof Set ? (granted as Set<string>) : new Set(granted);
  return required.every((code) => set.has(code));
}

/** Permisos efectivos de una membresía: unión de los permisos de sus roles. */
export function effectivePermissions(
  roles: readonly { permissions: readonly string[] }[],
): Set<string> {
  const set = new Set<string>();
  for (const role of roles) for (const code of role.permissions) set.add(code);
  return set;
}
