-- La auditoría es solo-inserción: la base rechaza UPDATE y DELETE sobre audit_logs,
-- aunque un bug de la aplicación lo intente. (TRUNCATE queda permitido para
-- entornos de test y mantenimiento administrativo explícito.)
CREATE FUNCTION audit_logs_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs es solo-inserción: % no permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();
