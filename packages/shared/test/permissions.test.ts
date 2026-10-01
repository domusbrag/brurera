import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSION_CODES,
  PERMISSION_CATALOG,
  PERMISSIONS,
  hasPermissions,
  isPermissionCode,
} from "../src/permissions";
import { SYSTEM_ROLES, SYSTEM_ROLE_CODES } from "../src/roles";

describe("catálogo de permisos", () => {
  it("no tiene códigos duplicados", () => {
    expect(new Set(ALL_PERMISSION_CODES).size).toBe(PERMISSION_CATALOG.length);
  });

  it("usa el formato modulo.accion", () => {
    for (const code of ALL_PERMISSION_CODES) expect(code).toMatch(/^[a-z_-]+\.[a-z_-]+$/);
  });

  it("reconoce códigos válidos e inválidos", () => {
    expect(isPermissionCode(PERMISSIONS.AUDIT_READ)).toBe(true);
    expect(isPermissionCode("stock.delete-everything")).toBe(false);
  });
});

describe("hasPermissions", () => {
  it("exige todos los permisos requeridos", () => {
    const granted = [PERMISSIONS.DASHBOARD_VIEW];
    expect(hasPermissions(granted, [PERMISSIONS.DASHBOARD_VIEW])).toBe(true);
    expect(hasPermissions(granted, [PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.AUDIT_READ])).toBe(
      false,
    );
  });

  it("sin requisitos siempre autoriza", () => {
    expect(hasPermissions([], [])).toBe(true);
  });
});

describe("roles de sistema", () => {
  it("define exactamente los roles iniciales", () => {
    expect(SYSTEM_ROLES.map((r) => r.code).sort()).toEqual([...SYSTEM_ROLE_CODES].sort());
  });

  it("solo referencian permisos del catálogo", () => {
    for (const role of SYSTEM_ROLES)
      for (const code of role.permissions) expect(isPermissionCode(code)).toBe(true);
  });

  it("ADMIN y OWNER tienen todos los permisos; VENTAS no puede leer auditoría", () => {
    const byCode = new Map(SYSTEM_ROLES.map((r) => [r.code, r]));
    expect(byCode.get("ADMIN")?.permissions).toEqual(ALL_PERMISSION_CODES);
    expect(byCode.get("OWNER")?.permissions).toEqual(ALL_PERMISSION_CODES);
    expect(hasPermissions(byCode.get("SALES")?.permissions ?? [], [PERMISSIONS.AUDIT_READ])).toBe(
      false,
    );
  });
});
