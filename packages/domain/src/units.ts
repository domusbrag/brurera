import Decimal from "decimal.js";

/**
 * Conversión explícita entre unidades de medida.
 *
 * Modelo: una unidad raíz no tiene base; una unidad derivada declara
 * `1 unidad = factor × base`, donde la base es siempre una raíz de la misma
 * dimensión. Dos unidades son compatibles solo si comparten la misma raíz.
 * Masa y volumen nunca se convierten entre sí (no hay densidades en el MVP).
 */
export interface UnitForConversion {
  id: string;
  code: string;
  dimension: string;
  /** null si es una unidad raíz. */
  baseUnitId: string | null;
  /** Decimal como string; null si es una unidad raíz. */
  conversionFactor: string | null;
}

export class IncompatibleUnitsError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`No se puede convertir ${from} a ${to}: son unidades incompatibles`);
    this.name = "IncompatibleUnitsError";
  }
}

export class InvalidUnitDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUnitDefinitionError";
  }
}

/** Raíz de una unidad (su propio id si es raíz). */
export function rootUnitId(unit: UnitForConversion): string {
  return unit.baseUnitId ?? unit.id;
}

/** Factor hacia la raíz: cuántas unidades raíz equivalen a 1 de esta unidad. */
export function factorToRoot(unit: UnitForConversion): Decimal {
  if (unit.baseUnitId === null) return new Decimal(1);
  if (unit.conversionFactor === null) {
    throw new InvalidUnitDefinitionError(`La unidad ${unit.code} tiene base pero no factor`);
  }
  const factor = new Decimal(unit.conversionFactor);
  if (factor.lte(0)) {
    throw new InvalidUnitDefinitionError(`El factor de ${unit.code} debe ser mayor que cero`);
  }
  return factor;
}

export function areUnitsCompatible(a: UnitForConversion, b: UnitForConversion): boolean {
  return a.dimension === b.dimension && rootUnitId(a) === rootUnitId(b);
}

/**
 * Convierte una cantidad de `from` a `to`. Lanza IncompatibleUnitsError si las
 * unidades no comparten raíz. Devuelve un Decimal exacto (sin redondeo).
 */
export function convertQuantity(
  quantity: Decimal.Value,
  from: UnitForConversion,
  to: UnitForConversion,
): Decimal {
  if (!areUnitsCompatible(from, to)) throw new IncompatibleUnitsError(from.code, to.code);
  return new Decimal(quantity).times(factorToRoot(from)).dividedBy(factorToRoot(to));
}

/**
 * Valida la definición de una unidad derivada antes de crearla: la base debe
 * ser una raíz de la misma dimensión y el factor, positivo.
 */
export function validateDerivedUnit(
  dimension: string,
  base: UnitForConversion,
  conversionFactor: string,
): void {
  if (base.baseUnitId !== null) {
    throw new InvalidUnitDefinitionError(
      `La unidad base ${base.code} no puede ser a su vez derivada`,
    );
  }
  if (base.dimension !== dimension) {
    throw new InvalidUnitDefinitionError(
      `La unidad base ${base.code} es de otra dimensión (${base.dimension})`,
    );
  }
  if (!new Decimal(conversionFactor).gt(0)) {
    throw new InvalidUnitDefinitionError("El factor de conversión debe ser mayor que cero");
  }
}

/** Unidades estándar con que se aprovisiona cada empresa. */
export interface StandardUnit {
  code: string;
  name: string;
  symbol: string;
  dimension: "MASS" | "VOLUME" | "COUNT" | "PACKAGING";
  decimals: number;
  base?: { code: string; factor: string };
}

export const STANDARD_UNITS: readonly StandardUnit[] = [
  { code: "kg", name: "Kilogramo", symbol: "kg", dimension: "MASS", decimals: 3 },
  {
    code: "g",
    name: "Gramo",
    symbol: "g",
    dimension: "MASS",
    decimals: 0,
    base: { code: "kg", factor: "0.001" },
  },
  { code: "l", name: "Litro", symbol: "l", dimension: "VOLUME", decimals: 3 },
  {
    code: "ml",
    name: "Mililitro",
    symbol: "ml",
    dimension: "VOLUME",
    decimals: 0,
    base: { code: "l", factor: "0.001" },
  },
  { code: "unidad", name: "Unidad", symbol: "u", dimension: "COUNT", decimals: 0 },
  {
    code: "docena",
    name: "Docena",
    symbol: "doc",
    dimension: "COUNT",
    decimals: 0,
    base: { code: "unidad", factor: "12" },
  },
  // Envases genéricos: su contenido varía por artículo (una bolsa de harina no es
  // una bolsa de azúcar), por eso no tienen conversión global.
  { code: "bolsa", name: "Bolsa", symbol: "bolsa", dimension: "PACKAGING", decimals: 0 },
  { code: "caja", name: "Caja", symbol: "caja", dimension: "PACKAGING", decimals: 0 },
];
