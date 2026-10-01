/** Acciones auditables. Cada fase agrega las propias; las etiquetas son para la UI. */
export const AUDIT_ACTION_LABELS = {
  AUTH_LOGIN_SUCCEEDED: "Ingreso al sistema",
  AUTH_LOGIN_FAILED: "Intento de ingreso fallido",
  AUTH_LOGOUT: "Salida del sistema",

  COMPANY_UPDATED: "Empresa modificada",

  EMPLOYEE_CREATED: "Empleado creado",
  EMPLOYEE_UPDATED: "Empleado modificado",
  EMPLOYEE_DEACTIVATED: "Empleado dado de baja",
  EMPLOYEE_REACTIVATED: "Empleado reactivado",

  USER_CREATED: "Acceso creado",
  USER_UPDATED: "Usuario modificado",
  USER_DEACTIVATED: "Acceso desactivado",
  USER_REACTIVATED: "Acceso reactivado",
  USER_ROLE_CHANGED: "Roles modificados",

  CUSTOMER_CREATED: "Cliente creado",
  CUSTOMER_UPDATED: "Cliente modificado",
  CUSTOMER_DEACTIVATED: "Cliente desactivado",
  CUSTOMER_REACTIVATED: "Cliente reactivado",

  SUPPLIER_CREATED: "Proveedor creado",
  SUPPLIER_UPDATED: "Proveedor modificado",
  SUPPLIER_DEACTIVATED: "Proveedor desactivado",
  SUPPLIER_REACTIVATED: "Proveedor reactivado",

  UNIT_CREATED: "Unidad creada",
  UNIT_UPDATED: "Unidad modificada",

  CATEGORY_CREATED: "Categoría creada",
  CATEGORY_UPDATED: "Categoría modificada",

  RAW_MATERIAL_CREATED: "Materia prima creada",
  RAW_MATERIAL_UPDATED: "Materia prima modificada",
  RAW_MATERIAL_DEACTIVATED: "Materia prima desactivada",
  RAW_MATERIAL_REACTIVATED: "Materia prima reactivada",
  RAW_MATERIAL_REFERENCE_COST_CHANGED: "Costo de referencia modificado",

  PRODUCT_CREATED: "Producto creado",
  PRODUCT_UPDATED: "Producto modificado",
  PRODUCT_DEACTIVATED: "Producto desactivado",
  PRODUCT_REACTIVATED: "Producto reactivado",

  WAREHOUSE_CREATED: "Depósito creado",
  WAREHOUSE_UPDATED: "Depósito modificado",
  WAREHOUSE_DEACTIVATED: "Depósito desactivado",
  WAREHOUSE_REACTIVATED: "Depósito reactivado",

  RECIPE_CREATED: "Receta creada",
  RECIPE_UPDATED: "Receta modificada",
  RECIPE_DEACTIVATED: "Receta desactivada",
  RECIPE_REACTIVATED: "Receta reactivada",
  RECIPE_VERSION_CREATED: "Versión creada",
  RECIPE_VERSION_UPDATED: "Borrador modificado",
  RECIPE_VERSION_PUBLISHED: "Versión publicada",
  RECIPE_VERSION_ARCHIVED: "Versión archivada",
  RECIPE_VERSION_DISCARDED: "Borrador descartado",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTION_LABELS;

export interface AuditLogItemDto {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  actor: { id: string; displayName: string } | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}
