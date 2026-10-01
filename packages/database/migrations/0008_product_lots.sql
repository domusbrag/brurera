-- Fase 4.5 — Lotes de producto terminado, conservación y vida útil (ADR-043 a 046).
-- Perfiles de conservación por producto, lotes (raíz desde la orden de producción,
-- hijos por transformación), saldos por lote custodiados por trigger, y el lote en
-- todo movimiento de producto. Migra el stock de Fase 4 a lotes sin inventar
-- procedencia: si algo no reconcilia, la migración ABORTA (BLOCKER).
--
-- IMPORTANTE (igual que 0007): el migrador aplica las migraciones pendientes en UNA
-- transacción y Postgres no permite usar como literal un valor de enum agregado en
-- la misma transacción. Las restricciones y consultas comparan movement_type::text.
CREATE TYPE "public"."conservation_state" AS ENUM('FRESH', 'REFRIGERATED', 'FROZEN', 'THAWED');--> statement-breakpoint
CREATE TYPE "public"."lot_quality_status" AS ENUM('AVAILABLE', 'BLOCKED');--> statement-breakpoint
ALTER TYPE "public"."stock_movement_type" ADD VALUE 'LOT_TRANSFORMATION_OUT';--> statement-breakpoint
ALTER TYPE "public"."stock_movement_type" ADD VALUE 'LOT_TRANSFORMATION_IN';--> statement-breakpoint
CREATE TABLE "product_conservation_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"state" "conservation_state" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"shelf_life_minutes" integer,
	"allowed_as_initial" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_conservation_profiles_shelf_life" CHECK ((not "product_conservation_profiles"."enabled" or ("product_conservation_profiles"."shelf_life_minutes" is not null and "product_conservation_profiles"."shelf_life_minutes" > 0 and "product_conservation_profiles"."shelf_life_minutes" <= 5270400))
        and ("product_conservation_profiles"."shelf_life_minutes" is null or "product_conservation_profiles"."shelf_life_minutes" > 0)),
	CONSTRAINT "product_conservation_profiles_initial" CHECK (not "product_conservation_profiles"."allowed_as_initial" or "product_conservation_profiles"."enabled")
);
--> statement-breakpoint
CREATE TABLE "product_conservation_settings" (
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"default_initial_state" "conservation_state" DEFAULT 'FRESH' NOT NULL,
	"near_expiry_minutes" integer DEFAULT 1440 NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_conservation_settings_company_id_product_id_pk" PRIMARY KEY("company_id","product_id"),
	CONSTRAINT "product_conservation_settings_near_expiry" CHECK ("product_conservation_settings"."near_expiry_minutes" > 0 and "product_conservation_settings"."near_expiry_minutes" <= 527040)
);
--> statement-breakpoint
CREATE TABLE "product_lot_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_lot_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" numeric(28, 10) DEFAULT '0' NOT NULL,
	"inventory_value" numeric(20, 6) DEFAULT '0' NOT NULL,
	"last_movement_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_lot_balances_nonneg" CHECK ("product_lot_balances"."quantity" >= 0 and "product_lot_balances"."inventory_value" >= 0),
	CONSTRAINT "product_lot_balances_empty_value" CHECK ("product_lot_balances"."quantity" > 0 or "product_lot_balances"."inventory_value" = 0)
);
--> statement-breakpoint
CREATE TABLE "product_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"production_order_id" uuid NOT NULL,
	"parent_lot_id" uuid,
	"lot_code" varchar(60) NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"conservation_state" "conservation_state" NOT NULL,
	"produced_at" timestamp with time zone NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	"usable_until" timestamp with time zone,
	"shelf_life_minutes" integer,
	"initial_quantity" numeric(28, 10) NOT NULL,
	"unit_id" uuid NOT NULL,
	"unit_material_cost" numeric(20, 6) NOT NULL,
	"initial_value" numeric(20, 6) NOT NULL,
	"quality_status" "lot_quality_status" DEFAULT 'AVAILABLE' NOT NULL,
	"quality_reason" text,
	"notes" text,
	"operation_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_lots_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "product_lots_company_product_id_uq" UNIQUE("company_id","product_id","id"),
	CONSTRAINT "product_lots_amounts" CHECK ("product_lots"."initial_quantity" > 0 and "product_lots"."unit_material_cost" >= 0 and "product_lots"."initial_value" >= 0),
	CONSTRAINT "product_lots_dates" CHECK ("product_lots"."state_changed_at" >= "product_lots"."produced_at" and ("product_lots"."usable_until" is null or "product_lots"."usable_until" > "product_lots"."state_changed_at")),
	CONSTRAINT "product_lots_shelf_life" CHECK (("product_lots"."usable_until" is null) = ("product_lots"."shelf_life_minutes" is null)),
	CONSTRAINT "product_lots_not_own_parent" CHECK ("product_lots"."parent_lot_id" is null or "product_lots"."parent_lot_id" <> "product_lots"."id"),
	CONSTRAINT "product_lots_quality_reason" CHECK ("product_lots"."quality_status" = 'AVAILABLE' or ("product_lots"."quality_reason" is not null and length(trim("product_lots"."quality_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_sign";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reason";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_product_types";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "product_lot_id" uuid;--> statement-breakpoint
ALTER TABLE "product_conservation_profiles" ADD CONSTRAINT "product_conservation_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_conservation_profiles" ADD CONSTRAINT "product_conservation_profiles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_conservation_profiles" ADD CONSTRAINT "product_conservation_profiles_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_conservation_profiles" ADD CONSTRAINT "product_conservation_profiles_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_conservation_settings" ADD CONSTRAINT "product_conservation_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_conservation_settings" ADD CONSTRAINT "product_conservation_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_conservation_settings" ADD CONSTRAINT "product_conservation_settings_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_balances" ADD CONSTRAINT "product_lot_balances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_balances" ADD CONSTRAINT "product_lot_balances_warehouse_fk" FOREIGN KEY ("company_id","warehouse_id") REFERENCES "public"."warehouses"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_balances" ADD CONSTRAINT "product_lot_balances_lot_fk" FOREIGN KEY ("company_id","product_id","product_lot_id") REFERENCES "public"."product_lots"("company_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_balances" ADD CONSTRAINT "product_lot_balances_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lot_balances" ADD CONSTRAINT "product_lot_balances_last_movement_fk" FOREIGN KEY ("company_id","last_movement_id") REFERENCES "public"."stock_movements"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_order_fk" FOREIGN KEY ("company_id","production_order_id") REFERENCES "public"."production_orders"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_parent_fk" FOREIGN KEY ("company_id","parent_lot_id") REFERENCES "public"."product_lots"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_warehouse_fk" FOREIGN KEY ("company_id","warehouse_id") REFERENCES "public"."warehouses"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_unit_fk" FOREIGN KEY ("company_id","unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_conservation_profiles_product_state_uq" ON "product_conservation_profiles" USING btree ("company_id","product_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "product_lot_balances_lot_uq" ON "product_lot_balances" USING btree ("company_id","warehouse_id","product_lot_id");--> statement-breakpoint
CREATE INDEX "product_lot_balances_product_idx" ON "product_lot_balances" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_lots_company_code_uq" ON "product_lots" USING btree ("company_id","lot_code");--> statement-breakpoint
CREATE UNIQUE INDEX "product_lots_company_operation_uq" ON "product_lots" USING btree ("company_id","operation_id") WHERE "product_lots"."operation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_lots_root_order_uq" ON "product_lots" USING btree ("company_id","production_order_id") WHERE "product_lots"."parent_lot_id" is null;--> statement-breakpoint
CREATE INDEX "product_lots_company_product_idx" ON "product_lots" USING btree ("company_id","product_id","usable_until");--> statement-breakpoint
CREATE INDEX "product_lots_parent_idx" ON "product_lots" USING btree ("company_id","parent_lot_id");--> statement-breakpoint
CREATE INDEX "product_lots_company_usable_idx" ON "product_lots" USING btree ("company_id","usable_until");--> statement-breakpoint
CREATE INDEX "stock_movements_company_lot_idx" ON "stock_movements" USING btree ("company_id","product_lot_id","sequence");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_transformation" CHECK ("stock_movements"."movement_type"::text not in ('LOT_TRANSFORMATION_OUT', 'LOT_TRANSFORMATION_IN')
        or ("stock_movements"."item_type" = 'PRODUCT' and "stock_movements"."reference_type" = 'PRODUCT_LOT_TRANSFORMATION'
            and "stock_movements"."reference_id" is not null and "stock_movements"."source_line_id" is not null));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_waste" CHECK ("stock_movements"."item_type" <> 'PRODUCT' or "stock_movements"."movement_type"::text <> 'WASTE'
        or ("stock_movements"."reason" in ('EXPIRED', 'DAMAGED', 'QUALITY', 'OTHER') and "stock_movements"."reference_type" = 'PRODUCT_LOT'
            and "stock_movements"."reference_id" = "stock_movements"."product_lot_id" and "stock_movements"."source_line_id" is not null));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sign" CHECK (("stock_movements"."movement_type"::text in ('INITIAL_STOCK', 'PURCHASE_RECEIPT', 'ADJUSTMENT_POSITIVE', 'PRODUCTION_OUTPUT', 'LOT_TRANSFORMATION_IN') and "stock_movements"."quantity" > 0 and "stock_movements"."total_value" >= 0)
        or ("stock_movements"."movement_type"::text in ('ADJUSTMENT_NEGATIVE', 'WASTE', 'PRODUCTION_CONSUMPTION', 'LOT_TRANSFORMATION_OUT') and "stock_movements"."quantity" < 0 and "stock_movements"."total_value" <= 0));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason" CHECK (("stock_movements"."movement_type"::text in ('ADJUSTMENT_POSITIVE', 'ADJUSTMENT_NEGATIVE') and "stock_movements"."reason" in ('PHYSICAL_COUNT', 'DATA_CORRECTION', 'BREAKAGE', 'OTHER'))
        or ("stock_movements"."movement_type"::text = 'WASTE' and "stock_movements"."reason" in ('EXPIRED', 'DAMAGED', 'PRODUCTION_LOSS', 'QUALITY', 'OTHER'))
        or ("stock_movements"."movement_type"::text in ('INITIAL_STOCK', 'PURCHASE_RECEIPT', 'PRODUCTION_CONSUMPTION', 'PRODUCTION_OUTPUT', 'LOT_TRANSFORMATION_OUT', 'LOT_TRANSFORMATION_IN') and "stock_movements"."reason" is null));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_types" CHECK ("stock_movements"."item_type" = 'RAW_MATERIAL' or "stock_movements"."movement_type"::text in ('PRODUCTION_OUTPUT', 'LOT_TRANSFORMATION_OUT', 'LOT_TRANSFORMATION_IN', 'WASTE'));
