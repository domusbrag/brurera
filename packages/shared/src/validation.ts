import { z } from "zod";

/*
 * Primitivas de validación compartidas entre API y web. Los textos opcionales
 * vacíos se normalizan a null; los decimales viajan siempre como string.
 */

/** Texto obligatorio, recortado. */
export const requiredText = (max = 200) => z.string().trim().min(1, "Obligatorio").max(max);

/** Texto opcional: "" / null / undefined → null. */
export const optionalText = (max = 500) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v === null || v === undefined ? null : v.trim()))
    .pipe(z.string().max(max).nullable())
    .transform((v) => (v === "" ? null : v));

export const optionalEmail = () =>
  optionalText(254).pipe(z.string().email("Email inválido").nullable());

export const optionalUrl = () => optionalText(2000).pipe(z.string().url("URL inválida").nullable());

/** Fecha de calendario YYYY-MM-DD opcional. */
export const optionalDate = () =>
  optionalText(10).pipe(
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD)")
      .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Fecha inválida")
      .nullable(),
  );

export const uuid = () => z.string().uuid("Referencia inválida");
export const optionalUuid = () =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v === null || v === undefined || v === "" ? null : v))
    .pipe(z.string().uuid("Referencia inválida").nullable());

/**
 * Decimal no negativo como string (nunca float). Acepta "1234.5" o 1234.5 y
 * verifica la cantidad máxima de enteros y decimales de la columna numeric.
 */
export const decimalString = (opts: { integers: number; scale: number; positive?: boolean }) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "number" ? String(v) : v.trim().replace(",", ".")))
    .pipe(
      z
        .string()
        .regex(
          new RegExp(`^\\d{1,${opts.integers}}(\\.\\d{1,${opts.scale}})?$`),
          `Número inválido (máximo ${opts.scale} decimales)`,
        )
        .refine((v) => !opts.positive || Number(v) > 0, "Debe ser mayor que cero"),
    );

export const optionalDecimalString = (opts: { integers: number; scale: number }) =>
  z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v) => (v === null || v === undefined || v === "" ? null : v))
    .pipe(decimalString(opts).nullable());

/** Dinero: numeric(14,2). */
export const moneySchema = () => decimalString({ integers: 12, scale: 2 });
export const optionalMoneySchema = () => optionalDecimalString({ integers: 12, scale: 2 });
/** Costo por unidad base: numeric(18,6). */
export const optionalUnitCostSchema = () => optionalDecimalString({ integers: 12, scale: 6 });
/** Cantidad: numeric(18,4). */
export const quantitySchema = () => decimalString({ integers: 14, scale: 4 });
/** Factor de conversión: numeric(24,10). */
export const conversionFactorSchema = () =>
  decimalString({ integers: 14, scale: 10, positive: true });

/**
 * Código interno opcional: si se omite, la API lo genera (PREFIJO-0001).
 * Se normaliza a mayúsculas; único por empresa.
 */
export const optionalCodeSchema = () =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v === null || v === undefined ? null : v.trim().toUpperCase()))
    .transform((v) => (v === "" ? null : v))
    .pipe(
      z
        .string()
        .max(32)
        .regex(/^[A-Z0-9][A-Z0-9._-]*$/, "Solo letras, números, punto, guion y guion bajo")
        .nullable(),
    );

export const activeFilterSchema = z.enum(["active", "inactive", "all"]).default("active");
export type ActiveFilter = z.infer<typeof activeFilterSchema>;

/** Query estándar de listados de maestros. */
export const listQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : undefined)),
  status: activeFilterSchema,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

/**
 * Zona horaria IANA válida. Se prueba con Intl.DateTimeFormat porque
 * `supportedValuesOf` solo lista nombres canónicos de ICU (p. ej. no incluye
 * "America/Argentina/Buenos_Aires", que es el valor por defecto).
 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz.includes("/") && tz !== "UTC") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
