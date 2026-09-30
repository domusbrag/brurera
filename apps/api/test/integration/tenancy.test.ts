import { auditLogs } from "@bakery/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  ADMIN_B,
  clientFor,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";

/*
 * Aislamiento multiempresa (Empresa A / Empresa B). La empresa sale siempre de
 * la sesión: un id de la otra empresa se comporta como inexistente (404) al
 * leer o modificar, no aparece en listados ni búsquedas, y como referencia en
 * un alta se rechaza (422) sin revelar si existe.
 */

let ctx: TestContext;
let a: ApiClient;
let b: ApiClient;

const B: Record<string, string> = {};

beforeAll(async () => {
  ctx = await createTestContext();
  a = await clientFor(ctx.app, ADMIN);
  b = await clientFor(ctx.app, ADMIN_B);

  const units = (await b.get("/api/units?pageSize=100")).json().items;
  B.unitKg = units.find((u: { code: string }) => u.code === "kg").id;
  B.customer = (
    await b.post("/api/customers", { type: "RETAILER", legalName: "Cliente Secreto B" })
  ).json().id;
  B.supplier = (await b.post("/api/suppliers", { legalName: "Proveedor Secreto B" })).json().id;
  B.mpCategory = (
    await b.post("/api/categories", { type: "RAW_MATERIAL", name: "Harinas B" })
  ).json().id;
  B.productCategory = (
    await b.post("/api/categories", { type: "PRODUCT", name: "Panes B" })
  ).json().id;
  B.rawMaterial = (
    await b.post("/api/raw-materials", {
      name: "Harina Secreta B",
      categoryId: B.mpCategory,
      baseUnitId: B.unitKg,
    })
  ).json().id;
  B.product = (
    await b.post("/api/products", {
      name: "Pan Secreto B",
      categoryId: B.productCategory,
      saleUnitId: B.unitKg,
      salePrice: "10",
    })
  ).json().id;
  B.employee = (
    await b.post("/api/employees", { firstName: "Empleado", lastName: "SecretoB" })
  ).json().id;
  B.warehouse = (await b.get("/api/warehouses")).json().items[0].id;
  B.user = (await b.get("/api/auth/me")).json().user.id;
  B.role = (await b.get("/api/roles")).json()[0].id;
});
afterAll(() => ctx.close());

const RESOURCES: [string, string, Record<string, unknown>][] = [
  ["customers", "customer", { legalName: "Hackeado" }],
  ["suppliers", "supplier", { legalName: "Hackeado" }],
  ["raw-materials", "rawMaterial", { name: "Hackeado" }],
  ["products", "product", { name: "Hackeado" }],
  ["employees", "employee", { firstName: "Hackeado" }],
  ["warehouses", "warehouse", { name: "Hackeado" }],
  ["categories", "mpCategory", { name: "Hackeado" }],
  ["units", "unitKg", { name: "Hackeado" }],
  ["users", "user", { displayName: "Hackeado" }],
];

