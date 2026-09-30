CREATE TYPE "public"."category_type" AS ENUM('RAW_MATERIAL', 'PRODUCT');--> statement-breakpoint
CREATE TYPE "public"."unit_dimension" AS ENUM('MASS', 'VOLUME', 'COUNT', 'PACKAGING', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."commercial_condition" AS ENUM('CASH', 'CURRENT_ACCOUNT');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('CONSUMER', 'RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('DNI', 'CUIL', 'CUIT', 'PASSPORT', 'OTHER');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" "category_type" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "units_of_measure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"dimension" "unit_dimension" NOT NULL,
	"base_unit_id" uuid,
	"conversion_factor" numeric(24, 10),
	"decimals" smallint DEFAULT 2 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "units_base_and_factor_together" CHECK (("units_of_measure"."base_unit_id" is null) = ("units_of_measure"."conversion_factor" is null)),
	CONSTRAINT "units_factor_positive" CHECK ("units_of_measure"."conversion_factor" is null or "units_of_measure"."conversion_factor" > 0),
	CONSTRAINT "units_decimals_range" CHECK ("units_of_measure"."decimals" between 0 and 6),
	CONSTRAINT "units_not_own_base" CHECK ("units_of_measure"."base_unit_id" is null or "units_of_measure"."base_unit_id" <> "units_of_measure"."id")
);
--> statement-breakpoint
CREATE TABLE "code_sequences" (
	"company_id" uuid NOT NULL,
	"entity" varchar(32) NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "code_sequences_company_id_entity_pk" PRIMARY KEY("company_id","entity")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"internal_code" varchar(32) NOT NULL,
	"type" "customer_type" NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"tax_id" varchar(32),
	"phone" varchar(50),
	"email" varchar(254),
	"address" text,
	"city" text,
	"province" text,
	"postal_code" varchar(16),
	"commercial_condition" "commercial_condition" DEFAULT 'CASH' NOT NULL,
	"credit_limit" numeric(14, 2),
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "customers_credit_limit_nonneg" CHECK ("customers"."credit_limit" is null or "customers"."credit_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"internal_code" varchar(32) NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"tax_id" varchar(32),
	"contact_name" text,
	"phone" varchar(50),
	"email" varchar(254),
	"address" text,
	"city" text,
	"province" text,
	"payment_terms" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"address" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouses_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"internal_code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" uuid NOT NULL,
	"sale_unit_id" uuid NOT NULL,
	"sale_price" numeric(14, 2) NOT NULL,
	"controls_stock" boolean DEFAULT true NOT NULL,
	"image_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sale_price_nonneg" CHECK ("products"."sale_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "raw_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"internal_code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" uuid NOT NULL,
	"base_unit_id" uuid NOT NULL,
	"minimum_stock" numeric(18, 4) DEFAULT '0' NOT NULL,
	"preferred_supplier_id" uuid,
	"current_cost" numeric(18, 6),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_materials_minimum_stock_nonneg" CHECK ("raw_materials"."minimum_stock" >= 0),
	CONSTRAINT "raw_materials_cost_nonneg" CHECK ("raw_materials"."current_cost" is null or "raw_materials"."current_cost" >= 0)
);
--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
-- ON_LEAVE deja de existir: una licencia no es una baja, el empleado sigue ACTIVE.
UPDATE "employees" SET "status" = 'ACTIVE' WHERE "status" = 'ON_LEAVE';--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::text;--> statement-breakpoint
DROP TYPE "public"."employee_status";--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::"public"."employee_status";--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "status" SET DATA TYPE "public"."employee_status" USING "status"::"public"."employee_status";--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "province" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "postal_code" varchar(16);--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "employee_code" varchar(32);--> statement-breakpoint
-- Códigos para empleados existentes (EMP-0001, ...) por empresa, en orden de alta.
UPDATE "employees" e SET "employee_code" = 'EMP-' || lpad(n.rn::text, 4, '0')
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "company_id" ORDER BY "created_at", "id") AS rn
  FROM "employees"
) n
WHERE n."id" = e."id";--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "employee_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "document_type" "document_type";--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "termination_date" date;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_base_unit_fk" FOREIGN KEY ("company_id","base_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_sequences" ADD CONSTRAINT "code_sequences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_fk" FOREIGN KEY ("company_id","category_id") REFERENCES "public"."categories"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_sale_unit_fk" FOREIGN KEY ("company_id","sale_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_materials" ADD CONSTRAINT "raw_materials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_materials" ADD CONSTRAINT "raw_materials_category_fk" FOREIGN KEY ("company_id","category_id") REFERENCES "public"."categories"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_materials" ADD CONSTRAINT "raw_materials_base_unit_fk" FOREIGN KEY ("company_id","base_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_materials" ADD CONSTRAINT "raw_materials_supplier_fk" FOREIGN KEY ("company_id","preferred_supplier_id") REFERENCES "public"."suppliers"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_company_type_name_uq" ON "categories" USING btree ("company_id","type",lower("name"));--> statement-breakpoint
CREATE INDEX "categories_company_type_idx" ON "categories" USING btree ("company_id","type","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "units_company_code_uq" ON "units_of_measure" USING btree ("company_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "customers_company_code_uq" ON "customers" USING btree ("company_id","internal_code");--> statement-breakpoint
CREATE INDEX "customers_company_active_name_idx" ON "customers" USING btree ("company_id","active","legal_name");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_company_code_uq" ON "suppliers" USING btree ("company_id","internal_code");--> statement-breakpoint
CREATE INDEX "suppliers_company_active_name_idx" ON "suppliers" USING btree ("company_id","active","legal_name");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_company_code_uq" ON "warehouses" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "warehouses_company_active_idx" ON "warehouses" USING btree ("company_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_code_uq" ON "products" USING btree ("company_id","internal_code");--> statement-breakpoint
CREATE INDEX "products_company_active_name_idx" ON "products" USING btree ("company_id","active","name");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_materials_company_code_uq" ON "raw_materials" USING btree ("company_id","internal_code");--> statement-breakpoint
CREATE INDEX "raw_materials_company_active_name_idx" ON "raw_materials" USING btree ("company_id","active","name");--> statement-breakpoint
CREATE INDEX "raw_materials_category_idx" ON "raw_materials" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "raw_materials_supplier_idx" ON "raw_materials" USING btree ("preferred_supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_company_code_uq" ON "employees" USING btree ("company_id","employee_code");--> statement-breakpoint
CREATE INDEX "employees_company_status_idx" ON "employees" USING btree ("company_id","status");--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_termination_after_hire" CHECK ("employees"."termination_date" is null or "employees"."hire_date" is null or "employees"."termination_date" >= "employees"."hire_date");--> statement-breakpoint
-- La secuencia de códigos de empleados continúa después de los ya asignados.
INSERT INTO "code_sequences" ("company_id", "entity", "next_value")
SELECT "company_id", 'EMP', count(*) + 1 FROM "employees" GROUP BY "company_id";
