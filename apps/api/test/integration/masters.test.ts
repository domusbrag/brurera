import { auditLogs } from "@bakery/database";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  clientFor,
  createTestContext,
  type ApiClient,
  type TestContext,
} from "./helpers.js";

/*
 * Maestros comerciales y de catálogo: alta con código automático o manual,
 * búsqueda, paginación, edición, desactivación sin borrado y auditoría.
 */

let ctx: TestContext;
let api: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
});
afterAll(() => ctx.close());

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await ctx.database.db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityId, entityId)))
    .orderBy(auditLogs.id);
  return rows.map((r) => r.action);
}

async function unitId(code: string): Promise<string> {
  const res = await api.get(`/api/units?search=${code}&pageSize=100`);
  const unit = res.json().items.find((u: { code: string }) => u.code === code);
  if (!unit) throw new Error(`unidad ${code}`);
  return unit.id;
}

describe("clientes", () => {
  it("alta con código automático CLI-0001, CLI-0002…", async () => {
    const a = await api.post("/api/customers", { type: "RETAILER", legalName: "Almacén Uno" });
    const b = await api.post("/api/customers", { type: "CONSUMER", legalName: "Juana Pérez" });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ code: "CLI-0001", active: true, commercialCondition: "CASH" });
    expect(b.json().code).toBe("CLI-0002");
    expect(a.json()).not.toHaveProperty("companyId");
  });

  it("código manual en mayúsculas; duplicado → 409 CODE_TAKEN", async () => {
    const ok = await api.post("/api/customers", {
      code: "may-01",
      type: "WHOLESALER",
      legalName: "Mayorista",
    });
    expect(ok.json().code).toBe("MAY-01");
    const dup = await api.post("/api/customers", {
      code: "MAY-01",
      type: "OTHER",
      legalName: "Otro",
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CODE_TAKEN");
  });

  it("el nombre y el CUIT no son únicos (dos clientes pueden compartirlos)", async () => {
    const one = await api.post("/api/customers", {
      type: "OTHER",
      legalName: "Repetido",
      taxId: "20-1",
    });
    const two = await api.post("/api/customers", {
      type: "OTHER",
      legalName: "Repetido",
      taxId: "20-1",
    });
    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
  });

  it("valida tipo, email y límite de crédito decimal", async () => {
    const res = await api.post("/api/customers", {
      type: "VIP",
      legalName: "",
      email: "no-es-mail",
      creditLimit: "12.345",
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["type", "legalName", "email", "creditLimit"]));
  });

  it("busca por nombre, código o CUIT y pagina en el servidor", async () => {
    const byName = await api.get("/api/customers?search=almac");
    expect(byName.json().items.map((c: { legalName: string }) => c.legalName)).toEqual([
      "Almacén Uno",
    ]);
    const byCode = await api.get("/api/customers?search=cli-0002");
    expect(byCode.json().total).toBe(1);
    const page = await api.get("/api/customers?page=2&pageSize=2");
    // 5 creados + Consumidor Final (Fase 5B, uno por empresa).
    expect(page.json()).toMatchObject({ page: 2, pageSize: 2, total: 6 });
    expect(page.json().items).toHaveLength(2);
  });

  it("la búsqueda trata % y _ como texto literal", async () => {
    const res = await api.get("/api/customers?search=%25");
    expect(res.json().total).toBe(0);
  });

  it("edita, desactiva (sin borrar), filtra por estado y reactiva, con auditoría", async () => {
    const created = (
      await api.post("/api/customers", { type: "RETAILER", legalName: "Kiosco Sol" })
    ).json();
    const edited = await api.patch(`/api/customers/${created.id}`, {
      phone: "341-555",
      creditLimit: "150000.50",
      commercialCondition: "CURRENT_ACCOUNT",
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ phone: "341-555", creditLimit: "150000.50" });

    const off = await api.post(`/api/customers/${created.id}/deactivate`);
    expect(off.json().active).toBe(false);
    expect((await api.get("/api/customers?search=Kiosco")).json().total).toBe(0);
    expect((await api.get("/api/customers?search=Kiosco&status=inactive")).json().total).toBe(1);
    expect((await api.get(`/api/customers/${created.id}`)).statusCode).toBe(200);

    const on = await api.post(`/api/customers/${created.id}/activate`);
    expect(on.json().active).toBe(true);
    expect(await auditActions(created.id)).toEqual([
      "CUSTOMER_CREATED",
      "CUSTOMER_UPDATED",
      "CUSTOMER_DEACTIVATED",
      "CUSTOMER_REACTIVATED",
    ]);
  });

  it("no existe DELETE", async () => {
    const [first] = (await api.get("/api/customers")).json().items;
    expect((await api.delete(`/api/customers/${first.id}`)).statusCode).toBe(404);
  });

  it("id inexistente o mal formado → 404", async () => {
    expect((await api.get("/api/customers/00000000-0000-4000-8000-000000000000")).statusCode).toBe(
      404,
    );
    expect((await api.get("/api/customers/no-es-uuid")).statusCode).toBe(404);
  });
});

