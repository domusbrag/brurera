import {
  companyMemberships,
  findRoleIdsByCode,
  membershipRoles,
  users,
  type Transaction,
} from "@bakery/database";

/**
 * Crea la identidad de un administrador con membresía ADMIN en la empresa.
 * Solo lo usan los scripts de alta (seed de desarrollo y alta de empresa);
 * los usuarios del día a día se crean desde la API.
 */
export async function createAdminAccess(
  tx: Transaction,
  companyId: string,
  input: { email: string; displayName: string; passwordHash: string; employeeId?: string | null },
): Promise<{ userId: string; membershipId: string }> {
  const [user] = await tx
    .insert(users)
    .values({
      email: input.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("No se pudo crear el usuario administrador");
  const [membership] = await tx
    .insert(companyMemberships)
    .values({ companyId, userId: user.id, employeeId: input.employeeId ?? null })
    .returning({ id: companyMemberships.id });
  if (!membership) throw new Error("No se pudo crear la membresía");
  const adminRoleId = (await findRoleIdsByCode(tx, companyId, ["ADMIN"])).get("ADMIN");
  if (!adminRoleId) throw new Error("Rol ADMIN inexistente");
  await tx
    .insert(membershipRoles)
    .values({ membershipId: membership.id, roleId: adminRoleId, companyId });
  return { userId: user.id, membershipId: membership.id };
}
