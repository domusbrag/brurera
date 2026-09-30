/**
 * Seed SOLO para desarrollo. Crea la empresa demo, sincroniza permisos/roles y
 * un usuario administrador. Idempotente. Se niega a correr en producción.
 * El código productivo no depende de ninguno de estos datos.
 */
import {
  companies,
  createDatabase,
  employees,
  findRoleIdsByCode,
  loadRootEnv,
  requireDatabaseUrl,
  syncPermissionCatalog,
  syncSystemRoles,
  userRoles,
  users,
} from "@bakery/database";
import { eq, sql } from "drizzle-orm";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../modules/auth/password.js";

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
const handle = createDatabase(requireDatabaseUrl(), { max: 1 });

try {
  const passwordHash = await hashPassword(password);
  await handle.db.transaction(async (tx) => {
    await syncPermissionCatalog(tx);

    let [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.taxId, DEMO_TAX_ID))
      .limit(1);
    company ??= (
      await tx
        .insert(companies)
        .values({
          legalName: "Panificadora Demo S.R.L.",
          tradeName: "Panificadora Demo",
          taxId: DEMO_TAX_ID,
          address: "Av. Siempreviva 742",
          email: "contacto@panificadora.local",
        })
        .returning()
    )[0];
    if (!company) throw new Error("No se pudo crear la empresa demo");

    await syncSystemRoles(tx, company.id);

    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (existing) {
      console.log(
        JSON.stringify({ level: "info", msg: "seed: admin ya existe, no se modifica", email }),
      );
      return;
    }

    const [employee] = await tx
      .insert(employees)
      .values({
        companyId: company.id,
        firstName: "Admin",
        lastName: "Sistema",
        position: "Administrador",
      })
      .returning({ id: employees.id });
    const [admin] = await tx
      .insert(users)
      .values({
        companyId: company.id,
        employeeId: employee?.id,
        email,
        displayName: "Admin Sistema",
        passwordHash,
      })
      .returning({ id: users.id });
    if (!admin) throw new Error("No se pudo crear el usuario administrador");

    const roleIds = await findRoleIdsByCode(tx, company.id, ["ADMIN"]);
    const adminRoleId = roleIds.get("ADMIN");
    if (!adminRoleId) throw new Error("Rol ADMIN inexistente");
    await tx.insert(userRoles).values({ userId: admin.id, roleId: adminRoleId });

    console.log(JSON.stringify({ level: "info", msg: "seed: admin creado", email }));
  });
} finally {
  await handle.close();
}
