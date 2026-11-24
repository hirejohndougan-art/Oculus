-- Record deletion with tombstones, and locks that keep a save's checks true
-- until it commits (T-032, D-067).
--
-- Numbered 0008, not 0007: branch autopilot/T-028 holds 0007_staff_search.sql,
-- and the runner allows gaps but never two files with one number.
--
-- 1. Deletion is a version (D-063 planned it). Every record_versions row now
--    says what it records: 'save' (every row so far) or 'delete'. A delete
--    version holds the record exactly as it was when deleted, who deleted it,
--    when and why, and is numbered one past the record's last version. The
--    database keeps deletes and their versions together, for every writer:
--    - a delete version is accepted only while the record row still exists,
--      at the number before it (zzzz_record_versions_check), and only if its
--      snapshot is that row;
--    - at COMMIT, a record that has a delete version written by this
--      transaction must be gone (zzzz_record_versions_delete_done,
--      deferred): a delete version can't be left in front of a live row;
--    - a DELETE of a record row is refused unless this same transaction has
--      stored its delete version (zzzz_records_delete_needs_version);
--    - the delete version is always the record's last: no version of any
--      kind is stored after one (record_versions_after_delete), the row can't
--      be updated once its delete version is stored (records_deleted), and the
--      ID can't be used again (records_id_used_before, 0005).
--    The app's writer role gets DELETE on records only now (D-067 lists its
--    GRANTs); every other role still has none.
--
-- 2. A save checks a record against the current version of its template and
--    record type (T-032). New versions of either are INSERTs, which row locks
--    on the identity rows don't stop, so each (organization, key) gets a
--    transaction-level advisory lock: a new template or record type version
--    takes it exclusive (a trigger, so every writer does), and a record save
--    takes it shared (definition_lock) before reading the template or type.
--    A save then either sees the new version or finishes before it is
--    written. Two-int key space: classid 66 for templates, 67 for record
--    types (65 is the arrangement lock, 0006; the identifier locks and the
--    migration lock are single-bigint keys).

ALTER TABLE public.record_versions
  ADD COLUMN action text NOT NULL DEFAULT 'save'
    CONSTRAINT record_versions_action_known CHECK (action IN ('save', 'delete'));

-- The version check of 0005, now for both actions. A save version must be
-- the number the row carries; a delete version the number after it, with
-- the row as it is (locked here, so it can't change before the DELETE).
CREATE OR REPLACE FUNCTION public.record_versions_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_row public.records;
  last_version integer;
  previous jsonb;
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
  ELSE
    SELECT record INTO previous FROM public.record_versions
    WHERE organization_id = NEW.organization_id AND record_id = NEW.record_id
      AND version = NEW.version - 1;
  END IF;
  NEW.recorded_at := date_trunc('milliseconds', now());
  NEW.written_in := pg_current_xact_id();
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

-- At COMMIT, a delete version stored by this transaction means the record is
-- gone. (A delete version from an earlier transaction can't exist beside a
-- live row: this check refused that transaction's COMMIT.)
CREATE FUNCTION public.record_versions_delete_done() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.records
             WHERE organization_id = NEW.organization_id AND id = NEW.record_id) THEN
    RAISE EXCEPTION 'A deletion version is stored only with the deletion of its record.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'record_versions_delete_done';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER zzzz_record_versions_delete_done AFTER INSERT ON public.record_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.action = 'delete')
  EXECUTE FUNCTION public.record_versions_delete_done();

-- A record whose deletion version is stored can't be written again before
-- its DELETE (its row is about to go): the deletion holds the row as it was.
CREATE FUNCTION public.records_not_deleted() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.record_versions
             WHERE organization_id = OLD.organization_id AND record_id = OLD.id
               AND action = 'delete') THEN
    RAISE EXCEPTION 'A record with a deletion version is never written again.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'records_deleted';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER zzzz_records_not_deleted BEFORE UPDATE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.records_not_deleted();

-- A record row is deleted only after this transaction stored its delete
-- version, one past the row's version (so it holds the row as deleted).
CREATE FUNCTION public.records_delete_needs_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.record_versions
    WHERE organization_id = OLD.organization_id AND record_id = OLD.id
      AND version = OLD.version + 1 AND action = 'delete'
      AND written_in = pg_current_xact_id()
      AND record = public.record_snapshot(OLD)
  ) THEN
    RAISE EXCEPTION 'A record is deleted only with its deletion version (who, when, why).'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'records_delete_needs_version';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER zzzz_records_delete_needs_version BEFORE DELETE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.records_delete_needs_version();

