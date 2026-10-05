import { SYSTEM_ROLES, type SystemRoleCode } from "@bakery/shared";
import { describe, expect, it } from "vitest";
import {
  NAVIGATION,
  UPCOMING_SECTIONS,
  activeNavHref,
  findUpcomingSection,
  safeNextPath,
  visibleNavigation,
} from "@/lib/navigation";

const permsOf = (code: SystemRoleCode) => SYSTEM_ROLES.find((r) => r.code === code)!.permissions;
const labelsFor = (code: SystemRoleCode) =>
  visibleNavigation(permsOf(code)).flatMap((g) => g.items.map((i) => i.label));
const groupsFor = (code: SystemRoleCode) => visibleNavigation(permsOf(code)).map((g) => g.label);

describe("navegación", () => {
  it("las rutas y los rótulos del menú son únicos (un nombre, un destino)", () => {
    const items = NAVIGATION.flatMap((g) => g.items);
    expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.label)).size).toBe(items.length);
  });

  it("todo ítem declara al menos un permiso que lo habilita", () => {
    for (const g of NAVIGATION) for (const i of g.items) expect(i.anyOf.length).toBeGreaterThan(0);
  });

  it("los módulos futuros no ocupan lugar en el menú, pero su ruta directa existe", () => {
    const hrefs = NAVIGATION.flatMap((g) => g.items.map((i) => i.href));
    for (const s of UPCOMING_SECTIONS) expect(hrefs).not.toContain(`/${s.slug}`);
    expect(findUpcomingSection("caja")?.label).toBe("Caja");
    expect(findUpcomingSection("ventas")).toBeUndefined();
  });

  it("el ítem activo es el más específico que contiene la ruta", () => {
    const items = NAVIGATION.flatMap((g) => g.items);
    expect(activeNavHref("/stock/productos/por-vencer", items)).toBe("/stock/productos/por-vencer");
    expect(activeNavHref("/stock/productos/abc", items)).toBe("/stock/productos");
    expect(activeNavHref("/stock/lotes/abc", items)).toBe("/stock");
    expect(activeNavHref("/ventas/nueva", items)).toBe("/ventas");
    expect(activeNavHref("/ventasx", items)).toBeNull();
  });
});

describe("safeNextPath (prevención de open redirect)", () => {
  it.each([
    [undefined, "/"],
    ["", "/"],
    ["/ventas", "/ventas"],
    ["https://evil.example", "/"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
  ])("%s → %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe("menú por rol (sólo lo que cada persona puede usar)", () => {
  it("Ventas / mostrador: comercial y cobranza; sin producción, inventario, compras ni costos", () => {
    expect(groupsFor("SALES")).toEqual(["Comercial", "Finanzas", "Catálogo"]);
    expect(labelsFor("SALES")).toEqual([
      "Pedidos",
      "Ventas",
      "Clientes",
      "Listas de precios",
      "Cuentas a cobrar",
      "Productos",
    ]);
  });

  it("Producción: planificación, órdenes, recetas e inventario; sin finanzas ni precios", () => {
    const groups = groupsFor("PRODUCTION");
    expect(groups).toContain("Producción");
    expect(groups).not.toContain("Finanzas");
    expect(groups).not.toContain("Organización");
    expect(labelsFor("PRODUCTION")).not.toContain("Listas de precios");
    expect(labelsFor("PRODUCTION")).toEqual(
      expect.arrayContaining(["Planificación", "Órdenes de producción", "Recetas"]),
    );
  });

  it("Depósito: stock, lotes por vencer y movimientos; sin listas de precios ni finanzas", () => {
    const labels = labelsFor("WAREHOUSE");
    expect(labels).toEqual(
      expect.arrayContaining([
        "Stock de materias primas",
        "Productos terminados",
        "Próximos a vencer",
        "Movimientos",
      ]),
    );
    expect(labels).not.toContain("Listas de precios");
    expect(groupsFor("WAREHOUSE")).not.toContain("Finanzas");
  });

  it("Compras: compras, proveedores y stock de materias primas", () => {
    expect(labelsFor("PURCHASING")).toEqual(
      expect.arrayContaining(["Compras", "Proveedores", "Stock de materias primas"]),
    );
    expect(groupsFor("PURCHASING")).not.toContain("Comercial");
  });

  it("Configuración sólo para quien administra algo, aunque todos lean unidades", () => {
    for (const code of ["SALES", "PURCHASING", "PRODUCTION", "WAREHOUSE"] as const)
      expect(labelsFor(code)).not.toContain("Configuración");
    for (const code of ["ADMIN", "OWNER", "ADMINISTRATION"] as const)
      expect(labelsFor(code)).toContain("Configuración");
  });

  it("Dueño ve todos los grupos, en orden de frecuencia", () => {
    expect(groupsFor("OWNER")).toEqual([
      "Comercial",
      "Producción",
      "Inventario",
      "Compras",
      "Finanzas",
      "Catálogo",
      "Organización",
    ]);
  });

  it("sin permisos no hay grupos", () => {
    expect(visibleNavigation([])).toEqual([]);
  });
});
