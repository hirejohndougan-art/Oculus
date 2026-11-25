-- The safe purge of removed files (S-052, D-086 amended). Numbered 0049, after
-- main's 0048 (S-040's file_scans, which section 4 reads).
--
-- 1. A removal remembers the stored copy's own time. When a file is removed,
--    the service reads the copy's modification time (the file system's
--    clock, in nanoseconds) and logs it with the removal. Every attach in
--    any database sets that time to now (D-086, fifth review), so a copy
--    whose time is still the one logged with this database's removal has
--    not been used anywhere since: the purge takes only such copies. A copy
--    another database (a restored dump, a clone) attached again since has a
--    newer time, and is kept whatever this database believes.
ALTER TABLE public.stored_file_events ADD COLUMN copy_mtime_ns bigint;
ALTER TABLE public.stored_file_events ADD CONSTRAINT stored_file_events_copy_mtime
  CHECK (copy_mtime_ns IS NULL OR (kind = 'removed' AND copy_mtime_ns >= 0));
-- An attach whose touch couldn't change the copy's time (a file system that
-- ignores it): the purge can't tell that copy's later use, so it never
-- takes that content.
ALTER TABLE public.stored_file_events ADD COLUMN touch_failed boolean NOT NULL DEFAULT false;

-- 2. The purge takes the folder's lease as a start or a renewal does: a new
--    epoch, here first, then in the marker. Its rows say so.
ALTER TABLE public.file_store_epochs DROP CONSTRAINT file_store_epochs_kind;
ALTER TABLE public.file_store_epochs ADD CONSTRAINT file_store_epochs_kind
  CHECK (kind IN ('bind', 'renew', 'adopt', 'purge'));

