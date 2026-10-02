-- Fase 5B (cierre) — Idempotencia de imputaciones manuales y ajustes de cuenta (ADR-063).
-- operation_id del intento, único por empresa (índice parcial): un mismo intento no
-- puede producir dos imputaciones ni dos movimientos. Columnas nulas para la historia
-- existente; no cambia saldos ni movimientos.
ALTER TABLE "customer_account_movements" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_payment_applications" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_account_movements_operation_uq" ON "customer_account_movements" USING btree ("company_id","operation_id") WHERE "customer_account_movements"."operation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payment_applications_operation_uq" ON "customer_payment_applications" USING btree ("company_id","operation_id") WHERE "customer_payment_applications"."operation_id" is not null;--> statement-breakpoint
ALTER TABLE "customer_account_movements" ADD CONSTRAINT "customer_account_movements_operation_adjustment" CHECK ("customer_account_movements"."operation_id" is null or "customer_account_movements"."movement_type" in ('ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT'));