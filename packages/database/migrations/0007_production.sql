-- Fase 4 — Producción. Órdenes de producción (= lote), líneas de consumo, costo
-- promedio de producto terminado y su historial. El ledger de stock suma los tipos
-- PRODUCTION_CONSUMPTION y PRODUCTION_OUTPUT; stock_balances ya era genérico
-- (item_type + raw_material_id | product_id) desde 0006: no se migran datos.
--
-- IMPORTANTE: el migrador aplica las migraciones pendientes en UNA transacción y
-- Postgres no permite usar como literal un valor de enum agregado en la misma
-- transacción. Por eso las restricciones comparan movement_type::text.
CREATE TYPE "public"."production_line_type" AS ENUM('RECIPE', 'EXTRA');--> statement-breakpoint
CREATE TYPE "public"."production_order_status" AS ENUM('DRAFT', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."stock_movement_type" ADD VALUE 'PRODUCTION_CONSUMPTION';--> statement-breakpoint
ALTER TYPE "public"."stock_movement_type" ADD VALUE 'PRODUCTION_OUTPUT';--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_company_recipe_id_uq" UNIQUE("company_id","recipe_id","id");--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_company_product_id_uq" UNIQUE("company_id","product_id","id");--> statement-breakpoint
CREATE TABLE "product_inventory_cost_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"movement_sequence" bigint NOT NULL,
	"movement_type" "stock_movement_type" NOT NULL,
	"production_order_id" uuid,
	"quantity_before" numeric(28, 10) NOT NULL,
	"quantity_after" numeric(28, 10) NOT NULL,
	"value_before" numeric(20, 6) NOT NULL,
	"value_after" numeric(20, 6) NOT NULL,
	"average_before" numeric(20, 6),
	"average_after" numeric(20, 6),
	"batch_quantity" numeric(28, 10) NOT NULL,
	"batch_unit_cost" numeric(20, 6) NOT NULL,
	"batch_value" numeric(20, 6) NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_inventory_costs" (
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" numeric(28, 10) DEFAULT '0' NOT NULL,
	"inventory_value" numeric(20, 6) DEFAULT '0' NOT NULL,
	"moving_average_cost" numeric(20, 6),
	"last_movement_id" uuid,
	"last_updated_at" timestamp with time zone,
	CONSTRAINT "product_inventory_costs_company_id_product_id_pk" PRIMARY KEY("company_id","product_id"),
	CONSTRAINT "product_inventory_costs_nonneg" CHECK ("product_inventory_costs"."quantity" >= 0 and "product_inventory_costs"."inventory_value" >= 0 and ("product_inventory_costs"."moving_average_cost" is null or "product_inventory_costs"."moving_average_cost" >= 0)),
	CONSTRAINT "product_inventory_costs_empty_value" CHECK ("product_inventory_costs"."quantity" > 0 or "product_inventory_costs"."inventory_value" = 0)
);
--> statement-breakpoint
CREATE TABLE "production_material_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"production_order_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"line_type" "production_line_type" NOT NULL,
	"recipe_ingredient_id" uuid,
	"raw_material_id" uuid NOT NULL,
	"base_unit_id" uuid NOT NULL,
	"planned_quantity" numeric(28, 10),
	"planned_unit_id" uuid,
	"planned_normalized_quantity" numeric(28, 10),
	"planned_unit_cost" numeric(20, 6),
	"planned_cost_source" "cost_source",
	"planned_cost" numeric(20, 6),
	"actual_quantity" numeric(28, 10),
	"actual_unit_id" uuid,
	"actual_normalized_quantity" numeric(28, 10),
	"actual_unit_cost" numeric(20, 6),
	"actual_cost" numeric(20, 6),
	"variance_quantity" numeric(28, 10),
	"variance_percentage" numeric(20, 4),
	"consumption_movement_id" uuid,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_material_lines_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "production_material_lines_order_number_uq" UNIQUE("production_order_id","line_number"),
	CONSTRAINT "production_material_lines_type" CHECK (("production_material_lines"."line_type" = 'RECIPE' and "production_material_lines"."planned_quantity" > 0 and "production_material_lines"."planned_unit_id" is not null and "production_material_lines"."planned_normalized_quantity" > 0)
        or ("production_material_lines"."line_type" = 'EXTRA' and "production_material_lines"."planned_quantity" is null and "production_material_lines"."planned_unit_id" is null and "production_material_lines"."planned_normalized_quantity" is null
            and "production_material_lines"."recipe_ingredient_id" is null and "production_material_lines"."actual_quantity" is not null
            and "production_material_lines"."notes" is not null and length(trim("production_material_lines"."notes")) > 0)),
	CONSTRAINT "production_material_lines_actual" CHECK (("production_material_lines"."actual_quantity" is null and "production_material_lines"."actual_unit_id" is null and "production_material_lines"."actual_normalized_quantity" is null)
        or ("production_material_lines"."actual_quantity" >= 0 and "production_material_lines"."actual_unit_id" is not null and "production_material_lines"."actual_normalized_quantity" >= 0)),
	CONSTRAINT "production_material_lines_costs" CHECK ((("production_material_lines"."planned_unit_cost" is null) = ("production_material_lines"."planned_cost" is null))
        and ("production_material_lines"."planned_unit_cost" is null or ("production_material_lines"."planned_unit_cost" >= 0 and "production_material_lines"."planned_cost_source" is not null))
        and (("production_material_lines"."actual_unit_cost" is null) = ("production_material_lines"."actual_cost" is null))
        and ("production_material_lines"."actual_cost" is null or "production_material_lines"."actual_cost" >= 0))
);
--> statement-breakpoint
CREATE TABLE "production_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"internal_code" varchar(32) NOT NULL,
	"product_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"recipe_version_id" uuid NOT NULL,
	"source_warehouse_id" uuid NOT NULL,
	"output_warehouse_id" uuid NOT NULL,
	"status" "production_order_status" DEFAULT 'DRAFT' NOT NULL,
	"scheduled_for" date NOT NULL,
	"planned_output_quantity" numeric(18, 6) NOT NULL,
	"planned_output_unit_id" uuid NOT NULL,
	"sale_unit_id" uuid NOT NULL,
	"planned_output_normalized" numeric(28, 10) NOT NULL,
	"scale_factor" numeric(28, 10),
	"theoretical_waste_percentage" numeric(7, 4),
	"actual_output_quantity" numeric(18, 6),
	"actual_output_unit_id" uuid,
	"actual_output_normalized" numeric(28, 10),
	"batch_code" varchar(40),
	"responsible_employee_id" uuid,
	"notes" text,
	"currency_code" varchar(3),
	"planned_cost_status" "cost_completeness",
	"planned_material_cost" numeric(20, 6),
	"planned_unit_material_cost" numeric(20, 6),
	"actual_material_cost" numeric(20, 6),
	"actual_unit_material_cost" numeric(20, 6),
	"output_movement_id" uuid,
	"created_by_user_id" uuid,
	"planned_by_user_id" uuid,
	"started_by_user_id" uuid,
	"completed_by_user_id" uuid,
	"cancelled_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"planned_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_orders_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "production_orders_quantities" CHECK ("production_orders"."planned_output_quantity" > 0 and "production_orders"."planned_output_normalized" > 0
        and ("production_orders"."scale_factor" is null or "production_orders"."scale_factor" > 0)
        and (("production_orders"."actual_output_quantity" is null and "production_orders"."actual_output_unit_id" is null and "production_orders"."actual_output_normalized" is null)
          or ("production_orders"."actual_output_quantity" > 0 and "production_orders"."actual_output_unit_id" is not null and "production_orders"."actual_output_normalized" > 0))),
	CONSTRAINT "production_orders_planned_cost" CHECK (("production_orders"."planned_cost_status" is null and "production_orders"."planned_material_cost" is null and "production_orders"."planned_unit_material_cost" is null)
        or ("production_orders"."planned_cost_status" = 'COMPLETE' and "production_orders"."planned_material_cost" >= 0 and "production_orders"."planned_unit_material_cost" >= 0)
        or ("production_orders"."planned_cost_status" = 'INCOMPLETE' and "production_orders"."planned_material_cost" is null and "production_orders"."planned_unit_material_cost" is null)),
	CONSTRAINT "production_orders_status_data" CHECK (("production_orders"."status" = 'DRAFT' and "production_orders"."planned_at" is null and "production_orders"."started_at" is null and "production_orders"."completed_at" is null and "production_orders"."cancelled_at" is null)
        or ("production_orders"."status" = 'PLANNED' and "production_orders"."planned_at" is not null and "production_orders"."scale_factor" is not null and "production_orders"."planned_cost_status" is not null and "production_orders"."currency_code" is not null
            and "production_orders"."started_at" is null and "production_orders"."completed_at" is null and "production_orders"."cancelled_at" is null)
        or ("production_orders"."status" = 'IN_PROGRESS' and "production_orders"."planned_at" is not null and "production_orders"."started_at" is not null and "production_orders"."completed_at" is null and "production_orders"."cancelled_at" is null)
        or ("production_orders"."status" = 'COMPLETED' and "production_orders"."planned_at" is not null and "production_orders"."started_at" is not null and "production_orders"."completed_at" is not null and "production_orders"."cancelled_at" is null
            and "production_orders"."actual_output_normalized" is not null and "production_orders"."actual_material_cost" >= 0 and "production_orders"."actual_unit_material_cost" >= 0 and "production_orders"."output_movement_id" is not null)
        or ("production_orders"."status" = 'CANCELLED' and "production_orders"."cancelled_at" is not null and "production_orders"."completed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_sign";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reason";--> statement-breakpoint
ALTER TABLE "product_inventory_cost_history" ADD CONSTRAINT "product_inventory_cost_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory_cost_history" ADD CONSTRAINT "product_inventory_cost_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory_cost_history" ADD CONSTRAINT "product_inventory_cost_history_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory_cost_history" ADD CONSTRAINT "product_inventory_cost_history_movement_fk" FOREIGN KEY ("company_id","movement_id") REFERENCES "public"."stock_movements"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory_cost_history" ADD CONSTRAINT "product_inventory_cost_history_order_fk" FOREIGN KEY ("company_id","production_order_id") REFERENCES "public"."production_orders"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory_costs" ADD CONSTRAINT "product_inventory_costs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory_costs" ADD CONSTRAINT "product_inventory_costs_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory_costs" ADD CONSTRAINT "product_inventory_costs_last_movement_fk" FOREIGN KEY ("company_id","last_movement_id") REFERENCES "public"."stock_movements"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_material_lines" ADD CONSTRAINT "production_material_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_material_lines" ADD CONSTRAINT "production_material_lines_recipe_ingredient_id_recipe_ingredients_id_fk" FOREIGN KEY ("recipe_ingredient_id") REFERENCES "public"."recipe_ingredients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_material_lines" ADD CONSTRAINT "production_material_lines_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_material_lines" ADD CONSTRAINT "production_material_lines_order_fk" FOREIGN KEY ("company_id","production_order_id") REFERENCES "public"."production_orders"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_material_lines" ADD CONSTRAINT "production_material_lines_raw_material_fk" FOREIGN KEY ("company_id","raw_material_id") REFERENCES "public"."raw_materials"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_material_lines" ADD CONSTRAINT "production_material_lines_base_unit_fk" FOREIGN KEY ("company_id","base_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_material_lines" ADD CONSTRAINT "production_material_lines_planned_unit_fk" FOREIGN KEY ("company_id","planned_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_material_lines" ADD CONSTRAINT "production_material_lines_actual_unit_fk" FOREIGN KEY ("company_id","actual_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_material_lines" ADD CONSTRAINT "production_material_lines_movement_fk" FOREIGN KEY ("company_id","consumption_movement_id") REFERENCES "public"."stock_movements"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_planned_by_user_id_users_id_fk" FOREIGN KEY ("planned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_recipe_fk" FOREIGN KEY ("company_id","product_id","recipe_id") REFERENCES "public"."recipes"("company_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_version_fk" FOREIGN KEY ("company_id","recipe_id","recipe_version_id") REFERENCES "public"."recipe_versions"("company_id","recipe_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_source_warehouse_fk" FOREIGN KEY ("company_id","source_warehouse_id") REFERENCES "public"."warehouses"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_output_warehouse_fk" FOREIGN KEY ("company_id","output_warehouse_id") REFERENCES "public"."warehouses"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_planned_unit_fk" FOREIGN KEY ("company_id","planned_output_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_sale_unit_fk" FOREIGN KEY ("company_id","sale_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_actual_unit_fk" FOREIGN KEY ("company_id","actual_output_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_responsible_fk" FOREIGN KEY ("company_id","responsible_employee_id") REFERENCES "public"."employees"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_output_movement_fk" FOREIGN KEY ("company_id","output_movement_id") REFERENCES "public"."stock_movements"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_inventory_cost_history_movement_uq" ON "product_inventory_cost_history" USING btree ("movement_id");--> statement-breakpoint
CREATE INDEX "product_inventory_cost_history_product_idx" ON "product_inventory_cost_history" USING btree ("company_id","product_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_material_lines_recipe_material_uq" ON "production_material_lines" USING btree ("production_order_id","raw_material_id") WHERE "production_material_lines"."line_type" = 'RECIPE';--> statement-breakpoint
CREATE INDEX "production_material_lines_material_idx" ON "production_material_lines" USING btree ("company_id","raw_material_id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_orders_company_code_uq" ON "production_orders" USING btree ("company_id","internal_code");--> statement-breakpoint
CREATE UNIQUE INDEX "production_orders_company_batch_uq" ON "production_orders" USING btree ("company_id","batch_code") WHERE "production_orders"."batch_code" is not null;--> statement-breakpoint
CREATE INDEX "production_orders_company_status_date_idx" ON "production_orders" USING btree ("company_id","status","scheduled_for");--> statement-breakpoint
CREATE INDEX "production_orders_company_date_idx" ON "production_orders" USING btree ("company_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "production_orders_company_product_idx" ON "production_orders" USING btree ("company_id","product_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "production_orders_company_version_idx" ON "production_orders" USING btree ("company_id","recipe_version_id");--> statement-breakpoint
CREATE INDEX "production_orders_company_responsible_idx" ON "production_orders" USING btree ("company_id","responsible_employee_id");--> statement-breakpoint
CREATE INDEX "production_orders_company_completed_idx" ON "production_orders" USING btree ("company_id","completed_at");--> statement-breakpoint
CREATE INDEX "stock_balances_company_product_idx" ON "stock_balances" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_movements_company_product_idx" ON "stock_movements" USING btree ("company_id","product_id","sequence");--> statement-breakpoint
CREATE INDEX "stock_movements_company_item_type_idx" ON "stock_movements" USING btree ("company_id","item_type","sequence");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_production" CHECK (("stock_movements"."movement_type"::text not in ('PRODUCTION_CONSUMPTION', 'PRODUCTION_OUTPUT'))
        or ("stock_movements"."reference_type" = 'PRODUCTION_ORDER' and "stock_movements"."reference_id" is not null and "stock_movements"."source_line_id" is not null
            and (("stock_movements"."movement_type"::text = 'PRODUCTION_CONSUMPTION' and "stock_movements"."item_type" = 'RAW_MATERIAL')
              or ("stock_movements"."movement_type"::text = 'PRODUCTION_OUTPUT' and "stock_movements"."item_type" = 'PRODUCT'))));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_types" CHECK ("stock_movements"."item_type" = 'RAW_MATERIAL' or "stock_movements"."movement_type"::text = 'PRODUCTION_OUTPUT');--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sign" CHECK (("stock_movements"."movement_type"::text in ('INITIAL_STOCK', 'PURCHASE_RECEIPT', 'ADJUSTMENT_POSITIVE', 'PRODUCTION_OUTPUT') and "stock_movements"."quantity" > 0 and "stock_movements"."total_value" >= 0)
        or ("stock_movements"."movement_type"::text in ('ADJUSTMENT_NEGATIVE', 'WASTE', 'PRODUCTION_CONSUMPTION') and "stock_movements"."quantity" < 0 and "stock_movements"."total_value" <= 0));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason" CHECK (("stock_movements"."movement_type"::text in ('ADJUSTMENT_POSITIVE', 'ADJUSTMENT_NEGATIVE') and "stock_movements"."reason" in ('PHYSICAL_COUNT', 'DATA_CORRECTION', 'BREAKAGE', 'OTHER'))
        or ("stock_movements"."movement_type"::text = 'WASTE' and "stock_movements"."reason" in ('EXPIRED', 'DAMAGED', 'PRODUCTION_LOSS', 'QUALITY', 'OTHER'))
        or ("stock_movements"."movement_type"::text in ('INITIAL_STOCK', 'PURCHASE_RECEIPT', 'PRODUCTION_CONSUMPTION', 'PRODUCTION_OUTPUT') and "stock_movements"."reason" is null));--> statement-breakpoint
-- ===== Invariantes de producción garantizadas por la base (ADR-039 a ADR-042) =====
-- Máquina de estados, plan fijo desde PLANNED e inmutabilidad de COMPLETED / CANCELLED.
CREATE FUNCTION production_orders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- Lo único que cambia una vez planificada la orden (además del estado).
  operational text[] := ARRAY[
    'status', 'notes', 'responsible_employee_id', 'batch_code', 'updated_at',
    'started_at', 'started_by_user_id', 'completed_at', 'completed_by_user_id',
    'cancelled_at', 'cancelled_by_user_id', 'cancel_reason',
    'actual_output_quantity', 'actual_output_unit_id', 'actual_output_normalized',
    'actual_material_cost', 'actual_unit_material_cost', 'output_movement_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'production_not_deletable: la orden % (%) no se borra', OLD.internal_code, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'production_immutable: la orden % (%) no se modifica', OLD.internal_code, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PLANNED', 'CANCELLED'))
    OR (OLD.status = 'PLANNED' AND NEW.status IN ('IN_PROGRESS', 'CANCELLED'))
    OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('COMPLETED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'production_invalid_transition: % → %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.internal_code <> OLD.internal_code THEN
    RAISE EXCEPTION 'production_identity: la identidad de la orden no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'DRAFT' AND (to_jsonb(NEW) - operational) <> (to_jsonb(OLD) - operational) THEN
    RAISE EXCEPTION 'production_plan_locked: la orden % ya está planificada: producto, receta, cantidades, depósitos y costo esperado no cambian', OLD.internal_code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'IN_PROGRESS' AND (
       NEW.actual_output_quantity IS DISTINCT FROM OLD.actual_output_quantity
    OR NEW.actual_output_unit_id IS DISTINCT FROM OLD.actual_output_unit_id
    OR NEW.actual_output_normalized IS DISTINCT FROM OLD.actual_output_normalized) THEN
    RAISE EXCEPTION 'production_actuals: la salida real sólo se registra con la producción en curso'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> 'COMPLETED' AND (
       NEW.actual_material_cost IS NOT NULL OR NEW.actual_unit_material_cost IS NOT NULL
    OR NEW.output_movement_id IS NOT NULL) THEN
    RAISE EXCEPTION 'production_actual_cost: el costo real se fija sólo al completar'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER production_orders_guard
  BEFORE UPDATE OR DELETE ON "production_orders"
  FOR EACH ROW EXECUTE FUNCTION production_orders_guard();--> statement-breakpoint
-- Líneas: el plan (RECIPE) se fija al planificar; durante la producción sólo cambian
-- los consumos reales y se agregan o quitan extras; COMPLETED / CANCELLED: nada.
CREATE FUNCTION production_material_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_state production_order_status;
  line production_material_lines%ROWTYPE;
  actual text[] := ARRAY[
    'actual_quantity', 'actual_unit_id', 'actual_normalized_quantity', 'actual_unit_cost',
    'actual_cost', 'variance_quantity', 'variance_percentage', 'consumption_movement_id',
    'notes', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN line := OLD; ELSE line := NEW; END IF;
  SELECT status INTO order_state FROM production_orders WHERE id = line.production_order_id;
  IF NOT FOUND OR order_state = 'DRAFT' THEN
    RETURN line;
  END IF;
  IF order_state IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'production_immutable: las líneas de una orden % no se modifican', order_state
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - actual) <> (to_jsonb(OLD) - actual) THEN
      RAISE EXCEPTION 'production_plan_locked: el plan de consumo no cambia una vez planificada la orden'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF order_state = 'IN_PROGRESS' AND line.line_type = 'EXTRA' THEN
    RETURN line;
  END IF;
  RAISE EXCEPTION 'production_plan_locked: sólo se agregan o quitan consumos extra durante la producción'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER production_material_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "production_material_lines"
  FOR EACH ROW EXECUTE FUNCTION production_material_lines_guard();--> statement-breakpoint
-- Costo de producto: proyección del ledger con el mismo contrato que el de materias primas.
CREATE FUNCTION product_inventory_costs_guard() RETURNS trigger
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
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER product_inventory_costs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "product_inventory_costs"
  FOR EACH ROW EXECUTE FUNCTION product_inventory_costs_guard();--> statement-breakpoint
CREATE TRIGGER product_inventory_cost_history_append_only
  BEFORE UPDATE OR DELETE ON "product_inventory_cost_history"
  FOR EACH ROW EXECUTE FUNCTION inventory_reject_mutation();
