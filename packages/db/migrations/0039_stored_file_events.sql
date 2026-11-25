-- The second review of M-002 (D-086, amended): the files folder bound to
-- one install, a log of every attach and removal (which also keeps a
-- removed file's bytes for seven days), and the file name check covering
-- every format character. Numbered 0039, right after 0038 (stored_files).

-- core cleanFileName: no control (Cc), format character (every Cf of
-- Unicode 15.1, listed: PostgreSQL's regular expressions have no \p{Cf}),
-- line or paragraph separator, or path separator. Lone surrogates can't be
-- stored in UTF-8 text at all. The service's check (core) is the one that
-- decides; this backs it up. 0038's narrower check is replaced.
ALTER TABLE public.stored_files DROP CONSTRAINT stored_files_original_name_format;
ALTER TABLE public.stored_files ADD CONSTRAINT stored_files_original_name_format
  CHECK (char_length(original_name) BETWEEN 1 AND 255
    AND original_name !~ '[\x01-\x1f\x7f-\x9f\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f/\\]');

-- The files folder belongs to one install (D-086, review B1). Its ID is made
-- the first time the admin server starts with a files folder, kept here and
-- in a marker file in the folder's root; at every start the two must agree,
-- or the server refuses to start or to sweep, so two installs (or a staging
-- copy, or a test) sharing one folder can never delete each other's files.
-- One row, made once, never changed or removed.
CREATE TABLE public.file_store_binding (
  singleton boolean PRIMARY KEY DEFAULT true CONSTRAINT file_store_binding_one CHECK (singleton),
  store_id uuid NOT NULL CONSTRAINT file_store_binding_store_id_v4
    CHECK (store_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  bound_at timestamptz NOT NULL DEFAULT now()
);

-- What happened to files, append-only (like D-084's people_events):
--   placing   an attach is about to put a copy on disk (committed in its own
--             transaction before the copy is placed);
--   attached  the attach committed;
--   removed   the file was removed from its asset.
-- Nothing automatic ever deletes a stored copy (fourth review), and this
-- version has no purge (fifth review). A later, safe purge (S-043) reads
-- this log to free the space of content this database removed at least
-- seven days ago, or of a copy an attach placed but never committed, and
-- nothing else.
CREATE TABLE public.stored_file_events (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL CONSTRAINT stored_file_events_id_v4
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  kind text NOT NULL CONSTRAINT stored_file_events_kind CHECK (kind IN ('placing', 'attached', 'removed')),
  -- No foreign keys to the file or the record: a removed file's row is gone,
  -- and the log outlives both.
  file_id uuid NOT NULL,
  record_id uuid NOT NULL,
  sha256 text NOT NULL CONSTRAINT stored_file_events_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CONSTRAINT stored_file_events_byte_size_range
    CHECK (byte_size >= 1 AND byte_size <= 1099511627776),
  actor text NOT NULL CONSTRAINT stored_file_events_actor_format
    CHECK (actor ~ '^(user:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|system:[a-z][a-z0-9_-]{0,63})$'),
  -- The database's clock, never the caller's.
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX stored_file_events_content
  ON public.stored_file_events (organization_id, sha256, occurred_at);
CREATE INDEX stored_file_events_record
  ON public.stored_file_events (organization_id, record_id, occurred_at);

-- Both tables only grow: no UPDATE, DELETE or TRUNCATE for any role that
-- can't disable triggers; occurred_at is stamped now whatever the INSERT says.
CREATE FUNCTION public.stored_files_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% only grows.', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation',
          CONSTRAINT = TG_TABLE_NAME || '_append_only';
END
$$;

CREATE FUNCTION public.stored_file_events_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.occurred_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER stored_file_events_stamp BEFORE INSERT ON public.stored_file_events
  FOR EACH ROW EXECUTE FUNCTION public.stored_file_events_stamp();
CREATE TRIGGER stored_file_events_append_only BEFORE UPDATE OR DELETE ON public.stored_file_events
  FOR EACH ROW EXECUTE FUNCTION public.stored_files_append_only();
CREATE TRIGGER stored_file_events_no_truncate BEFORE TRUNCATE ON public.stored_file_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.stored_files_append_only();
CREATE TRIGGER file_store_binding_append_only BEFORE UPDATE OR DELETE ON public.file_store_binding
  FOR EACH ROW EXECUTE FUNCTION public.stored_files_append_only();
CREATE TRIGGER file_store_binding_no_truncate BEFORE TRUNCATE ON public.file_store_binding
  FOR EACH STATEMENT EXECUTE FUNCTION public.stored_files_append_only();

ALTER TABLE public.stored_file_events ENABLE ALWAYS TRIGGER stored_file_events_stamp;
ALTER TABLE public.stored_file_events ENABLE ALWAYS TRIGGER stored_file_events_append_only;
ALTER TABLE public.stored_file_events ENABLE ALWAYS TRIGGER stored_file_events_no_truncate;
ALTER TABLE public.file_store_binding ENABLE ALWAYS TRIGGER file_store_binding_append_only;
ALTER TABLE public.file_store_binding ENABLE ALWAYS TRIGGER file_store_binding_no_truncate;

-- The files folder's lease (fourth review): an epoch, a random ID that the
-- marker file in the folder and this table must share. The admin server
-- moves it to a new value at every start and every hour, and the purge at
-- every run (here first, then in the marker); a second database using the
-- same folder (a copy, a restored dump, a clone) then finds the two apart at
-- its next start or purge and is refused the purge. The latest row is the
-- current epoch. An adopt row (npm run files:adopt) also records `since`:
-- the purge treats every file event older than it as unknown.
CREATE TABLE public.file_store_epochs (
  epoch uuid PRIMARY KEY CONSTRAINT file_store_epochs_epoch_v4
    CHECK (epoch::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  kind text NOT NULL CONSTRAINT file_store_epochs_kind CHECK (kind IN ('bind', 'renew', 'adopt')),
  database_identity text NOT NULL CONSTRAINT file_store_epochs_identity_format
    CHECK (database_identity ~ '^[0-9A-Za-z_.:-]{1,100}$'),
  -- The database's clock, never the caller's.
  made_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX file_store_epochs_made_at ON public.file_store_epochs (made_at);

CREATE FUNCTION public.file_store_epochs_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.made_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER file_store_epochs_stamp BEFORE INSERT ON public.file_store_epochs
  FOR EACH ROW EXECUTE FUNCTION public.file_store_epochs_stamp();
CREATE TRIGGER file_store_epochs_append_only BEFORE UPDATE OR DELETE ON public.file_store_epochs
  FOR EACH ROW EXECUTE FUNCTION public.stored_files_append_only();
CREATE TRIGGER file_store_epochs_no_truncate BEFORE TRUNCATE ON public.file_store_epochs
  FOR EACH STATEMENT EXECUTE FUNCTION public.stored_files_append_only();

ALTER TABLE public.file_store_epochs ENABLE ALWAYS TRIGGER file_store_epochs_stamp;
ALTER TABLE public.file_store_epochs ENABLE ALWAYS TRIGGER file_store_epochs_append_only;
ALTER TABLE public.file_store_epochs ENABLE ALWAYS TRIGGER file_store_epochs_no_truncate;
