import { z } from "zod";
import {
  conversionFactorSchema,
  isValidTimeZone,
  moneySchema,
  optionalCodeSchema,
  optionalDate,
  optionalEmail,
  optionalMoneySchema,
  optionalText,
  optionalUnitCostSchema,
  optionalUrl,
  optionalUuid,
  quantitySchema,
  requiredText,
  uuid,
} from "./validation";

/* ---------- Enumeraciones del dominio (con etiquetas para la UI) ---------- */

export const CUSTOMER_TYPES = [
  "CONSUMER",
  "RETAILER",
  "WHOLESALER",
  "DISTRIBUTOR",
  "OTHER",
] as const;
export const CUSTOMER_TYPE_LABELS: Record<(typeof CUSTOMER_TYPES)[number], string> = {
  CONSUMER: "Consumidor final",
  RETAILER: "Comercio",
  WHOLESALER: "Mayorista",
  DISTRIBUTOR: "Distribuidor",
  OTHER: "Otro",
};

export const COMMERCIAL_CONDITIONS = ["CASH", "CURRENT_ACCOUNT"] as const;
export const COMMERCIAL_CONDITION_LABELS: Record<(typeof COMMERCIAL_CONDITIONS)[number], string> = {
  CASH: "Contado",
  CURRENT_ACCOUNT: "Cuenta corriente",
};

export const DOCUMENT_TYPES = ["DNI", "CUIL", "CUIT", "PASSPORT", "OTHER"] as const;
export const DOCUMENT_TYPE_LABELS: Record<(typeof DOCUMENT_TYPES)[number], string> = {
  DNI: "DNI",
  CUIL: "CUIL",
  CUIT: "CUIT",
  PASSPORT: "Pasaporte",
  OTHER: "Otro",
};

export const EMPLOYEE_STATUSES = ["ACTIVE", "INACTIVE"] as const;

export const UNIT_DIMENSIONS = ["MASS", "VOLUME", "COUNT", "PACKAGING", "OTHER"] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];
export const UNIT_DIMENSION_LABELS: Record<UnitDimension, string> = {
  MASS: "Masa",
  VOLUME: "Volumen",
  COUNT: "Cantidad",
  PACKAGING: "Envase",
  OTHER: "Otra",
};

export const CATEGORY_TYPES = ["RAW_MATERIAL", "PRODUCT"] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];
export const CATEGORY_TYPE_LABELS: Record<CategoryType, string> = {
  RAW_MATERIAL: "Materias primas",
  PRODUCT: "Productos",
};

/** Una edición (PATCH) debe traer al menos un campo. */
const withChanges = <T extends z.ZodType<Record<string, unknown>>>(schema: T) =>
  schema.refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "No hay cambios para guardar",
  });

/* ---------- Empresa ---------- */

export const updateCompanySchema = withChanges(
  z
    .object({
      legalName: requiredText(),
      tradeName: requiredText(),
      taxId: optionalText(32),
      address: optionalText(),
      city: optionalText(120),
      province: optionalText(120),
      postalCode: optionalText(16),
      phone: optionalText(50),
      email: optionalEmail(),
      logoUrl: optionalUrl(),
      currencyCode: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{3}$/, "Código ISO 4217 de 3 letras"),
      timezone: z.string().trim().refine(isValidTimeZone, "Zona horaria desconocida"),
    })
    .partial(),
);
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

/* ---------- Empleados ---------- */

const employeeFields = {
  firstName: requiredText(100),
  lastName: requiredText(100),
  documentType: z.enum(DOCUMENT_TYPES).nullable().optional(),
  documentNumber: optionalText(32),
  phone: optionalText(50),
  email: optionalEmail(),
  address: optionalText(),
  city: optionalText(120),
  position: optionalText(120),
  hireDate: optionalDate(),
  notes: optionalText(2000),
};
export const createEmployeeSchema = z.object({ code: optionalCodeSchema(), ...employeeFields });
export const updateEmployeeSchema = withChanges(z.object(employeeFields).partial());
export const deactivateEmployeeSchema = z.object({ terminationDate: optionalDate() });
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

/* ---------- Usuarios ---------- */

export const MIN_USER_PASSWORD_LENGTH = 10;

export const createUserSchema = z
  .object({
    email: z.string().trim().toLowerCase().email("Email inválido").max(254),
    displayName: optionalText(120),
    password: z
      .string()
      .min(MIN_USER_PASSWORD_LENGTH, `Mínimo ${MIN_USER_PASSWORD_LENGTH} caracteres`)
      .max(200),
    employeeId: optionalUuid(),
    roleIds: z.array(uuid()).min(1, "Asigne al menos un rol").max(20),
  })
  .refine((v) => v.password.toLowerCase() !== v.email, {
    message: "La contraseña no puede ser el email",
    path: ["password"],
  });
