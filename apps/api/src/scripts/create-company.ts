/**
 * Alta de una empresa y su primer administrador (apto para producción).
 * Lee los datos de variables de entorno para no dejar la contraseña en el
 * historial de la shell:
 *
 *   COMPANY_LEGAL_NAME, COMPANY_TRADE_NAME, [COMPANY_TAX_ID],
 *   ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD (mínimo 10 caracteres)
 *
 * Aborta si el email ya existe. La contraseña nunca se imprime ni se registra.
 */
import {
  createDatabase,
  loadRootEnv,
  provisionCompany,
  requireDatabaseUrl,
  users,
} from "@bakery/database";
import { MIN_USER_PASSWORD_LENGTH } from "@bakery/shared";
import { sql } from "drizzle-orm";
import { hashPassword } from "../modules/auth/password.js";
import { createAdminAccess } from "./admin-access.js";

loadRootEnv();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable ${name}`);
  return value;
}

const legalName = required("COMPANY_LEGAL_NAME");
const tradeName = required("COMPANY_TRADE_NAME");
const taxId = process.env.COMPANY_TAX_ID?.trim() || null;
const email = required("ADMIN_EMAIL").toLowerCase();
const displayName = required("ADMIN_NAME");
const password = required("ADMIN_PASSWORD");
if (password.length < MIN_USER_PASSWORD_LENGTH) {
  throw new Error(`ADMIN_PASSWORD debe tener al menos ${MIN_USER_PASSWORD_LENGTH} caracteres`);
}

const handle = createDatabase(requireDatabaseUrl(), { max: 1 });
try {
  const [taken] = await handle.db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`);
  if (taken) throw new Error(`El email ${email} ya está en uso`);
  const passwordHash = await hashPassword(password);
  const company = await handle.db.transaction(async (tx) => {
    const company = await provisionCompany(tx, { legalName, tradeName, taxId });
    await createAdminAccess(tx, company.id, { email, displayName, passwordHash });
    return company;
  });
  console.log(
    JSON.stringify({
      level: "info",
      msg: "empresa creada",
      tradeName: company.tradeName,
      admin: email,
    }),
  );
} finally {
  await handle.close();
}
