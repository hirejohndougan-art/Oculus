-- Definition changes in the change log (S-064, D-117). Numbered 0051 above
-- main's 0049 and migration 0050 (reserved on the work board for S-061).
--
-- definition_events: one row per change to a definition the organization's
-- records lean on, which until now changed in place with no record of who
-- (identifier types, vocabulary terms, site names) or kept only the last
-- editor (storage levels and locations, Dublin Core mappings, the System
-- settings). Each row says what (the subject and its key), who, when, and
-- the definition before and after the change.
--
-- Rows are written by AFTER INSERT OR UPDATE triggers on those tables, in
-- the same transaction as the change, so no code path can change a
-- definition without its row (the T-053 data review, M5). The actor is the
-- transaction's `oculus.actor` setting, which the service sets at the
-- start of every transaction it runs (service.ts `run`), or, where the
-- table has one, the account the row itself names (updated_by,
-- changed_by). Neither: NULL, shown as "the command line" (first-time
-- setup, the migrations themselves). An UPDATE that changes nothing but a
-- timestamp, editor or version number writes no row, and a row's version
-- number isn't kept (the definition's own history is this log). Nothing deletes these definitions (the writer
-- has no DELETE on them, roles.ts), so deletions aren't logged.
--
-- Append-only as people_events (0020): the writer has INSERT only, triggers
-- refuse UPDATE, DELETE and TRUNCATE, and a row is stamped now. As for
-- people_events, a writer with direct SQL can add false rows (never change
-- or remove true ones), and can set `oculus.actor` to another account.
--
-- The System settings belong to no organization: their rows have no
-- organization_id, and only system managers see them (people.ts
-- `readAuditTrail`, scope.system).
--
-- Every trigger here is ENABLE ALWAYS (D-067), so replica mode skips none.

CREATE TABLE public.definition_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  -- NULL only for the System settings.
  organization_id uuid REFERENCES public.organizations (id),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- NULL: no account (first-time setup or a command run on the server).
  actor text CONSTRAINT definition_events_actor_format
    CHECK (actor IS NULL OR actor ~ '^(user:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|system:[a-z][a-z0-9_-]{0,63})$'),
  subject text NOT NULL CONSTRAINT definition_events_subject_known
    CHECK (subject IN ('identifier_type', 'term', 'site', 'storage_levels', 'storage_location',
                       'dublin_core_mapping', 'system_settings')),
  -- The identifier type's key, the term's, site's or location's ID, the
  -- mapping's template key; NULL for the storage levels and the System
  -- settings (one per organization, one per install).
  subject_key text CHECK (subject_key IS NULL OR length(subject_key) BETWEEN 1 AND 200),
  action text NOT NULL CONSTRAINT definition_events_action_known
    CHECK (action IN ('created', 'changed')),
  -- The stored row before (NULL when created) and after, without its
  -- organization and timestamps.
  before jsonb CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  after jsonb NOT NULL CHECK (jsonb_typeof(after) = 'object'),
  CONSTRAINT definition_events_shape CHECK (
    (action = 'created') = (before IS NULL)
    AND (subject = 'system_settings') = (organization_id IS NULL)
    AND (subject IN ('storage_levels', 'system_settings')) = (subject_key IS NULL))
);