describe("aislamiento Empresa A / Empresa B", () => {
  it("cada empresa ve sus propios datos (sesiones distintas, empresas distintas)", async () => {
    expect((await a.get("/api/company")).json().tradeName).toBe("Panadería Test");
    expect((await b.get("/api/company")).json().tradeName).toBe("Panadería Otra");
  });

  for (const [path, key] of RESOURCES) {
    it(`${path}: A no puede leer por id un registro de B (404)`, async () => {
      const res = await a.get(`/api/${path}/${B[key]}`);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("Secreto");
    });
  }

  for (const [path, key, patch] of RESOURCES) {
    it(`${path}: A no puede modificar un registro de B (404) y B queda intacto`, async () => {
      const res = await a.patch(`/api/${path}/${B[key]}`, patch);
      expect(res.statusCode).toBe(404);
      const still = await b.get(`/api/${path}/${B[key]}`);
      expect(still.statusCode).toBe(200);
      expect(still.body).not.toContain("Hackeado");
    });
  }

  it("A no puede desactivar registros de B", async () => {
    for (const [path, key] of [
      ["customers", "customer"],
      ["suppliers", "supplier"],
      ["raw-materials", "rawMaterial"],
      ["products", "product"],
      ["employees", "employee"],
      ["warehouses", "warehouse"],
      ["users", "user"],
    ] as const) {
      expect((await a.post(`/api/${path}/${B[key]}/deactivate`)).statusCode, path).toBe(404);
    }
    expect((await b.get(`/api/customers/${B.customer}`)).json().active).toBe(true);
    expect((await b.get(`/api/employees/${B.employee}`)).json().status).toBe("ACTIVE");
  });

  it("A no puede inferir datos de B por búsqueda ni listados", async () => {
    for (const path of [
      "customers",
      "suppliers",
      "raw-materials",
      "products",
      "employees",
      "users",
    ]) {
      const res = await a.get(`/api/${path}?search=secreto&status=all`);
      expect(res.json().total, path).toBe(0);
    }
    const categories = await a.get("/api/categories?status=all&pageSize=100");
    expect(categories.body).not.toContain("Harinas B");
  });

  it("A no puede usar referencias de B (categoría, unidad, proveedor) → 422", async () => {
    const own = (await a.post("/api/categories", { type: "RAW_MATERIAL", name: "Propia" })).json()
      .id;
    const ownKg = (await a.get("/api/units?search=kg"))
      .json()
      .items.find((u: { code: string }) => u.code === "kg").id;
    const cases = [
      { name: "x", categoryId: B.mpCategory, baseUnitId: ownKg },
      { name: "x", categoryId: own, baseUnitId: B.unitKg },
      { name: "x", categoryId: own, baseUnitId: ownKg, preferredSupplierId: B.supplier },
    ];
    for (const body of cases) {
      const res = await a.post("/api/raw-materials", body);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("INVALID_REFERENCE");
    }
    const derived = await a.post("/api/units", {
      code: "cruzada",
      name: "x",
      symbol: "x",
      dimension: "MASS",
      baseUnitId: B.unitKg,
      conversionFactor: "2",
    });
    expect(derived.statusCode).toBe(422);
  });

  it("A no puede vincular un empleado de B ni asignar roles de B", async () => {
    const ownRole = (await a.get("/api/roles"))
      .json()
      .find((r: { code: string }) => r.code === "SALES").id;
    const withForeignEmployee = await a.post("/api/users", {
      email: "cruzado@test.local",
      password: "password-larga",
      employeeId: B.employee,
      roleIds: [ownRole],
    });
    expect(withForeignEmployee.statusCode).toBe(422);
    const withForeignRole = await a.post("/api/users", {
      email: "cruzado2@test.local",
      password: "password-larga",
      roleIds: [B.role],
    });
    expect(withForeignRole.statusCode).toBe(422);
    const seller = (await a.get("/api/users?search=ventas")).json().items[0];
    const reassign = await a.put(`/api/users/${seller.id}/roles`, { roleIds: [B.role] });
    expect(reassign.statusCode).toBe(422);
  });

  it("la empresa no se puede elegir desde el cliente (companyId enviado se ignora)", async () => {
    const res = await a.post("/api/customers", {
      type: "OTHER",
      legalName: "Intento de inyección",
      companyId: ctx.companyBId,
    });
    expect(res.statusCode).toBe(201);
    expect((await b.get("/api/customers?search=inyecci&status=all")).json().total).toBe(0);
    expect((await a.get("/api/customers?search=inyecci")).json().total).toBe(1);
    const q = await a.get(`/api/customers?companyId=${ctx.companyBId}&search=secreto`);
    expect(q.json().total ?? 0).toBe(0);
  });

  it("la auditoría de A no incluye eventos de B", async () => {
    const res = await a.get("/api/audit-logs?pageSize=100");
    const bIds = new Set(Object.values(B));
    expect(res.json().items.some((i: { entityId: string }) => bIds.has(i.entityId))).toBe(false);
    const rows = await ctx.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, B.customer!));
    expect(rows.every((r) => r.companyId === ctx.companyBId)).toBe(true);
  });

  it("la base misma rechaza referencias cruzadas aunque la aplicación fallara (FK compuesta)", async () => {
    const { rawMaterials } = await import("@bakery/database");
    await expect(
      ctx.database.db.insert(rawMaterials).values({
        companyId: ctx.companyId,
        internalCode: "MP-9999",
        name: "Directo a la base",
        categoryId: B.mpCategory!,
        baseUnitId: B.unitKg!,
      }),
    ).rejects.toThrow();
  });
});