-- TRUNCATE would remove records without any version; nobody but the owner
-- may, and the owner is refused too unless it disables this trigger.
CREATE FUNCTION public.records_no_truncate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Records are deleted one by one, each with its deletion version.'
    USING ERRCODE = 'integrity_constraint_violation',
          CONSTRAINT = 'records_delete_needs_version';
END
$$;

CREATE TRIGGER zzzz_records_no_truncate BEFORE TRUNCATE ON public.records
  FOR EACH STATEMENT EXECUTE FUNCTION public.records_no_truncate();

-- The lock on one template's or record type's versions (see 2. above).
-- `kind` is 'template' or 'record_type'; anything else is refused.
CREATE FUNCTION public.definition_lock(organization_id uuid, kind text, key text,
                                       exclusive boolean) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  class integer;
BEGIN
  class := CASE kind WHEN 'template' THEN 66 WHEN 'record_type' THEN 67 END;
  IF class IS NULL OR key IS NULL OR organization_id IS NULL THEN
    RAISE EXCEPTION 'definition_lock takes an organization, ''template'' or ''record_type'', and a key.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF exclusive THEN
    PERFORM pg_advisory_xact_lock(class, hashtext(organization_id::text || '/' || key));
  ELSE
    PERFORM pg_advisory_xact_lock_shared(class, hashtext(organization_id::text || '/' || key));
  END IF;
END
$$;

CREATE FUNCTION public.template_versions_lock() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.definition_lock(NEW.organization_id, 'template', NEW.key, true);
  RETURN NEW;
END
$$;

CREATE FUNCTION public.record_type_versions_lock() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.definition_lock(NEW.organization_id, 'record_type', NEW.key, true);
  RETURN NEW;
END
$$;

-- Named to fire first among BEFORE INSERT triggers, so the lock is held
-- before anything else about the new version is decided.
CREATE TRIGGER aaaa_template_versions_lock BEFORE INSERT ON public.template_versions
  FOR EACH ROW EXECUTE FUNCTION public.template_versions_lock();
CREATE TRIGGER aaaa_record_type_versions_lock BEFORE INSERT ON public.record_type_versions
  FOR EACH ROW EXECUTE FUNCTION public.record_type_versions_lock();

-- 3. Template and record type versions are append-only, like record versions
-- (third independent review: a role granted UPDATE on one column of
-- template_versions rewrote stored history). Row triggers refuse UPDATE and
-- DELETE and a statement trigger refuses TRUNCATE, for every role that can't
-- disable triggers. Named to fire after zzzz_*_keep_identity, so a change of
-- identity is still reported as such.
CREATE FUNCTION public.definition_versions_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Template and record type versions are never changed or removed.'
    USING ERRCODE = 'integrity_constraint_violation',
          CONSTRAINT = TG_TABLE_NAME || '_append_only';
END
$$;

CREATE TRIGGER zzzz_template_versions_no_update BEFORE UPDATE OR DELETE ON public.template_versions
  FOR EACH ROW EXECUTE FUNCTION public.definition_versions_append_only();
CREATE TRIGGER zzzz_template_versions_no_truncate BEFORE TRUNCATE ON public.template_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.definition_versions_append_only();
CREATE TRIGGER zzzz_record_type_versions_no_update BEFORE UPDATE OR DELETE ON public.record_type_versions
  FOR EACH ROW EXECUTE FUNCTION public.definition_versions_append_only();
CREATE TRIGGER zzzz_record_type_versions_no_truncate BEFORE TRUNCATE ON public.record_type_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.definition_versions_append_only();

-- 4. Every guard trigger fires in replica mode too (fourth independent
-- review). With session_replication_role = replica, ordinary (ORIGIN)
-- triggers don't fire, so a session that starts in replica mode (a role or
-- database setting, a subscription's apply worker) could write records
-- without versions, rewrite history and skip the arrangement guard. ENABLE
-- ALWAYS makes them fire whatever the setting. This covers every trigger
-- the migrations have made on public tables so far (0002 to 0008); any later
-- migration that adds a guard trigger must ENABLE ALWAYS it too. Foreign keys
-- are internal triggers that replica mode still skips and that only a
-- superuser could change, so the service also refuses to write in replica
-- mode (checkWriterConnection, D-067).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname, tg.tgname
    FROM pg_catalog.pg_trigger tg
    JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT tg.tgisinternal
    ORDER BY c.relname, tg.tgname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t.relname, t.tgname);
  END LOOP;
END
$$;
