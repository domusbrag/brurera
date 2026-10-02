import { eq } from "drizzle-orm";
import type { Transaction } from "./client.js";
import { allocateCode } from "./codes.js";
import { syncPermissionCatalog, syncStandardUnits, syncSystemRoles } from "./reference-data.js";
import { companies, customers, warehouses } from "./schema/index.js";

export interface NewCompany {
  legalName: string;
  tradeName: string;
  taxId?: string | null;
  email?: string | null;
  currencyCode?: string;
  timezone?: string;
}

/**
 * Deja una empresa lista para operar: catálogo de permisos, roles de sistema,
 * unidades estándar, el depósito principal y el cliente "Consumidor Final"
 * (ventas de mostrador, Fase 5B). Es la única forma de crear
 * empresas (seed de desarrollo, CLI de alta y tests), para que todas nazcan
 * con la misma estructura. Debe ejecutarse dentro de una transacción.
 */
export async function provisionCompany(
  tx: Transaction,
  input: NewCompany,
  /** Las pruebas de migración aprovisionan sobre esquemas anteriores a 0010 (sin Consumidor Final). */
  options: { walkInCustomer?: boolean } = {},
) {
  await syncPermissionCatalog(tx);
  const [company] = await tx
    .insert(companies)
    .values({
      legalName: input.legalName,
      tradeName: input.tradeName,
      taxId: input.taxId ?? null,
      email: input.email ?? null,
      ...(input.currencyCode ? { currencyCode: input.currencyCode } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
    })
    .returning();
  if (!company) throw new Error("No se pudo crear la empresa");

  await syncSystemRoles(tx, company.id);
  await syncStandardUnits(tx, company.id);

  const code = await allocateCode(tx, company.id, "WAREHOUSE", async (c) => {
    const rows = await tx
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(eq(warehouses.code, c));
    return rows.length > 0;
  });
  await tx.insert(warehouses).values({
    companyId: company.id,
    code,
    name: "Depósito Principal",
    description: "Depósito creado al dar de alta la empresa",
  });
  if (options.walkInCustomer === false) return company;
  await tx.insert(customers).values({
    companyId: company.id,
    internalCode: "CONS-FINAL",
    type: "CONSUMER",
    legalName: "Consumidor Final",
    commercialCondition: "CASH",
    isWalkIn: true,
    notes: "Cliente genérico para ventas de mostrador.",
  });
  return company;
}
