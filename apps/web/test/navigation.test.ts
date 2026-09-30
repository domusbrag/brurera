import { describe, expect, it } from "vitest";
import { NAVIGATION, findNavItem, safeNextPath } from "@/lib/navigation";

describe("navegación", () => {
  it("los slugs del menú son únicos", () => {
    const slugs = NAVIGATION.flatMap((g) => g.items.map((i) => i.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("todo módulo pendiente apunta a una fase posterior a la 0", () => {
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
