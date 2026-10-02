-- Fase 5B — Ventas, entrega, cobros, cuenta corriente y margen (ADR-057 a 062).
-- Ventas con asignación de lotes y costo congelado (identificación específica),
-- listas de precios y cotización congelada de pedidos, cobros, aplicaciones y
-- ledger de cuenta corriente del cliente. Cambios sobre tablas existentes: estados
-- de entrega del pedido, cumplimiento parcial de reservas, precio cotizado en
-- pedidos (los de Fase 5A quedan UNPRICED: no se inventan precios), tipo de
-- movimiento SALE y moving_average_cost → average_material_cost (promedio derivado
-- valor / cantidad). 0000–0009 intactas.
CREATE TYPE "public"."order_pricing_status" AS ENUM('UNPRICED', 'QUOTED', 'AGREED');--> statement-breakpoint
CREATE TYPE "public"."price_source" AS ENUM('ORDER_QUOTE', 'CUSTOMER_PRICE_LIST', 'DEFAULT_PRICE_LIST', 'PRODUCT_PRICE', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."customer_account_movement_type" AS ENUM('SALE_DEBIT', 'PAYMENT_CREDIT', 'ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT');--> statement-breakpoint
CREATE TYPE "public"."customer_payment_kind" AS ENUM('ORDER_ADVANCE', 'SALE_PAYMENT', 'ON_ACCOUNT');--> statement-breakpoint
CREATE TYPE "public"."customer_payment_status" AS ENUM('POSTED');--> statement-breakpoint
CREATE TYPE "public"."payment_application_origin" AS ENUM('ADVANCE_AUTO', 'SALE_PAYMENT', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'TRANSFER', 'DEBIT_CARD', 'CREDIT_CARD', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."sale_payment_status" AS ENUM('UNPAID', 'PARTIALLY_PAID', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."sale_status" AS ENUM('DRAFT', 'POSTED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."stock_movement_type" ADD VALUE 'SALE';--> statement-breakpoint
ALTER TYPE "public"."customer_order_status" ADD VALUE 'PARTIALLY_DELIVERED';--> statement-breakpoint
ALTER TYPE "public"."customer_order_status" ADD VALUE 'DELIVERED';--> statement-breakpoint
CREATE TABLE "customer_account_balances" (
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"last_movement_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_account_balances_company_id_customer_id_pk" PRIMARY KEY("company_id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "customer_account_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"movement_type" "customer_account_movement_type" NOT NULL,
	"signed_amount" numeric(14, 2) NOT NULL,
	"balance_after" numeric(14, 2) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"sale_id" uuid,
	"payment_id" uuid,
	"reason" text,
	"notes" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_account_movements_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "customer_account_movements_sequence_uq" UNIQUE("sequence"),
	CONSTRAINT "customer_account_movements_sign" CHECK (("customer_account_movements"."movement_type" in ('SALE_DEBIT', 'ADJUSTMENT_DEBIT') and "customer_account_movements"."signed_amount" > 0)
        or ("customer_account_movements"."movement_type" in ('PAYMENT_CREDIT', 'ADJUSTMENT_CREDIT') and "customer_account_movements"."signed_amount" < 0)),
	CONSTRAINT "customer_account_movements_reference" CHECK (("customer_account_movements"."movement_type" = 'SALE_DEBIT' and "customer_account_movements"."sale_id" is not null and "customer_account_movements"."payment_id" is null)
        or ("customer_account_movements"."movement_type" = 'PAYMENT_CREDIT' and "customer_account_movements"."payment_id" is not null and "customer_account_movements"."sale_id" is null)
        or ("customer_account_movements"."movement_type" in ('ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT') and "customer_account_movements"."sale_id" is null and "customer_account_movements"."payment_id" is null
            and "customer_account_movements"."reason" is not null and length(trim("customer_account_movements"."reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "customer_payment_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"origin" "payment_application_origin" NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_payment_applications_amount" CHECK ("customer_payment_applications"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "customer_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"internal_code" varchar(32) NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" "customer_payment_kind" NOT NULL,
	"source_order_id" uuid,
	"source_sale_id" uuid,
	"status" "customer_payment_status" DEFAULT 'POSTED' NOT NULL,
	"payment_date" timestamp with time zone NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"reference" varchar(120),
	"notes" text,
	"operation_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"posted_by_user_id" uuid,
	"posted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_payments_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "customer_payments_company_id_customer_uq" UNIQUE("company_id","id","customer_id"),
	CONSTRAINT "customer_payments_amount" CHECK ("customer_payments"."amount" > 0),
	CONSTRAINT "customer_payments_kind" CHECK (("customer_payments"."kind" = 'ORDER_ADVANCE' and "customer_payments"."source_order_id" is not null)
        or ("customer_payments"."kind" = 'SALE_PAYMENT' and "customer_payments"."source_sale_id" is not null)
        or ("customer_payments"."kind" = 'ON_ACCOUNT' and "customer_payments"."source_order_id" is null and "customer_payments"."source_sale_id" is null))
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_list_items_price_nonneg" CHECK ("price_list_items"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_lists_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "price_lists_default_active" CHECK (not "price_lists"."is_default" or "price_lists"."active")
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"source_order_line_id" uuid,
	"product_id" uuid NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	"unit_id" uuid NOT NULL,
	"normalized_quantity" numeric(28, 10) NOT NULL,
	"sale_unit_id" uuid NOT NULL,
	"requested_conservation" "requested_conservation" DEFAULT 'ANY' NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"discount_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"net_amount" numeric(14, 2) NOT NULL,
	"price_source" "price_source" NOT NULL,
	"agreed_unit_price" numeric(14, 2),
	"agreed_discount_amount" numeric(14, 2),
	"price_override_reason" text,
	"material_cost" numeric(20, 6),
	"average_lot_unit_cost" numeric(20, 6),
	"gross_margin_amount" numeric(20, 6),
	"gross_margin_percentage" numeric(14, 4),
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_lines_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "sale_lines_company_sale_id_uq" UNIQUE("company_id","sale_id","id"),
	CONSTRAINT "sale_lines_company_product_id_uq" UNIQUE("company_id","product_id","id"),
	CONSTRAINT "sale_lines_amounts" CHECK ("sale_lines"."quantity" > 0 and "sale_lines"."normalized_quantity" > 0 and "sale_lines"."unit_price" >= 0
        and "sale_lines"."discount_amount" >= 0 and "sale_lines"."net_amount" >= 0),
	CONSTRAINT "sale_lines_override_reason" CHECK ("sale_lines"."price_source" <> 'MANUAL' or ("sale_lines"."price_override_reason" is not null and length(trim("sale_lines"."price_override_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "sale_lot_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_lot_id" uuid NOT NULL,
	"reservation_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"quantity" numeric(28, 10) NOT NULL,
	"unit_id" uuid NOT NULL,
	"unit_material_cost" numeric(20, 6) NOT NULL,
	"material_cost" numeric(20, 6) NOT NULL,
	"stock_movement_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_lot_allocations_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "sale_lot_allocations_amounts" CHECK ("sale_lot_allocations"."quantity" > 0 and "sale_lot_allocations"."unit_material_cost" >= 0 and "sale_lot_allocations"."material_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"internal_code" varchar(32) NOT NULL,
	"customer_id" uuid NOT NULL,
	"source_order_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"status" "sale_status" DEFAULT 'DRAFT' NOT NULL,
	"payment_status" "sale_payment_status" DEFAULT 'UNPAID' NOT NULL,
	"sale_date" timestamp with time zone,
	"price_list_id" uuid,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"discount_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"paid_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"material_cost_total" numeric(20, 6),
	"gross_margin_amount" numeric(20, 6),
	"gross_margin_percentage" numeric(14, 4),
	"currency" varchar(3) NOT NULL,
	"notes" text,
	"credit_limit_exceeded" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"posted_by_user_id" uuid,
	"posted_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "sales_company_id_customer_uq" UNIQUE("company_id","id","customer_id"),
	CONSTRAINT "sales_status_data" CHECK (("sales"."status" = 'DRAFT' and "sales"."posted_at" is null and "sales"."sale_date" is null and "sales"."cancelled_at" is null and "sales"."material_cost_total" is null)
        or ("sales"."status" = 'POSTED' and "sales"."posted_at" is not null and "sales"."sale_date" is not null and "sales"."cancelled_at" is null and "sales"."material_cost_total" is not null and "sales"."gross_margin_amount" is not null)
        or ("sales"."status" = 'CANCELLED' and "sales"."cancelled_at" is not null and "sales"."posted_at" is null)),
	CONSTRAINT "sales_amounts" CHECK ("sales"."subtotal" >= 0 and "sales"."discount_total" >= 0 and "sales"."total" >= 0 and "sales"."total" = "sales"."subtotal" - "sales"."discount_total"
        and "sales"."paid_amount" >= 0 and "sales"."paid_amount" <= "sales"."total"),
	CONSTRAINT "sales_payment_status" CHECK (("sales"."status" <> 'POSTED' and "sales"."payment_status" = 'UNPAID' and "sales"."paid_amount" = 0)
        or ("sales"."status" = 'POSTED' and (
          ("sales"."paid_amount" >= "sales"."total" and "sales"."payment_status" = 'PAID')
          or ("sales"."paid_amount" = 0 and "sales"."total" > 0 and "sales"."payment_status" = 'UNPAID')
          or ("sales"."paid_amount" > 0 and "sales"."paid_amount" < "sales"."total" and "sales"."payment_status" = 'PARTIALLY_PAID'))))
);
--> statement-breakpoint
ALTER TABLE "product_inventory_costs" RENAME COLUMN "moving_average_cost" TO "average_material_cost";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_sign";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reason";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_product_types";--> statement-breakpoint
ALTER TABLE "customer_orders" DROP CONSTRAINT "customer_orders_status_data";--> statement-breakpoint
ALTER TABLE "product_inventory_costs" DROP CONSTRAINT "product_inventory_costs_nonneg";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "default_price_list_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "is_walk_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_order_lines" ADD COLUMN "quoted_unit_price" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "customer_order_lines" ADD COLUMN "quoted_discount_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "customer_order_lines" ADD COLUMN "quoted_net_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "customer_order_lines" ADD COLUMN "price_source" "price_source";--> statement-breakpoint
ALTER TABLE "customer_order_lines" ADD COLUMN "price_override_reason" text;--> statement-breakpoint
-- Los pedidos existentes nacen UNPRICED (sin precio inventado); los nuevos, QUOTED.
ALTER TABLE "customer_orders" ADD COLUMN "pricing_status" "order_pricing_status" DEFAULT 'UNPRICED' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_orders" ALTER COLUMN "pricing_status" SET DEFAULT 'QUOTED';--> statement-breakpoint
ALTER TABLE "customer_orders" ADD COLUMN "price_list_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD COLUMN "quoted_subtotal" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "customer_orders" ADD COLUMN "quoted_discount_total" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "customer_orders" ADD COLUMN "quoted_total" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "customer_orders" ADD COLUMN "first_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD COLUMN "delivered_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "product_lot_reservations" ADD COLUMN "fulfilled_quantity" numeric(28, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_company_id_customer_uq" UNIQUE("company_id","id","customer_id");--> statement-breakpoint
ALTER TABLE "customer_account_balances" ADD CONSTRAINT "customer_account_balances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_balances" ADD CONSTRAINT "customer_account_balances_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_balances" ADD CONSTRAINT "customer_account_balances_last_movement_fk" FOREIGN KEY ("company_id","last_movement_id") REFERENCES "public"."customer_account_movements"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_movements" ADD CONSTRAINT "customer_account_movements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_movements" ADD CONSTRAINT "customer_account_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_movements" ADD CONSTRAINT "customer_account_movements_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_movements" ADD CONSTRAINT "customer_account_movements_sale_fk" FOREIGN KEY ("company_id","sale_id","customer_id") REFERENCES "public"."sales"("company_id","id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_movements" ADD CONSTRAINT "customer_account_movements_payment_fk" FOREIGN KEY ("company_id","payment_id","customer_id") REFERENCES "public"."customer_payments"("company_id","id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_applications" ADD CONSTRAINT "customer_payment_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_applications" ADD CONSTRAINT "customer_payment_applications_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_applications" ADD CONSTRAINT "customer_payment_applications_payment_fk" FOREIGN KEY ("company_id","payment_id","customer_id") REFERENCES "public"."customer_payments"("company_id","id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_applications" ADD CONSTRAINT "customer_payment_applications_sale_fk" FOREIGN KEY ("company_id","sale_id","customer_id") REFERENCES "public"."sales"("company_id","id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_order_fk" FOREIGN KEY ("company_id","source_order_id","customer_id") REFERENCES "public"."customer_orders"("company_id","id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_sale_fk" FOREIGN KEY ("company_id","source_sale_id","customer_id") REFERENCES "public"."sales"("company_id","id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_list_fk" FOREIGN KEY ("company_id","price_list_id") REFERENCES "public"."price_lists"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_fk" FOREIGN KEY ("company_id","sale_id") REFERENCES "public"."sales"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_order_line_fk" FOREIGN KEY ("company_id","product_id","source_order_line_id") REFERENCES "public"."customer_order_lines"("company_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_unit_fk" FOREIGN KEY ("company_id","unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_unit_fk" FOREIGN KEY ("company_id","sale_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lot_allocations" ADD CONSTRAINT "sale_lot_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lot_allocations" ADD CONSTRAINT "sale_lot_allocations_line_fk" FOREIGN KEY ("company_id","sale_id","sale_line_id") REFERENCES "public"."sale_lines"("company_id","sale_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lot_allocations" ADD CONSTRAINT "sale_lot_allocations_line_product_fk" FOREIGN KEY ("company_id","product_id","sale_line_id") REFERENCES "public"."sale_lines"("company_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lot_allocations" ADD CONSTRAINT "sale_lot_allocations_lot_fk" FOREIGN KEY ("company_id","product_id","product_lot_id") REFERENCES "public"."product_lots"("company_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lot_allocations" ADD CONSTRAINT "sale_lot_allocations_reservation_fk" FOREIGN KEY ("company_id","reservation_id") REFERENCES "public"."product_lot_reservations"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lot_allocations" ADD CONSTRAINT "sale_lot_allocations_warehouse_fk" FOREIGN KEY ("company_id","warehouse_id") REFERENCES "public"."warehouses"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lot_allocations" ADD CONSTRAINT "sale_lot_allocations_unit_fk" FOREIGN KEY ("company_id","unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lot_allocations" ADD CONSTRAINT "sale_lot_allocations_movement_fk" FOREIGN KEY ("company_id","stock_movement_id") REFERENCES "public"."stock_movements"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_order_fk" FOREIGN KEY ("company_id","source_order_id","customer_id") REFERENCES "public"."customer_orders"("company_id","id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_warehouse_fk" FOREIGN KEY ("company_id","warehouse_id") REFERENCES "public"."warehouses"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_price_list_fk" FOREIGN KEY ("company_id","price_list_id") REFERENCES "public"."price_lists"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_account_balances_balance_idx" ON "customer_account_balances" USING btree ("company_id","balance");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_account_movements_sale_uq" ON "customer_account_movements" USING btree ("company_id","sale_id") WHERE "customer_account_movements"."movement_type" = 'SALE_DEBIT';--> statement-breakpoint
CREATE UNIQUE INDEX "customer_account_movements_payment_uq" ON "customer_account_movements" USING btree ("company_id","payment_id") WHERE "customer_account_movements"."movement_type" = 'PAYMENT_CREDIT';--> statement-breakpoint
CREATE INDEX "customer_account_movements_customer_idx" ON "customer_account_movements" USING btree ("company_id","customer_id","sequence");--> statement-breakpoint
CREATE INDEX "customer_account_movements_customer_date_idx" ON "customer_account_movements" USING btree ("company_id","customer_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customer_account_movements_company_date_idx" ON "customer_account_movements" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customer_payment_applications_sale_idx" ON "customer_payment_applications" USING btree ("company_id","sale_id");--> statement-breakpoint
CREATE INDEX "customer_payment_applications_payment_idx" ON "customer_payment_applications" USING btree ("company_id","payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payments_company_code_uq" ON "customer_payments" USING btree ("company_id","internal_code");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payments_company_operation_uq" ON "customer_payments" USING btree ("company_id","operation_id");--> statement-breakpoint
CREATE INDEX "customer_payments_customer_date_idx" ON "customer_payments" USING btree ("company_id","customer_id","payment_date");--> statement-breakpoint
CREATE INDEX "customer_payments_company_date_idx" ON "customer_payments" USING btree ("company_id","payment_date");--> statement-breakpoint
CREATE INDEX "customer_payments_order_idx" ON "customer_payments" USING btree ("company_id","source_order_id") WHERE "customer_payments"."source_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_items_list_product_uq" ON "price_list_items" USING btree ("company_id","price_list_id","product_id");--> statement-breakpoint
CREATE INDEX "price_list_items_product_idx" ON "price_list_items" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_company_code_uq" ON "price_lists" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_company_default_uq" ON "price_lists" USING btree ("company_id") WHERE "price_lists"."is_default";--> statement-breakpoint
CREATE INDEX "sale_lines_sale_idx" ON "sale_lines" USING btree ("company_id","sale_id","sort_order");--> statement-breakpoint
CREATE INDEX "sale_lines_product_idx" ON "sale_lines" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "sale_lines_order_line_idx" ON "sale_lines" USING btree ("company_id","source_order_line_id") WHERE "sale_lines"."source_order_line_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_lot_allocations_movement_uq" ON "sale_lot_allocations" USING btree ("company_id","stock_movement_id");--> statement-breakpoint
CREATE INDEX "sale_lot_allocations_sale_idx" ON "sale_lot_allocations" USING btree ("company_id","sale_id");--> statement-breakpoint
CREATE INDEX "sale_lot_allocations_lot_idx" ON "sale_lot_allocations" USING btree ("company_id","product_lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_company_code_uq" ON "sales" USING btree ("company_id","internal_code");--> statement-breakpoint
CREATE INDEX "sales_company_date_idx" ON "sales" USING btree ("company_id","sale_date");--> statement-breakpoint
CREATE INDEX "sales_company_status_date_idx" ON "sales" USING btree ("company_id","status","sale_date");--> statement-breakpoint
CREATE INDEX "sales_company_customer_date_idx" ON "sales" USING btree ("company_id","customer_id","sale_date");--> statement-breakpoint
CREATE INDEX "sales_company_payment_status_idx" ON "sales" USING btree ("company_id","payment_status","sale_date");--> statement-breakpoint
CREATE INDEX "sales_company_order_idx" ON "sales" USING btree ("company_id","source_order_id") WHERE "sales"."source_order_id" is not null;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_delivered_by_user_id_users_id_fk" FOREIGN KEY ("delivered_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_company_walk_in_uq" ON "customers" USING btree ("company_id") WHERE "customers"."is_walk_in";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sale" CHECK ("stock_movements"."movement_type"::text <> 'SALE'
        or ("stock_movements"."item_type" = 'PRODUCT' and "stock_movements"."reference_type" = 'SALE' and "stock_movements"."reference_id" is not null and "stock_movements"."source_line_id" is not null));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sign" CHECK (("stock_movements"."movement_type"::text in ('INITIAL_STOCK', 'PURCHASE_RECEIPT', 'ADJUSTMENT_POSITIVE', 'PRODUCTION_OUTPUT', 'LOT_TRANSFORMATION_IN') and "stock_movements"."quantity" > 0 and "stock_movements"."total_value" >= 0)
        or ("stock_movements"."movement_type"::text in ('ADJUSTMENT_NEGATIVE', 'WASTE', 'PRODUCTION_CONSUMPTION', 'LOT_TRANSFORMATION_OUT', 'SALE') and "stock_movements"."quantity" < 0 and "stock_movements"."total_value" <= 0));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason" CHECK (("stock_movements"."movement_type"::text in ('ADJUSTMENT_POSITIVE', 'ADJUSTMENT_NEGATIVE') and "stock_movements"."reason" in ('PHYSICAL_COUNT', 'DATA_CORRECTION', 'BREAKAGE', 'OTHER'))
        or ("stock_movements"."movement_type"::text = 'WASTE' and "stock_movements"."reason" in ('EXPIRED', 'DAMAGED', 'PRODUCTION_LOSS', 'QUALITY', 'OTHER'))
        or ("stock_movements"."movement_type"::text in ('INITIAL_STOCK', 'PURCHASE_RECEIPT', 'PRODUCTION_CONSUMPTION', 'PRODUCTION_OUTPUT', 'LOT_TRANSFORMATION_OUT', 'LOT_TRANSFORMATION_IN', 'SALE') and "stock_movements"."reason" is null));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_types" CHECK ("stock_movements"."item_type" = 'RAW_MATERIAL' or "stock_movements"."movement_type"::text in ('PRODUCTION_OUTPUT', 'LOT_TRANSFORMATION_OUT', 'LOT_TRANSFORMATION_IN', 'WASTE', 'SALE'));--> statement-breakpoint
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_quote" CHECK (("customer_order_lines"."quoted_unit_price" is null and "customer_order_lines"."quoted_discount_amount" is null and "customer_order_lines"."quoted_net_amount" is null and "customer_order_lines"."price_source" is null)
        or ("customer_order_lines"."quoted_unit_price" >= 0 and "customer_order_lines"."quoted_discount_amount" >= 0 and "customer_order_lines"."quoted_net_amount" >= 0 and "customer_order_lines"."price_source" is not null));--> statement-breakpoint
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_override_reason" CHECK ("customer_order_lines"."price_source" is distinct from 'MANUAL' or ("customer_order_lines"."price_override_reason" is not null and length(trim("customer_order_lines"."price_override_reason")) > 0));--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_delivery" CHECK (("customer_orders"."status"::text in ('PARTIALLY_DELIVERED', 'DELIVERED')) = ("customer_orders"."first_delivered_at" is not null) or "customer_orders"."status"::text = 'CANCELLED');--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_delivered" CHECK (("customer_orders"."status"::text = 'DELIVERED') = ("customer_orders"."delivered_at" is not null));--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_pricing" CHECK (("customer_orders"."pricing_status" = 'UNPRICED' and "customer_orders"."quoted_total" is null and "customer_orders"."quoted_subtotal" is null and "customer_orders"."quoted_discount_total" is null)
        or ("customer_orders"."pricing_status" in ('QUOTED', 'AGREED') and "customer_orders"."quoted_total" is not null and "customer_orders"."quoted_subtotal" is not null and "customer_orders"."quoted_discount_total" is not null
            and "customer_orders"."quoted_total" = "customer_orders"."quoted_subtotal" - "customer_orders"."quoted_discount_total" and "customer_orders"."quoted_total" >= 0));--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_agreed_when_confirmed" CHECK ("customer_orders"."pricing_status" <> 'QUOTED' or "customer_orders"."status"::text in ('DRAFT', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_status_data" CHECK (("customer_orders"."status"::text = 'DRAFT' and "customer_orders"."plan_revision" = 0 and "customer_orders"."coverage_status" is null and "customer_orders"."confirmed_at" is null and "customer_orders"."cancelled_at" is null)
        or ("customer_orders"."status"::text in ('CONFIRMED', 'IN_PREPARATION', 'READY', 'PARTIALLY_DELIVERED', 'DELIVERED') and "customer_orders"."plan_revision" >= 1 and "customer_orders"."coverage_status" is not null and "customer_orders"."confirmed_at" is not null and "customer_orders"."cancelled_at" is null)
        or ("customer_orders"."status"::text = 'CANCELLED' and "customer_orders"."cancelled_at" is not null));--> statement-breakpoint
ALTER TABLE "product_lot_reservations" ADD CONSTRAINT "product_lot_reservations_fulfilled" CHECK ("product_lot_reservations"."fulfilled_quantity" >= 0 and "product_lot_reservations"."fulfilled_quantity" <= "product_lot_reservations"."quantity"
        and ("product_lot_reservations"."status" <> 'FULFILLED' or "product_lot_reservations"."fulfilled_quantity" = "product_lot_reservations"."quantity")
        and ("product_lot_reservations"."status" <> 'ACTIVE' or "product_lot_reservations"."fulfilled_quantity" < "product_lot_reservations"."quantity"));--> statement-breakpoint
ALTER TABLE "product_inventory_costs" ADD CONSTRAINT "product_inventory_costs_nonneg" CHECK ("product_inventory_costs"."quantity" >= 0 and "product_inventory_costs"."inventory_value" >= 0 and ("product_inventory_costs"."average_material_cost" is null or "product_inventory_costs"."average_material_cost" >= 0));--> statement-breakpoint
-- Lista de precios del cliente y lista con que se cotizó un pedido (declaradas aquí y no
-- en el schema de Drizzle para no crear ciclos de tipos commercial/orders ↔ sales).
ALTER TABLE "customers" ADD CONSTRAINT "customers_default_price_list_fk" FOREIGN KEY ("company_id","default_price_list_id") REFERENCES "public"."price_lists"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_price_list_fk" FOREIGN KEY ("company_id","price_list_id") REFERENCES "public"."price_lists"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- ===== Valorización de producto por lote específico (ADR-057) =====
-- Reconciliación previa obligatoria: Σ lotes = saldo agregado y = costo de inventario.
DO $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad FROM stock_balances sb
   WHERE sb.item_type = 'PRODUCT'
     AND sb.quantity <> coalesce((
       SELECT sum(lb.quantity) FROM product_lot_balances lb
        WHERE lb.company_id = sb.company_id AND lb.product_id = sb.product_id
          AND lb.warehouse_id = sb.warehouse_id), 0);
  IF bad > 0 THEN
    RAISE EXCEPTION 'FASE_5B_MIGRATION_BLOCKER: % saldos de producto no reconcilian con sus lotes', bad;
  END IF;
  SELECT count(*) INTO bad FROM product_inventory_costs c
   WHERE c.quantity <> coalesce((SELECT sum(lb.quantity) FROM product_lot_balances lb
                                  WHERE lb.company_id = c.company_id AND lb.product_id = c.product_id), 0)
      OR c.inventory_value <> coalesce((SELECT sum(lb.inventory_value) FROM product_lot_balances lb
                                  WHERE lb.company_id = c.company_id AND lb.product_id = c.product_id), 0);
  IF bad > 0 THEN
    RAISE EXCEPTION 'FASE_5B_MIGRATION_BLOCKER: % productos cuyo stock o valor no reconcilia con sus lotes', bad;
  END IF;
END;
$$;--> statement-breakpoint
-- El promedio pasa a ser derivado (valor / cantidad, 6 decimales, half-up): única
-- escritura sobre la proyección fuera de un movimiento; el guard se suspende sólo aquí.
ALTER TABLE "product_inventory_costs" DISABLE TRIGGER "product_inventory_costs_guard";--> statement-breakpoint
UPDATE "product_inventory_costs"
   SET "average_material_cost" = CASE WHEN quantity > 0 THEN round(inventory_value / quantity, 6) ELSE NULL END;--> statement-breakpoint
ALTER TABLE "product_inventory_costs" ENABLE TRIGGER "product_inventory_costs_guard";--> statement-breakpoint
-- Costo de producto: proyección del ledger; desde 5B además exige el promedio derivado.
CREATE OR REPLACE FUNCTION product_inventory_costs_guard() RETURNS trigger
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
       AND NEW.average_material_cost IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'inventory_cost_derived: el costo nace vacío y sólo cambia con movimientos'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.product_id <> OLD.product_id THEN
    RAISE EXCEPTION 'inventory_cost_derived: la identidad no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.last_movement_id IS NULL OR NEW.last_movement_id IS NOT DISTINCT FROM OLD.last_movement_id THEN
    RAISE EXCEPTION 'inventory_cost_derived: el costo sólo cambia con un movimiento nuevo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO m FROM stock_movements WHERE id = NEW.last_movement_id;
  IF NOT FOUND OR m.company_id <> NEW.company_id OR m.product_id IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION 'inventory_cost_derived: el movimiento no corresponde a este producto'
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
  IF (NEW.quantity = 0 AND NEW.average_material_cost IS NOT NULL)
     OR (NEW.quantity > 0 AND NEW.average_material_cost IS DISTINCT FROM round(NEW.inventory_value / NEW.quantity, 6)) THEN
    RAISE EXCEPTION 'inventory_cost_derived: el costo promedio % no es valor / cantidad', NEW.average_material_cost
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- ===== Reservas: cumplimiento parcial por ventas (ADR-059) =====
-- Inmutable salvo fulfilled_quantity (sólo crece) y el paso ACTIVE → RELEASED /
-- INVALIDATED / FULFILLED; nunca se borra.
CREATE OR REPLACE FUNCTION product_lot_reservations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['status', 'released_at', 'release_reason', 'released_by_user_id', 'fulfilled_quantity'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lot_reservation_history: las reservas no se borran (se liberan)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'lot_reservation_closed: la reserva ya fue %', OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'lot_reservation_immutable: cantidad, lote y revisión de una reserva no cambian'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.fulfilled_quantity < OLD.fulfilled_quantity THEN
    RAISE EXCEPTION 'lot_reservation_fulfilled: lo entregado de una reserva no disminuye'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Comprometido = Σ (reservado − entregado) de las reservas activas.
CREATE OR REPLACE FUNCTION product_lot_reservations_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot_quality lot_quality_status;
  balance numeric;
  committed numeric;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  SELECT quality_status INTO lot_quality FROM product_lots WHERE id = NEW.product_lot_id;
  IF lot_quality <> 'AVAILABLE' THEN
    RAISE EXCEPTION 'lot_reservation_blocked_lot: no se reserva un lote bloqueado por calidad'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(quantity), 0) INTO balance FROM product_lot_balances
   WHERE product_lot_id = NEW.product_lot_id;
  SELECT coalesce(sum(quantity - fulfilled_quantity), 0) INTO committed FROM product_lot_reservations
   WHERE product_lot_id = NEW.product_lot_id AND status = 'ACTIVE' AND id <> NEW.id;
  IF committed + NEW.quantity - NEW.fulfilled_quantity > balance THEN
    RAISE EXCEPTION 'lot_reservation_exceeds_balance: reservas % + % superan el saldo % del lote', committed, NEW.quantity - NEW.fulfilled_quantity, balance
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION product_lot_balances_reserved() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  committed numeric;
  balance numeric;
BEGIN
  SELECT coalesce(sum(quantity - fulfilled_quantity), 0) INTO committed FROM product_lot_reservations
   WHERE product_lot_id = NEW.product_lot_id AND status = 'ACTIVE';
  IF committed = 0 THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(quantity), 0) INTO balance FROM product_lot_balances
   WHERE product_lot_id = NEW.product_lot_id;
  IF balance < committed THEN
    RAISE EXCEPTION 'lot_reservation_exceeds_balance: el saldo % del lote quedaría debajo de lo reservado %', balance, committed
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Pedido: no se borra, identidad fija, cancelado o entregado por completo es inmutable.
CREATE OR REPLACE FUNCTION customer_orders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer_order_not_deletable: el pedido % no se borra (se cancela)', OLD.internal_code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.internal_code <> OLD.internal_code THEN
    RAISE EXCEPTION 'customer_order_identity: la identidad del pedido no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status::text IN ('CANCELLED', 'DELIVERED') THEN
    RAISE EXCEPTION 'customer_order_immutable: el pedido % está %', OLD.internal_code, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.plan_revision < OLD.plan_revision THEN
    RAISE EXCEPTION 'customer_order_revision: la revisión del plan no retrocede'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.pricing_status = 'AGREED' AND NEW.pricing_status <> 'AGREED' THEN
    RAISE EXCEPTION 'customer_order_quote: un precio acordado no vuelve atrás'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- ===== Ventas: inmutables una vez posteadas (ADR-058) =====
CREATE FUNCTION sales_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['paid_amount', 'payment_status', 'updated_at'];
  applied numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sale_not_deletable: la venta % no se borra', OLD.internal_code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.internal_code <> OLD.internal_code THEN
    RAISE EXCEPTION 'sale_identity: la identidad de la venta no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'sale_immutable: la venta % está cancelada', OLD.internal_code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'POSTED' AND (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'sale_immutable: la venta % ya se registró; sólo cambia su cobro', OLD.internal_code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.paid_amount <> OLD.paid_amount THEN
    SELECT coalesce(sum(amount), 0) INTO applied FROM customer_payment_applications WHERE sale_id = NEW.id;
    IF NEW.paid_amount <> applied THEN
      RAISE EXCEPTION 'sale_paid_amount: lo cobrado % no coincide con las aplicaciones %', NEW.paid_amount, applied
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER sales_guard
  BEFORE UPDATE OR DELETE ON "sales"
  FOR EACH ROW EXECUTE FUNCTION sales_guard();--> statement-breakpoint
-- Líneas: se editan y borran sólo mientras la venta es borrador.
CREATE FUNCTION sale_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sale_state sale_status;
  line sale_lines%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN line := OLD; ELSE line := NEW; END IF;
  SELECT status INTO sale_state FROM sales WHERE id = line.sale_id;
  IF sale_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'sale_line_immutable: las líneas de una venta % no cambian', sale_state
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.company_id <> OLD.company_id OR NEW.sale_id <> OLD.sale_id) THEN
    RAISE EXCEPTION 'sale_line_identity: una línea no cambia de venta'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER sale_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "sale_lines"
  FOR EACH ROW EXECUTE FUNCTION sale_lines_guard();--> statement-breakpoint
-- Asignación de lotes: sólo nace al postear (venta todavía DRAFT en la transacción) y
-- nunca cambia.
CREATE FUNCTION sale_lot_allocations_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sale_state sale_status;
BEGIN
  SELECT status INTO sale_state FROM sales WHERE id = NEW.sale_id;
  IF sale_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'sale_allocation_closed: la venta ya no admite asignaciones de lote'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER sale_lot_allocations_insert_guard
  BEFORE INSERT ON "sale_lot_allocations"
  FOR EACH ROW EXECUTE FUNCTION sale_lot_allocations_insert_guard();--> statement-breakpoint
CREATE TRIGGER sale_lot_allocations_append_only
  BEFORE UPDATE OR DELETE ON "sale_lot_allocations"
  FOR EACH ROW EXECUTE FUNCTION inventory_reject_mutation();--> statement-breakpoint
-- ===== Cobros y cuenta corriente (ADR-061) =====
-- Un cobro registrado no se modifica ni se borra (se corrige con un ajuste).
CREATE TRIGGER customer_payments_immutable
  BEFORE UPDATE OR DELETE ON "customer_payments"
  FOR EACH ROW EXECUTE FUNCTION inventory_reject_mutation();--> statement-breakpoint
-- Aplicación: sobre una venta registrada, sin superar su total ni el monto del pago.
CREATE FUNCTION customer_payment_applications_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sale_row sales%ROWTYPE;
  payment_amount numeric;
  applied_sale numeric;
  applied_payment numeric;
BEGIN
  SELECT * INTO sale_row FROM sales WHERE id = NEW.sale_id;
  IF sale_row.status <> 'POSTED' THEN
    RAISE EXCEPTION 'payment_application_sale: sólo se aplican pagos a ventas registradas'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO applied_sale FROM customer_payment_applications WHERE sale_id = NEW.sale_id;
  IF applied_sale + NEW.amount > sale_row.total THEN
    RAISE EXCEPTION 'payment_exceeds_sale_balance: aplicado % + % supera el total % de la venta', applied_sale, NEW.amount, sale_row.total
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT amount INTO payment_amount FROM customer_payments WHERE id = NEW.payment_id;
  SELECT coalesce(sum(amount), 0) INTO applied_payment FROM customer_payment_applications WHERE payment_id = NEW.payment_id;
  IF applied_payment + NEW.amount > payment_amount THEN
    RAISE EXCEPTION 'payment_application_exceeds_payment: aplicado % + % supera el pago %', applied_payment, NEW.amount, payment_amount
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER customer_payment_applications_capacity
  BEFORE INSERT ON "customer_payment_applications"
  FOR EACH ROW EXECUTE FUNCTION customer_payment_applications_capacity();--> statement-breakpoint
CREATE TRIGGER customer_payment_applications_append_only
  BEFORE UPDATE OR DELETE ON "customer_payment_applications"
  FOR EACH ROW EXECUTE FUNCTION inventory_reject_mutation();--> statement-breakpoint
CREATE TRIGGER customer_account_movements_append_only
  BEFORE UPDATE OR DELETE ON "customer_account_movements"
  FOR EACH ROW EXECUTE FUNCTION inventory_reject_mutation();--> statement-breakpoint
-- Saldo de cuenta: proyección del ledger con el mismo contrato que stock_balances.
CREATE FUNCTION customer_account_balances_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m customer_account_movements%ROWTYPE;
  previous_sequence bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer_account_derived: el saldo de cuenta no se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance = 0 AND NEW.last_movement_id IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'customer_account_derived: el saldo nace en cero y sólo cambia con movimientos'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.customer_id <> OLD.customer_id THEN
    RAISE EXCEPTION 'customer_account_derived: la identidad no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.last_movement_id IS NULL OR NEW.last_movement_id IS NOT DISTINCT FROM OLD.last_movement_id THEN
    RAISE EXCEPTION 'customer_account_derived: el saldo sólo cambia con un movimiento nuevo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO m FROM customer_account_movements WHERE id = NEW.last_movement_id;
  IF NOT FOUND OR m.company_id <> NEW.company_id OR m.customer_id <> NEW.customer_id THEN
    RAISE EXCEPTION 'customer_account_derived: el movimiento no corresponde a este cliente'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.last_movement_id IS NOT NULL THEN
    SELECT sequence INTO previous_sequence FROM customer_account_movements WHERE id = OLD.last_movement_id;
    IF m.sequence <= previous_sequence THEN
      RAISE EXCEPTION 'customer_account_derived: el movimiento ya fue aplicado'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.balance <> OLD.balance + m.signed_amount OR NEW.balance <> m.balance_after THEN
    RAISE EXCEPTION 'customer_account_derived: el saldo % no coincide con el movimiento', NEW.balance
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER customer_account_balances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "customer_account_balances"
  FOR EACH ROW EXECUTE FUNCTION customer_account_balances_guard();--> statement-breakpoint
-- ===== Consumidor Final (uno por empresa, sin UUID fijo) =====
INSERT INTO "customers" ("company_id", "internal_code", "type", "legal_name", "commercial_condition", "is_walk_in", "notes")
SELECT c.id, 'CONS-FINAL', 'CONSUMER', 'Consumidor Final', 'CASH', true,
       'Cliente genérico para ventas de mostrador (creado por la migración de Fase 5B).'
  FROM companies c
 WHERE NOT EXISTS (SELECT 1 FROM customers x WHERE x.company_id = c.id AND (x.is_walk_in OR x.internal_code = 'CONS-FINAL'));
