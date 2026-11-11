import { PERMISSIONS as P } from "@bakery/shared";
import { describe, expect, it } from "vitest";
import { matches, normalize, staticEntries } from "@/components/ui/command-palette";
import { MORE_CREATE_ACTIONS, QUICK_ACTIONS, allowedActions } from "@/lib/navigation";

describe("buscador global", () => {
  it("compara sin tildes ni mayúsculas", () => {
    expect(normalize("  Producción ")).toBe("produccion");
    const entry = staticEntries([P.PRODUCTION_ORDERS_READ]).find((e) => e.href === "/produccion")!;
    expect(matches(entry, "produccion")).toBe(true);
    expect(matches(entry, "ÓRDENES prod")).toBe(true);
    expect(matches(entry, "ventas")).toBe(false);
  });

  it("encuentra pantallas por sinónimos de uso diario", () => {
    const entries = staticEntries([P.CUSTOMER_ACCOUNTS_READ, P.INVENTORY_READ]);
    const found = (q: string) => entries.filter((e) => matches(e, q)).map((e) => e.href);
    expect(found("deudas")).toContain("/cuentas-a-cobrar");
    expect(found("kardex")).toContain("/stock/movimientos");
  });

  it("sólo ofrece pantallas y acciones que el rol puede usar", () => {
    const seller = staticEntries([P.SALES_READ, P.SALES_CREATE, P.CUSTOMERS_READ]);
    const hrefs = seller.map((e) => e.href);
    expect(hrefs).toEqual(expect.arrayContaining(["/", "/ventas", "/ventas/nueva", "/clientes"]));
    expect(hrefs).not.toContain("/compras");
    expect(hrefs).not.toContain("/compras/nueva");
    expect(hrefs).not.toContain("/clientes/nuevo");
    expect(hrefs).not.toContain("/configuracion/roles");
  });

  it("una acción exige todos sus permisos", () => {
    const cobro = (perms: string[]) =>
      allowedActions(QUICK_ACTIONS, perms).some((a) => a.label === "Registrar un cobro");
    expect(cobro([P.CUSTOMER_ACCOUNTS_READ])).toBe(false);
    expect(cobro([P.CUSTOMER_ACCOUNTS_READ, P.PAYMENTS_CREATE])).toBe(true);
    expect(allowedActions(MORE_CREATE_ACTIONS, [])).toEqual([]);
  });

  it("primero las acciones, después las pantallas", () => {
    const entries = staticEntries(Object.values(P));
    const firstScreen = entries.findIndex((e) => e.group === "Ir a");
    expect(entries.slice(0, firstScreen).every((e) => e.group === "Acciones")).toBe(true);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });
});
