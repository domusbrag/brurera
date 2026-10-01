import { formatCode, type CodeEntity } from "@bakery/domain";
import { sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.js";
import { codeSequences } from "./schema/index.js";

/**
 * Reserva el próximo código interno de una entidad (p. ej. CLI-0007) dentro de la
 * transacción del alta. La fila de la secuencia queda bloqueada hasta el commit,
 * por lo que dos altas concurrentes nunca obtienen el mismo número. Si el código
 * ya fue usado manualmente (`isTaken`), se avanza al siguiente.
 */
export async function allocateCode(
  db: Database | Transaction,
  companyId: string,
  entity: CodeEntity,
  isTaken: (code: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const [row] = await db
      .insert(codeSequences)
      .values({ companyId, entity, nextValue: 2 })
      .onConflictDoUpdate({
        target: [codeSequences.companyId, codeSequences.entity],
        set: { nextValue: sql`${codeSequences.nextValue} + 1` },
      })
      .returning({ nextValue: codeSequences.nextValue });
    if (!row) throw new Error("No se pudo reservar la secuencia de códigos");
    const code = formatCode(entity, row.nextValue - 1);
    if (!(await isTaken(code))) return code;
  }
  throw new Error(`No se encontró un código libre para ${entity}`);
}
