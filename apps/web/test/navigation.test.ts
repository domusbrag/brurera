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

  it("Producción → Recetas aparece sólo con recipes.read", async () => {
    const { visibleNavigation } = await import("@/lib/navigation");
    const withRecipes = visibleNavigation(["recipes.read"]);
    const production = withRecipes.find((g) => g.label === "Producción");
    expect(production?.items.map((i) => i.slug)).toContain("recetas");
    const without = visibleNavigation(["products.read"]).flatMap((g) => g.items.map((i) => i.slug));
    expect(without).not.toContain("recetas");
  });

  it("configuración aparece con cualquiera de sus permisos de lectura", async () => {
    const { visibleNavigation } = await import("@/lib/navigation");
    const slugs = visibleNavigation(["units.read"]).flatMap((g) => g.items.map((i) => i.slug));
    expect(slugs).toContain("configuracion");
  });

  it("Compras y Stock (Fase 3) aparecen sólo con su permiso de lectura", async () => {
    const { visibleNavigation } = await import("@/lib/navigation");
    const slugsOf = (perms: string[]) =>
      visibleNavigation(perms).flatMap((g) => g.items.map((i) => i.slug));
    expect(slugsOf(["purchases.read"])).toContain("compras");
    expect(slugsOf(["purchases.read"])).not.toContain("stock");
    expect(slugsOf(["inventory.read"])).toContain("stock");
    expect(slugsOf(["inventory.read"])).not.toContain("compras");
  });

  it("Producción → Órdenes (Fase 4) aparece sólo con production_orders.read, antes que Recetas", async () => {
    const { visibleNavigation, CURRENT_PHASE } = await import("@/lib/navigation");
    expect(CURRENT_PHASE).toBe(4);
    const group = (perms: string[]) =>
      visibleNavigation(perms).find((g) => g.label === "Producción")?.items ?? [];
    const both = group(["production_orders.read", "recipes.read"]);
    expect(both.map((i) => [i.slug, i.label])).toEqual([
      ["produccion", "Órdenes"],
      ["recetas", "Recetas"],
    ]);
    expect(group(["recipes.read"]).map((i) => i.slug)).toEqual(["recetas"]);
    expect(group(["inventory.read"])).toEqual([]);
  });

  it("Comercial → Pedidos y Planificación → Necesidades (Fase 5A) aparecen con su permiso", async () => {
    const { visibleNavigation } = await import("@/lib/navigation");
    const slugsOf = (perms: string[]) =>
      visibleNavigation(perms).flatMap((g) => g.items.map((i) => i.slug));
    expect(slugsOf(["orders.read"])).toContain("pedidos");
    expect(slugsOf(["orders.read"])).not.toContain("necesidades");
    expect(slugsOf(["order_planning.read"])).toContain("necesidades");
    expect(slugsOf(["customers.read"])).not.toContain("pedidos");
    const commercial = visibleNavigation(["orders.read", "customers.read"]).find(
      (g) => g.label === "Comercial",
    );
    expect(commercial?.items[0]?.slug).toBe("pedidos");
  });
});
