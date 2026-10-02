-- Fase 5A — Pedidos de clientes, reservas de lotes y necesidades (ADR-050 a 055).
-- Pedidos con fecha y hora comprometidas, reservas DURAS de producto terminado por
-- lote (no mueven stock), necesidades de producción con la receta fijada y
-- snapshot de materias primas (sólo demanda proyectada: nunca reserva física).
-- Sólo tablas nuevas y una columna opcional en production_orders: no hay datos
-- de fases anteriores que migrar (0000–0008 intactas).
CREATE TYPE "public"."customer_order_status" AS ENUM('DRAFT', 'CONFIRMED', 'IN_PREPARATION', 'READY', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_type" AS ENUM('PICKUP', 'DELIVERY');--> statement-breakpoint
CREATE TYPE "public"."lot_reservation_status" AS ENUM('ACTIVE', 'RELEASED', 'INVALIDATED', 'FULFILLED');--> statement-breakpoint
CREATE TYPE "public"."order_coverage_status" AS ENUM('FULLY_COVERED', 'PARTIALLY_COVERED', 'NOT_COVERED', 'NEEDS_REPLAN');--> statement-breakpoint
CREATE TYPE "public"."order_priority" AS ENUM('NORMAL', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."order_requirement_problem" AS ENUM('NO_RECIPE_FOR_PRODUCTION', 'RECIPE_NOT_USABLE');--> statement-breakpoint
CREATE TYPE "public"."order_requirement_status" AS ENUM('OPEN', 'PRODUCTION_CREATED', 'SATISFIED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."requested_conservation" AS ENUM('ANY', 'FRESH', 'REFRIGERATED', 'FROZEN', 'THAWED');--> statement-breakpoint
CREATE TYPE "public"."reservation_release_reason" AS ENUM('ORDER_CANCELLED', 'ORDER_REPLANNED', 'LOT_BLOCKED', 'LOT_WASTE');--> statement-breakpoint
CREATE TABLE "customer_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"requested_quantity" numeric(18, 6) NOT NULL,
	"unit_id" uuid NOT NULL,
	"normalized_quantity" numeric(28, 10) NOT NULL,
	"sale_unit_id" uuid NOT NULL,
	"requested_conservation" "requested_conservation" DEFAULT 'ANY' NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_order_lines_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "customer_order_lines_company_order_id_uq" UNIQUE("company_id","customer_order_id","id"),
	CONSTRAINT "customer_order_lines_company_product_id_uq" UNIQUE("company_id","product_id","id"),
	CONSTRAINT "customer_order_lines_quantities" CHECK ("customer_order_lines"."requested_quantity" > 0 and "customer_order_lines"."normalized_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "customer_order_operations" (
	"company_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"customer_order_id" uuid NOT NULL,
	"action" varchar(32) NOT NULL,
	"plan_revision" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_order_operations_company_id_operation_id_pk" PRIMARY KEY("company_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "customer_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"internal_code" varchar(32) NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "customer_order_status" DEFAULT 'DRAFT' NOT NULL,
	"coverage_status" "order_coverage_status",
	"requested_at" timestamp with time zone NOT NULL,
	"fulfillment_type" "fulfillment_type" DEFAULT 'PICKUP' NOT NULL,
	"delivery_address" text,
	"contact_name" text,
	"contact_phone" varchar(50),
	"event_name" text,
	"priority" "order_priority" DEFAULT 'NORMAL' NOT NULL,
	"notes" text,
	"plan_revision" integer DEFAULT 0 NOT NULL,
	"confirmed_by_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"preparation_started_by_user_id" uuid,
	"preparation_started_at" timestamp with time zone,
	"ready_by_user_id" uuid,
	"ready_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "customer_orders_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "customer_orders_status_data" CHECK (("customer_orders"."status" = 'DRAFT' and "customer_orders"."plan_revision" = 0 and "customer_orders"."coverage_status" is null and "customer_orders"."confirmed_at" is null and "customer_orders"."cancelled_at" is null)
        or ("customer_orders"."status" in ('CONFIRMED', 'IN_PREPARATION', 'READY') and "customer_orders"."plan_revision" >= 1 and "customer_orders"."coverage_status" is not null and "customer_orders"."confirmed_at" is not null and "customer_orders"."cancelled_at" is null)
        or ("customer_orders"."status" = 'CANCELLED' and "customer_orders"."cancelled_at" is not null)),
	CONSTRAINT "customer_orders_ready_covered" CHECK ("customer_orders"."status" <> 'READY' or "customer_orders"."coverage_status" = 'FULLY_COVERED')
);
--> statement-breakpoint
CREATE TABLE "order_material_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_production_requirement_id" uuid NOT NULL,
	"customer_order_id" uuid NOT NULL,
	"raw_material_id" uuid NOT NULL,
	"required_quantity" numeric(28, 10) NOT NULL,
	"base_unit_id" uuid NOT NULL,
	"recipe_version_id" uuid NOT NULL,
	"plan_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_material_requirements_quantity" CHECK ("order_material_requirements"."required_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_production_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"required_output_quantity" numeric(28, 10) NOT NULL,
	"output_unit_id" uuid NOT NULL,
	"recipe_id" uuid,
	"recipe_version_id" uuid,
	"problem" "order_requirement_problem",
	"plan_revision" integer NOT NULL,
	"status" "order_requirement_status" DEFAULT 'OPEN' NOT NULL,
	"linked_production_order_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "order_production_requirements_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "order_production_requirements_company_product_id_uq" UNIQUE("company_id","product_id","id"),
	CONSTRAINT "order_production_requirements_quantity" CHECK ("order_production_requirements"."required_output_quantity" > 0 and "order_production_requirements"."plan_revision" >= 1),
	CONSTRAINT "order_production_requirements_recipe" CHECK (("order_production_requirements"."problem" is null and "order_production_requirements"."recipe_id" is not null and "order_production_requirements"."recipe_version_id" is not null)
        or ("order_production_requirements"."problem" is not null and "order_production_requirements"."recipe_version_id" is null)),
	CONSTRAINT "order_production_requirements_link" CHECK (("order_production_requirements"."status" = 'OPEN' and "order_production_requirements"."linked_production_order_id" is null)
        or ("order_production_requirements"."status" = 'PRODUCTION_CREATED' and "order_production_requirements"."linked_production_order_id" is not null)
        or "order_production_requirements"."status" in ('SATISFIED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "product_lot_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_lot_id" uuid NOT NULL,
	"quantity" numeric(28, 10) NOT NULL,
	"unit_id" uuid NOT NULL,
	"plan_revision" integer NOT NULL,
	"status" "lot_reservation_status" DEFAULT 'ACTIVE' NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" "reservation_release_reason",
	"released_by_user_id" uuid,
	"replaces_reservation_id" uuid,
	"created_by_user_id" uuid,
	CONSTRAINT "product_lot_reservations_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "product_lot_reservations_quantity" CHECK ("product_lot_reservations"."quantity" > 0 and "product_lot_reservations"."plan_revision" >= 1),
	CONSTRAINT "product_lot_reservations_release" CHECK (("product_lot_reservations"."status" = 'ACTIVE' and "product_lot_reservations"."released_at" is null and "product_lot_reservations"."release_reason" is null)
        or ("product_lot_reservations"."status" = 'FULFILLED' and "product_lot_reservations"."released_at" is not null)
        or ("product_lot_reservations"."status" in ('RELEASED', 'INVALIDATED') and "product_lot_reservations"."released_at" is not null and "product_lot_reservations"."release_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "production_orders" ADD COLUMN "source_order_requirement_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_order_fk" FOREIGN KEY ("company_id","customer_order_id") REFERENCES "public"."customer_orders"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_unit_fk" FOREIGN KEY ("company_id","unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_sale_unit_fk" FOREIGN KEY ("company_id","sale_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_operations" ADD CONSTRAINT "customer_order_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_operations" ADD CONSTRAINT "customer_order_operations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_operations" ADD CONSTRAINT "customer_order_operations_order_fk" FOREIGN KEY ("company_id","customer_order_id") REFERENCES "public"."customer_orders"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_preparation_started_by_user_id_users_id_fk" FOREIGN KEY ("preparation_started_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_ready_by_user_id_users_id_fk" FOREIGN KEY ("ready_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_material_requirements" ADD CONSTRAINT "order_material_requirements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_material_requirements" ADD CONSTRAINT "order_material_requirements_requirement_fk" FOREIGN KEY ("company_id","order_production_requirement_id") REFERENCES "public"."order_production_requirements"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_material_requirements" ADD CONSTRAINT "order_material_requirements_order_fk" FOREIGN KEY ("company_id","customer_order_id") REFERENCES "public"."customer_orders"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_material_requirements" ADD CONSTRAINT "order_material_requirements_raw_material_fk" FOREIGN KEY ("company_id","raw_material_id") REFERENCES "public"."raw_materials"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_material_requirements" ADD CONSTRAINT "order_material_requirements_unit_fk" FOREIGN KEY ("company_id","base_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_production_requirements" ADD CONSTRAINT "order_production_requirements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_production_requirements" ADD CONSTRAINT "order_production_requirements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_production_requirements" ADD CONSTRAINT "order_production_requirements_order_fk" FOREIGN KEY ("company_id","customer_order_id") REFERENCES "public"."customer_orders"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_production_requirements" ADD CONSTRAINT "order_production_requirements_line_fk" FOREIGN KEY ("company_id","customer_order_id","order_line_id") REFERENCES "public"."customer_order_lines"("company_id","customer_order_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_production_requirements" ADD CONSTRAINT "order_production_requirements_line_product_fk" FOREIGN KEY ("company_id","product_id","order_line_id") REFERENCES "public"."customer_order_lines"("company_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_production_requirements" ADD CONSTRAINT "order_production_requirements_unit_fk" FOREIGN KEY ("company_id","output_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_production_requirements" ADD CONSTRAINT "order_production_requirements_recipe_fk" FOREIGN KEY ("company_id","product_id","recipe_id") REFERENCES "public"."recipes"("company_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_production_requirements" ADD CONSTRAINT "order_production_requirements_version_fk" FOREIGN KEY ("company_id","recipe_id","recipe_version_id") REFERENCES "public"."recipe_versions"("company_id","recipe_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_production_requirements" ADD CONSTRAINT "order_production_requirements_production_fk" FOREIGN KEY ("company_id","linked_production_order_id") REFERENCES "public"."production_orders"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_reservations" ADD CONSTRAINT "product_lot_reservations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_reservations" ADD CONSTRAINT "product_lot_reservations_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_reservations" ADD CONSTRAINT "product_lot_reservations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_reservations" ADD CONSTRAINT "product_lot_reservations_order_fk" FOREIGN KEY ("company_id","customer_order_id") REFERENCES "public"."customer_orders"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_reservations" ADD CONSTRAINT "product_lot_reservations_line_fk" FOREIGN KEY ("company_id","customer_order_id","order_line_id") REFERENCES "public"."customer_order_lines"("company_id","customer_order_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_reservations" ADD CONSTRAINT "product_lot_reservations_line_product_fk" FOREIGN KEY ("company_id","product_id","order_line_id") REFERENCES "public"."customer_order_lines"("company_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_reservations" ADD CONSTRAINT "product_lot_reservations_lot_fk" FOREIGN KEY ("company_id","product_id","product_lot_id") REFERENCES "public"."product_lots"("company_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_reservations" ADD CONSTRAINT "product_lot_reservations_unit_fk" FOREIGN KEY ("company_id","unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_reservations" ADD CONSTRAINT "product_lot_reservations_replaces_fk" FOREIGN KEY ("company_id","replaces_reservation_id") REFERENCES "public"."product_lot_reservations"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_order_lines_order_idx" ON "customer_order_lines" USING btree ("company_id","customer_order_id","sort_order");--> statement-breakpoint
CREATE INDEX "customer_order_lines_product_idx" ON "customer_order_lines" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_orders_company_code_uq" ON "customer_orders" USING btree ("company_id","internal_code");--> statement-breakpoint
CREATE INDEX "customer_orders_company_requested_idx" ON "customer_orders" USING btree ("company_id","requested_at");--> statement-breakpoint
CREATE INDEX "customer_orders_company_status_requested_idx" ON "customer_orders" USING btree ("company_id","status","requested_at");--> statement-breakpoint
CREATE INDEX "customer_orders_company_customer_idx" ON "customer_orders" USING btree ("company_id","customer_id","requested_at");--> statement-breakpoint
CREATE INDEX "customer_orders_company_coverage_idx" ON "customer_orders" USING btree ("company_id","coverage_status");--> statement-breakpoint
CREATE UNIQUE INDEX "order_material_requirements_requirement_material_uq" ON "order_material_requirements" USING btree ("order_production_requirement_id","raw_material_id");--> statement-breakpoint
CREATE INDEX "order_material_requirements_material_idx" ON "order_material_requirements" USING btree ("company_id","raw_material_id");--> statement-breakpoint
CREATE INDEX "order_material_requirements_order_idx" ON "order_material_requirements" USING btree ("company_id","customer_order_id");--> statement-breakpoint
CREATE INDEX "order_production_requirements_order_idx" ON "order_production_requirements" USING btree ("company_id","customer_order_id","plan_revision");--> statement-breakpoint
CREATE INDEX "order_production_requirements_product_idx" ON "order_production_requirements" USING btree ("company_id","product_id","status");--> statement-breakpoint
CREATE INDEX "order_production_requirements_production_idx" ON "order_production_requirements" USING btree ("company_id","linked_production_order_id");--> statement-breakpoint
CREATE INDEX "product_lot_reservations_lot_active_idx" ON "product_lot_reservations" USING btree ("company_id","product_lot_id") WHERE "product_lot_reservations"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "product_lot_reservations_order_idx" ON "product_lot_reservations" USING btree ("company_id","customer_order_id","plan_revision");--> statement-breakpoint
CREATE INDEX "product_lot_reservations_product_active_idx" ON "product_lot_reservations" USING btree ("company_id","product_id") WHERE "product_lot_reservations"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "production_orders_source_requirement_idx" ON "production_orders" USING btree ("company_id","source_order_requirement_id") WHERE "production_orders"."source_order_requirement_id" is not null;--> statement-breakpoint
-- Orden de producción creada desde la necesidad de un pedido (declarada aquí y no en
-- el schema de Drizzle para no crear un ciclo de tipos production ↔ orders).
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_source_requirement_fk" FOREIGN KEY ("company_id","source_order_requirement_id") REFERENCES "public"."order_production_requirements"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- ===== Invariantes de pedidos garantizados por la base =====
-- Un pedido no se borra (se cancela) y su identidad no cambia.
CREATE FUNCTION customer_orders_guard() RETURNS trigger
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
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'customer_order_immutable: el pedido % está cancelado', OLD.internal_code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.plan_revision < OLD.plan_revision THEN
    RAISE EXCEPTION 'customer_order_revision: la revisión del plan no retrocede'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER customer_orders_guard
  BEFORE UPDATE OR DELETE ON "customer_orders"
  FOR EACH ROW EXECUTE FUNCTION customer_orders_guard();--> statement-breakpoint
-- Líneas: se borran sólo en borrador; confirmado, una línea quitada queda con removed_at.
CREATE FUNCTION customer_order_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_state customer_order_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO order_state FROM customer_orders WHERE id = OLD.customer_order_id;
    IF order_state IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'customer_order_line_history: las líneas de un pedido confirmado no se borran'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.customer_order_id <> OLD.customer_order_id
     OR NEW.product_id <> OLD.product_id THEN
    RAISE EXCEPTION 'customer_order_line_identity: una línea no cambia de pedido ni de producto'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER customer_order_lines_guard
  BEFORE UPDATE OR DELETE ON "customer_order_lines"
  FOR EACH ROW EXECUTE FUNCTION customer_order_lines_guard();--> statement-breakpoint
-- Reserva: inmutable salvo ACTIVE → RELEASED / INVALIDATED / FULFILLED; nunca se borra.
CREATE FUNCTION product_lot_reservations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['status', 'released_at', 'release_reason', 'released_by_user_id'];
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
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER product_lot_reservations_guard
  BEFORE UPDATE OR DELETE ON "product_lot_reservations"
  FOR EACH ROW EXECUTE FUNCTION product_lot_reservations_guard();--> statement-breakpoint
-- Nueva reserva activa: el lote debe estar apto y Σ reservas activas ≤ saldo del lote.
-- El servicio ya lo garantiza con el lote bloqueado (FOR UPDATE); esto es la red.
CREATE FUNCTION product_lot_reservations_capacity() RETURNS trigger
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
  SELECT coalesce(sum(quantity), 0) INTO committed FROM product_lot_reservations
   WHERE product_lot_id = NEW.product_lot_id AND status = 'ACTIVE' AND id <> NEW.id;
  IF committed + NEW.quantity > balance THEN
    RAISE EXCEPTION 'lot_reservation_exceeds_balance: reservas % + % superan el saldo % del lote', committed, NEW.quantity, balance
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER product_lot_reservations_capacity
  BEFORE INSERT ON "product_lot_reservations"
  FOR EACH ROW EXECUTE FUNCTION product_lot_reservations_capacity();--> statement-breakpoint
-- Un saldo de lote nunca queda por debajo de lo reservado (merma: invalidar antes).
CREATE FUNCTION product_lot_balances_reserved() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  committed numeric;
  balance numeric;
BEGIN
  SELECT coalesce(sum(quantity), 0) INTO committed FROM product_lot_reservations
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
CREATE TRIGGER product_lot_balances_reserved
  AFTER UPDATE ON "product_lot_balances"
  FOR EACH ROW EXECUTE FUNCTION product_lot_balances_reserved();--> statement-breakpoint
-- Un lote bloqueado no conserva reservas activas (calidad tiene prioridad: invalidar antes).
CREATE FUNCTION product_lots_blocked_reserved() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quality_status = 'BLOCKED' AND EXISTS (
       SELECT 1 FROM product_lot_reservations WHERE product_lot_id = NEW.id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'lot_reservation_blocked_lot: el lote % tiene reservas activas: invalidarlas al bloquear', NEW.lot_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER product_lots_blocked_reserved
  AFTER UPDATE ON "product_lots"
  FOR EACH ROW EXECUTE FUNCTION product_lots_blocked_reserved();--> statement-breakpoint
-- Necesidad de producción: cantidad, receta y revisión fijas; sólo cambian estado,
-- orden vinculada y cierre. Nunca se borra.
CREATE FUNCTION order_production_requirements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['status', 'linked_production_order_id', 'closed_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order_requirement_history: las necesidades no se borran (se cancelan)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('SATISFIED', 'CANCELLED') THEN
    RAISE EXCEPTION 'order_requirement_closed: la necesidad ya está %', OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'order_requirement_immutable: cantidad, receta y revisión de una necesidad no cambian'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER order_production_requirements_guard
  BEFORE UPDATE OR DELETE ON "order_production_requirements"
  FOR EACH ROW EXECUTE FUNCTION order_production_requirements_guard();--> statement-breakpoint
CREATE TRIGGER order_material_requirements_append_only
  BEFORE UPDATE OR DELETE ON "order_material_requirements"
  FOR EACH ROW EXECUTE FUNCTION inventory_reject_mutation();--> statement-breakpoint
CREATE TRIGGER customer_order_operations_append_only
  BEFORE UPDATE OR DELETE ON "customer_order_operations"
  FOR EACH ROW EXECUTE FUNCTION inventory_reject_mutation();