describe("proveedores", () => {
  it("alta PROV-0001, edición, desactivación y auditoría", async () => {
    const res = await api.post("/api/suppliers", {
      legalName: "Molino Norte S.A.",
      contactName: "Raúl",
      paymentTerms: "30 días",
    });
    expect(res.statusCode).toBe(201);
    const supplier = res.json();
    expect(supplier.code).toBe("PROV-0001");
    await api.patch(`/api/suppliers/${supplier.id}`, { phone: "0800" });
    await api.post(`/api/suppliers/${supplier.id}/deactivate`);
    expect((await api.get(`/api/suppliers/${supplier.id}`)).json()).toMatchObject({
      phone: "0800",
      active: false,
    });
    expect(await auditActions(supplier.id)).toEqual([
      "SUPPLIER_CREATED",
      "SUPPLIER_UPDATED",
      "SUPPLIER_DEACTIVATED",
    ]);
  });

  it("busca por contacto y por código", async () => {
    expect((await api.get("/api/suppliers?search=raúl&status=all")).json().total).toBe(1);
    expect((await api.get("/api/suppliers?search=PROV-0001&status=all")).json().total).toBe(1);
  });
});

describe("depósitos", () => {
  it("la empresa nace con el Depósito Principal (DEP-0001)", async () => {
    const res = await api.get("/api/warehouses");
    expect(res.json().items).toEqual([
      expect.objectContaining({ code: "DEP-0001", name: "Depósito Principal", active: true }),
    ]);
  });

  it("alta DEP-0002; código duplicado → 409", async () => {
    const res = await api.post("/api/warehouses", { name: "Cámara de frío" });
    expect(res.json().code).toBe("DEP-0002");
    const dup = await api.post("/api/warehouses", { code: "DEP-0002", name: "Otro" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CODE_TAKEN");
  });

  it("edita y desactiva con auditoría", async () => {
    const created = (await api.post("/api/warehouses", { name: "Local centro" })).json();
    await api.patch(`/api/warehouses/${created.id}`, { address: "San Martín 100" });
    await api.post(`/api/warehouses/${created.id}/deactivate`);
    expect(await auditActions(created.id)).toEqual([
      "WAREHOUSE_CREATED",
      "WAREHOUSE_UPDATED",
      "WAREHOUSE_DEACTIVATED",
    ]);
  });
});

describe("categorías", () => {
  it("una sola abstracción con tipo; nombre único por empresa y tipo (sin distinguir mayúsculas)", async () => {
    const mp = await api.post("/api/categories", { type: "RAW_MATERIAL", name: "Harinas" });
    expect(mp.statusCode).toBe(201);
    const dup = await api.post("/api/categories", { type: "RAW_MATERIAL", name: "HARINAS" });
    expect(dup.statusCode).toBe(409);
    const sameNameOtherType = await api.post("/api/categories", {
      type: "PRODUCT",
      name: "Harinas",
    });
    expect(sameNameOtherType.statusCode).toBe(201);
  });

  it("filtra por tipo y audita altas y cambios", async () => {
    const res = await api.get("/api/categories?type=PRODUCT");
    expect(res.json().items.every((c: { type: string }) => c.type === "PRODUCT")).toBe(true);
    const cat = (await api.post("/api/categories", { type: "PRODUCT", name: "Panes" })).json();
    await api.patch(`/api/categories/${cat.id}`, { sortOrder: 3 });
    expect(await auditActions(cat.id)).toEqual(["CATEGORY_CREATED", "CATEGORY_UPDATED"]);
  });
});

describe("materias primas y productos", () => {
  let mpCategory: string;
  let productCategory: string;

  beforeAll(async () => {
    mpCategory = (
      await api.post("/api/categories", { type: "RAW_MATERIAL", name: "Grasas" })
    ).json().id;
    productCategory = (
      await api.post("/api/categories", { type: "PRODUCT", name: "Facturas" })
    ).json().id;
  });

  it("materia prima: MP-0001, costo decimal exacto, sin campo de stock", async () => {
    const res = await api.post("/api/raw-materials", {
      name: "Margarina",
      categoryId: mpCategory,
      baseUnitId: await unitId("kg"),
      minimumStock: "12.5",
      referenceCost: "1234.567891",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      code: "MP-0001",
      minimumStock: "12.5000",
      referenceCost: "1234.567891",
      referenceCostSource: "MANUAL_REFERENCE",
      baseUnit: { code: "kg" },
      category: { name: "Grasas" },
    });
    expect(body).not.toHaveProperty("currentStock");
    expect(body).not.toHaveProperty("stock");
  });

  it("materia prima: la unidad base debe ser raíz (g → 422)", async () => {
    const res = await api.post("/api/raw-materials", {
      name: "Sal",
      categoryId: mpCategory,
      baseUnitId: await unitId("g"),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("INVALID_REFERENCE");
  });

  it("materia prima: una categoría de productos se rechaza (422)", async () => {
    const res = await api.post("/api/raw-materials", {
      name: "Azúcar",
      categoryId: productCategory,
      baseUnitId: await unitId("kg"),
    });
    expect(res.statusCode).toBe(422);
  });

  it("materia prima: proveedor preferido inactivo se rechaza", async () => {
    const supplier = (await api.post("/api/suppliers", { legalName: "Dado de baja" })).json();
    await api.post(`/api/suppliers/${supplier.id}/deactivate`);
    const res = await api.post("/api/raw-materials", {
      name: "Manteca",
      categoryId: mpCategory,
      baseUnitId: await unitId("kg"),
      preferredSupplierId: supplier.id,
    });
    expect(res.statusCode).toBe(422);
  });

  it("materia prima: edita y desactiva con auditoría", async () => {
    const [mp] = (await api.get("/api/raw-materials?search=Margarina")).json().items;
    await api.patch(`/api/raw-materials/${mp.id}`, { minimumStock: "15" });
    await api.put(`/api/raw-materials/${mp.id}/reference-cost`, { referenceCost: "1300" });
    await api.post(`/api/raw-materials/${mp.id}/deactivate`);
    expect(await auditActions(mp.id)).toEqual([
      "RAW_MATERIAL_CREATED",
      "RAW_MATERIAL_UPDATED",
      "RAW_MATERIAL_REFERENCE_COST_CHANGED",
      "RAW_MATERIAL_DEACTIVATED",
    ]);
  });

  it("producto: PROD-0001, precio decimal, sin costo manual", async () => {
    const res = await api.post("/api/products", {
      name: "Medialuna",
      categoryId: productCategory,
      saleUnitId: await unitId("docena"),
      salePrice: "3600.5",
      cost: "999",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      code: "PROD-0001",
      salePrice: "3600.50",
      controlsStock: true,
      saleUnit: { code: "docena" },
    });
    expect(res.json()).not.toHaveProperty("cost");
  });

  it("producto: categoría de materias primas se rechaza y precio negativo es inválido", async () => {
    const wrongCategory = await api.post("/api/products", {
      name: "X",
      categoryId: mpCategory,
      saleUnitId: await unitId("unidad"),
      salePrice: "1",
    });
    expect(wrongCategory.statusCode).toBe(422);
    const negative = await api.post("/api/products", {
      name: "X",
      categoryId: productCategory,
      saleUnitId: await unitId("unidad"),
      salePrice: "-1",
    });
    expect(negative.statusCode).toBe(400);
  });

  it("producto: edita precio, desactiva y reactiva con auditoría", async () => {
    const [p] = (await api.get("/api/products?search=medialuna")).json().items;
    await api.patch(`/api/products/${p.id}`, { salePrice: "3800" });
    await api.post(`/api/products/${p.id}/deactivate`);
    await api.post(`/api/products/${p.id}/activate`);
    expect(await auditActions(p.id)).toEqual([
      "PRODUCT_CREATED",
      "PRODUCT_UPDATED",
      "PRODUCT_DEACTIVATED",
      "PRODUCT_REACTIVATED",
    ]);
  });

  it("filtra productos por categoría", async () => {
    const res = await api.get(`/api/products?categoryId=${productCategory}&status=all`);
    expect(res.json().total).toBe(1);
  });
});
