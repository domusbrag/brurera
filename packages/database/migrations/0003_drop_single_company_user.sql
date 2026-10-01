ALTER TABLE "user_roles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "user_roles" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_employee_id_employees_id_fk";
--> statement-breakpoint
DROP INDEX "users_employee_uq";--> statement-breakpoint
DROP INDEX "users_company_idx";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "company_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "employee_id";