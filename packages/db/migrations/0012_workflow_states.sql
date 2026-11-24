-- Workflow states stored with every record, changed only as versions of the
-- record (T-034b, D-076, on D-075's states and moves).
--
-- Numbered 0012: branch autopilot/T-037 holds 0010_sessions.sql and branch
-- autopilot/T-041 holds 0011_roles.sql; the runner allows gaps but never two
-- files with one number.
--
-- 1. records.workflow_state: draft, ready_for_review, published or withdrawn
--    (D-075), 'draft' for every record so far and every new one.
--
-- 2. Every change of state is a version of the record, like a save or a
--    deletion (D-063, D-067), so history says who moved it, when and why.
--    record_versions.action gains the four workflow actions, and each
--    version keeps the state the record was in once it was written
--    (record_versions.workflow_state, filled in by the database from the
--    row, never by the writer). The version check now also requires, for
--    every writer:
--    - version 1 is a 'save' of a 'draft' record;
--    - a 'save' never changes the state (the previous version's state is the
--      row's): saving, restoring and identifier changes leave it alone;
--    - a workflow action changes nothing but the state, along one of
--      D-075's moves for that action, from the previous version's state;
--    - a 'delete' is refused while the record is published (it must be
--      withdrawn first).
--    So the state can't change without its version (every UPDATE of a record
--    is a new version, 0005), and a version can't say anything but what the
--    row holds. changed_fields of a workflow version is {workflowState}.
--
-- 3. records_require_version (the COMMIT check of 0005) also compares the
--    state, so a record's state as committed is always the one its latest
--    version records.
--
-- What the database can't check is whether a record may be published right
-- now (rights, deeds, staff values, D-013, D-043): core's publish check,
-- which the service runs in the same transaction (D-076). The public output
-- re-checks everything when it is read (D-054), so a record that no longer
-- passes is not shown even while its state is published.

ALTER TABLE public.records
  ADD COLUMN workflow_state text NOT NULL DEFAULT 'draft'
    CONSTRAINT records_workflow_state_known
      CHECK (workflow_state IN ('draft', 'ready_for_review', 'published', 'withdrawn'));

-- Every version stored so far was written while its record was a draft. (A
-- column added with a default fills existing rows without an UPDATE, which
-- the append-only trigger would refuse.) The default is then dropped: the
-- version check fills the column in from the record row.
ALTER TABLE public.record_versions
  ADD COLUMN workflow_state text NOT NULL DEFAULT 'draft'
    CONSTRAINT record_versions_workflow_state_known
      CHECK (workflow_state IN ('draft', 'ready_for_review', 'published', 'withdrawn'));
ALTER TABLE public.record_versions ALTER COLUMN workflow_state DROP DEFAULT;

ALTER TABLE public.record_versions DROP CONSTRAINT record_versions_action_known;
ALTER TABLE public.record_versions ADD CONSTRAINT record_versions_action_known
  CHECK (action IN ('save', 'delete', 'submit_for_review', 'return_to_draft', 'publish',
                    'withdraw'));

-- The published records of an organization, for the public output's list
-- (D-076) and the counts T-034d builds.
CREATE INDEX records_published
  ON public.records (organization_id, id) WHERE workflow_state = 'published';

-- D-075's moves: true when `action` may take a record from `from_state` to
-- `to_state`. The same table as core's workflow.ts (a test compares them).
CREATE FUNCTION public.workflow_move_allowed(action text, from_state text, to_state text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(CASE action
    WHEN 'submit_for_review' THEN from_state IN ('draft', 'withdrawn')
                                  AND to_state = 'ready_for_review'
    WHEN 'return_to_draft' THEN from_state IN ('ready_for_review', 'withdrawn')
                                AND to_state = 'draft'
    WHEN 'publish' THEN from_state IN ('draft', 'ready_for_review', 'withdrawn')
                        AND to_state = 'published'
    WHEN 'withdraw' THEN from_state = 'published' AND to_state = 'withdrawn'
    ELSE false
  END, false)
$$;

-- The version check of 0008, with the workflow rules of 2. above.
CREATE OR REPLACE FUNCTION public.record_versions_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_row public.records;
  last_version integer;
  previous jsonb;
  previous_state text;
  row_version integer;
  fixed CONSTANT text[] := ARRAY['id', 'organizationId', 'createdAt', 'updatedAt', 'fields'];
BEGIN
  -- A deletion is always the record's last version: nothing, not even
  -- another deletion, is stored after one.
  IF EXISTS (SELECT 1 FROM public.record_versions
             WHERE organization_id = NEW.organization_id AND record_id = NEW.record_id
               AND action = 'delete') THEN
    RAISE EXCEPTION 'Nothing is stored after a record''s deletion version.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'record_versions_after_delete';
  END IF;
  row_version := CASE WHEN NEW.action = 'delete' THEN NEW.version - 1 ELSE NEW.version END;
  SELECT * INTO current_row FROM public.records
  WHERE organization_id = NEW.organization_id AND id = NEW.record_id
  FOR NO KEY UPDATE;
  IF NOT FOUND OR current_row.version <> row_version THEN
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
    previous_state := NULL;
  ELSE
    SELECT record, workflow_state INTO previous, previous_state FROM public.record_versions
    WHERE organization_id = NEW.organization_id AND record_id = NEW.record_id
      AND version = NEW.version - 1;
  END IF;
  -- The state is the row's, never the writer's.
  NEW.workflow_state := current_row.workflow_state;
  IF NEW.version = 1 THEN
    IF NEW.action <> 'save' OR NEW.workflow_state <> 'draft' THEN
      RAISE EXCEPTION 'A new record is saved as a draft.'
        USING ERRCODE = 'integrity_constraint_violation',
              CONSTRAINT = 'record_versions_workflow_move';
    END IF;
  ELSIF NEW.action IN ('save', 'delete') THEN
    IF NEW.workflow_state IS DISTINCT FROM previous_state THEN
      RAISE EXCEPTION 'Only a workflow action changes a record''s state.'
        USING ERRCODE = 'integrity_constraint_violation',
              CONSTRAINT = 'record_versions_workflow_move';
    END IF;
    IF NEW.action = 'delete' AND NEW.workflow_state = 'published' THEN
      RAISE EXCEPTION 'A published record is withdrawn before it is deleted.'
        USING ERRCODE = 'integrity_constraint_violation',
              CONSTRAINT = 'record_versions_delete_published';
    END IF;
  ELSE
    IF NOT public.workflow_move_allowed(NEW.action, previous_state, NEW.workflow_state) THEN
      RAISE EXCEPTION 'This workflow action can''t make this change of state.'
        USING ERRCODE = 'integrity_constraint_violation',
              CONSTRAINT = 'record_versions_workflow_move';
    END IF;
    IF NEW.record IS DISTINCT FROM previous THEN
      RAISE EXCEPTION 'A workflow action changes the record''s state only.'
        USING ERRCODE = 'integrity_constraint_violation',
              CONSTRAINT = 'record_versions_workflow_move';
    END IF;
  END IF;
  NEW.recorded_at := date_trunc('milliseconds', now());
  NEW.written_in := pg_current_xact_id();
  IF NEW.action IN ('submit_for_review', 'return_to_draft', 'publish', 'withdraw') THEN
    NEW.changed_fields := ARRAY['workflowState'];
    RETURN NEW;
  END IF;
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

-- The COMMIT check of 0005, now also for the state (3. above).
CREATE OR REPLACE FUNCTION public.records_require_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_row public.records;
  stored jsonb;
  stored_state text;
  stored_in xid8;
BEGIN
  SELECT * INTO current_row FROM public.records
  WHERE organization_id = NEW.organization_id AND id = NEW.id;
  IF NOT FOUND OR current_row.version <> NEW.version THEN
    RETURN NULL;
  END IF;
  SELECT record, workflow_state, written_in INTO stored, stored_state, stored_in
  FROM public.record_versions
  WHERE organization_id = NEW.organization_id AND record_id = NEW.id
    AND version = NEW.version;
  -- The version must be this transaction's own: an older stored version
  -- with the same content (a record wound back) doesn't count.
  IF stored IS NULL OR stored_in IS DISTINCT FROM pg_current_xact_id()
     OR stored IS DISTINCT FROM public.record_snapshot(current_row)
     OR stored_state IS DISTINCT FROM current_row.workflow_state THEN
    RAISE EXCEPTION 'A record was written without storing its version.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'records_have_version';
  END IF;
  RETURN NULL;
END
$$;

-- Every guard trigger fires in replica mode too (D-067). This migration adds
-- no trigger, but the rule is re-applied so none is ever left ORIGIN.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname, tg.tgname
    FROM pg_catalog.pg_trigger tg
    JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT tg.tgisinternal AND tg.tgenabled <> 'A'
    ORDER BY c.relname, tg.tgname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t.relname, t.tgname);
  END LOOP;
END
$$;
