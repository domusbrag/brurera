import { companies, type Database } from "@bakery/database";
import type { CompanyDto, UpdateCompanyInput } from "@bakery/shared";
import { eq } from "drizzle-orm";
import { auditBase, type OperationContext } from "../../lib/context.js";
import { notFound } from "../../lib/db-errors.js";
import { diffChanges, recordAudit } from "../audit/audit.service.js";

type CompanyRow = typeof companies.$inferSelect;

function toDto(row: CompanyRow): CompanyDto {
  return {
    legalName: row.legalName,
    tradeName: row.tradeName,
    taxId: row.taxId,
    address: row.address,
    city: row.city,
    province: row.province,
    postalCode: row.postalCode,
    phone: row.phone,
    email: row.email,
    logoUrl: row.logoUrl,
    currencyCode: row.currencyCode,
    timezone: row.timezone,
    active: row.active,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** La empresa de la sesión. No existe forma de consultar otra empresa. */
export async function getCompany(db: Database, ctx: OperationContext): Promise<CompanyDto> {
  const [row] = await db.select().from(companies).where(eq(companies.id, ctx.companyId));
  if (!row) throw notFound("Empresa");
  return toDto(row);
}

export async function updateCompany(
  db: Database,
  ctx: OperationContext,
  input: UpdateCompanyInput,
): Promise<CompanyDto> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, ctx.companyId))
      .for("update");
    if (!before) throw notFound("Empresa");
    const [after] = await tx
      .update(companies)
      .set(input)
      .where(eq(companies.id, ctx.companyId))
      .returning();
    if (!after) throw notFound("Empresa");
    const changes = diffChanges(before, after, Object.keys(input));
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, {
        ...auditBase(ctx),
        action: "COMPANY_UPDATED",
        entityType: "company",
        entityId: ctx.companyId,
        metadata: { changes },
      });
    }
    return toDto(after);
  });
}
