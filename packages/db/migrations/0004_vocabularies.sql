-- Vocabularies and terms (T-027, D-062): each organization's stored terms
-- (its local terms and the authority terms it has saved), and an index of
-- which records use which terms, so staff Subjects counts and Data Cleaning are
-- worked out from the index, never by reading every record's fields.
--
-- A term is identified by its term key, worked out by packages/db from core's
-- rules before writing and checked again after reading (vocabularies.ts): a
-- term with a URI by its vocabulary and termUriKey(uri), any other by its
-- vocabulary (no vocabulary and `local` are the same, D-014) and its exact
-- label. The key is stored as the SHA-256 of that text, in hex, so it always
-- fits in a btree index whatever the URI or label holds. The database can't
-- work it out itself: termUriKey parses the URI as a WHATWG URL.
--
-- The index is the data-access layer's, not a trigger's (D-062): which
-- fields of a record hold terms is in its template's JSON, and the key needs
-- core. refreshRecordTerms rebuilds one record's usages from the record and
-- its template as stored, and record_term_index keeps what it was built from
-- (the template version and a digest of the fields), so a record changed
-- without a refresh can be found and refreshed.
--
-- Complete separation (D-019, D-030): every table has organization_id, every
-- key includes it and every foreign key names it on both sides. Two
-- organizations can store the same term, and their records' usages are
-- counted apart. Identity is fixed by catalog_keep_identity (0002), with
-- triggers named zzzz_* as there. Nothing cascades: a record whose usages are
-- indexed can't be deleted until they are cleared.

-- An organization's stored term: a local term (no vocabulary, or `local`, and
-- no URI) or an authority term it saved (vocabulary, optional URI, label).
-- The ID is a random version 4 UUID that never changes; the term can (a local
-- term renamed), and its key with it.
CREATE TABLE public.terms (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  vocabulary text
    CHECK (vocabulary IN ('lcsh', 'lcnaf', 'lcgft', 'nomenclature', 'gnis', 'local')),
  uri text CHECK (uri <> '' AND length(uri) <= 2000),
  label text NOT NULL
    CHECK (label <> '' AND length(label) <= 500 AND btrim(label) = label
           AND label !~ '[\t\n\r  ]'),
  term_key text NOT NULL CHECK (term_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  -- One stored copy of a term per organization.
  CONSTRAINT terms_one_per_key UNIQUE (organization_id, term_key),
  -- Local terms have no URI, and a URI needs its vocabulary (D-014).
  CONSTRAINT terms_local_without_uri
    CHECK (uri IS NULL OR (vocabulary IS NOT NULL AND vocabulary <> 'local'))
);

-- What a record's usage index was built from. A record whose fields or
-- template changed since (or that has no row) needs refreshRecordTerms.
CREATE TABLE public.record_term_index (
  organization_id uuid NOT NULL,
  record_id uuid NOT NULL,
  template_key text NOT NULL,
  template_version integer NOT NULL,
  -- md5 of the record's fields as jsonb text, as refreshRecordTerms read them.
  -- A change detector, not a security check.
  fields_digest text NOT NULL CHECK (fields_digest ~ '^[0-9a-f]{32}$'),
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, record_id),
  FOREIGN KEY (organization_id, record_id) REFERENCES public.records (organization_id, id),
  FOREIGN KEY (organization_id, template_key, template_version)
    REFERENCES public.template_versions (organization_id, key, version)
);

-- One term one record uses in one field: the field's key, the field's
-- visibility in the template version the index was built from, the term's
-- key, and the term as the record holds it (its first value with that key in
-- the field). Staff-only data: the label can come from a staff field or an
-- unpublished record, so the counts never show it (D-062). Public counts must
-- use only usages whose visibility is 'public', and only of published records
-- (the service and public layers, T-034 and T-050).
CREATE TABLE public.record_terms (
  organization_id uuid NOT NULL,
  record_id uuid NOT NULL,
  field_key text NOT NULL CHECK (field_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  visibility text NOT NULL CHECK (visibility IN ('public', 'staff')),
  term_key text NOT NULL CHECK (term_key ~ '^[0-9a-f]{64}$'),
  vocabulary text
    CHECK (vocabulary IN ('lcsh', 'lcnaf', 'lcgft', 'nomenclature', 'gnis', 'local')),
  uri text CHECK (uri <> '' AND length(uri) <= 2000),
  label text NOT NULL
    CHECK (label <> '' AND length(label) <= 500 AND btrim(label) = label
           AND label !~ '[\t\n\r  ]'),
  PRIMARY KEY (organization_id, record_id, field_key, term_key),
  -- Usages exist only beside the index row that says what they were built from.
  FOREIGN KEY (organization_id, record_id)
    REFERENCES public.record_term_index (organization_id, record_id),
  CONSTRAINT record_terms_local_without_uri
    CHECK (uri IS NULL OR (vocabulary IS NOT NULL AND vocabulary <> 'local'))
);

-- Counts per term, and the records using one term, in one organization.
CREATE INDEX record_terms_by_term ON public.record_terms (organization_id, term_key, record_id);

CREATE TRIGGER zzzz_terms_keep_identity BEFORE UPDATE ON public.terms
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'id');
CREATE TRIGGER zzzz_record_term_index_keep_identity BEFORE UPDATE ON public.record_term_index
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'record_id');
CREATE TRIGGER zzzz_record_terms_keep_identity BEFORE UPDATE ON public.record_terms
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'record_id', 'field_key', 'term_key');
