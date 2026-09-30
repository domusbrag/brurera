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
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export interface PermissionDefinition {
  code: PermissionCode;
  module: string;
  description: string;
}

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  { code: PERMISSIONS.DASHBOARD_VIEW, module: "dashboard", description: "Ver el panel de inicio" },
  {
    code: PERMISSIONS.AUDIT_READ,
    module: "audit",
    description: "Consultar el registro de auditoría",
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
