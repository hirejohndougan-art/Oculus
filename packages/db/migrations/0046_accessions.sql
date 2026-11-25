-- Accessions and donor contacts (T-018c, D-114; core: accessions.ts,
-- D-043 and D-056). Numbered 0046: 0044 and 0045 are reserved for Chat A's
-- S-040 and S-052 (the runner allows gaps).
--
-- STAFF ONLY. Accessions name donors, materials, restrictions and notes;
-- donor contacts hold people's email, phone and address. The public reader
-- (D-080) has no privilege on any table here. What the public output needs
-- of an accession is only whether it holds records back (its deed status,
-- its access restriction and which records it produced), and it gets that
-- only through public_record_snapshot (below), for records that function
-- already returns.
--
-- accessions: one row per accession, the core Accession as `definition`,
-- validated by core (indexAccessions) before every save. Its deed status,
-- access restriction and source agent are generated from `definition`, so
-- they can't disagree with it. `number_key` is identifierKey of its number,
-- unique in the organization (core checks the same). `version` goes up by
-- one on every update; who made and last changed it, and when, are stamped
-- here (the database's clock). Accessions are never deleted here.
--
-- accession_records: the records each accession produced, kept by a trigger
-- from definition.records (the writer has no privilege on it), with foreign
-- keys to records: a record an accession names can't be deleted.
--
-- accession_versions: every definition saved, with who and when, written by
-- a trigger (insert only), so the history can't be skipped.
--
-- donor_contacts: one DonorContact per agent record (core's
-- validateDonorContact), versioned the same way; the writer may DELETE one.
--
-- Every trigger here is ENABLE ALWAYS (D-067).

CREATE TABLE public.accessions (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  number_key text NOT NULL CHECK (length(number_key) BETWEEN 1 AND 1000),
  deed_status text GENERATED ALWAYS AS (definition ->> 'deedStatus') STORED,
  access_restriction jsonb GENERATED ALWAYS AS (definition -> 'accessRestriction') STORED,
  source_agent_id uuid GENERATED ALWAYS AS ((definition #>> '{sourceAgent,recordId}')::uuid) STORED,
  created_by uuid NOT NULL REFERENCES public.users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL REFERENCES public.users (id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT accessions_number_unique UNIQUE (organization_id, number_key),
  CONSTRAINT accessions_identity CHECK (
    definition ->> 'id' = id::text AND definition ->> 'organizationId' = organization_id::text),
  CONSTRAINT accessions_deed_status_known
    CHECK (deed_status IN ('missing', 'sent', 'signed', 'not_needed')),
  CONSTRAINT accessions_records_list CHECK (jsonb_typeof(definition -> 'records') = 'array'),
  FOREIGN KEY (organization_id, source_agent_id) REFERENCES public.records (organization_id, id)
);

CREATE INDEX accessions_source ON public.accessions (organization_id, source_agent_id);

CREATE TABLE public.accession_records (
  organization_id uuid NOT NULL,
  accession_id uuid NOT NULL,
  record_id uuid NOT NULL,
  PRIMARY KEY (organization_id, accession_id, record_id),
  FOREIGN KEY (organization_id, accession_id)
    REFERENCES public.accessions (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, record_id) REFERENCES public.records (organization_id, id)
);

CREATE INDEX accession_records_record ON public.accession_records (organization_id, record_id);

CREATE TABLE public.accession_versions (
  organization_id uuid NOT NULL,
  accession_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  definition jsonb NOT NULL,
  saved_by uuid NOT NULL REFERENCES public.users (id),
  saved_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, accession_id, version),
  FOREIGN KEY (organization_id, accession_id) REFERENCES public.accessions (organization_id, id)
);

CREATE TABLE public.donor_contacts (
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  updated_by uuid NOT NULL REFERENCES public.users (id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, agent_id),
  CONSTRAINT donor_contacts_identity CHECK (
    definition ->> 'agentId' = agent_id::text
    AND definition ->> 'organizationId' = organization_id::text),
  FOREIGN KEY (organization_id, agent_id) REFERENCES public.records (organization_id, id)
);

-- Identity never changes; the version goes up by exactly one; the creation
-- stamps stay; the change is stamped now.
CREATE FUNCTION public.accessions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'a new accession starts at version 1' USING ERRCODE = 'OC081';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    NEW.updated_by := NEW.created_by;
    RETURN NEW;
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.id <> OLD.id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an accession''s identity and creation never change' USING ERRCODE = 'OC082';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'an accession''s version goes up by one on every change' USING ERRCODE = 'OC083';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER accessions_guard BEFORE INSERT OR UPDATE ON public.accessions
  FOR EACH ROW EXECUTE FUNCTION public.accessions_guard();
ALTER TABLE public.accessions ENABLE ALWAYS TRIGGER accessions_guard;

-- The produced records and the history, from the saved row (as the owner:
-- the writer can't write either table itself).
CREATE FUNCTION public.accessions_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM public.accession_records
  WHERE organization_id = NEW.organization_id AND accession_id = NEW.id;
  INSERT INTO public.accession_records (organization_id, accession_id, record_id)
  SELECT DISTINCT NEW.organization_id, NEW.id, (link.value ->> 'recordId')::uuid
  FROM jsonb_array_elements(NEW.definition -> 'records') AS link(value);
  INSERT INTO public.accession_versions
    (organization_id, accession_id, version, definition, saved_by, saved_at)
  VALUES (NEW.organization_id, NEW.id, NEW.version, NEW.definition, NEW.updated_by,
          NEW.updated_at);
  RETURN NULL;
END
$$;

CREATE TRIGGER accessions_after AFTER INSERT OR UPDATE ON public.accessions
  FOR EACH ROW EXECUTE FUNCTION public.accessions_after();
ALTER TABLE public.accessions ENABLE ALWAYS TRIGGER accessions_after;

CREATE FUNCTION public.donor_contacts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'a new donor contact starts at version 1' USING ERRCODE = 'OC081';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.agent_id <> OLD.agent_id THEN
    RAISE EXCEPTION 'a donor contact''s agent never changes' USING ERRCODE = 'OC082';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a donor contact''s version goes up by one on every change' USING ERRCODE = 'OC083';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER donor_contacts_guard BEFORE INSERT OR UPDATE ON public.donor_contacts
  FOR EACH ROW EXECUTE FUNCTION public.donor_contacts_guard();
ALTER TABLE public.donor_contacts ENABLE ALWAYS TRIGGER donor_contacts_guard;

-- What the public output needs of accessions, for records the snapshot
-- already returns: per accession that produced any of `p_records`, its deed
-- status, its access restriction and which of `p_records` it produced.
-- Never a number, source, materials, restriction text or note. Not SECURITY
-- DEFINER: run by the public reader itself it reads tables it has no
-- privilege on and fails; public_record_snapshot (as the owner) calls it.
CREATE FUNCTION public.accession_holds_of(p_org uuid, p_records uuid[]) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'deedStatus', a.deed_status,
           'accessRestriction', a.access_restriction,
           'records', (SELECT jsonb_agg(ar.record_id::text ORDER BY ar.record_id)
                       FROM public.accession_records ar
                       WHERE ar.organization_id = a.organization_id
                         AND ar.accession_id = a.id
                         AND ar.record_id = ANY(p_records)))
         ORDER BY a.id), '[]'::jsonb)
  FROM public.accessions a
  WHERE a.organization_id = p_org
    AND EXISTS (SELECT 1 FROM public.accession_records ar
                WHERE ar.organization_id = a.organization_id AND ar.accession_id = a.id
                  AND ar.record_id = ANY(p_records))
$$;

-- 0017's public_record_snapshot with one more key, `accessionHolds`: the
-- holds of the accessions that produced any of the records it returns
-- (`wanted`), so the public output's deed and restriction check is the
-- publish check's (D-114). Everything else is unchanged.
CREATE OR REPLACE FUNCTION public.public_record_snapshot(p_org uuid, p_site uuid, p_record uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH RECURSIVE
  target AS (
    SELECT r.id FROM public.records r
    WHERE r.organization_id = p_org AND r.id = p_record
      AND public.record_public_on_site(r, p_site)
  ),
  chain(id) AS (
    SELECT id FROM target
    UNION
    SELECT n.id
    FROM chain
    JOIN public.records r ON r.organization_id = p_org AND r.id = chain.id
    CROSS JOIN LATERAL unnest(ARRAY[r.parent_id, r.represents_id]) AS n(id)
    WHERE n.id IS NOT NULL
  ),
  linked(id) AS (
    SELECT DISTINCT (item.value ->> 'recordId')::uuid
    FROM public.records r
    JOIN chain ON r.organization_id = p_org AND r.id = chain.id
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(r.fields) = 'object' THEN r.fields ELSE '{}'::jsonb END) AS f(key, value)
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(f.value) = 'array' THEN f.value ELSE jsonb_build_array(f.value) END
    ) AS item(value)
    WHERE jsonb_typeof(item.value) = 'object'
      AND jsonb_typeof(item.value -> 'recordId') = 'string'
      AND (item.value ->> 'recordId') ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  up(id) AS (
    SELECT id FROM linked
    UNION
    SELECT n.id
    FROM up
    JOIN public.records r ON r.organization_id = p_org AND r.id = up.id
    CROSS JOIN LATERAL unnest(ARRAY[r.parent_id, r.represents_id]) AS n(id)
    WHERE n.id IS NOT NULL
  ),
  wanted AS (
    SELECT r.*, r.id IN (SELECT id FROM chain) AS in_chain FROM public.records r
    WHERE r.organization_id = p_org
      AND (r.id IN (SELECT id FROM chain) OR r.id IN (SELECT id FROM up))
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM target) THEN NULL
    WHEN (SELECT count(*) FROM chain) > 10000 OR (SELECT count(*) FROM up) > 10000
      THEN jsonb_build_object('tooMany', true)
    ELSE jsonb_build_object(
      'records', (
        SELECT jsonb_agg(jsonb_build_object(
                 'id', w.id::text, 'organization_id', w.organization_id::text,
                 'site_id', w.site_id::text, 'kind', w.kind, 'template_key', w.template_key,
                 'record_type_key', w.record_type_key,
                 'title', CASE WHEN w.in_chain THEN w.title ELSE 'Linked record' END,
                 'level', w.level,
                 'parent_id', w.parent_id::text, 'media_type', w.media_type,
                 'represents_id', w.represents_id::text, 'agent_type', w.agent_type,
                 'latitude', CASE WHEN w.in_chain THEN w.latitude END,
                 'longitude', CASE WHEN w.in_chain THEN w.longitude END,
                 'fields', CASE WHEN w.in_chain THEN w.fields ELSE '{}'::jsonb END,
                 'created_at',
                 to_char(w.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'updated_at',
                 to_char(w.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
               ORDER BY w.id)
        FROM wanted w),
      'public', (
        SELECT jsonb_agg(r.id::text ORDER BY r.id) FROM public.records r
        WHERE r.organization_id = p_org AND r.id IN (SELECT w.id FROM wanted w)
          AND public.record_public_on_site(r, p_site)),
      'templates', (
        SELECT jsonb_agg(jsonb_build_object('key', t.key, 'version', t.version,
                                            'definition', t.definition) ORDER BY t.key)
        FROM (SELECT DISTINCT ON (v.key) v.key, v.version, v.definition
              FROM public.template_versions v
              WHERE v.organization_id = p_org
                AND v.key IN (SELECT w.template_key FROM wanted w)
              ORDER BY v.key, v.version DESC) t),
      'identifierTypes', (
        SELECT jsonb_agg(jsonb_build_object('key', t.key, 'definition', t.definition)
                         ORDER BY t.key)
        FROM public.identifier_types t WHERE t.organization_id = p_org),
      'identifiers', (
        SELECT jsonb_agg(jsonb_build_object(
                 'recordId', c.id::text,
                 'current', (
                   SELECT jsonb_agg(jsonb_build_object('type_key', i.type_key, 'value', i.value,
                                                       'key', i.key, 'is_primary', i.is_primary)
                                    ORDER BY i.position)
                   FROM public.record_identifiers i
                   WHERE i.organization_id = p_org AND i.record_id = c.id),
                 'former', (
                   SELECT jsonb_agg(jsonb_build_object(
                            'type_key', f.type_key, 'value', f.value, 'key', f.key,
                            'note', f.note, 'retired_at',
                            to_char(f.retired_at AT TIME ZONE 'UTC',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                          ORDER BY f.position)
                   FROM public.former_identifiers f
                   WHERE f.organization_id = p_org AND f.record_id = c.id))
               ORDER BY c.id)
        FROM chain c WHERE EXISTS (SELECT 1 FROM wanted w WHERE w.id = c.id)),
      'accessionHolds',
        public.accession_holds_of(p_org, ARRAY(SELECT w.id FROM wanted w)))
  END
$$;