export const updateUserSchema = withChanges(
  z.object({ displayName: requiredText(120), employeeId: optionalUuid() }).partial(),
);
export const assignRolesSchema = z.object({
  roleIds: z.array(uuid()).min(1, "Asigne al menos un rol").max(20),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/* ---------- Clientes ---------- */

const customerFields = {
  type: z.enum(CUSTOMER_TYPES),
  legalName: requiredText(),
  tradeName: optionalText(200),
  taxId: optionalText(32),
  phone: optionalText(50),
  email: optionalEmail(),
  address: optionalText(),
  city: optionalText(120),
  province: optionalText(120),
  postalCode: optionalText(16),
  commercialCondition: z.enum(COMMERCIAL_CONDITIONS).default("CASH"),
  creditLimit: optionalMoneySchema(),
  notes: optionalText(2000),
};
export const createCustomerSchema = z.object({ code: optionalCodeSchema(), ...customerFields });
export const updateCustomerSchema = withChanges(
  z.object({ ...customerFields, commercialCondition: z.enum(COMMERCIAL_CONDITIONS) }).partial(),
);
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

/* ---------- Proveedores ---------- */

const supplierFields = {
  legalName: requiredText(),
  tradeName: optionalText(200),
  taxId: optionalText(32),
  contactName: optionalText(120),
  phone: optionalText(50),
  email: optionalEmail(),
  address: optionalText(),
  city: optionalText(120),
  province: optionalText(120),
  paymentTerms: optionalText(200),
  notes: optionalText(2000),
};
export const createSupplierSchema = z.object({ code: optionalCodeSchema(), ...supplierFields });
export const updateSupplierSchema = withChanges(z.object(supplierFields).partial());

/* ---------- Unidades de medida ---------- */

export const createUnitSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, "Obligatorio")
      .max(16)
      .regex(/^[\p{L}0-9._-]+$/u, "Sin espacios"),
    name: requiredText(60),
    symbol: requiredText(16),
    dimension: z.enum(UNIT_DIMENSIONS),
    baseUnitId: optionalUuid(),
    conversionFactor: z
      .union([z.string(), z.number(), z.null()])
      .optional()
      .transform((v) => (v === null || v === undefined || v === "" ? null : v))
      .pipe(conversionFactorSchema().nullable()),
    decimals: z.coerce.number().int().min(0).max(6).default(2),
  })
  .refine((v) => (v.baseUnitId === null) === (v.conversionFactor === null), {
    message: "La unidad base y el factor se indican juntos",
    path: ["conversionFactor"],
  });
/** Dimensión, base y factor no se editan: cambiarían el significado de cantidades ya cargadas. */
export const updateUnitSchema = withChanges(
  z
    .object({
      name: requiredText(60),
      symbol: requiredText(16),
      decimals: z.coerce.number().int().min(0).max(6),
      active: z.boolean(),
    })
    .partial(),
);
export const convertQuerySchema = z.object({
  from: uuid(),
  to: uuid(),
  quantity: quantitySchema(),
});

/* ---------- Categorías ---------- */

export const createCategorySchema = z.object({
  type: z.enum(CATEGORY_TYPES),
  name: requiredText(80),
  description: optionalText(500),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});
export const updateCategorySchema = withChanges(
  z
    .object({
      name: requiredText(80),
      description: optionalText(500),
      sortOrder: z.coerce.number().int().min(0).max(9999),
      active: z.boolean(),
    })
    .partial(),
);

/* ---------- Materias primas ---------- */

const rawMaterialFields = {
  name: requiredText(),
  description: optionalText(1000),
  categoryId: uuid(),
  baseUnitId: uuid(),
  minimumStock: quantitySchema().default("0"),
  preferredSupplierId: optionalUuid(),
};
/** El costo inicial es opcional y exige además raw_materials.update_cost. */
export const createRawMaterialSchema = z.object({
  code: optionalCodeSchema(),
  ...rawMaterialFields,
  referenceCost: optionalUnitCostSchema(),
});
/** El costo de referencia NO se edita aquí: tiene endpoint y permiso propios. */
export const updateRawMaterialSchema = withChanges(
  z.object({ ...rawMaterialFields, minimumStock: quantitySchema() }).partial(),
);
/**
 * Costo de referencia: dinero por UNIDAD BASE ($850/kg). `null` lo borra (las
 * recetas que lo usan pasan a costo incompleto). La clave es obligatoria: un
 * body sin `referenceCost` no debe borrar el costo por accidente.
 */
export const referenceCostSchema = z
  .custom<{ referenceCost?: string | number | null }>(
    (v) => typeof v === "object" && v !== null && "referenceCost" in v,
    { message: "Indique referenceCost (número o null)" },
  )
  .pipe(z.object({ referenceCost: optionalUnitCostSchema() }));
export type ReferenceCostInput = z.infer<typeof referenceCostSchema>;

/* ---------- Productos ---------- */

const productFields = {
  name: requiredText(),
  description: optionalText(1000),
  categoryId: uuid(),
  saleUnitId: uuid(),
  salePrice: moneySchema(),
  controlsStock: z.boolean().default(true),
  imageUrl: optionalUrl(),
};
export const createProductSchema = z.object({ code: optionalCodeSchema(), ...productFields });
export const updateProductSchema = withChanges(
  z.object({ ...productFields, controlsStock: z.boolean() }).partial(),
);

/* ---------- Depósitos ---------- */

const warehouseFields = {
  name: requiredText(120),
  description: optionalText(500),
  address: optionalText(),
};
export const createWarehouseSchema = z.object({ code: optionalCodeSchema(), ...warehouseFields });
export const updateWarehouseSchema = withChanges(z.object(warehouseFields).partial());
