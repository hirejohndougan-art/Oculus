-- The catalog's first tables (T-025, D-060): organizations, their templates and
-- record types (stored as validated JSON, one row per version) and their
-- records.
--
-- Complete separation (D-019, D-030): every table but organizations carries
-- organization_id, and every key another row can point at includes it. So
-- every foreign key between catalog rows names the organization on both
-- sides, and a record can't follow, be filed under or represent anything of
-- another organization, whatever the application sends.
--
-- These checks back up the rules packages/core enforces (records.ts,
-- templates.ts, record-types.ts, organizations.ts); each is implied by them,
-- so nothing core accepts is refused here. What SQL can't see is the service
-- layer's job (T-032), with core's checks: cycles in the arrangement
-- (a unit filed under its own descendant), a parent that is an archival unit
-- at a higher level, a record type of the record's kind, a template that
-- applies to the record's kind, and the fields themselves against the
-- template. That includes links to other records inside fields (record_link
-- values): JSON has no foreign key, so checking that a link names a record of
-- the same organization, and refusing to delete a record others link to, are
-- the service layer's too.
--
-- Nothing here cascades: deleting a row that another row points at through a
-- column (a parent, a represented record, a template, a record type) is
-- refused.
--
-- What identifies a row never changes (catalog_keep_identity, at the end; its
-- triggers are named zzzz_* so they fire after any other BEFORE UPDATE trigger,
-- which fire in name order, and nothing can change a row after the check): no
-- UPDATE by a role that does not own the tables (T-029) can move a row to another organization or give it another ID, key or
-- version number, even a row nothing points at.

