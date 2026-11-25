-- Virus scanning of stored files (S-040, D-113). Numbered 0048: main ends
-- at 0039 and 0040 is reserved for another task; renumber at merge only if
-- main has gone past it.
--
-- Content is stored once per organization and SHA-256 (D-086), so a scan
-- result belongs to the content, not to each asset holding it: one row per
-- (organization, sha256), shared by every stored_files row naming it and
-- kept when they are removed (a later upload of the same bytes finds the
-- same result at once; an infected content stays quarantined).
--
--   pending    uploaded with scanning on: waiting for its first scan, not
--              served until it is clean
--   unscanned  stored before scanning was turned on: waiting for its first
--              scan and still served until then (turning scanning on must
--              not lock the whole collection); a failed scan leaves it so
--   clean      the scanner found nothing; a rescan keeps it clean (and
--              served) while it waits (rescan_requested_at)
--   infected   the scanner found something: quarantined, never served, and
--              never changed back by the writer (file_scans_guard)
--   failed     the first scan of a pending upload couldn't be done (timeout,
--              scanner down, a refusal or a reply that made no sense);
--              retried with backoff unless the cause won't change by itself
--
-- Only an infected verdict takes a served file away. A content with no row
-- has never been scanned. Nothing here deletes anything: no row and no
-- stored copy (D-086).
CREATE TABLE public.file_scans (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  sha256 text NOT NULL CONSTRAINT file_scans_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CONSTRAINT file_scans_state
    CHECK (state IN ('pending', 'unscanned', 'clean', 'infected', 'failed')),
  -- Failed attempts since the last result that wasn't a failure.
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT file_scans_attempts_range
    CHECK (attempts BETWEEN 0 AND 1000000),
  -- Moved on by every rescan request: a scan claimed under an older one
  -- doesn't store a clean or failed result (it is queued again).
  generation integer NOT NULL DEFAULT 0 CONSTRAINT file_scans_generation_range
    CHECK (generation BETWEEN 0 AND 2147483647),
  -- When the queue may take it next (NULL: not by itself, until a rescan).
  next_attempt_at timestamptz DEFAULT clock_timestamp(),
  -- Held by a worker scanning it until then (a lease: a crash only delays
  -- it). The claim takes no row whose lease is running, whatever a rescan
  -- or a new upload did to next_attempt_at meanwhile, so one content is
  -- never scanned by two workers at once. Cleared when a result is stored.
  leased_until timestamptz,
  -- A clean content asked to be scanned again (it stays clean meanwhile).
  rescan_requested_at timestamptz,
  -- Why the last scan failed: the state's cause for failed, the last
  -- attempt's for an unscanned or clean content waiting to be tried again.
  failure text CONSTRAINT file_scans_failure
    CHECK (failure IN ('timeout', 'unavailable', 'too_large', 'refused', 'protocol', 'unreadable')),
  -- The scanner's name for what it found: printable ASCII, no spaces.
  signature text CONSTRAINT file_scans_signature_format CHECK (signature ~ '^[!-~]{1,200}$'),
  scanned_at timestamptz,
  quarantined_at timestamptz,
  -- The database's clock, never the caller's.
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, sha256),
  CONSTRAINT file_scans_infected_shape
    CHECK ((state = 'infected') = (signature IS NOT NULL AND quarantined_at IS NOT NULL)),
  CONSTRAINT file_scans_failed_shape CHECK (state <> 'failed' OR failure IS NOT NULL),
  CONSTRAINT file_scans_failure_shape CHECK (failure IS NULL OR state IN ('failed', 'unscanned', 'clean')),
  CONSTRAINT file_scans_rescan_shape CHECK (rescan_requested_at IS NULL OR state = 'clean'),
  CONSTRAINT file_scans_queue_shape CHECK (
    next_attempt_at IS NULL OR state IN ('pending', 'unscanned', 'failed')
    OR (state = 'clean' AND rescan_requested_at IS NOT NULL))
);

CREATE INDEX file_scans_due ON public.file_scans (next_attempt_at)
  WHERE next_attempt_at IS NOT NULL;

