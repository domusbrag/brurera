/**
 * Códigos internos por empresa: PREFIJO-NNNN (con al menos 4 dígitos).
 * Son únicos por empresa y tipo; no dependen del nombre de la entidad.
 */
export const CODE_PREFIXES = {
  EMPLOYEE: "EMP",
  CUSTOMER: "CLI",
  SUPPLIER: "PROV",
  RAW_MATERIAL: "MP",
  PRODUCT: "PROD",
  WAREHOUSE: "DEP",
  PURCHASE: "OC",
  PURCHASE_RECEIPT: "REC",
  PRODUCTION_ORDER: "OP",
  CUSTOMER_ORDER: "PED",
} as const;

export type CodeEntity = keyof typeof CODE_PREFIXES;

export function formatCode(entity: CodeEntity, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`Secuencia inválida: ${sequence}`);
  }
  return `${CODE_PREFIXES[entity]}-${String(sequence).padStart(4, "0")}`;
}

/** Normaliza un código ingresado a mano: recorta y pasa a mayúsculas. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
