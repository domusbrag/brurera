-- Fase 1: la pertenencia de un usuario a una empresa pasa a una tabla propia
-- (company_memberships) y los roles se asignan a la membresía (membership_roles).
-- Las sesiones abiertas se cierran: a partir de aquí cada sesión trabaja en una empresa.
DELETE FROM "sessions";
--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "company_id" uuid NOT NULL;
--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('ACTIVE', 'DISABLED');
--> statement-breakpoint
CREATE TABLE "company_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"employee_id" uuid,
	"status" "membership_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_memberships_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "membership_roles" (
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by_user_id" uuid,
	CONSTRAINT "membership_roles_membership_id_role_id_pk" PRIMARY KEY("membership_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_employee_fk" FOREIGN KEY ("company_id","employee_id") REFERENCES "public"."employees"("company_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membership_fk" FOREIGN KEY ("company_id","membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_role_fk" FOREIGN KEY ("company_id","role_id") REFERENCES "public"."roles"("company_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "company_memberships_company_user_uq" ON "company_memberships" USING btree ("company_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "company_memberships_employee_uq" ON "company_memberships" USING btree ("employee_id");
--> statement-breakpoint
CREATE INDEX "company_memberships_user_idx" ON "company_memberships" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "membership_roles_role_idx" ON "membership_roles" USING btree ("role_id");
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Traslado de datos: una membresía por usuario existente, con su empleado y sus roles.
INSERT INTO "company_memberships" ("company_id", "user_id", "employee_id")
SELECT "company_id", "id", "employee_id" FROM "users";
--> statement-breakpoint
INSERT INTO "membership_roles" ("membership_id", "role_id", "company_id", "assigned_at", "assigned_by_user_id")
SELECT m."id", ur."role_id", m."company_id", ur."assigned_at", ur."assigned_by_user_id"
FROM "user_roles" ur
JOIN "company_memberships" m ON m."user_id" = ur."user_id"
JOIN "roles" r ON r."id" = ur."role_id" AND r."company_id" = m."company_id";
