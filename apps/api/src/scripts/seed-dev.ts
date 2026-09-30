/**
 * Seed SOLO para desarrollo. Crea la empresa demo (con roles, unidades y depósito
 * principal), un administrador y algunos maestros de ejemplo. Idempotente: si la
 * empresa demo ya existe no modifica nada. Se niega a correr en producción.
 * El código productivo no depende de ninguno de estos datos.
 */
import {
  companies,
  companyMemberships,
  createDatabase,
  loadRootEnv,
  provisionCompany,
  requireDatabaseUrl,
  syncPermissionCatalog,
  syncSystemRoles,
  unitsOfMeasure,
  users,
} from "@bakery/database";
import {
  createCategorySchema,
  createCustomerSchema,
  createEmployeeSchema,
  createProductSchema,
  createRawMaterialSchema,
  createSupplierSchema,
} from "@bakery/shared";
import { and, eq, sql } from "drizzle-orm";
import type { OperationContext } from "../lib/context.js";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../modules/auth/password.js";
import { createCategory } from "../modules/categories/categories.service.js";
import { createCustomer } from "../modules/customers/customers.service.js";
import { createEmployee } from "../modules/employees/employees.service.js";
import { createProduct } from "../modules/products/products.service.js";
import { createRawMaterial } from "../modules/raw-materials/raw-materials.service.js";
import { createSupplier } from "../modules/suppliers/suppliers.service.js";
import { createAdminAccess } from "./admin-access.js";

loadRootEnv();
if (process.env.NODE_ENV === "production") {
  throw new Error("seed-dev no puede ejecutarse con NODE_ENV=production");
}

const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@panificadora.local").toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";
if (password.length < MIN_PASSWORD_LENGTH) {
  throw new Error(`SEED_ADMIN_PASSWORD debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
}

const DEMO_TAX_ID = "30-00000000-0";
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: "info", msg: `seed: ${msg}`, ...extra }));

const handle = createDatabase(requireDatabaseUrl(), { max: 1 });
const { db } = handle;

try {
  const [existingCompany] = await db
    .select()
    .from(companies)
    .where(eq(companies.taxId, DEMO_TAX_ID))
    .limit(1);
  if (existingCompany) {
    // Mantiene al día permisos y roles de sistema aunque la empresa ya exista.
    await db.transaction(async (tx) => {
      await syncPermissionCatalog(tx);
      await syncSystemRoles(tx, existingCompany.id);
    });
    log("empresa demo ya existe, no se modifican datos");
  } else {
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);
    if (taken) throw new Error(`El email ${email} ya está en uso por otro usuario`);

    const passwordHash = await hashPassword(password);
    const { company, userId, membershipId } = await db.transaction(async (tx) => {
      const company = await provisionCompany(tx, {
        legalName: "Panificadora Demo S.R.L.",
        tradeName: "Panificadora Demo",
        taxId: DEMO_TAX_ID,
        email: "contacto@panificadora.local",
      });
      await tx
        .update(companies)
        .set({ address: "Av. Siempreviva 742", city: "Rosario", province: "Santa Fe" })
        .where(eq(companies.id, company.id));
      const access = await createAdminAccess(tx, company.id, {
        email,
        displayName: "Administrador Demo",
        passwordHash,
      });
      return { company, ...access };
    });

    const ctx: OperationContext = {
      companyId: company.id,
      userId,
      timezone: company.timezone,
      requestId: "seed-dev",
      ipAddress: "127.0.0.1",
    };

    const employee = await createEmployee(
      db,
      ctx,
      createEmployeeSchema.parse({
        firstName: "Administrador",
        lastName: "Demo",
        position: "Administración",
        email,
      }),
    );
    await db
      .update(companyMemberships)
      .set({ employeeId: employee.id })
      .where(eq(companyMemberships.id, membershipId));

    const categoryIds = new Map<string, string>();
    for (const [type, names] of [
      ["RAW_MATERIAL", ["Harinas", "Grasas", "Lácteos", "Levaduras", "Envases"]],
      ["PRODUCT", ["Panes", "Facturas", "Tortas", "Prepizzas"]],
    ] as const) {
      for (const [i, name] of names.entries()) {
        const category = await createCategory(
          db,
          ctx,
          createCategorySchema.parse({ type, name, sortOrder: i }),
        );
        categoryIds.set(name, category.id);
      }
    }

    await createCustomer(
      db,
      ctx,
      createCustomerSchema.parse({
        type: "RETAILER",
        legalName: "Supermercado Demo S.A.",
        tradeName: "Supermercado Demo",
        city: "Rosario",
      }),
    );
    const supplier = await createSupplier(
      db,
      ctx,
      createSupplierSchema.parse({
        legalName: "Molino Demo S.A.",
        tradeName: "Molino Demo",
        contactName: "Ventas Molino",
      }),
    );

    const unitId = async (code: string) => {
      const [u] = await db
        .select({ id: unitsOfMeasure.id })
        .from(unitsOfMeasure)
        .where(and(eq(unitsOfMeasure.companyId, company.id), eq(unitsOfMeasure.code, code)));
      if (!u) throw new Error(`Unidad estándar ${code} inexistente`);
      return u.id;
    };

    await createRawMaterial(
      db,
      ctx,
      createRawMaterialSchema.parse({
        name: "Harina 000",
        categoryId: categoryIds.get("Harinas"),
        baseUnitId: await unitId("kg"),
        minimumStock: "50",
        preferredSupplierId: supplier.id,
      }),
    );
    await createProduct(
      db,
      ctx,
      createProductSchema.parse({
        name: "Pan francés",
        categoryId: categoryIds.get("Panes"),
        saleUnitId: await unitId("kg"),
        salePrice: "2500.00",
      }),
    );
    log("empresa demo, administrador y maestros de ejemplo creados", { email });
  }
} finally {
  await handle.close();
}
