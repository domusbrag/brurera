import { describe, expect, it } from "vitest";
import {
  createCustomerSchema,
  createEmployeeSchema,
  createProductSchema,
  createRawMaterialSchema,
  createUnitSchema,
  createUserSchema,
  updateCompanySchema,
  updateCustomerSchema,
} from "../src/masters";
import { effectivePermissions, hasPermissions, PERMISSIONS } from "../src/permissions";
import { SYSTEM_ROLES } from "../src/roles";
import { listQuerySchema } from "../src/validation";

const UUID = "00000000-0000-4000-8000-000000000000";

describe("validaciones de maestros", () => {
  it("normaliza textos opcionales vacíos a null y códigos a mayúsculas", () => {
    const parsed = createCustomerSchema.parse({
      code: " cli-a1 ",
      type: "CONSUMER",
      legalName: "  Ana  ",
      email: "",
      phone: "  ",
    });
    expect(parsed).toMatchObject({ code: "CLI-A1", legalName: "Ana", email: null, phone: null });
  });

  it("rechaza códigos con espacios o símbolos", () => {
    expect(
      createCustomerSchema.safeParse({ code: "CLI 1", type: "OTHER", legalName: "x" }).success,
    ).toBe(false);
  });

  it("dinero: máximo 2 decimales, acepta coma decimal, nunca negativo", () => {
    const base = { name: "Pan", categoryId: UUID, saleUnitId: UUID };
    expect(createProductSchema.parse({ ...base, salePrice: "1500,5" }).salePrice).toBe("1500.5");
    expect(createProductSchema.safeParse({ ...base, salePrice: "1.234" }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...base, salePrice: "-1" }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...base, salePrice: "1e3" }).success).toBe(false);
  });

  it("costo por unidad base admite 6 decimales; cantidades 4", () => {
    const base = { name: "Harina", categoryId: UUID, baseUnitId: UUID };
    expect(createRawMaterialSchema.parse({ ...base, currentCost: "0.123456" }).currentCost).toBe(
      "0.123456",
    );
    expect(createRawMaterialSchema.safeParse({ ...base, currentCost: "0.1234567" }).success).toBe(
      false,
    );
    expect(createRawMaterialSchema.safeParse({ ...base, minimumStock: "1.12345" }).success).toBe(
      false,
    );
  });

  it("unidad derivada: base y factor van juntos; factor > 0", () => {
    const base = { code: "b", name: "B", symbol: "b", dimension: "MASS" };
    expect(createUnitSchema.safeParse({ ...base, baseUnitId: UUID }).success).toBe(false);
    expect(createUnitSchema.safeParse({ ...base, conversionFactor: "2" }).success).toBe(false);
    expect(
      createUnitSchema.safeParse({ ...base, baseUnitId: UUID, conversionFactor: "0" }).success,
    ).toBe(false);
    expect(
      createUnitSchema.safeParse({ ...base, baseUnitId: UUID, conversionFactor: "0.5" }).success,
    ).toBe(true);
  });

  it("usuario: email normalizado, contraseña mínima y distinta del email, al menos un rol", () => {
    const ok = createUserSchema.parse({
      email: " Ana@X.com ",
      password: "una-clave-1",
      roleIds: [UUID],
    });
    expect(ok.email).toBe("ana@x.com");
    expect(
      createUserSchema.safeParse({ email: "a@x.com", password: "corta", roleIds: [UUID] }).success,
    ).toBe(false);
    expect(
      createUserSchema.safeParse({
        email: "abcdefghij@x.com",
        password: "abcdefghij@x.com",
        roleIds: [UUID],
      }).success,
    ).toBe(false);
    expect(
      createUserSchema.safeParse({ email: "a@x.com", password: "una-clave-1", roleIds: [] })
        .success,
    ).toBe(false);
  });

  it("empleado: fecha de ingreso AAAA-MM-DD", () => {
    expect(
      createEmployeeSchema.safeParse({ firstName: "A", lastName: "B", hireDate: "01/02/2024" })
        .success,
    ).toBe(false);
    expect(
      createEmployeeSchema.parse({ firstName: "A", lastName: "B", hireDate: "2024-02-01" })
        .hireDate,
    ).toBe("2024-02-01");
  });

  it("empresa: zona horaria y moneda válidas", () => {
    expect(
      updateCompanySchema.safeParse({ timezone: "America/Argentina/Buenos_Aires" }).success,
    ).toBe(true);
    expect(updateCompanySchema.safeParse({ timezone: "America/Argentina/Cordoba" }).success).toBe(
      true,
    );
    expect(updateCompanySchema.safeParse({ timezone: "UTC" }).success).toBe(true);
    expect(updateCompanySchema.safeParse({ timezone: "Marte/Base" }).success).toBe(false);
    expect(updateCompanySchema.parse({ currencyCode: "usd" }).currencyCode).toBe("USD");
  });

  it("una edición sin campos es inválida", () => {
    expect(updateCustomerSchema.safeParse({}).success).toBe(false);
    expect(updateCompanySchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it("listados: estado por defecto activos y pageSize máximo 100", () => {
    expect(listQuerySchema.parse({})).toMatchObject({ status: "active", page: 1, pageSize: 25 });
    expect(listQuerySchema.safeParse({ pageSize: "500" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ status: "borrados" }).success).toBe(false);
  });
});

describe("permisos efectivos", () => {
  it("son la unión de los permisos de todos los roles de la membresía", () => {
    const sales = SYSTEM_ROLES.find((r) => r.code === "SALES")!;
    const purchasing = SYSTEM_ROLES.find((r) => r.code === "PURCHASING")!;
    const effective = effectivePermissions([sales, purchasing]);
    expect(
      hasPermissions(effective, [PERMISSIONS.CUSTOMERS_CREATE, PERMISSIONS.SUPPLIERS_CREATE]),
    ).toBe(true);
    expect(effective.size).toBe(new Set([...sales.permissions, ...purchasing.permissions]).size);
  });

  it("sin roles no hay permisos", () => {
    expect(effectivePermissions([]).size).toBe(0);
  });
});
