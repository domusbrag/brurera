import { auditLogs, users } from "@bakery/database";
import { SYSTEM_ROLES } from "@bakery/shared";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  SELLER,
  WEB_ORIGIN,
  apiClient,
  clientFor,
  createTestContext,
  loginAs,
  type ApiClient,
  type TestContext,
} from "./helpers.js";

/* Empresa, empleados, usuarios (membresía), roles y permisos efectivos. */

let ctx: TestContext;
let api: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  api = await clientFor(ctx.app, ADMIN);
});
afterAll(() => ctx.close());

const roleId = async (code: string): Promise<string> => {
  const role = (await api.get("/api/roles")).json().find((r: { code: string }) => r.code === code);
  if (!role) throw new Error(`rol ${code}`);
  return role.id;
};

const login = (email: string, password: string) =>
  ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: WEB_ORIGIN },
    payload: { email, password },
  });

describe("empresa", () => {
  it("lee los datos de la empresa de la sesión, sin ids internos", async () => {
    const res = await api.get("/api/company");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      tradeName: "Panadería Test",
      currencyCode: "ARS",
      timezone: "America/Argentina/Buenos_Aires",
      active: true,
    });
    expect(res.json()).not.toHaveProperty("id");
  });

  it("edita con validación y audita COMPANY_UPDATED con el detalle del cambio", async () => {
    const bad = await api.patch("/api/company", {
      timezone: "Marte/Olympus",
      currencyCode: "pesos",
    });
    expect(bad.statusCode).toBe(400);
    const ok = await api.patch("/api/company", { city: "Rosario", phone: "341-000" });
    expect(ok.json()).toMatchObject({ city: "Rosario", phone: "341-000" });
    const [last] = await ctx.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "COMPANY_UPDATED"))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(last?.metadata).toMatchObject({ changes: { city: { from: null, to: "Rosario" } } });
  });

  it("guardar el formulario completo con los valores por defecto funciona", async () => {
    const current = (await api.get("/api/company")).json();
    const { active: _active, updatedAt: _updatedAt, ...form } = current;
    const res = await api.patch("/api/company", form);
    expect(res.statusCode).toBe(200);
    expect(res.json().timezone).toBe("America/Argentina/Buenos_Aires");
  });

  it("sin company.update no puede editar (VENTAS → 403)", async () => {
    const seller = await clientFor(ctx.app, SELLER);
    expect((await seller.patch("/api/company", { city: "X" })).statusCode).toBe(403);
  });
});

