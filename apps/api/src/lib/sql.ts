import { getTableName, sql, type Column } from "drizzle-orm";

/** El esquema usa casing snake_case: la clave TS es el nombre salvo que se dé uno explícito. */
const columnName = (column: Column) =>
  column.keyAsName ? column.name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : column.name;

/**
 * Columna calificada con su tabla ("tabla"."columna"). Drizzle omite la tabla
 * en los SELECT de una sola tabla, y dentro de una subconsulta correlacionada
 * un "id" suelto se resuelve contra la tabla de la subconsulta, no la exterior.
 */
export const qualified = (column: Column) =>
  sql.raw(`"${getTableName(column.table)}"."${columnName(column)}"`);
