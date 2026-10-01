import { describe, expect, it } from "vitest";
import { NAVIGATION, findNavItem, safeNextPath } from "@/lib/navigation";

describe("navegación", () => {
  it("los slugs del menú son únicos", () => {
    const slugs = NAVIGATION.flatMap((g) => g.items.map((i) => i.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("todo módulo apunta a una fase del roadmap (1 o posterior)", () => {
    for (const g of NAVIGATION) for (const i of g.items) expect(i.phase).toBeGreaterThanOrEqual(1);
  });

  it("encuentra secciones existentes y rechaza inexistentes", () => {
    expect(findNavItem("ventas")?.label).toBe("Ventas");
    expect(findNavItem("no-existe")).toBeUndefined();
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

describe("menú según permisos", () => {
  it("oculta módulos implementados sin permiso y conserva los de fases futuras", async () => {
    const { visibleNavigation } = await import("@/lib/navigation");
    const slugs = visibleNavigation(["customers.read"]).flatMap((g) => g.items.map((i) => i.slug));
    expect(slugs).toContain("clientes");
    expect(slugs).toContain("ventas");
    expect(slugs).not.toContain("proveedores");
    expect(slugs).not.toContain("usuarios");
    expect(slugs).not.toContain("configuracion");
  });

  it("configuración aparece con cualquiera de sus permisos de lectura", async () => {
    const { visibleNavigation } = await import("@/lib/navigation");
    const slugs = visibleNavigation(["units.read"]).flatMap((g) => g.items.map((i) => i.slug));
    expect(slugs).toContain("configuracion");
  });
});