describe("empleados", () => {
  it("alta EMP-0001; un empleado existe sin usuario", async () => {
    const res = await api.post("/api/employees", {
      firstName: "Ana",
      lastName: "Panadera",
      documentType: "DNI",
      documentNumber: "30111222",
      position: "Maestra panadera",
      hireDate: "2024-03-01",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ code: "EMP-0001", status: "ACTIVE", access: null });
  });

  it("documento duplicado en la empresa → 409 DOCUMENT_TAKEN", async () => {
    const res = await api.post("/api/employees", {
      firstName: "Otra",
      lastName: "Persona",
      documentNumber: "30111222",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DOCUMENT_TAKEN");
  });

  it("busca por nombre, apellido, código o documento", async () => {
    for (const q of ["ana", "PANADERA", "EMP-0001", "30111"]) {
      expect((await api.get(`/api/employees?search=${q}`)).json().total, q).toBe(1);
    }
  });

  it("baja: INACTIVE con fecha de egreso, no se borra y queda auditada", async () => {
    const emp = (
      await api.post("/api/employees", { firstName: "Luis", lastName: "Temporal" })
    ).json();
    const off = await api.post(`/api/employees/${emp.id}/deactivate`, {
      terminationDate: "2026-01-15",
    });
    expect(off.json()).toMatchObject({ status: "INACTIVE", terminationDate: "2026-01-15" });
    expect((await api.get("/api/employees?search=Temporal")).json().total).toBe(0);
    expect((await api.get("/api/employees?search=Temporal&status=inactive")).json().total).toBe(1);
    const on = await api.post(`/api/employees/${emp.id}/activate`);
    expect(on.json()).toMatchObject({ status: "ACTIVE", terminationDate: null });
  });

  it("baja sin fecha usa hoy; egreso anterior al ingreso → 400", async () => {
    const emp = (
      await api.post("/api/employees", {
        firstName: "Eva",
        lastName: "Fechas",
        hireDate: "2025-06-01",
      })
    ).json();
    const bad = await api.post(`/api/employees/${emp.id}/deactivate`, {
      terminationDate: "2025-01-01",
    });
    expect(bad.statusCode).toBe(400);
    const ok = await api.post(`/api/employees/${emp.id}/deactivate`);
    expect(ok.json().terminationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("usuarios y membresía", () => {
  const NEW_USER = { email: "juan@test.local", password: "juan-password-1" };
  let employeeId: string;
  let userId: string;

  beforeAll(async () => {
    employeeId = (
      await api.post("/api/employees", { firstName: "Juan", lastName: "Mostrador" })
    ).json().id;
  });

  it("crea el acceso de un empleado con rol inicial; nunca expone el hash", async () => {
    const res = await api.post("/api/users", {
      email: "Juan@Test.local",
      password: NEW_USER.password,
      employeeId,
      roleIds: [await roleId("SALES")],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    userId = body.id;
    expect(body).toMatchObject({
      email: NEW_USER.email,
      displayName: "Juan Mostrador",
      status: "ACTIVE",
      employee: { id: employeeId, code: expect.stringMatching(/^EMP-/) },
      roles: [expect.objectContaining({ code: "SALES" })],
    });
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|argon2|juan-password/);
    const [stored] = await ctx.database.db.select().from(users).where(eq(users.id, userId));
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("la contraseña no queda en la auditoría", async () => {
    const [created] = await ctx.database.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "USER_CREATED"), eq(auditLogs.entityId, userId)));
    expect(JSON.stringify(created)).not.toContain(NEW_USER.password);
  });

  it("el empleado muestra su acceso; un segundo acceso para el mismo empleado → 409", async () => {
    expect((await api.get(`/api/employees/${employeeId}`)).json().access).toMatchObject({
      email: NEW_USER.email,
      status: "ACTIVE",
    });
    const dup = await api.post("/api/users", {
      email: "otro@test.local",
      password: "otra-password-1",
      employeeId,
      roleIds: [await roleId("SALES")],
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("EMPLOYEE_ALREADY_LINKED");
  });

  it("email duplicado → 409 EMAIL_TAKEN; contraseña corta o sin rol → 400", async () => {
    const dup = await api.post("/api/users", {
      email: ADMIN.email,
      password: "password-larga",
      roleIds: [await roleId("SALES")],
    });
    expect(dup.json().error.code).toBe("EMAIL_TAKEN");
    const weak = await api.post("/api/users", {
      email: "x@test.local",
      password: "corta",
      roleIds: [],
    });
    expect(weak.statusCode).toBe(400);
  });

  it("el usuario nuevo inicia sesión y recibe los permisos efectivos de su rol", async () => {
    const detail = (await api.get(`/api/users/${userId}`)).json();
    const sales = SYSTEM_ROLES.find((r) => r.code === "SALES")!;
    expect([...detail.permissions].sort()).toEqual([...sales.permissions].sort());
    expect((await login(NEW_USER.email, NEW_USER.password)).statusCode).toBe(200);
  });

  it("asignar roles cambia los permisos en el próximo request y audita USER_ROLE_CHANGED", async () => {
    const cookie = await loginAs(ctx.app, NEW_USER);
    const juan = apiClient(ctx.app, cookie);
    expect((await juan.get("/api/suppliers")).statusCode).toBe(403);
    const res = await api.put(`/api/users/${userId}/roles`, {
      roleIds: [await roleId("SALES"), await roleId("PURCHASING")],
    });
    expect(res.json().roles.map((r: { code: string }) => r.code)).toEqual(["PURCHASING", "SALES"]);
    expect((await juan.get("/api/suppliers")).statusCode).toBe(200);
    const [audit] = await ctx.database.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "USER_ROLE_CHANGED"), eq(auditLogs.entityId, userId)));
    expect(audit?.metadata).toEqual({ from: ["SALES"], to: ["PURCHASING", "SALES"] });
  });

  it("no puede cambiar sus propios roles ni desactivarse", async () => {
    const me = (await api.get("/api/auth/me")).json().user;
    const roles = await api.put(`/api/users/${me.id}/roles`, { roleIds: [await roleId("SALES")] });
    expect(roles.json().error.code).toBe("CANNOT_MODIFY_SELF");
    expect((await api.post(`/api/users/${me.id}/deactivate`)).json().error.code).toBe(
      "CANNOT_MODIFY_SELF",
    );
  });

  it("desactivar el usuario cierra sus sesiones y rechaza el login", async () => {
    const cookie = await loginAs(ctx.app, NEW_USER);
    const juan = apiClient(ctx.app, cookie);
    const off = await api.post(`/api/users/${userId}/deactivate`);
    expect(off.json().status).toBe("DISABLED");
    expect((await juan.get("/api/auth/me")).statusCode).toBe(401);
    const res = await login(NEW_USER.email, NEW_USER.password);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
    // Reactivar devuelve el acceso.
    await api.post(`/api/users/${userId}/activate`);
    expect((await login(NEW_USER.email, NEW_USER.password)).statusCode).toBe(200);
  });

  it("dar de baja al empleado desactiva su acceso; reactivar el acceso exige empleado activo", async () => {
    const cookie = await loginAs(ctx.app, NEW_USER);
    await api.post(`/api/employees/${employeeId}/deactivate`);
    expect((await apiClient(ctx.app, cookie).get("/api/auth/me")).statusCode).toBe(401);
    expect((await api.get(`/api/users/${userId}`)).json().status).toBe("DISABLED");
    const reactivate = await api.post(`/api/users/${userId}/activate`);
    expect(reactivate.statusCode).toBe(409);
    expect(reactivate.json().error.code).toBe("EMPLOYEE_INACTIVE");
  });

  it("un empleado dado de baja no se puede vincular a un usuario nuevo", async () => {
    const res = await api.post("/api/users", {
      email: "nuevo@test.local",
      password: "password-larga",
      employeeId,
      roleIds: [await roleId("SALES")],
    });
    expect(res.statusCode).toBe(422);
  });

  it("un usuario puede existir sin empleado", async () => {
    const res = await api.post("/api/users", {
      email: "contador@test.local",
      displayName: "Estudio contable",
      password: "password-larga",
      roleIds: [await roleId("ADMINISTRATION")],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().employee).toBeNull();
  });

  it("lista y busca usuarios de la empresa", async () => {
    const res = await api.get("/api/users?search=contador");
    expect(res.json().items).toHaveLength(1);
    const all = await api.get("/api/users?pageSize=100&status=all");
    expect(all.json().items.map((u: { email: string }) => u.email)).toEqual(
      expect.arrayContaining([ADMIN.email, SELLER.email, NEW_USER.email]),
    );
  });
});

describe("roles", () => {
  it("lista los 7 roles de sistema con su matriz de permisos", async () => {
    const res = await api.get("/api/roles");
    expect(res.statusCode).toBe(200);
    const roles = res.json();
    expect(roles.map((r: { code: string }) => r.code).sort()).toEqual(
      SYSTEM_ROLES.map((r) => r.code).sort(),
    );
    for (const def of SYSTEM_ROLES) {
      const role = roles.find((r: { code: string }) => r.code === def.code);
      expect([...role.permissions].sort(), def.code).toEqual([...def.permissions].sort());
    }
  });
});