-- Every scan result and every rescan request, append-only (like
-- stored_file_events): what was found in which content, and when.
CREATE TABLE public.file_scan_events (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL CONSTRAINT file_scan_events_id_v4
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  kind text NOT NULL CONSTRAINT file_scan_events_kind
    CHECK (kind IN ('clean', 'infected', 'failed', 'rescan')),
  -- NULL for a rescan of the whole organization.
  sha256 text CONSTRAINT file_scan_events_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  signature text CONSTRAINT file_scan_events_signature_format CHECK (signature ~ '^[!-~]{1,200}$'),
  failure text CONSTRAINT file_scan_events_failure
    CHECK (failure IN ('timeout', 'unavailable', 'too_large', 'refused', 'protocol', 'unreadable')),
  -- How many contents a rescan queued.
  queued integer CONSTRAINT file_scan_events_queued_range CHECK (queued >= 0),
  actor text NOT NULL CONSTRAINT file_scan_events_actor_format
    CHECK (actor ~ '^(user:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|system:[a-z][a-z0-9_-]{0,63})$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT file_scan_events_shape CHECK (
    (kind = 'rescan' AND sha256 IS NULL AND queued IS NOT NULL AND signature IS NULL AND failure IS NULL)
    OR (kind = 'clean' AND sha256 IS NOT NULL AND queued IS NULL AND signature IS NULL AND failure IS NULL)
    OR (kind = 'infected' AND sha256 IS NOT NULL AND queued IS NULL AND signature IS NOT NULL AND failure IS NULL)
    OR (kind = 'failed' AND sha256 IS NOT NULL AND queued IS NULL AND signature IS NULL AND failure IS NOT NULL))
);

CREATE INDEX file_scan_events_content
  ON public.file_scan_events (organization_id, sha256, occurred_at);

-- A quarantine holds: an infected content never goes back to another state,
-- and its signature and quarantine time never change, by any writer (a false positive is for an operator, by hand, as the
-- owner); no row is ever deleted; updated_at is the database's clock.
CREATE FUNCTION public.file_scans_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'file_scans rows are never removed.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'file_scans_kept';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
    RAISE EXCEPTION 'A scan result stays with its content.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'file_scans_fixed_key';
  END IF;
  IF OLD.state = 'infected' AND (NEW.state <> 'infected'
     OR NEW.quarantined_at IS DISTINCT FROM OLD.quarantined_at
     OR NEW.signature IS DISTINCT FROM OLD.signature) THEN
    RAISE EXCEPTION 'An infected file stays quarantined.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'file_scans_quarantine_holds';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

-- Every row starts queued, with nothing found yet: pending (an upload with
-- scanning on) or unscanned (stored before scanning was turned on). No
-- writer can insert a result it didn't scan for.
CREATE FUNCTION public.file_scans_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.state NOT IN ('pending', 'unscanned') OR NEW.signature IS NOT NULL
     OR NEW.failure IS NOT NULL OR NEW.scanned_at IS NOT NULL
     OR NEW.quarantined_at IS NOT NULL OR NEW.rescan_requested_at IS NOT NULL
     OR NEW.attempts <> 0 OR NEW.generation <> 0 OR NEW.leased_until IS NOT NULL THEN
    RAISE EXCEPTION 'A scan result starts queued.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'file_scans_start_queued';
  END IF;
  NEW.next_attempt_at := clock_timestamp();
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER file_scans_stamp BEFORE INSERT ON public.file_scans
  FOR EACH ROW EXECUTE FUNCTION public.file_scans_stamp();
CREATE TRIGGER file_scans_guard BEFORE UPDATE OR DELETE ON public.file_scans
  FOR EACH ROW EXECUTE FUNCTION public.file_scans_guard();
CREATE TRIGGER file_scans_no_truncate BEFORE TRUNCATE ON public.file_scans
  FOR EACH STATEMENT EXECUTE FUNCTION public.stored_files_append_only();

-- 0039's functions: occurred_at stamped now, and append-only.
CREATE TRIGGER file_scan_events_stamp BEFORE INSERT ON public.file_scan_events
  FOR EACH ROW EXECUTE FUNCTION public.stored_file_events_stamp();
CREATE TRIGGER file_scan_events_append_only BEFORE UPDATE OR DELETE ON public.file_scan_events
  FOR EACH ROW EXECUTE FUNCTION public.stored_files_append_only();
CREATE TRIGGER file_scan_events_no_truncate BEFORE TRUNCATE ON public.file_scan_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.stored_files_append_only();

ALTER TABLE public.file_scans ENABLE ALWAYS TRIGGER file_scans_stamp;
ALTER TABLE public.file_scans ENABLE ALWAYS TRIGGER file_scans_guard;
ALTER TABLE public.file_scans ENABLE ALWAYS TRIGGER file_scans_no_truncate;
ALTER TABLE public.file_scan_events ENABLE ALWAYS TRIGGER file_scan_events_stamp;
ALTER TABLE public.file_scan_events ENABLE ALWAYS TRIGGER file_scan_events_append_only;
ALTER TABLE public.file_scan_events ENABLE ALWAYS TRIGGER file_scan_events_no_truncate;