-- The audit trail pages newest first, per organization (and the install's).
CREATE INDEX definition_events_time
  ON public.definition_events (organization_id, occurred_at DESC, id DESC);

CREATE FUNCTION public.definition_events_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.occurred_at < now() OR NEW.occurred_at > clock_timestamp() THEN
    RAISE EXCEPTION 'A change is logged when it is made.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'definition_events_now';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER definition_events_check_new
  BEFORE INSERT ON public.definition_events
  FOR EACH ROW EXECUTE FUNCTION public.definition_events_check_new();

CREATE FUNCTION public.definition_events_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'The change log is never changed or emptied.'
    USING ERRCODE = 'integrity_constraint_violation',
          CONSTRAINT = 'definition_events_append_only';
END
$$;

CREATE TRIGGER definition_events_append_only
  BEFORE UPDATE OR DELETE ON public.definition_events
  FOR EACH ROW EXECUTE FUNCTION public.definition_events_append_only();

CREATE TRIGGER definition_events_no_truncate
  BEFORE TRUNCATE ON public.definition_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.definition_events_append_only();

-- The logging trigger, one function for every definition table. TG_ARGV[0]
-- is the subject; the key and the "by" column are read by name from the
-- row's JSON, so one function serves every table.
CREATE FUNCTION public.definition_events_log() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  subject text := TG_ARGV[0];
  old_row jsonb;
  new_row jsonb := to_jsonb(NEW);
  noise text[] := ARRAY['organization_id', 'created_at', 'updated_at', 'changed_at',
                        'updated_by', 'changed_by', 'singleton', 'version'];
  given text := current_setting('oculus.actor', true);
  who text;
  by_id text := coalesce(new_row ->> 'updated_by', new_row ->> 'changed_by');
  key text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_row := to_jsonb(OLD);
    IF (old_row - noise) = (new_row - noise) THEN
      RETURN NULL;
    END IF;
  END IF;
  IF given IS NOT NULL AND given <> '' THEN
    who := given;
  ELSIF by_id IS NOT NULL THEN
    who := 'user:' || by_id;
  END IF;
  key := CASE subject
           WHEN 'identifier_type' THEN new_row ->> 'key'
           WHEN 'dublin_core_mapping' THEN new_row ->> 'template_key'
           WHEN 'storage_levels' THEN NULL
           WHEN 'system_settings' THEN NULL
           ELSE new_row ->> 'id'
         END;
  INSERT INTO public.definition_events
    (organization_id, actor, subject, subject_key, action, before, after)
  VALUES ((new_row ->> 'organization_id')::uuid, who, subject, key,
          CASE TG_OP WHEN 'INSERT' THEN 'created' ELSE 'changed' END,
          old_row - noise, new_row - noise);
  RETURN NULL;
END
$$;

CREATE TRIGGER definition_events_log AFTER INSERT OR UPDATE ON public.identifier_types
  FOR EACH ROW EXECUTE FUNCTION public.definition_events_log('identifier_type');
CREATE TRIGGER definition_events_log AFTER INSERT OR UPDATE ON public.terms
  FOR EACH ROW EXECUTE FUNCTION public.definition_events_log('term');
CREATE TRIGGER definition_events_log AFTER INSERT OR UPDATE ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.definition_events_log('site');
CREATE TRIGGER definition_events_log AFTER INSERT OR UPDATE ON public.storage_levels
  FOR EACH ROW EXECUTE FUNCTION public.definition_events_log('storage_levels');
CREATE TRIGGER definition_events_log AFTER INSERT OR UPDATE ON public.storage_locations
  FOR EACH ROW EXECUTE FUNCTION public.definition_events_log('storage_location');
CREATE TRIGGER definition_events_log AFTER INSERT OR UPDATE ON public.dublin_core_mappings
  FOR EACH ROW EXECUTE FUNCTION public.definition_events_log('dublin_core_mapping');
CREATE TRIGGER definition_events_log AFTER INSERT OR UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.definition_events_log('system_settings');

ALTER TABLE public.definition_events ENABLE ALWAYS TRIGGER definition_events_check_new;
ALTER TABLE public.definition_events ENABLE ALWAYS TRIGGER definition_events_append_only;
ALTER TABLE public.definition_events ENABLE ALWAYS TRIGGER definition_events_no_truncate;
ALTER TABLE public.identifier_types ENABLE ALWAYS TRIGGER definition_events_log;
ALTER TABLE public.terms ENABLE ALWAYS TRIGGER definition_events_log;
ALTER TABLE public.sites ENABLE ALWAYS TRIGGER definition_events_log;
ALTER TABLE public.storage_levels ENABLE ALWAYS TRIGGER definition_events_log;
ALTER TABLE public.storage_locations ENABLE ALWAYS TRIGGER definition_events_log;
ALTER TABLE public.dublin_core_mappings ENABLE ALWAYS TRIGGER definition_events_log;
ALTER TABLE public.system_settings ENABLE ALWAYS TRIGGER definition_events_log;
