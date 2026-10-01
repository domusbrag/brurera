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

  it("usa el formato modulo.accion (o modulo.recurso.accion, como inventory.cost.read)", () => {
    for (const code of ALL_PERMISSION_CODES) {
      expect(code).toMatch(/^[a-z_-]+(\.[a-z_-]+){1,2}$/);
    }
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

describe("matriz de recetas y costos (Fase 2)", () => {
  const can = (role: string, code: string) =>
    SYSTEM_ROLES.find((r) => r.code === role)!.permissions.includes(code as never);

  it("Producción formula y edita, pero no publica ni archiva", () => {
    expect(can("PRODUCTION", PERMISSIONS.RECIPES_READ)).toBe(true);
    expect(can("PRODUCTION", PERMISSIONS.RECIPES_CREATE)).toBe(true);
    expect(can("PRODUCTION", PERMISSIONS.RECIPES_UPDATE)).toBe(true);
    expect(can("PRODUCTION", PERMISSIONS.RECIPES_PUBLISH)).toBe(false);
    expect(can("PRODUCTION", PERMISSIONS.RECIPES_ARCHIVE)).toBe(false);
  });

  it("sólo ADMIN y OWNER publican recetas", () => {
    const publishers = SYSTEM_ROLES.filter((r) =>
      r.permissions.includes(PERMISSIONS.RECIPES_PUBLISH),
    ).map((r) => r.code);
    expect(publishers.sort()).toEqual(["ADMIN", "OWNER"]);
  });

  it("el costo de referencia lo cambian Administración y Compras, no Producción ni Ventas", () => {
    expect(can("ADMINISTRATION", PERMISSIONS.RAW_MATERIALS_UPDATE_COST)).toBe(true);
    expect(can("PURCHASING", PERMISSIONS.RAW_MATERIALS_UPDATE_COST)).toBe(true);
    expect(can("PRODUCTION", PERMISSIONS.RAW_MATERIALS_UPDATE_COST)).toBe(false);
    expect(can("SALES", PERMISSIONS.RAW_MATERIALS_UPDATE_COST)).toBe(false);
  });
});
