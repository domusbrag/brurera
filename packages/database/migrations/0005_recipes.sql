-- Fase 2: recetas versionadas y costo teórico.
-- El costo de referencia de la materia prima se renombra para que su semántica sea
-- inequívoca (dinero por UNIDAD BASE) y gana procedencia y fecha de actualización.
ALTER TABLE "raw_materials" RENAME COLUMN "current_cost" TO "reference_cost";--> statement-breakpoint
-- Recetas e ingredientes referencian productos y materias primas por (company_id, id),
-- así la base rechaza referencias entre empresas (ADR-016).
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "raw_materials" ADD CONSTRAINT "raw_materials_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
CREATE TYPE "public"."cost_source" AS ENUM('MANUAL_REFERENCE', 'PURCHASE_MOVING_AVERAGE', 'SUPPLIER_QUOTE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."cost_completeness" AS ENUM('COMPLETE', 'INCOMPLETE');--> statement-breakpoint
CREATE TYPE "public"."recipe_version_status" AS ENUM('DRAFT', 'ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "recipe_cost_snapshot_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"raw_material_id" uuid NOT NULL,
	"raw_material_code" varchar(32) NOT NULL,
	"raw_material_name" text NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	"unit_code" varchar(16) NOT NULL,
	"unit_symbol" varchar(16) NOT NULL,
	"normalized_quantity" numeric(28, 10) NOT NULL,
	"base_unit_code" varchar(16) NOT NULL,
	"base_unit_symbol" varchar(16) NOT NULL,
	"reference_cost" numeric(18, 6),
	"cost_source" "cost_source",
	"ingredient_cost" numeric(20, 6),
	CONSTRAINT "recipe_cost_snapshot_lines_cost_coherent" CHECK (("recipe_cost_snapshot_lines"."reference_cost" is null) = ("recipe_cost_snapshot_lines"."ingredient_cost" is null))
);
--> statement-breakpoint
CREATE TABLE "recipe_cost_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"recipe_version_id" uuid NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"completeness_status" "cost_completeness" NOT NULL,
	"total_cost" numeric(20, 6),
	"yield_quantity" numeric(18, 6) NOT NULL,
	"yield_unit_code" varchar(16) NOT NULL,
	"yield_unit_symbol" varchar(16) NOT NULL,
	"normalized_yield" numeric(28, 10) NOT NULL,
	"sale_unit_code" varchar(16) NOT NULL,
	"sale_unit_symbol" varchar(16) NOT NULL,
	"unit_cost" numeric(20, 6),
	"sale_price" numeric(20, 6),
	CONSTRAINT "recipe_cost_snapshots_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "recipe_cost_snapshots_complete_has_totals" CHECK (("recipe_cost_snapshots"."completeness_status" = 'COMPLETE') = ("recipe_cost_snapshots"."total_cost" is not null and "recipe_cost_snapshots"."unit_cost" is not null))
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"recipe_version_id" uuid NOT NULL,
	"raw_material_id" uuid NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	"unit_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_ingredients_version_material_uq" UNIQUE("recipe_version_id","raw_material_id"),
	CONSTRAINT "recipe_ingredients_quantity_positive" CHECK ("recipe_ingredients"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "recipe_version_status" DEFAULT 'DRAFT' NOT NULL,
	"yield_quantity" numeric(18, 6) NOT NULL,
	"yield_unit_id" uuid NOT NULL,
	"waste_percentage" numeric(7, 4),
	"instructions" text,
	"effective_from" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_user_id" uuid,
	"archived_at" timestamp with time zone,
	CONSTRAINT "recipe_versions_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "recipe_versions_recipe_number_uq" UNIQUE("recipe_id","version_number"),
	CONSTRAINT "recipe_versions_number_positive" CHECK ("recipe_versions"."version_number" > 0),
	CONSTRAINT "recipe_versions_yield_positive" CHECK ("recipe_versions"."yield_quantity" > 0),
	CONSTRAINT "recipe_versions_waste_range" CHECK ("recipe_versions"."waste_percentage" is null or ("recipe_versions"."waste_percentage" >= 0 and "recipe_versions"."waste_percentage" < 100)),
	CONSTRAINT "recipe_versions_status_dates" CHECK (("recipe_versions"."status" = 'DRAFT' and "recipe_versions"."published_at" is null and "recipe_versions"."effective_from" is null and "recipe_versions"."archived_at" is null)
        or ("recipe_versions"."status" = 'ACTIVE' and "recipe_versions"."published_at" is not null and "recipe_versions"."effective_from" is not null and "recipe_versions"."archived_at" is null)
        or ("recipe_versions"."status" = 'ARCHIVED' and "recipe_versions"."archived_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_version_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipes_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "raw_materials" ADD COLUMN "reference_cost_source" "cost_source" DEFAULT 'MANUAL_REFERENCE' NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_materials" ADD COLUMN "reference_cost_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recipe_cost_snapshot_lines" ADD CONSTRAINT "recipe_cost_snapshot_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_cost_snapshot_lines" ADD CONSTRAINT "recipe_cost_snapshot_lines_snapshot_fk" FOREIGN KEY ("company_id","snapshot_id") REFERENCES "public"."recipe_cost_snapshots"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_cost_snapshot_lines" ADD CONSTRAINT "recipe_cost_snapshot_lines_raw_material_fk" FOREIGN KEY ("company_id","raw_material_id") REFERENCES "public"."raw_materials"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_cost_snapshots" ADD CONSTRAINT "recipe_cost_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_cost_snapshots" ADD CONSTRAINT "recipe_cost_snapshots_version_fk" FOREIGN KEY ("company_id","recipe_version_id") REFERENCES "public"."recipe_versions"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_version_fk" FOREIGN KEY ("company_id","recipe_version_id") REFERENCES "public"."recipe_versions"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_raw_material_fk" FOREIGN KEY ("company_id","raw_material_id") REFERENCES "public"."raw_materials"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_unit_fk" FOREIGN KEY ("company_id","unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_recipe_fk" FOREIGN KEY ("company_id","recipe_id") REFERENCES "public"."recipes"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_yield_unit_fk" FOREIGN KEY ("company_id","yield_unit_id") REFERENCES "public"."units_of_measure"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_product_fk" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."products"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipe_cost_snapshot_lines_snapshot_idx" ON "recipe_cost_snapshot_lines" USING btree ("snapshot_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_cost_snapshots_version_uq" ON "recipe_cost_snapshots" USING btree ("recipe_version_id");--> statement-breakpoint
CREATE INDEX "recipe_ingredients_version_idx" ON "recipe_ingredients" USING btree ("recipe_version_id","sort_order");--> statement-breakpoint
CREATE INDEX "recipe_ingredients_raw_material_idx" ON "recipe_ingredients" USING btree ("raw_material_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_versions_one_active_uq" ON "recipe_versions" USING btree ("recipe_id") WHERE "recipe_versions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_versions_one_draft_uq" ON "recipe_versions" USING btree ("recipe_id") WHERE "recipe_versions"."status" = 'DRAFT';--> statement-breakpoint
CREATE INDEX "recipe_versions_company_status_idx" ON "recipe_versions" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_one_active_per_product_uq" ON "recipes" USING btree ("company_id","product_id") WHERE "recipes"."active";--> statement-breakpoint
CREATE INDEX "recipes_product_idx" ON "recipes" USING btree ("product_id");--> statement-breakpoint
-- Los costos ya cargados en Fase 1 quedan como referencia manual, fechados en su última edición.
UPDATE "raw_materials" SET "reference_cost_updated_at" = "updated_at" WHERE "reference_cost" IS NOT NULL;--> statement-breakpoint
-- Inmutabilidad de versiones publicadas. La aplicación ya lo valida; la base lo
-- garantiza aunque un bug o un UPDATE manual lo intente:
--   * DRAFT se edita y se puede borrar (descartar);
--   * ACTIVE sólo admite pasar a ARCHIVED (status, archived_at, updated_at);
--   * ARCHIVED no admite cambios; ACTIVE y ARCHIVED no se borran.
CREATE FUNCTION recipe_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'recipe_version_immutable: la versión % está publicada y no se puede borrar', OLD.version_number
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'ARCHIVED'
     AND (to_jsonb(NEW) - 'status' - 'archived_at' - 'updated_at')
       = (to_jsonb(OLD) - 'status' - 'archived_at' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'recipe_version_immutable: la versión % (%) no se puede modificar', OLD.version_number, OLD.status
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER recipe_versions_guard
  BEFORE UPDATE OR DELETE ON "recipe_versions"
  FOR EACH ROW EXECUTE FUNCTION recipe_versions_guard();--> statement-breakpoint
-- Los ingredientes sólo se agregan, cambian o quitan mientras su versión es DRAFT.
-- (Si la versión ya no existe, es el borrado en cascada de un DRAFT descartado.)
CREATE FUNCTION recipe_ingredients_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_status recipe_version_status;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO version_status FROM recipe_versions WHERE id = OLD.recipe_version_id;
    IF FOUND AND version_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'recipe_version_immutable: los ingredientes de una versión % no se modifican', version_status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO version_status FROM recipe_versions WHERE id = NEW.recipe_version_id;
    IF FOUND AND version_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'recipe_version_immutable: no se agregan ingredientes a una versión %', version_status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER recipe_ingredients_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "recipe_ingredients"
  FOR EACH ROW EXECUTE FUNCTION recipe_ingredients_guard();--> statement-breakpoint
-- Los snapshots de costo son históricos: sólo inserción (TRUNCATE queda para tests).
CREATE FUNCTION recipe_cost_snapshots_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'recipe_cost_snapshot_immutable: % no está permitido en %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER recipe_cost_snapshots_append_only
  BEFORE UPDATE OR DELETE ON "recipe_cost_snapshots"
  FOR EACH ROW EXECUTE FUNCTION recipe_cost_snapshots_reject_mutation();--> statement-breakpoint
CREATE TRIGGER recipe_cost_snapshot_lines_append_only
  BEFORE UPDATE OR DELETE ON "recipe_cost_snapshot_lines"
  FOR EACH ROW EXECUTE FUNCTION recipe_cost_snapshots_reject_mutation();