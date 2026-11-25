-- Updates in the change log (T-060a, D-104). Numbered 0030 above main's
-- 0024 and the numbers reserved on the work board (0025 to 0029).
--
-- system_events: one row per change to the server itself, made by a system
-- manager or on the server's command line: today, an update installed and
-- an update rolled back (D-092), with the version before and after. It
-- belongs to no organization: only system managers see it in the audit
-- trail (people.ts `readAuditTrail`). Append-only as people_events (0020):
-- the writer has INSERT only (roles.ts), triggers refuse UPDATE, DELETE and
-- TRUNCATE, and a row is stamped now. Its actor is an account, or none for
-- the release command run on the server (npm run release -- install),
-- which signs in as nobody. As for people_events, the database can't check
-- that the change described happened.
--
-- Every trigger here is ENABLE ALWAYS (D-067), so replica mode skips none.

CREATE TABLE public.system_events (
  id uuid PRIMARY KEY
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- NULL: the release command on the server's command line.
  actor_id uuid REFERENCES public.users (id),
  kind text NOT NULL CONSTRAINT system_events_kind_known
    CHECK (kind IN ('update_installed', 'update_rolled_back')),
  -- The version running after the change, and before it (NULL: a
  -- development build, which has no version).
  version text NOT NULL CONSTRAINT system_events_version_shape
    CHECK (version ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'),
  from_version text CONSTRAINT system_events_from_version_shape
    CHECK (from_version IS NULL OR from_version ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$')
);

-- The audit trail pages newest first.
CREATE INDEX system_events_time ON public.system_events (occurred_at DESC, id DESC);

CREATE FUNCTION public.system_events_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.occurred_at < now() OR NEW.occurred_at > clock_timestamp() THEN
    RAISE EXCEPTION 'A change is logged when it is made.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'system_events_now';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER system_events_check_new
  BEFORE INSERT ON public.system_events
  FOR EACH ROW EXECUTE FUNCTION public.system_events_check_new();

CREATE FUNCTION public.system_events_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'The change log is never changed or emptied.'
    USING ERRCODE = 'integrity_constraint_violation',
          CONSTRAINT = 'system_events_append_only';
END
$$;

CREATE TRIGGER system_events_append_only
  BEFORE UPDATE OR DELETE ON public.system_events
  FOR EACH ROW EXECUTE FUNCTION public.system_events_append_only();

CREATE TRIGGER system_events_no_truncate
  BEFORE TRUNCATE ON public.system_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.system_events_append_only();

ALTER TABLE public.system_events ENABLE ALWAYS TRIGGER system_events_check_new;
ALTER TABLE public.system_events ENABLE ALWAYS TRIGGER system_events_append_only;
ALTER TABLE public.system_events ENABLE ALWAYS TRIGGER system_events_no_truncate;
