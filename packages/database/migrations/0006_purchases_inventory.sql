CREATE TYPE "public"."stock_item_type" AS ENUM('RAW_MATERIAL', 'PRODUCT');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_type" AS ENUM('INITIAL_STOCK', 'PURCHASE_RECEIPT', 'ADJUSTMENT_POSITIVE', 'ADJUSTMENT_NEGATIVE', 'WASTE');--> statement-breakpoint
CREATE TYPE "public"."purchase_receipt_status" AS ENUM('DRAFT', 'POSTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."purchase_status" AS ENUM('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "inventory_cost_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"raw_material_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"movement_sequence" bigint NOT NULL,
	"movement_type" "stock_movement_type" NOT NULL,
	"reference_type" varchar(32),
	"reference_id" uuid,
	"quantity_before" numeric(28, 10) NOT NULL,
	"quantity_after" numeric(28, 10) NOT NULL,
	"value_before" numeric(20, 6) NOT NULL,
	"value_after" numeric(20, 6) NOT NULL,
	"average_before" numeric(20, 6),
	"average_after" numeric(20, 6),
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_material_inventory_costs" (
	"company_id" uuid NOT NULL,
	"raw_material_id" uuid NOT NULL,
	"quantity" numeric(28, 10) DEFAULT '0' NOT NULL,
	"inventory_value" numeric(20, 6) DEFAULT '0' NOT NULL,
	"moving_average_cost" numeric(20, 6),
	"last_movement_id" uuid,
	"last_updated_at" timestamp with time zone,
	CONSTRAINT "raw_material_inventory_costs_company_id_raw_material_id_pk" PRIMARY KEY("company_id","raw_material_id"),
	CONSTRAINT "raw_material_inventory_costs_nonneg" CHECK ("raw_material_inventory_costs"."quantity" >= 0 and "raw_material_inventory_costs"."inventory_value" >= 0 and ("raw_material_inventory_costs"."moving_average_cost" is null or "raw_material_inventory_costs"."moving_average_cost" >= 0)),
	CONSTRAINT "raw_material_inventory_costs_empty_value" CHECK ("raw_material_inventory_costs"."quantity" > 0 or "raw_material_inventory_costs"."inventory_value" = 0)
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"item_type" "stock_item_type" DEFAULT 'RAW_MATERIAL' NOT NULL,
	"raw_material_id" uuid,
	"product_id" uuid,
	"quantity" numeric(28, 10) DEFAULT '0' NOT NULL,
	"base_unit_id" uuid NOT NULL,
	"last_movement_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_item_coherent" CHECK (("stock_balances"."item_type" = 'RAW_MATERIAL' and "stock_balances"."raw_material_id" is not null and "stock_balances"."product_id" is null)
        or ("stock_balances"."item_type" = 'PRODUCT' and "stock_balances"."product_id" is not null and "stock_balances"."raw_material_id" is null)),
	CONSTRAINT "stock_balances_quantity_nonneg" CHECK ("stock_balances"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"company_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"item_type" "stock_item_type" DEFAULT 'RAW_MATERIAL' NOT NULL,
	"raw_material_id" uuid,
	"product_id" uuid,
	"movement_type" "stock_movement_type" NOT NULL,
	"quantity" numeric(28, 10) NOT NULL,
	"base_unit_id" uuid NOT NULL,
	"unit_cost" numeric(20, 6) NOT NULL,
	"total_value" numeric(20, 6) NOT NULL,
	"balance_after" numeric(28, 10) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"reference_type" varchar(32),
	"reference_id" uuid,
	"source_line_id" uuid,
	"reason" varchar(32),
	"actor_user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "stock_movements_sequence_uq" UNIQUE("sequence"),
	CONSTRAINT "stock_movements_item_coherent" CHECK (("stock_movements"."item_type" = 'RAW_MATERIAL' and "stock_movements"."raw_material_id" is not null and "stock_movements"."product_id" is null)
        or ("stock_movements"."item_type" = 'PRODUCT' and "stock_movements"."product_id" is not null and "stock_movements"."raw_material_id" is null)),
	CONSTRAINT "stock_movements_sign" CHECK (("stock_movements"."movement_type" in ('INITIAL_STOCK', 'PURCHASE_RECEIPT', 'ADJUSTMENT_POSITIVE') and "stock_movements"."quantity" > 0 and "stock_movements"."total_value" >= 0)
        or ("stock_movements"."movement_type" in ('ADJUSTMENT_NEGATIVE', 'WASTE') and "stock_movements"."quantity" < 0 and "stock_movements"."total_value" <= 0)),
	CONSTRAINT "stock_movements_balance_nonneg" CHECK ("stock_movements"."balance_after" >= 0),
	CONSTRAINT "stock_movements_unit_cost_nonneg" CHECK ("stock_movements"."unit_cost" >= 0),
	CONSTRAINT "stock_movements_reason" CHECK (("stock_movements"."movement_type" in ('ADJUSTMENT_POSITIVE', 'ADJUSTMENT_NEGATIVE') and "stock_movements"."reason" in ('PHYSICAL_COUNT', 'DATA_CORRECTION', 'BREAKAGE', 'OTHER'))
        or ("stock_movements"."movement_type" = 'WASTE' and "stock_movements"."reason" in ('EXPIRED', 'DAMAGED', 'PRODUCTION_LOSS', 'QUALITY', 'OTHER'))
        or ("stock_movements"."movement_type" in ('INITIAL_STOCK', 'PURCHASE_RECEIPT') and "stock_movements"."reason" is null)),
	CONSTRAINT "stock_movements_receipt_reference" CHECK ("stock_movements"."movement_type" <> 'PURCHASE_RECEIPT' or ("stock_movements"."reference_type" = 'PURCHASE_RECEIPT' and "stock_movements"."reference_id" is not null and "stock_movements"."source_line_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "purchase_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"raw_material_id" uuid NOT NULL,
	"presentation_id" uuid,
	"purchase_unit_id" uuid NOT NULL,
	"ordered_quantity" numeric(18, 4) NOT NULL,
	"received_quantity" numeric(18, 4) DEFAULT '0' NOT NULL,
	"unit_price" numeric(18, 6) NOT NULL,
	"gross_amount" numeric(20, 6) NOT NULL,
	"discount_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"net_amount" numeric(20, 6) NOT NULL,
	"base_quantity_per_unit" numeric(28, 10) NOT NULL,
	"ordered_base_quantity" numeric(28, 10) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_lines_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "purchase_lines_purchase_id_uq" UNIQUE("company_id","purchase_id","id"),
	CONSTRAINT "purchase_lines_purchase_number_uq" UNIQUE("purchase_id","line_number"),
	CONSTRAINT "purchase_lines_quantity_positive" CHECK ("purchase_lines"."ordered_quantity" > 0),
	CONSTRAINT "purchase_lines_received_range" CHECK ("purchase_lines"."received_quantity" >= 0 and "purchase_lines"."received_quantity" <= "purchase_lines"."ordered_quantity"),
	CONSTRAINT "purchase_lines_amounts" CHECK ("purchase_lines"."unit_price" >= 0 and "purchase_lines"."gross_amount" >= 0 and "purchase_lines"."discount_amount" >= 0
        and "purchase_lines"."discount_amount" <= "purchase_lines"."gross_amount" and "purchase_lines"."net_amount" = "purchase_lines"."gross_amount" - "purchase_lines"."discount_amount"),
	CONSTRAINT "purchase_lines_base_positive" CHECK ("purchase_lines"."base_quantity_per_unit" > 0 and "purchase_lines"."ordered_base_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"purchase_line_id" uuid NOT NULL,
	"raw_material_id" uuid NOT NULL,
	"presentation_id" uuid,
	"purchase_unit_id" uuid NOT NULL,
	"base_unit_id" uuid NOT NULL,
	"ordered_quantity" numeric(18, 4) NOT NULL,
	"previously_received_quantity" numeric(18, 4) DEFAULT '0' NOT NULL,
	"received_quantity" numeric(18, 4) NOT NULL,
	"normalized_base_quantity" numeric(28, 10) NOT NULL,
	"acquisition_unit_cost_base" numeric(20, 6) NOT NULL,
	"line_inventory_value" numeric(20, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_receipt_lines_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "purchase_receipt_lines_receipt_line_uq" UNIQUE("receipt_id","purchase_line_id"),
	CONSTRAINT "purchase_receipt_lines_quantity_positive" CHECK ("purchase_receipt_lines"."received_quantity" > 0),
	CONSTRAINT "purchase_receipt_lines_values_nonneg" CHECK ("purchase_receipt_lines"."normalized_base_quantity" > 0 and "purchase_receipt_lines"."acquisition_unit_cost_base" >= 0 and "purchase_receipt_lines"."line_inventory_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"internal_number" varchar(32) NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"status" "purchase_receipt_status" DEFAULT 'DRAFT' NOT NULL,
	"document_number" varchar(64),
	"notes" text,
	"created_by_user_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_receipts_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "purchase_receipts_purchase_id_uq" UNIQUE("company_id","purchase_id","id"),
	CONSTRAINT "purchase_receipts_status_dates" CHECK (("purchase_receipts"."status" = 'DRAFT' and "purchase_receipts"."posted_at" is null and "purchase_receipts"."cancelled_at" is null)
        or ("purchase_receipts"."status" = 'POSTED' and "purchase_receipts"."posted_at" is not null and "purchase_receipts"."cancelled_at" is null)
        or ("purchase_receipts"."status" = 'CANCELLED' and "purchase_receipts"."posted_at" is null and "purchase_receipts"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"internal_number" varchar(32) NOT NULL,
	"supplier_document_number" varchar(64),
	"purchase_date" date NOT NULL,
	"expected_date" date,
	"status" "purchase_status" DEFAULT 'DRAFT' NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"notes" text,
	"subtotal" numeric(20, 6) DEFAULT '0' NOT NULL,
	"discount_total" numeric(20, 6) DEFAULT '0' NOT NULL,
	"tax_total" numeric(20, 6) DEFAULT '0' NOT NULL,
	"total" numeric(20, 6) DEFAULT '0' NOT NULL,
	"created_by_user_id" uuid,
	"ordered_at" timestamp with time zone,
	"ordered_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "purchases_amounts_nonneg" CHECK ("purchases"."subtotal" >= 0 and "purchases"."discount_total" >= 0 and "purchases"."tax_total" >= 0 and "purchases"."total" >= 0),
	CONSTRAINT "purchases_status_dates" CHECK (("purchases"."status" = 'DRAFT' and "purchases"."ordered_at" is null and "purchases"."cancelled_at" is null)
        or ("purchases"."status" in ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED') and "purchases"."ordered_at" is not null and "purchases"."cancelled_at" is null)
        or ("purchases"."status" = 'CANCELLED' and "purchases"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "raw_material_presentations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"raw_material_id" uuid NOT NULL,
	"name" text NOT NULL,
	"purchase_unit_id" uuid NOT NULL,
	"contained_quantity" numeric(18, 6) NOT NULL,
	"contained_unit_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_material_presentations_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "raw_material_presentations_material_id_uq" UNIQUE("company_id","raw_material_id","id"),
	CONSTRAINT "raw_material_presentations_contained_positive" CHECK ("raw_material_presentations"."contained_quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_cost_history" ADD CONSTRAINT "inventory_cost_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_cost_history" ADD CONSTRAINT "inventory_cost_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_cost_history" ADD CONSTRAINT "inventory_cost_history_material_fk" FOREIGN KEY ("company_id","raw_material_id") REFERENCES "public"."raw_materials"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_cost_history" ADD CONSTRAINT "inventory_cost_history_movement_fk" FOREIGN KEY ("company_id","movement_id") REFERENCES "public"."stock_movements"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_material_inventory_costs" ADD CONSTRAINT "raw_material_inventory_costs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_material_inventory_costs" ADD CONSTRAINT "raw_material_inventory_costs_material_fk" FOREIGN KEY ("company_id","raw_material_id") REFERENCES "public"."raw_materials"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_material_inventory_costs" ADD CONSTRAINT "raw_material_inventory_costs_last_movement_fk" FOREIGN KEY ("company_id","last_movement_id") REFERENCES "public"."stock_movements"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_fk" FOREIGN KEY ("company_id","warehouse_id") REFERENCES "public"."warehouses"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_raw_material_fk" FOREIGN KEY ("company_id","raw_material_id") REFERENCES "public"."raw_materials"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_base_unit_fk" FOREIGN KEY ("company_id","base_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_last_movement_fk" FOREIGN KEY ("company_id","last_movement_id") REFERENCES "public"."stock_movements"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_fk" FOREIGN KEY ("company_id","warehouse_id") REFERENCES "public"."warehouses"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_raw_material_fk" FOREIGN KEY ("company_id","raw_material_id") REFERENCES "public"."raw_materials"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_base_unit_fk" FOREIGN KEY ("company_id","base_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_purchase_fk" FOREIGN KEY ("company_id","purchase_id") REFERENCES "public"."purchases"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_raw_material_fk" FOREIGN KEY ("company_id","raw_material_id") REFERENCES "public"."raw_materials"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_presentation_fk" FOREIGN KEY ("company_id","raw_material_id","presentation_id") REFERENCES "public"."raw_material_presentations"("company_id","raw_material_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_unit_fk" FOREIGN KEY ("company_id","purchase_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_receipt_fk" FOREIGN KEY ("company_id","purchase_id","receipt_id") REFERENCES "public"."purchase_receipts"("company_id","purchase_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_purchase_line_fk" FOREIGN KEY ("company_id","purchase_id","purchase_line_id") REFERENCES "public"."purchase_lines"("company_id","purchase_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_raw_material_fk" FOREIGN KEY ("company_id","raw_material_id") REFERENCES "public"."raw_materials"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_base_unit_fk" FOREIGN KEY ("company_id","base_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_purchase_unit_fk" FOREIGN KEY ("company_id","purchase_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_purchase_fk" FOREIGN KEY ("company_id","purchase_id") REFERENCES "public"."purchases"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_warehouse_fk" FOREIGN KEY ("company_id","warehouse_id") REFERENCES "public"."warehouses"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_ordered_by_user_id_users_id_fk" FOREIGN KEY ("ordered_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_fk" FOREIGN KEY ("company_id","supplier_id") REFERENCES "public"."suppliers"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_material_presentations" ADD CONSTRAINT "raw_material_presentations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_material_presentations" ADD CONSTRAINT "raw_material_presentations_material_fk" FOREIGN KEY ("company_id","raw_material_id") REFERENCES "public"."raw_materials"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_material_presentations" ADD CONSTRAINT "raw_material_presentations_purchase_unit_fk" FOREIGN KEY ("company_id","purchase_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_material_presentations" ADD CONSTRAINT "raw_material_presentations_contained_unit_fk" FOREIGN KEY ("company_id","contained_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_cost_history_movement_uq" ON "inventory_cost_history" USING btree ("movement_id");--> statement-breakpoint
CREATE INDEX "inventory_cost_history_material_idx" ON "inventory_cost_history" USING btree ("company_id","raw_material_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_balances_raw_material_uq" ON "stock_balances" USING btree ("company_id","warehouse_id","raw_material_id") WHERE "stock_balances"."raw_material_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_balances_product_uq" ON "stock_balances" USING btree ("company_id","warehouse_id","product_id") WHERE "stock_balances"."product_id" is not null;--> statement-breakpoint
CREATE INDEX "stock_balances_company_material_idx" ON "stock_balances" USING btree ("company_id","raw_material_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_source_line_uq" ON "stock_movements" USING btree ("company_id","source_line_id") WHERE "stock_movements"."source_line_id" is not null;--> statement-breakpoint
CREATE INDEX "stock_movements_company_sequence_idx" ON "stock_movements" USING btree ("company_id","sequence");--> statement-breakpoint
CREATE INDEX "stock_movements_company_material_idx" ON "stock_movements" USING btree ("company_id","raw_material_id","sequence");--> statement-breakpoint
CREATE INDEX "stock_movements_company_material_occurred_idx" ON "stock_movements" USING btree ("company_id","raw_material_id","occurred_at");--> statement-breakpoint
CREATE INDEX "stock_movements_company_warehouse_occurred_idx" ON "stock_movements" USING btree ("company_id","warehouse_id","occurred_at");--> statement-breakpoint
CREATE INDEX "stock_movements_company_type_occurred_idx" ON "stock_movements" USING btree ("company_id","movement_type","occurred_at");--> statement-breakpoint
CREATE INDEX "stock_movements_company_occurred_idx" ON "stock_movements" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "stock_movements_reference_idx" ON "stock_movements" USING btree ("company_id","reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "purchase_lines_raw_material_idx" ON "purchase_lines" USING btree ("company_id","raw_material_id");--> statement-breakpoint
CREATE INDEX "purchase_receipt_lines_purchase_line_idx" ON "purchase_receipt_lines" USING btree ("company_id","purchase_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_receipts_company_number_uq" ON "purchase_receipts" USING btree ("company_id","internal_number");--> statement-breakpoint
CREATE INDEX "purchase_receipts_purchase_idx" ON "purchase_receipts" USING btree ("company_id","purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_company_number_uq" ON "purchases" USING btree ("company_id","internal_number");--> statement-breakpoint
CREATE INDEX "purchases_company_status_date_idx" ON "purchases" USING btree ("company_id","status","purchase_date");--> statement-breakpoint
CREATE INDEX "purchases_company_date_idx" ON "purchases" USING btree ("company_id","purchase_date");--> statement-breakpoint
CREATE INDEX "purchases_supplier_idx" ON "purchases" USING btree ("company_id","supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_material_presentations_material_name_uq" ON "raw_material_presentations" USING btree ("company_id","raw_material_id",lower("name"));--> statement-breakpoint
-- ===== Invariantes de inventario garantizadas por la base (ADR-026/027) =====
-- El ledger es append-only: las correcciones son movimientos nuevos (TRUNCATE queda para tests).
CREATE FUNCTION inventory_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_append_only: % no está permitido en %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION inventory_reject_mutation();--> statement-breakpoint
CREATE TRIGGER inventory_cost_history_append_only
  BEFORE UPDATE OR DELETE ON "inventory_cost_history"
  FOR EACH ROW EXECUTE FUNCTION inventory_reject_mutation();--> statement-breakpoint
-- stock_balances es una proyección del ledger: se crea vacía (para poder bloquearla) y
-- cada cambio debe aplicar exactamente UN movimiento nuevo del mismo depósito e ítem.
CREATE FUNCTION stock_balances_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m stock_movements%ROWTYPE;
  previous_sequence bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock_balance_derived: los saldos no se borran'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.last_movement_id IS NULL AND NEW.quantity = 0 THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'stock_balance_derived: un saldo nace en cero y sólo cambia con movimientos'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.warehouse_id <> OLD.warehouse_id
     OR NEW.item_type <> OLD.item_type
     OR NEW.raw_material_id IS DISTINCT FROM OLD.raw_material_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.base_unit_id <> OLD.base_unit_id THEN
    RAISE EXCEPTION 'stock_balance_derived: la identidad del saldo no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.last_movement_id IS NULL OR NEW.last_movement_id IS NOT DISTINCT FROM OLD.last_movement_id THEN
    RAISE EXCEPTION 'stock_balance_derived: el saldo sólo cambia con un movimiento nuevo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO m FROM stock_movements WHERE id = NEW.last_movement_id;
  IF NOT FOUND OR m.company_id <> NEW.company_id OR m.warehouse_id <> NEW.warehouse_id
     OR m.item_type <> NEW.item_type
     OR m.raw_material_id IS DISTINCT FROM NEW.raw_material_id
     OR m.product_id IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION 'stock_balance_derived: el movimiento no corresponde a este saldo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.last_movement_id IS NOT NULL THEN
    SELECT sequence INTO previous_sequence FROM stock_movements WHERE id = OLD.last_movement_id;
    IF m.sequence <= previous_sequence THEN
      RAISE EXCEPTION 'stock_balance_derived: el movimiento ya fue aplicado'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.quantity <> OLD.quantity + m.quantity OR NEW.quantity <> m.balance_after THEN
    RAISE EXCEPTION 'stock_balance_derived: cantidad % no coincide con % + %', NEW.quantity, OLD.quantity, m.quantity
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER stock_balances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "stock_balances"
  FOR EACH ROW EXECUTE FUNCTION stock_balances_guard();--> statement-breakpoint
-- Lo mismo para el costo de empresa: cantidad y valor cambian exactamente lo que dice el movimiento.
CREATE FUNCTION raw_material_inventory_costs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m stock_movements%ROWTYPE;
  previous_sequence bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_cost_derived: el costo de inventario no se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.last_movement_id IS NULL AND NEW.quantity = 0 AND NEW.inventory_value = 0
       AND NEW.moving_average_cost IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'inventory_cost_derived: el costo nace vacío y sólo cambia con movimientos'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.raw_material_id <> OLD.raw_material_id THEN
    RAISE EXCEPTION 'inventory_cost_derived: la identidad no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.last_movement_id IS NULL OR NEW.last_movement_id IS NOT DISTINCT FROM OLD.last_movement_id THEN
    RAISE EXCEPTION 'inventory_cost_derived: el costo sólo cambia con un movimiento nuevo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO m FROM stock_movements WHERE id = NEW.last_movement_id;
  IF NOT FOUND OR m.company_id <> NEW.company_id OR m.raw_material_id IS DISTINCT FROM NEW.raw_material_id THEN
    RAISE EXCEPTION 'inventory_cost_derived: el movimiento no corresponde a esta materia prima'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.last_movement_id IS NOT NULL THEN
    SELECT sequence INTO previous_sequence FROM stock_movements WHERE id = OLD.last_movement_id;
    IF m.sequence <= previous_sequence THEN
      RAISE EXCEPTION 'inventory_cost_derived: el movimiento ya fue aplicado'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.quantity <> OLD.quantity + m.quantity OR NEW.inventory_value <> OLD.inventory_value + m.total_value THEN
    RAISE EXCEPTION 'inventory_cost_derived: cantidad o valor no coinciden con el movimiento'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER raw_material_inventory_costs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "raw_material_inventory_costs"
  FOR EACH ROW EXECUTE FUNCTION raw_material_inventory_costs_guard();--> statement-breakpoint
-- ===== Compras =====
-- Una compra que salió de borrador no se borra (se cancela, y sólo sin recepciones).
CREATE FUNCTION purchases_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'purchase_not_deletable: la compra % (%) no se puede borrar', OLD.internal_number, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER purchases_guard
  BEFORE DELETE ON "purchases"
  FOR EACH ROW EXECUTE FUNCTION purchases_guard();--> statement-breakpoint
-- Las líneas sólo se agregan, cambian o quitan con la compra en DRAFT. Después, lo único
-- que cambia es received_quantity (al confirmar recepciones).
CREATE FUNCTION purchase_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  purchase_state purchase_status;
BEGIN
  SELECT status INTO purchase_state FROM purchases
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.purchase_id ELSE NEW.purchase_id END;
  IF NOT FOUND OR purchase_state = 'DRAFT' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'received_quantity') = (to_jsonb(OLD) - 'received_quantity') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'purchase_lines_locked: las líneas de una compra % no se modifican', purchase_state
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER purchase_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "purchase_lines"
  FOR EACH ROW EXECUTE FUNCTION purchase_lines_guard();--> statement-breakpoint
-- Una recepción confirmada (o descartada) es inmutable, y también sus líneas.
CREATE FUNCTION purchase_receipts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'purchase_receipt_immutable: la recepción % (%) no se modifica', OLD.internal_number, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER purchase_receipts_guard
  BEFORE UPDATE OR DELETE ON "purchase_receipts"
  FOR EACH ROW EXECUTE FUNCTION purchase_receipts_guard();--> statement-breakpoint
CREATE FUNCTION purchase_receipt_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  receipt_state purchase_receipt_status;
BEGIN
  SELECT status INTO receipt_state FROM purchase_receipts
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.receipt_id ELSE NEW.receipt_id END;
  IF NOT FOUND OR receipt_state = 'DRAFT' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'purchase_receipt_immutable: las líneas de una recepción % no se modifican', receipt_state
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER purchase_receipt_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "purchase_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION purchase_receipt_lines_guard();