--> statement-breakpoint
-- ===== Invariantes de lotes garantizados por la base =====
-- Lote: identidad, cantidades, costo y fechas inmutables; sólo cambian calidad y notas.
CREATE FUNCTION product_lots_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['quality_status', 'quality_reason', 'notes', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product_lot_not_deletable: el lote % no se borra (queda en el histórico)', OLD.lot_code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'product_lot_immutable: el lote % sólo cambia de calidad o notas; la conservación cambia con una transformación', OLD.lot_code
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER product_lots_guard
  BEFORE UPDATE OR DELETE ON "product_lots"
  FOR EACH ROW EXECUTE FUNCTION product_lots_guard();--> statement-breakpoint
-- Saldo de lote: proyección del ledger con el mismo contrato que stock_balances.
CREATE FUNCTION product_lot_balances_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m stock_movements%ROWTYPE;
  previous_sequence bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product_lot_balance_derived: los saldos de lote no se borran'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.quantity = 0 AND NEW.inventory_value = 0 AND NEW.last_movement_id IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'product_lot_balance_derived: un saldo de lote nace en cero y sólo cambia con movimientos'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.warehouse_id <> OLD.warehouse_id
     OR NEW.product_lot_id <> OLD.product_lot_id OR NEW.product_id <> OLD.product_id THEN
    RAISE EXCEPTION 'product_lot_balance_derived: la identidad del saldo no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.last_movement_id IS NULL OR NEW.last_movement_id IS NOT DISTINCT FROM OLD.last_movement_id THEN
    RAISE EXCEPTION 'product_lot_balance_derived: el saldo sólo cambia con un movimiento nuevo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO m FROM stock_movements WHERE id = NEW.last_movement_id;
  IF NOT FOUND OR m.company_id <> NEW.company_id OR m.warehouse_id <> NEW.warehouse_id
     OR m.product_lot_id IS DISTINCT FROM NEW.product_lot_id THEN
    RAISE EXCEPTION 'product_lot_balance_derived: el movimiento no corresponde a este lote'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.last_movement_id IS NOT NULL THEN
    SELECT sequence INTO previous_sequence FROM stock_movements WHERE id = OLD.last_movement_id;
    IF m.sequence <= previous_sequence THEN
      RAISE EXCEPTION 'product_lot_balance_derived: el movimiento ya fue aplicado'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.quantity <> OLD.quantity + m.quantity OR NEW.inventory_value <> OLD.inventory_value + m.total_value THEN
    RAISE EXCEPTION 'product_lot_balance_derived: cantidad % o valor % no coinciden con el movimiento', NEW.quantity, NEW.inventory_value
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER product_lot_balances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "product_lot_balances"
  FOR EACH ROW EXECUTE FUNCTION product_lot_balances_guard();--> statement-breakpoint
-- Un movimiento sólo puede apuntar a un lote del mismo producto y empresa.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_lot_fk" FOREIGN KEY ("company_id","product_id","product_lot_id") REFERENCES "public"."product_lots"("company_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- ===== Migración del stock de Fase 4 a lotes (ADR-046) =====
-- Hasta Fase 4 el producto terminado sólo entraba por PRODUCTION_OUTPUT de una orden
-- COMPLETED (CHECK stock_movements_product_types). Cualquier otra situación no puede
-- reconstruirse sin inventar procedencia: se aborta con un BLOCKER explícito.
DO $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad FROM stock_movements
   WHERE item_type = 'PRODUCT' AND movement_type::text <> 'PRODUCTION_OUTPUT';
  IF bad > 0 THEN
    RAISE EXCEPTION 'FASE_4_5_MIGRATION_BLOCKER: % movimientos de producto no son PRODUCTION_OUTPUT', bad;
  END IF;
  SELECT count(*) INTO bad FROM stock_movements m
   WHERE m.item_type = 'PRODUCT'
     AND NOT EXISTS (
       SELECT 1 FROM production_orders o
        WHERE o.company_id = m.company_id AND o.id = m.reference_id AND o.status = 'COMPLETED'
          AND o.output_movement_id = m.id AND o.product_id = m.product_id
          AND o.output_warehouse_id = m.warehouse_id);
  IF bad > 0 THEN
    RAISE EXCEPTION 'FASE_4_5_MIGRATION_BLOCKER: % ingresos de producto sin orden de producción COMPLETED que los origine', bad;
  END IF;
END;
$$;--> statement-breakpoint
-- Un lote raíz por orden COMPLETED: código = batch_code (o LOT-<orden> si quedó vacío),
-- FRESH, vida útil desconocida (no se inventa), cantidad / costo / valor del ingreso.
INSERT INTO "product_lots" (
  "company_id", "product_id", "production_order_id", "lot_code", "warehouse_id",
  "conservation_state", "produced_at", "state_changed_at", "usable_until", "shelf_life_minutes",
  "initial_quantity", "unit_id", "unit_material_cost", "initial_value", "notes",
  "created_by_user_id", "created_at")
SELECT o.company_id, o.product_id, o.id, coalesce(o.batch_code, 'LOT-' || o.internal_code),
       m.warehouse_id, 'FRESH', o.completed_at, o.completed_at, NULL, NULL,
       m.quantity, m.base_unit_id, m.unit_cost, m.total_value,
       'Lote migrado desde Fase 4: vida útil no configurada al producirse.',
       o.completed_by_user_id, o.completed_at
  FROM production_orders o
  JOIN stock_movements m ON m.company_id = o.company_id AND m.id = o.output_movement_id
 WHERE o.status = 'COMPLETED';--> statement-breakpoint
-- Única escritura sobre el ledger: completar la columna nueva product_lot_id de los
-- PRODUCTION_OUTPUT existentes (cantidad, valor y orden no cambian). El trigger
-- append-only se suspende sólo para esta sentencia, dentro de la misma transacción.
ALTER TABLE "stock_movements" DISABLE TRIGGER "stock_movements_append_only";--> statement-breakpoint
UPDATE "stock_movements" m
   SET "product_lot_id" = l.id
  FROM "product_lots" l
 WHERE m.item_type = 'PRODUCT' AND l.company_id = m.company_id
   AND l.production_order_id = m.reference_id AND l.parent_lot_id IS NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ENABLE TRIGGER "stock_movements_append_only";--> statement-breakpoint
-- Saldos de lote: nacen en cero y se cargan con su movimiento (validado por el trigger).
INSERT INTO "product_lot_balances" ("company_id", "warehouse_id", "product_lot_id", "product_id")
SELECT company_id, warehouse_id, id, product_id FROM product_lots;--> statement-breakpoint
UPDATE "product_lot_balances" b
   SET "quantity" = b.quantity + m.quantity,
       "inventory_value" = b.inventory_value + m.total_value,
       "last_movement_id" = m.id
  FROM "stock_movements" m
 WHERE m.company_id = b.company_id AND m.product_lot_id = b.product_lot_id;--> statement-breakpoint
-- Reconciliación obligatoria: Σ lotes = saldo agregado (por depósito) y = costo de
-- inventario del producto (cantidad y valor). Si no, BLOCKER.
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
    RAISE EXCEPTION 'FASE_4_5_MIGRATION_BLOCKER: % saldos de producto no reconcilian con sus lotes', bad;
  END IF;
  SELECT count(*) INTO bad FROM product_inventory_costs c
   WHERE c.quantity <> coalesce((SELECT sum(lb.quantity) FROM product_lot_balances lb
                                  WHERE lb.company_id = c.company_id AND lb.product_id = c.product_id), 0)
      OR c.inventory_value <> coalesce((SELECT sum(lb.inventory_value) FROM product_lot_balances lb
                                  WHERE lb.company_id = c.company_id AND lb.product_id = c.product_id), 0);
  IF bad > 0 THEN
    RAISE EXCEPTION 'FASE_4_5_MIGRATION_BLOCKER: % productos cuyo stock o valor no reconcilia con sus lotes', bad;
  END IF;
  SELECT count(*) INTO bad FROM stock_movements WHERE item_type = 'PRODUCT' AND product_lot_id IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION 'FASE_4_5_MIGRATION_BLOCKER: % movimientos de producto quedaron sin lote', bad;
  END IF;
END;
$$;--> statement-breakpoint
-- Desde ahora todo movimiento de producto tiene lote; las materias primas, nunca.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_lot" CHECK (("stock_movements"."item_type" = 'PRODUCT') = ("stock_movements"."product_lot_id" is not null));
