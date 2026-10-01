import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  clientFor,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;
let api: ApiClient;
const ids = new Map<string, string>();

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
  for (const u of (await api.get("/api/units?pageSize=100")).json().items) ids.set(u.code, u.id);
});
afterAll(() => ctx.close());

const convert = (from: string, to: string, quantity: string) =>
  api.get(`/api/units/convert?from=${ids.get(from)}&to=${ids.get(to)}&quantity=${quantity}`);

describe("unidades de medida", () => {
  it("la empresa nace con las unidades estándar", () => {
    expect([...ids.keys()].sort()).toEqual(
      ["bolsa", "caja", "docena", "g", "kg", "l", "ml", "unidad"].sort(),
    );
  });

  it("conversiones válidas exactas (sin float)", async () => {
    expect((await convert("kg", "g", "1.5")).json().result).toBe("1500");
    expect((await convert("g", "kg", "1")).json().result).toBe("0.001");
    expect((await convert("ml", "l", "250")).json().result).toBe("0.25");
    expect((await convert("docena", "unidad", "3")).json().result).toBe("36");
    expect((await convert("g", "kg", "0.1")).json().result).toBe("0.0001");
  });

  it("masa ↔ volumen y masa ↔ unidades → 422 INCOMPATIBLE_UNITS", async () => {
    for (const [from, to] of [
      ["kg", "l"],
      ["g", "ml"],
      ["kg", "unidad"],
      ["bolsa", "kg"],
      ["bolsa", "caja"],
    ] as const) {
      const res = await convert(from, to, "1");
      expect(res.statusCode, `${from}→${to}`).toBe(422);
      expect(res.json().error.code).toBe("INCOMPATIBLE_UNITS");
    }
  });

  it("crea una unidad derivada (bolsa de 25 kg como masa) y convierte", async () => {
    const res = await api.post("/api/units", {
      code: "bolsa25",
      name: "Bolsa de harina 25 kg",
      symbol: "b25",
      dimension: "MASS",
      baseUnitId: ids.get("kg"),
      conversionFactor: "25",
      decimals: 0,
    });
    expect(res.statusCode).toBe(201);
    ids.set("bolsa25", res.json().id);
    expect((await convert("bolsa25", "g", "2")).json().result).toBe("50000");
  });

  it("rechaza base de otra dimensión, base derivada, factor cero y código repetido", async () => {
    const otherDimension = await api.post("/api/units", {
      code: "x1",
      name: "X",
      symbol: "x",
      dimension: "VOLUME",
      baseUnitId: ids.get("kg"),
      conversionFactor: "2",
    });
    expect(otherDimension.statusCode).toBe(422);
    expect(otherDimension.json().error.code).toBe("INVALID_UNIT_DEFINITION");
    const derivedBase = await api.post("/api/units", {
      code: "x2",
      name: "X",
      symbol: "x",
      dimension: "MASS",
      baseUnitId: ids.get("g"),
      conversionFactor: "2",
    });
    expect(derivedBase.statusCode).toBe(422);
    const zero = await api.post("/api/units", {
      code: "x3",
      name: "X",
      symbol: "x",
      dimension: "MASS",
      baseUnitId: ids.get("kg"),
      conversionFactor: "0",
    });
    expect(zero.statusCode).toBe(400);
    const baseWithoutFactor = await api.post("/api/units", {
      code: "x4",
      name: "X",
      symbol: "x",
      dimension: "MASS",
      baseUnitId: ids.get("kg"),
    });
    expect(baseWithoutFactor.statusCode).toBe(400);
    const dup = await api.post("/api/units", {
      code: "KG",
      name: "Otro",
      symbol: "k",
      dimension: "MASS",
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CODE_TAKEN");
  });

  it("la definición de conversión no se edita (solo nombre, símbolo, decimales y estado)", async () => {
    const id = ids.get("bolsa25");
    const ignored = await api.patch(`/api/units/${id}`, {
      conversionFactor: "30",
      name: "Bolsa 25",
    });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json()).toMatchObject({ name: "Bolsa 25", conversionFactor: "25.0000000000" });
    const onlyFactor = await api.patch(`/api/units/${id}`, { conversionFactor: "30" });
    expect(onlyFactor.statusCode).toBe(400);
  });

  it("una unidad inactiva no se puede usar en una materia prima", async () => {
    const created = (
      await api.post("/api/units", {
        code: "atado",
        name: "Atado",
        symbol: "at",
        dimension: "OTHER",
      })
    ).json();
    await api.patch(`/api/units/${created.id}`, { active: false });
    const category = (
      await api.post("/api/categories", { type: "RAW_MATERIAL", name: "Varios" })
    ).json();
    const res = await api.post("/api/raw-materials", {
      name: "Perejil",
      categoryId: category.id,
      baseUnitId: created.id,
    });
    expect(res.statusCode).toBe(422);
  });

  it("valida la cantidad a convertir", async () => {
    expect((await convert("kg", "g", "abc")).statusCode).toBe(400);
    expect((await convert("kg", "g", "-1")).statusCode).toBe(400);
  });
});
