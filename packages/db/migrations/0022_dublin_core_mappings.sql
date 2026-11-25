-- Stored Dublin Core mappings (T-050b, D-096). Numbered 0022, the next
-- above main when it merged (the work board's rule): the numbers reserved
-- for M-002, T-034d and T-041c move above it.
--
-- D-012 keeps a template's Dublin Core mapping beside the template, not
-- inside it: `{ template, organizationId, entries: [{ field, term }] }`, the
-- JSON core's validateDublinCoreMapping accepted. One current mapping per
-- template, with a version that counts changes (an edit says which version
-- it started from). Core checks the mapping against the record's current
-- template at every read (a field since made staff-only refuses the output),
-- so nothing here has to follow template changes.
--
-- The public reader (D-080) can read no table. public_dublin_core_mapping
-- gives it one record's mapping only when that record is public on the site
-- asked about, exactly as public_record_snapshot gives its rows, so the
-- reader learns nothing about records it can't show. EXECUTE stays PUBLIC's,
-- as for every function here (0017's reasons).

CREATE TABLE public.dublin_core_mappings (
  organization_id uuid NOT NULL,
  template_key text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  mapping jsonb NOT NULL
    CHECK (jsonb_typeof(mapping) = 'object'),
  changed_by uuid NOT NULL REFERENCES public.users (id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, template_key),
  FOREIGN KEY (organization_id, template_key) REFERENCES public.templates (organization_id, key),
  CHECK (mapping ->> 'template' IS NOT DISTINCT FROM template_key),
  CHECK (mapping ->> 'organizationId' IS NOT DISTINCT FROM organization_id::text)
);

CREATE TRIGGER zzzz_dublin_core_mappings_keep_identity BEFORE UPDATE ON public.dublin_core_mappings
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'template_key');
ALTER TABLE public.dublin_core_mappings
  ENABLE ALWAYS TRIGGER zzzz_dublin_core_mappings_keep_identity;

-- Every change is the next version, so an edit's version check can't miss
-- one (even by direct SQL as the writer).
CREATE FUNCTION public.dublin_core_mappings_next_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'A mapping change is the next version.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'dublin_core_mappings_next_version';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dublin_core_mappings_next_version BEFORE UPDATE ON public.dublin_core_mappings
  FOR EACH ROW EXECUTE FUNCTION public.dublin_core_mappings_next_version();
ALTER TABLE public.dublin_core_mappings ENABLE ALWAYS TRIGGER dublin_core_mappings_next_version;

-- The stored mapping of record p_record's template, or NULL unless the
-- record is public on site p_site (record_public_on_site, 0017) or its
-- template has no stored mapping.
CREATE FUNCTION public.public_dublin_core_mapping(p_org uuid, p_site uuid, p_record uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.mapping
  FROM public.records r
  JOIN public.dublin_core_mappings m
    ON m.organization_id = r.organization_id AND m.template_key = r.template_key
  WHERE r.organization_id = p_org AND r.id = p_record
    AND public.record_public_on_site(r, p_site)
$$;
