-- Record versions (T-029, D-063): every write of a record stores a full copy
-- of the record as it now is, who made it, when, which fields changed and an
-- optional reason, in an append-only table, in the same transaction as the
-- write. This is the change log behind the History tab and the Audit trail.
--
-- What the database guarantees, for every writer (the data-access layer,
-- direct SQL, a bug), not only for packages/db:
-- - records.version counts the record's writes: an INSERT starts at 1 and
--   every UPDATE adds exactly 1 (zzzz_records_version_step).
-- - At COMMIT, the version row for each written record's current version
--   exists and holds exactly the record as it now is
--   (zzzz_records_have_version, deferred). A record write without its version
--   can't commit, and a version can't be written without its record write.
-- - A version row is accepted only as the next number for its record (no
--   gap, no duplicate), only when the record row already carries that number,
--   and only if its snapshot is exactly that row (record_snapshot below). Who
--   and why are the writer's; when and which fields changed are filled in by
--   the database (zzzz_record_versions_check), never what the writer sends.
-- - Versions are never changed or removed: UPDATE, DELETE and TRUNCATE are
--   refused by triggers (record_versions_append_only), and the app's role
--   gets only SELECT and INSERT on the table (D-063 lists the GRANTs; roles
--   are not created here, since a shared host may not allow CREATE ROLE).
--   The owner (the migrating role) can still disable triggers: the app must
--   never run as the owner.
--
-- Versions have no foreign key to records: the history of a deleted record
-- stays (deleting records is the service layer's, T-032). They are keyed by
-- (organization_id, record_id, version), so the organization is in every
-- lookup (D-019), and the snapshot must be the row of that organization's
-- record, so no version can be filed under another organization's record.
-- Read Committed is what Database.transaction uses (D-061); the checks below
-- don't depend on it: each is either a unique key or a comparison with the
-- record row, which the writer has locked by updating it.

-- How many times the record has been written. Existing rows (there are none
-- in any deployed database; Oculus isn't deployed yet) get version 1, and a
-- version 1 row is written for each of them at the end of this file.
ALTER TABLE public.records
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);

-- The record as core's CatalogRecord, built from its row exactly as
-- catalog.ts's recordFromRow does: optional columns only when set, the
-- timestamps in core's form. A version's snapshot must equal this.
-- extra_float_digits = 1 so a coordinate is written as the shortest text that
-- reads back as the same number, whatever the session's setting (D-060).
CREATE FUNCTION public.record_snapshot(r public.records) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
SET extra_float_digits = 1
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
           'id', r.id::text,
           'organizationId', r.organization_id::text,
           'kind', r.kind,
           'title', r.title,
           'templateKey', r.template_key,
           'recordTypeKey', r.record_type_key,
           'level', r.level,
           'parentId', r.parent_id::text,
           'mediaType', r.media_type,
           'represents', r.represents_id::text,
           'agentType', r.agent_type,
           'coordinates', CASE WHEN r.latitude IS NOT NULL OR r.longitude IS NOT NULL
                            THEN jsonb_build_object('lat', r.latitude, 'lng', r.longitude) END,
           'createdAt', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'updatedAt', to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
         -- Added after stripping: nulls inside fields are the record's own.
         || jsonb_build_object('fields', r.fields)
$$;

CREATE TABLE public.record_versions (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  record_id uuid NOT NULL
    CHECK (record_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  version integer NOT NULL CHECK (version >= 1),
  -- The whole record as core validated it (checked against the row on insert).
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  -- Who: an opaque actor ID until user accounts exist (T-036 adds a foreign
  -- key to users for user:<id>): `user:` and a lowercase version 4 UUID, or
  -- `system:` and a lower-case name for imports, migrations and jobs.
  actor text NOT NULL CONSTRAINT record_versions_actor_format
    CHECK (actor ~ '^(user:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|system:[a-z][a-z0-9_-]{0,63})$'),
  -- When: the database's clock at the write, in whole milliseconds.
  recorded_at timestamptz NOT NULL
    CHECK (date_trunc('milliseconds', recorded_at AT TIME ZONE 'UTC') = recorded_at AT TIME ZONE 'UTC'),
  -- Which fields changed since the previous version (every one for version
  -- 1): core's property names (title, parentId, coordinates …) and
  -- fields.<key> for template fields, sorted. Never id, organizationId,
  -- createdAt or updatedAt.
  changed_fields text[] NOT NULL,
  -- Why, if the person said: one trimmed line or paragraph, no control
  -- characters but line breaks.
  reason text CONSTRAINT record_versions_reason_format
    CHECK (reason <> '' AND length(reason) <= 2000 AND btrim(reason, E' \n') = reason
           AND reason !~ '[\x01-\x09\x0b-\x1f\x7f]'),
  PRIMARY KEY (organization_id, record_id, version),
  CONSTRAINT record_versions_snapshot_names_row
    CHECK (record ->> 'id' IS NOT DISTINCT FROM record_id::text
           AND record ->> 'organizationId' IS NOT DISTINCT FROM organization_id::text)
);

-- The Audit trail lists an organization's changes by time.
CREATE INDEX record_versions_by_time
  ON public.record_versions (organization_id, recorded_at, record_id, version);

-- Nobody but the owner gets anything by default; spelled out anyway.
REVOKE ALL ON public.record_versions FROM PUBLIC;

-- A version row is the next one for its record, written with the record:
-- the record row carries its number, the number follows the last stored one,
-- and the snapshot is the row. Fills in recorded_at and changed_fields.
-- Raised as SQLSTATE 23000 with the constraint named in the message's place.
CREATE FUNCTION public.record_versions_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_row public.records;
  last_version integer;
  previous jsonb;
  fixed CONSTANT text[] := ARRAY['id', 'organizationId', 'createdAt', 'updatedAt', 'fields'];
BEGIN
  -- Locked (a writer that updated the record already holds it), so the row
  -- can't change between this check and the end of the transaction except
  -- by this transaction.
  SELECT * INTO current_row FROM public.records
  WHERE organization_id = NEW.organization_id AND id = NEW.record_id
  FOR NO KEY UPDATE;
  IF NOT FOUND OR current_row.version <> NEW.version THEN
    RAISE EXCEPTION 'A record version is written with the record write that makes it.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'record_versions_with_record_write';
  END IF;
  SELECT max(version) INTO last_version FROM public.record_versions
  WHERE organization_id = NEW.organization_id AND record_id = NEW.record_id;
  IF coalesce(last_version, 0) <> NEW.version - 1 THEN
    RAISE EXCEPTION 'Record versions are numbered 1, 2, 3 … with no gaps.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'record_versions_next_number';
  END IF;
  IF NEW.record IS DISTINCT FROM public.record_snapshot(current_row) THEN
    RAISE EXCEPTION 'A record version holds the record exactly as written.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'record_versions_snapshot_matches';
  END IF;
  IF NEW.version = 1 THEN
    previous := '{}'::jsonb;
  ELSE
    SELECT record INTO previous FROM public.record_versions
    WHERE organization_id = NEW.organization_id AND record_id = NEW.record_id
      AND version = NEW.version - 1;
  END IF;
  NEW.recorded_at := date_trunc('milliseconds', now());
  SELECT coalesce(array_agg(name ORDER BY name COLLATE "C"), '{}') INTO NEW.changed_fields
  FROM (
    SELECT k AS name
    FROM (SELECT jsonb_object_keys(NEW.record) AS k
          UNION SELECT jsonb_object_keys(previous)) AS top
    WHERE k <> ALL (fixed) AND (NEW.record -> k) IS DISTINCT FROM (previous -> k)
    UNION ALL
    SELECT 'fields.' || k
    FROM (SELECT jsonb_object_keys(NEW.record -> 'fields') AS k
          UNION SELECT jsonb_object_keys(coalesce(previous -> 'fields', '{}'::jsonb))) AS f
    WHERE (NEW.record -> 'fields' -> k) IS DISTINCT FROM (previous -> 'fields' -> k)
  ) AS changed;
  RETURN NEW;
END
$$;

CREATE TRIGGER zzzz_record_versions_check BEFORE INSERT ON public.record_versions
  FOR EACH ROW EXECUTE FUNCTION public.record_versions_check();

-- Append-only: no version is ever changed or removed, by anyone who can't
-- disable triggers (only the owner can).
CREATE FUNCTION public.record_versions_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Record versions are never changed or removed.'
    USING ERRCODE = 'integrity_constraint_violation',
          CONSTRAINT = 'record_versions_append_only';
END
$$;

CREATE TRIGGER zzzz_record_versions_append_only BEFORE UPDATE OR DELETE ON public.record_versions
  FOR EACH ROW EXECUTE FUNCTION public.record_versions_append_only();
CREATE TRIGGER zzzz_record_versions_no_truncate BEFORE TRUNCATE ON public.record_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.record_versions_append_only();

-- records.version starts at 1 and every UPDATE adds exactly 1, so every
-- write is a new version number. Fires after zzzz_records_keep_identity.
CREATE FUNCTION public.records_version_step() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'A new record is version 1.'
        USING ERRCODE = 'integrity_constraint_violation',
              CONSTRAINT = 'records_version_step';
    END IF;
  ELSIF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'Every write of a record is its next version.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'records_version_step';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER zzzz_records_version_step BEFORE INSERT OR UPDATE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.records_version_step();

-- At COMMIT (or SET CONSTRAINTS … IMMEDIATE), a written record's current
-- version must be stored and hold the record as it now is. A later write of
-- the same record in the transaction is checked by its own event; a record
-- deleted later in the transaction needs nothing.
CREATE FUNCTION public.records_require_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_row public.records;
  stored jsonb;
BEGIN
  SELECT * INTO current_row FROM public.records
  WHERE organization_id = NEW.organization_id AND id = NEW.id;
  IF NOT FOUND OR current_row.version <> NEW.version THEN
    RETURN NULL;
  END IF;
  SELECT record INTO stored FROM public.record_versions
  WHERE organization_id = NEW.organization_id AND record_id = NEW.id
    AND version = NEW.version;
  IF stored IS NULL OR stored IS DISTINCT FROM public.record_snapshot(current_row) THEN
    RAISE EXCEPTION 'A record was written without storing its version.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'records_have_version';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER zzzz_records_have_version AFTER INSERT OR UPDATE ON public.records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.records_require_version();

-- Records stored before this migration get their first version, written by
-- the migration (none exist in a deployed database).
INSERT INTO public.record_versions (organization_id, record_id, version, record, actor,
                                    recorded_at, changed_fields)
SELECT r.organization_id, r.id, r.version, public.record_snapshot(r), 'system:migration_0005',
       now(), '{}'
FROM public.records r
ORDER BY r.organization_id, r.id;
