-- Identifier changes are versions (S-061, D-061 and D-063 amended). Numbered
-- 0068, above main's 0058 and every number reserved on the work board.
--
-- Before this, saving only a record's identifiers (its current and former
-- numbers) wrote no version: History and the audit trail didn't show it,
-- and a save from a stale copy of the record could silently put the old
-- numbers back, since the record's version (what If-Match and
-- expectedVersion compare) never moved. Now the service writes the record's
-- next version whenever its identifiers change, and every version holds the
-- identifiers as they stood when it was written:
--
-- 1. record_versions.identifiers: the record's identifiers when the version
--    was written, by type key: {"<type>": {"current": [{value, primary}],
--    "former": [{value, retiredAt?, note?}]}} in their stored order. Filled
--    in by the database (zzzz_record_versions_check), never the writer.
--    Versions written before 0068 keep NULL (not known). Staff-only, like
--    the rest of the table; nothing reads it to the public.
-- 2. A save's changed_fields also names `identifiers.<type>` for every type
--    whose numbers differ from the version before (when that version has a
--    snapshot). Workflow actions and deletions are unchanged.
--
-- The writer saves the identifiers before it writes the version (in the
-- same transaction), so the snapshot is what the version stands for.

ALTER TABLE public.record_versions ADD COLUMN identifiers jsonb;

-- The record's identifiers, as the version snapshot holds them. Times in
-- core's form (UTC, whole milliseconds), whatever the session's TimeZone.
CREATE FUNCTION public.record_identifier_snapshot(org uuid, rec uuid) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(jsonb_object_agg(t.type_key, jsonb_build_object(
           'current', coalesce((
             SELECT jsonb_agg(jsonb_build_object('value', i.value, 'primary', i.is_primary)
                              ORDER BY i.position)
             FROM public.record_identifiers i
             WHERE i.organization_id = org AND i.record_id = rec AND i.type_key = t.type_key),
             '[]'::jsonb),
           'former', coalesce((
             SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                      'value', f.value,
                      'retiredAt', to_char(f.retired_at AT TIME ZONE 'UTC',
                                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                      'note', f.note)) ORDER BY f.position)
             FROM public.former_identifiers f
             WHERE f.organization_id = org AND f.record_id = rec AND f.type_key = t.type_key),
             '[]'::jsonb))), '{}'::jsonb)
  FROM (SELECT type_key FROM public.record_identifiers
        WHERE organization_id = org AND record_id = rec
        UNION
        SELECT type_key FROM public.former_identifiers
        WHERE organization_id = org AND record_id = rec) AS t
$$;

CREATE OR REPLACE FUNCTION public.record_versions_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_row public.records;
  last_version integer;
  previous jsonb;
  previous_state text;
  previous_identifiers jsonb;
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
    previous_identifiers := '{}'::jsonb;
  ELSE
    SELECT record, workflow_state, identifiers INTO previous, previous_state, previous_identifiers
    FROM public.record_versions
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
  -- The record's identifiers as they stand now, never the writer's (S-061).
  NEW.identifiers := public.record_identifier_snapshot(NEW.organization_id, NEW.record_id);
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
    UNION ALL
    -- A save that changes the record's numbers names each type changed
    -- (S-061). Not after a version written before 0068 (no snapshot to
    -- compare with), and never for a deletion (its changedFields stay empty).
    SELECT 'identifiers.' || k
    FROM (SELECT jsonb_object_keys(NEW.identifiers) AS k
          UNION SELECT jsonb_object_keys(coalesce(previous_identifiers, '{}'::jsonb))) AS i
    WHERE NEW.action = 'save' AND previous_identifiers IS NOT NULL
      AND (NEW.identifiers -> k) IS DISTINCT FROM (previous_identifiers -> k)
  ) AS changed;
  RETURN NEW;
END
$$;