-- 2b. Each epoch row also records the database's catalog fingerprint: the
--    OIDs of file_store_epochs, stored_file_events and stored_files and of
--    the database, stamped by the database whatever the INSERT says. A
--    pg_upgrade keeps them (only the cluster's system identifier changes);
--    a pg_dump and restore usually gives new ones, though not always (a
--    restore into a fresh cluster made the same way can repeat them). It is
--    kept for people to read; nothing depends on it for safety (S-052
--    fourth review: there is no accepting of a changed identity).
CREATE FUNCTION public.file_store_fingerprint() RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT 'public.file_store_epochs'::regclass::oid::text || ':'
      || 'public.stored_file_events'::regclass::oid::text || ':'
      || 'public.stored_files'::regclass::oid::text || ':'
      || (SELECT d.oid::text FROM pg_catalog.pg_database d
          WHERE d.datname = pg_catalog.current_database())
$$;

ALTER TABLE public.file_store_epochs ADD COLUMN catalog_fingerprint text;

CREATE OR REPLACE FUNCTION public.file_store_epochs_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.made_at := clock_timestamp();
  NEW.catalog_fingerprint := public.file_store_fingerprint();
  RETURN NEW;
END
$$;

-- 3. The purge's two steps, append-only. For each content of an
--    organization, its newest row says where it stands:
--      trashed   step 1: the copy (and its thumbnails) moved into the
--                organization's trash folder, by one rename;
--      deleted   step 2, at least a day later by both clocks: deleted from
--                the trash;
--      restored  put back (an upload of the same content, or a check that
--                failed: a newer use, a reference, a changed copy).
--    `removal_id` names the removal (stored_file_events) the purge acted on,
--    `copy_mtime_ns` the copy's time it saw, `epoch` the lease it held.
CREATE TABLE public.file_purge_steps (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL CONSTRAINT file_purge_steps_id_v4
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  kind text NOT NULL CONSTRAINT file_purge_steps_kind
    CHECK (kind IN ('trashed', 'deleted', 'restored')),
  sha256 text NOT NULL CONSTRAINT file_purge_steps_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CONSTRAINT file_purge_steps_byte_size_range
    CHECK (byte_size >= 1 AND byte_size <= 1099511627776),
  removal_id uuid NOT NULL,
  copy_mtime_ns bigint NOT NULL CONSTRAINT file_purge_steps_copy_mtime CHECK (copy_mtime_ns >= 0),
  epoch uuid NOT NULL,
  actor text NOT NULL CONSTRAINT file_purge_steps_actor_format
    CHECK (actor ~ '^(user:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|system:[a-z][a-z0-9_-]{0,63})$'),
  -- The database's clock, never the caller's.
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX file_purge_steps_content
  ON public.file_purge_steps (organization_id, sha256, occurred_at);

CREATE FUNCTION public.file_purge_steps_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.occurred_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER file_purge_steps_stamp BEFORE INSERT ON public.file_purge_steps
  FOR EACH ROW EXECUTE FUNCTION public.file_purge_steps_stamp();
CREATE TRIGGER file_purge_steps_append_only BEFORE UPDATE OR DELETE ON public.file_purge_steps
  FOR EACH ROW EXECUTE FUNCTION public.stored_files_append_only();
CREATE TRIGGER file_purge_steps_no_truncate BEFORE TRUNCATE ON public.file_purge_steps
  FOR EACH STATEMENT EXECUTE FUNCTION public.stored_files_append_only();

ALTER TABLE public.file_purge_steps ENABLE ALWAYS TRIGGER file_purge_steps_stamp;
ALTER TABLE public.file_purge_steps ENABLE ALWAYS TRIGGER file_purge_steps_append_only;
ALTER TABLE public.file_purge_steps ENABLE ALWAYS TRIGGER file_purge_steps_no_truncate;

-- 4. Whether anything still keeps a content: the one list the purge asks
--    (its candidates, and every check again inside a step). A content named
--    here is never moved or deleted:
--    - a stored_files row names it;
--    - its virus scan found it infected (S-040, 0048's file_scans, the same
--      organization and sha256): quarantined content is kept for good. A
--      pending, unscanned or failed scan doesn't keep it by itself.
--    A table added later that names contents by (organization_id, sha256)
--    and must keep them adds one `OR EXISTS (...)` line here, in its own
--    migration (CREATE OR REPLACE).
CREATE FUNCTION public.stored_content_kept(organization uuid, content text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.stored_files f
                 WHERE f.organization_id = organization AND f.sha256 = content)
      OR EXISTS (SELECT 1 FROM public.file_scans s
                 WHERE s.organization_id = organization AND s.sha256 = content
                   AND s.state = 'infected')
$$;

-- 5. The change log (system_events, 0030): each step of the purge (one
--    content moved to the trash, deleted or put back) adds one row, in the
--    step's own transaction, with its count (1) and bytes. A purge has no
--    version, so the version is required for updates only.
ALTER TABLE public.system_events ADD COLUMN file_count integer
  CONSTRAINT system_events_file_count_range CHECK (file_count IS NULL OR file_count >= 0);
ALTER TABLE public.system_events ADD COLUMN byte_count bigint
  CONSTRAINT system_events_byte_count_range CHECK (byte_count IS NULL OR byte_count >= 0);
ALTER TABLE public.system_events DROP CONSTRAINT system_events_kind_known;
ALTER TABLE public.system_events ADD CONSTRAINT system_events_kind_known
  CHECK (kind IN ('update_installed', 'update_rolled_back',
                  'files_trashed', 'files_deleted', 'files_restored'));
ALTER TABLE public.system_events ALTER COLUMN version DROP NOT NULL;
-- Who changed files with no person: NULL for the command line, 'timer' for
-- the daily run (OCULUS_FILES_AUTO_PURGE=on), 'lease' for the trash put back
-- when the folder's lease was found moved. Only on the purge's kinds.
ALTER TABLE public.system_events ADD COLUMN source text
  CONSTRAINT system_events_source_known CHECK (source IS NULL
    OR (source IN ('timer', 'lease') AND actor_id IS NULL
        AND kind IN ('files_trashed', 'files_deleted', 'files_restored')));
ALTER TABLE public.system_events ADD CONSTRAINT system_events_shape
  CHECK (CASE WHEN kind IN ('update_installed', 'update_rolled_back')
              THEN version IS NOT NULL AND file_count IS NULL AND byte_count IS NULL
              ELSE version IS NULL AND from_version IS NULL
                AND file_count IS NOT NULL AND byte_count IS NOT NULL END);