-- One organization in the install. The ID is a random version 4 UUID that
-- never changes; the name can.
CREATE TABLE public.organizations (
  id uuid PRIMARY KEY
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  name text NOT NULL
    CHECK (name <> '' AND length(name) <= 200 AND btrim(name) = name
           AND name !~ '[\t\n\r  ]'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A template's identity: its key, unique within its organization only (two
-- organizations can both have "dacs-archival-unit"). Records and record types
-- point here. The template itself is in template_versions.
CREATE TABLE public.templates (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  key text NOT NULL
    CHECK (key ~ '^[a-z][a-z0-9_-]{0,63}$' AND key NOT IN ('constructor', 'prototype', '__proto__')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);

-- Every version of a template, as the JSON validateTemplate accepted. The
-- highest version is the current one; records follow the current version and
-- never pin one (D-029). The JSON's own key and organizationId must be the
-- row's, so a stored template can't claim another organization.
CREATE TABLE public.template_versions (
  organization_id uuid NOT NULL,
  key text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  definition jsonb NOT NULL
    CHECK (jsonb_typeof(definition) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key, version),
  FOREIGN KEY (organization_id, key) REFERENCES public.templates (organization_id, key),
  CHECK (definition ->> 'key' IS NOT DISTINCT FROM key),
  CHECK (definition ->> 'organizationId' IS NOT DISTINCT FROM organization_id::text)
);

-- A record type's identity (D-037), like a template's.
CREATE TABLE public.record_types (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  key text NOT NULL
    CHECK (key ~ '^[a-z][a-z0-9_-]{0,63}$' AND key NOT IN ('constructor', 'prototype', '__proto__')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);

-- Every version of a record type, as the JSON validateRecordType accepted.
-- Its kind and default template are columns too, so the default template is a
-- foreign key to a template of the same organization. Whether that template
-- applies to the kind is in the template's JSON: core checks it.
CREATE TABLE public.record_type_versions (
  organization_id uuid NOT NULL,
  key text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  kind text NOT NULL
    CHECK (kind IN ('object', 'archival_unit', 'digital_asset', 'agent', 'place', 'event')),
  default_template_key text NOT NULL,
  definition jsonb NOT NULL
    CHECK (jsonb_typeof(definition) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key, version),
  FOREIGN KEY (organization_id, key) REFERENCES public.record_types (organization_id, key),
  FOREIGN KEY (organization_id, default_template_key)
    REFERENCES public.templates (organization_id, key),
  CHECK (definition ->> 'key' IS NOT DISTINCT FROM key),
  CHECK (definition ->> 'organizationId' IS NOT DISTINCT FROM organization_id::text),
  CHECK (definition ->> 'kind' IS NOT DISTINCT FROM kind),
  CHECK (definition ->> 'defaultTemplateKey' IS NOT DISTINCT FROM default_template_key)
);

-- Catalog records (records.ts). The columns every kind has, then the ones
-- only some kinds have, then the template-defined fields as JSONB.
CREATE TABLE public.records (
  -- Unique within its organization only: the key is (organization_id, id), so
  -- another organization holding the same ID is never refused and learns
  -- nothing about this one's IDs. The service layer makes the IDs (random
  -- version 4 UUIDs), never the person.
  id uuid NOT NULL
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  kind text NOT NULL
    CHECK (kind IN ('object', 'archival_unit', 'digital_asset', 'agent', 'place', 'event')),
  -- Every stored record names its template (D-029); a record type is optional.
  template_key text NOT NULL,
  record_type_key text,
  title text NOT NULL
    CHECK (title <> '' AND length(title) <= 1000 AND btrim(title) = title
           AND title !~ '[\t\n\r  ]'),
  -- archival_unit only: its level, and the unit it is filed under.
  level text CHECK (level IN ('fonds', 'series', 'collection', 'file', 'item')),
  parent_id uuid,
  -- digital_asset only: the file's media type, and the record it is a scan or recording of.
  media_type text
    CHECK (media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'),
  represents_id uuid,
  -- agent only.
  agent_type text CHECK (agent_type IN ('person', 'organization', 'family')),
  -- place only, optional: a WGS 84 position in decimal degrees.
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  fields jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(fields) = 'object'),
  -- Whole milliseconds, as core writes them (2026-11-20T16:05:00.000Z). Read in
  -- UTC, so the check doesn't depend on the session's time zone.
  created_at timestamptz NOT NULL
    CHECK (date_trunc('milliseconds', created_at AT TIME ZONE 'UTC') = created_at AT TIME ZONE 'UTC'),
  updated_at timestamptz NOT NULL
    CHECK (date_trunc('milliseconds', updated_at AT TIME ZONE 'UTC') = updated_at AT TIME ZONE 'UTC'),
  CHECK (updated_at >= created_at),

  -- Also the target of the composite foreign keys below.
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, template_key) REFERENCES public.templates (organization_id, key),
  FOREIGN KEY (organization_id, record_type_key)
    REFERENCES public.record_types (organization_id, key),
  -- A parent or represented record must be of the same organization.
  FOREIGN KEY (organization_id, parent_id) REFERENCES public.records (organization_id, id),
  FOREIGN KEY (organization_id, represents_id) REFERENCES public.records (organization_id, id),
  CONSTRAINT records_not_own_parent CHECK (parent_id <> id),
  CONSTRAINT records_not_own_representation CHECK (represents_id <> id),

  -- Each kind has exactly its own columns.
  CHECK ((kind = 'archival_unit') = (level IS NOT NULL)),
  CHECK (kind = 'archival_unit' OR parent_id IS NULL),
  CHECK ((kind = 'digital_asset') = (media_type IS NOT NULL)),
  CHECK (kind = 'digital_asset' OR represents_id IS NULL),
  CHECK ((kind = 'agent') = (agent_type IS NOT NULL)),
  CHECK (kind = 'place' OR latitude IS NULL),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);

-- The service layer always reads one organization's records; children of a
-- unit are listed when browsing the arrangement.
CREATE INDEX records_organization_kind ON public.records (organization_id, kind);
CREATE INDEX records_parent ON public.records (organization_id, parent_id)
  WHERE parent_id IS NOT NULL;
CREATE INDEX records_represents ON public.records (organization_id, represents_id)
  WHERE represents_id IS NOT NULL;

-- What identifies a row can't be changed by UPDATE: its organization, and its
-- ID, key or version number. The trigger's arguments name those columns. A
-- foreign key alone would let a row nothing points at (a lone record, a
-- template version) move to another organization (D-019). Raised as
-- SQLSTATE 23000 with the constraint named <table>_<column>_fixed.
CREATE FUNCTION public.catalog_keep_identity() RETURNS trigger
LANGUAGE plpgsql
-- A fixed search path, so no function or operator a role creates elsewhere
-- (for example an exact-type to_jsonb overload) can replace the checks.
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  column_name text;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    IF to_jsonb(NEW) -> column_name IS DISTINCT FROM to_jsonb(OLD) -> column_name THEN
      RAISE EXCEPTION '%.% identifies the row and can''t be changed.', TG_TABLE_NAME, column_name
        USING ERRCODE = 'integrity_constraint_violation',
              CONSTRAINT = TG_TABLE_NAME || '_' || column_name || '_fixed';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER zzzz_organizations_keep_identity BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('id');
CREATE TRIGGER zzzz_templates_keep_identity BEFORE UPDATE ON public.templates
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'key');
CREATE TRIGGER zzzz_template_versions_keep_identity BEFORE UPDATE ON public.template_versions
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'key', 'version');
CREATE TRIGGER zzzz_record_types_keep_identity BEFORE UPDATE ON public.record_types
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'key');
CREATE TRIGGER zzzz_record_type_versions_keep_identity BEFORE UPDATE ON public.record_type_versions
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'key', 'version');
CREATE TRIGGER zzzz_records_keep_identity BEFORE UPDATE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'id');
