/*
 * Formas de respuesta de la API para los maestros. Nunca incluyen company_id ni
 * secretos. Los ids se usan para navegar, pero la UI no los muestra.
 */
import type {
  CategoryType,
  COMMERCIAL_CONDITIONS,
  CUSTOMER_TYPES,
  DOCUMENT_TYPES,
  UnitDimension,
} from "./masters";

export interface CompanyDto {
  legalName: string;
  tradeName: string;
  taxId: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
  logoUrl: string | null;
  currencyCode: string;
  timezone: string;
  active: boolean;
  updatedAt: string;
}

export interface EmployeeDto {
  id: string;
  code: string;
  firstName: string;
  lastName: string;
  fullName: string;
  documentType: (typeof DOCUMENT_TYPES)[number] | null;
  documentNumber: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  position: string | null;
  hireDate: string | null;
  terminationDate: string | null;
  status: "ACTIVE" | "INACTIVE";
  notes: string | null;
  /** Acceso al sistema del empleado en esta empresa, si tiene. */
  access: { userId: string; email: string; status: "ACTIVE" | "DISABLED" } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoleSummary {
  id: string;
  code: string;
  name: string;
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  /** Estado del acceso en esta empresa (membresía). */
  status: "ACTIVE" | "DISABLED";
  employee: { id: string; code: string; fullName: string } | null;
  roles: RoleSummary[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface UserDetailDto extends UserDto {
  /** Permisos efectivos: unión de los permisos de sus roles en esta empresa. */
  permissions: string[];
}

export interface RoleDto extends RoleSummary {
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

export interface CustomerDto {
  id: string;
  code: string;
  type: (typeof CUSTOMER_TYPES)[number];
  legalName: string;
  tradeName: string | null;
  taxId: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  commercialCondition: (typeof COMMERCIAL_CONDITIONS)[number];
  creditLimit: string | null;
  /** Lista de precios del cliente (Fase 5B). */
  defaultPriceList: { id: string; code: string; name: string } | null;
  /** "Consumidor Final": uno por empresa, para ventas de mostrador. */
  walkIn: boolean;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierDto {
  id: string;
  code: string;
  legalName: string;
  tradeName: string | null;
  taxId: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  paymentTerms: string | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UnitDto {
  id: string;
  code: string;
  name: string;
  symbol: string;
  dimension: UnitDimension;
  baseUnit: { id: string; code: string; symbol: string } | null;
  conversionFactor: string | null;
  decimals: number;
  isSystem: boolean;
  active: boolean;
}

export interface CategoryDto {
  id: string;
  type: CategoryType;
  name: string;
  description: string | null;
  sortOrder: number;
  active: boolean;
}

export interface RawMaterialDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: { id: string; name: string };
  baseUnit: { id: string; code: string; symbol: string };
  minimumStock: string;
  preferredSupplier: { id: string; code: string; legalName: string } | null;
  /** Dinero por unidad base (moneda de la empresa); null si no está cargado. */
  referenceCost: string | null;
  referenceCostSource: "MANUAL_REFERENCE" | "PURCHASE_MOVING_AVERAGE" | "SUPPLIER_QUOTE" | "OTHER";
  referenceCostUpdatedAt: string | null;
  /** Promedio ponderado móvil del inventario (null si nunca hubo ingresos valorizados). */
  movingAverageCost: string | null;
  /** Costo por unidad base que usan las recetas hoy (promedio > referencia > null). */
  effectiveCost: string | null;
  effectiveCostSource:
    "MANUAL_REFERENCE" | "PURCHASE_MOVING_AVERAGE" | "SUPPLIER_QUOTE" | "OTHER" | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: { id: string; name: string };
  saleUnit: { id: string; code: string; symbol: string };
  salePrice: string;
  controlsStock: boolean;
  imageUrl: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WarehouseDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  address: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
