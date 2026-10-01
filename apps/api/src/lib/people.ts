import { users, type Database, type Transaction } from "@bakery/database";
import type { PersonRefDto } from "@bakery/shared";
import { inArray } from "drizzle-orm";

/** Nombre visible de varios usuarios a la vez (para "creado por", "confirmado por"…). */
export async function loadPeople(
  db: Database | Transaction,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, PersonRefDto>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, r]));
}

export function personOf(
  people: Map<string, PersonRefDto>,
  id: string | null | undefined,
): PersonRefDto | null {
  return id ? (people.get(id) ?? null) : null;
}
