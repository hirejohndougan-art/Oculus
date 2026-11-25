-- Append-only guards for four tables the writer can't change by privilege but
-- no trigger protected (S-065, T-053 data review L4). Every other append-only
-- table (record_versions, people_events, system_events, stored_file_events,
-- the purge and scan logs) already refuses UPDATE, DELETE and TRUNCATE for
-- any role that can't disable triggers; these now do too. Defence in depth:
-- the writer has neither UPDATE nor DELETE on any of them (roles.ts).
--
-- - storage_moves (D-115, "insert only"): no UPDATE, DELETE or TRUNCATE.
-- - accession_versions (T-018c): no UPDATE, DELETE or TRUNCATE.
-- - second_step_alert_notices (0021): already refuses UPDATE; now DELETE and
--   TRUNCATE too.
-- - second_step_passes (0014): already refuses UPDATE and TRUNCATE; now
--   DELETE too.
--
-- The last two reference users (and alerts or factors) ON DELETE CASCADE.
-- Nothing in Oculus deletes a user, an alert or a factor, and a cascade now
-- stops at these rows, as it already did at people_events: a person's sign-in
-- history is kept. Numbered 0052, above 0050 and 0051 (reserved on the work
-- board by S-061 and S-064).

CREATE FUNCTION public.append_only_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- The constraint named is the trigger's own name (`<table>_append_only`,
  -- `<table>_no_truncate`, `<table>_no_delete`), so each refusal says which.
  RAISE EXCEPTION '% only grows.', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation',
          CONSTRAINT = TG_NAME;
END
$$;

CREATE TRIGGER storage_moves_append_only BEFORE UPDATE OR DELETE ON public.storage_moves
  FOR EACH ROW EXECUTE FUNCTION public.append_only_guard();
CREATE TRIGGER storage_moves_no_truncate BEFORE TRUNCATE ON public.storage_moves
  FOR EACH STATEMENT EXECUTE FUNCTION public.append_only_guard();

CREATE TRIGGER accession_versions_append_only BEFORE UPDATE OR DELETE ON public.accession_versions
  FOR EACH ROW EXECUTE FUNCTION public.append_only_guard();
CREATE TRIGGER accession_versions_no_truncate BEFORE TRUNCATE ON public.accession_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.append_only_guard();

CREATE TRIGGER second_step_alert_notices_append_only
  BEFORE DELETE ON public.second_step_alert_notices
  FOR EACH ROW EXECUTE FUNCTION public.append_only_guard();
CREATE TRIGGER second_step_alert_notices_no_truncate
  BEFORE TRUNCATE ON public.second_step_alert_notices
  FOR EACH STATEMENT EXECUTE FUNCTION public.append_only_guard();

CREATE TRIGGER second_step_passes_no_delete BEFORE DELETE ON public.second_step_passes
  FOR EACH ROW EXECUTE FUNCTION public.append_only_guard();

-- Like every other guard: fires even for replication-role sessions.
ALTER TABLE public.storage_moves ENABLE ALWAYS TRIGGER storage_moves_append_only;
ALTER TABLE public.storage_moves ENABLE ALWAYS TRIGGER storage_moves_no_truncate;
ALTER TABLE public.accession_versions ENABLE ALWAYS TRIGGER accession_versions_append_only;
ALTER TABLE public.accession_versions ENABLE ALWAYS TRIGGER accession_versions_no_truncate;
ALTER TABLE public.second_step_alert_notices
  ENABLE ALWAYS TRIGGER second_step_alert_notices_append_only;
ALTER TABLE public.second_step_alert_notices
  ENABLE ALWAYS TRIGGER second_step_alert_notices_no_truncate;
ALTER TABLE public.second_step_passes ENABLE ALWAYS TRIGGER second_step_passes_no_delete;
