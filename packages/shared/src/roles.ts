import { ALL_PERMISSION_CODES, PERMISSIONS, type PermissionCode } from "./permissions";

/**
 * Roles de sistema iniciales. Son datos (filas en `roles`), no lógica hardcodeada:
 * la autorización siempre se evalúa por permisos, nunca por código de rol.
 * Se pueden crear roles adicionales por empresa sin tocar código.
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
    description: "Gestión administrativa y financiera.",
    permissions: [PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.AUDIT_READ],
  },
  {
    code: "SALES",
    name: "Ventas",
    description: "Clientes, ventas y cobros.",
    permissions: [PERMISSIONS.DASHBOARD_VIEW],
  },
  {
    code: "PURCHASING",
    name: "Compras",
    description: "Proveedores y compras.",
    permissions: [PERMISSIONS.DASHBOARD_VIEW],
  },
  {
    code: "PRODUCTION",
    name: "Producción",
    description: "Recetas y órdenes de producción.",
    permissions: [PERMISSIONS.DASHBOARD_VIEW],
  },
  {
    code: "WAREHOUSE",
    name: "Depósito",
    description: "Stock, recepción y ajustes autorizados.",
    permissions: [PERMISSIONS.DASHBOARD_VIEW],
  },
];
