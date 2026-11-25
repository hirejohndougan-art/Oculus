-- Stored files (M-002, D-086): one row per file attached to a digital asset.
-- Numbered 0022: 0020 and 0021 are T-048's and T-040's branches (renumber
-- at merge if they move).
--
-- The bytes live on disk under OCULUS_FILES_DIR, named by their SHA-256 and
-- the organization only (service file-store.ts): one copy per organization
-- and content, however many assets it is attached to. This table says which
-- asset holds which content, its size, the media type sniffed from its
-- bytes (core files.ts, never the browser's claim), the type the client
-- claimed (a hint, may be NULL), the file's original name (metadata only,
-- never part of a path), who attached it and when.
--
-- Separation (D-019, D-060): keyed (organization_id, id), the asset by a
-- composite foreign key to its own organization's records, so no row points
-- across organizations. The writer may INSERT and DELETE (removing a file
-- from its asset); rows never change (stored_files_fixed). An asset holding
-- files can't be deleted (the service answers has_files; the foreign key
-- refuses too, ON DELETE NO ACTION).
CREATE TABLE public.stored_files (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL CONSTRAINT stored_files_id_v4
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  record_id uuid NOT NULL,
  sha256 text NOT NULL CONSTRAINT stored_files_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- At most 1 TiB; the configured caps are far lower (D-086).
  byte_size bigint NOT NULL CONSTRAINT stored_files_byte_size_range
    CHECK (byte_size >= 1 AND byte_size <= 1099511627776),
  media_type text NOT NULL CONSTRAINT stored_files_media_type_format
    CHECK (media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'),
  claimed_type text CONSTRAINT stored_files_claimed_type_format
    CHECK (claimed_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'),
  -- core cleanFileName: 1 to 255 code points, no control or bidirectional
  -- formatting characters, no path separator.
  original_name text NOT NULL CONSTRAINT stored_files_original_name_format
    CHECK (char_length(original_name) BETWEEN 1 AND 255
      AND original_name !~ '[\x01-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb/\\]'),
  created_by text NOT NULL CONSTRAINT stored_files_created_by_format
    CHECK (created_by ~ '^(user:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|system:[a-z][a-z0-9_-]{0,63})$'),
  created_at timestamptz NOT NULL CONSTRAINT stored_files_created_at_ms
    CHECK (date_trunc('milliseconds', created_at) = created_at),
  PRIMARY KEY (organization_id, id),
  -- The same content attached twice to one asset is one row.
  CONSTRAINT stored_files_once_per_record UNIQUE (organization_id, record_id, sha256),
  CONSTRAINT stored_files_record FOREIGN KEY (organization_id, record_id)
    REFERENCES public.records (organization_id, id)
);

-- De-duplication and the organization's total (one copy per content).
CREATE INDEX stored_files_content ON public.stored_files (organization_id, sha256);

-- Checked for every writer, in replica mode too:
--   stored_files_asset_only   the record is a digital asset
--   stored_files_same_size    one content (hash) has one size in an organization
CREATE FUNCTION public.stored_files_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.records r
    WHERE r.organization_id = NEW.organization_id AND r.id = NEW.record_id
      AND r.kind = 'digital_asset'
  ) THEN
    RAISE EXCEPTION 'Files are attached to digital assets only.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'stored_files_asset_only';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.stored_files f
    WHERE f.organization_id = NEW.organization_id AND f.sha256 = NEW.sha256
      AND f.byte_size <> NEW.byte_size
  ) THEN
    RAISE EXCEPTION 'One content has one size.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'stored_files_same_size';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER stored_files_check_new BEFORE INSERT ON public.stored_files
  FOR EACH ROW EXECUTE FUNCTION public.stored_files_check_new();

-- Rows never change: the writer has no UPDATE, and this stops any role that
-- can't disable triggers.
CREATE FUNCTION public.stored_files_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'A stored file''s row never changes.'
    USING ERRCODE = 'integrity_constraint_violation',
          CONSTRAINT = 'stored_files_fixed';
END
$$;

CREATE TRIGGER stored_files_fixed BEFORE UPDATE ON public.stored_files
  FOR EACH ROW EXECUTE FUNCTION public.stored_files_fixed();

-- Every guard trigger fires in replica mode too (D-067, 0008 part 4).
ALTER TABLE public.stored_files ENABLE ALWAYS TRIGGER stored_files_check_new;
ALTER TABLE public.stored_files ENABLE ALWAYS TRIGGER stored_files_fixed;
