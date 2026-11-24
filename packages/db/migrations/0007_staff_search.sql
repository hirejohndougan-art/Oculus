-- Staff search (T-028, D-066): full-text search over every record's title
-- and the text in its fields, ranked, accent-insensitive for Latin, Greek
-- and Cyrillic (Hebrew and Arabic vowel marks are kept); lookup by a current
-- or former identifier goes through identifier_holdings_lookup (0003) and
-- needs nothing here. public.rebuild_search_documents() rebuilds the stored
-- documents after a PostgreSQL major upgrade or a C library, ICU or locale
-- change (see it below).
--
-- ===========================================================================
-- STAFF ONLY. This index holds EVERY record's title and EVERY text value of
-- its fields: staff-only fields, unpublished and withdrawn records, donor
-- and accession notes included. A public search (Phase 4) must index only
-- the published public views of published records (publicOutput) in an index
-- of its own, and must NEVER read records.search_document, query it, rank
-- with it or use it to pick, count or order public results: a match on a
-- staff-only word would reveal that word. The public sites' read-only role
-- (D-034) must get no SELECT on public.records.
-- ===========================================================================
--
-- The document is a STORED generated column, so the database keeps it in
-- step with every insert and update of a record, by any writer, restores
-- included (D-065), and nobody can write it: a generated column can't be
-- set by INSERT or UPDATE. Identifier saves need no upkeep: identifier
-- lookup reads identifier_holdings, which the saves write.
--
-- Accent-insensitive matching (Latin, Greek and Cyrillic; see 2. below)
-- without the unaccent extension (which a host
-- may not let us install, D-035): public.search_fold, pure SQL from the
-- core server, folds the document and the query the same way:
--   1. NFKD (compatibility decomposition): accented letters split into base
--      letter + combining marks; full-width, ligature (ﬁ), superscript and
--      other compatibility forms become their plain letters and digits;
--   2. combining marks of the general diacritic blocks are removed
--      (U+0300-036F, 1AB0-1AFF, 1DC0-1DFF, 20D0-20FF, FE20-FE2F). Marks
--      of other scripts are kept: Hebrew points and Arabic vowel marks
--      (and Indic vowel signs), so vocalized and unvocalized Hebrew or
--      Arabic text do NOT match each other. Accent-insensitive means
--      Latin, Greek and Cyrillic here;
--   3. letters NFKD doesn't split are spelled out (ß ẞ -> ss, Æ æ -> ae,
--      Œ œ -> oe, Þ þ -> th, Ø ø -> o, Ł ł -> l, Đ đ Ð ð -> d, Ħ ħ -> h,
--      Ŧ ŧ -> t, dotless ı -> i);
--   4. Greek and Cyrillic capitals are lowered by a fixed table (final ς
--      becomes σ), and then lower(): so Latin, Greek and Cyrillic fold the
--      same on every server; other scripts' case follows the database's
--      locale, the same way for the document and the query.
-- The 'simple' configuration then splits words and lowercases them, with
-- no stemming and no stop words (records are in many languages).
--
-- The database must be UTF-8 (normalize() works only there); this file
-- refuses to run on another encoding rather than leave every record write
-- failing.
--
-- Bounded so a record core accepts (up to 1,000,000 characters of text) can
-- always be stored: a tsvector is limited to 1 MB, so only the first 100,000
-- characters of a record's field text (folded) are indexed, and the first
-- 2,000 of its title (core allows 1,000). Words over 2,047 bytes are
-- skipped by PostgreSQL itself.
--
-- Changing search_fold or record_search_document later is a migration that
-- replaces them and then calls public.rebuild_search_documents() (below), so
-- every stored document is rebuilt with the new rule: an edited function
-- alone would leave old documents folded the old way. The same call rebuilds
-- the documents after a PostgreSQL major upgrade or a C library, ICU or
-- locale change (see the function).

DO $$
BEGIN
  IF pg_catalog.getdatabaseencoding() <> 'UTF8' THEN
    RAISE EXCEPTION 'Oculus needs a UTF-8 database (this one is %): search folds text with normalize(), which works only in UTF-8.',
        pg_catalog.getdatabaseencoding();
  END IF;
END
$$;

-- The fold above. IMMUTABLE so the generated column may use it; a fixed
-- search path, so no function or operator created elsewhere can stand in.
CREATE FUNCTION public.search_fold(t text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT lower(translate(
    replace(replace(replace(replace(replace(replace(replace(replace(
      regexp_replace(normalize(t, NFKD),
                     '[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]+', '', 'g'),
      'ß', 'ss'), 'ẞ', 'ss'), 'Æ', 'ae'), 'æ', 'ae'), 'Œ', 'oe'), 'œ', 'oe'), 'Þ', 'th'), 'þ', 'th'),
    'ØøŁłĐđÐðĦħŦŧıΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩςЀЁЂЃЄЅІЇЈЉЊЋЌЍЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',
    'oollddddhhttiαβγδεζηθικλμνξοπρστυφχψωσѐёђѓєѕіїјљњћќѝўџабвгдежзийклмнопрстуфхцчшщъыьэюя'))
$$;

-- A record's search document: its title (weight A, ranked highest) and
-- every string anywhere in its fields, in a fixed order (weight C): plain
-- text, term labels, identifier values, dates as typed, link labels and
-- URIs. Object keys are not indexed. Every field is included, staff-only
-- ones too: see STAFF ONLY above.
CREATE FUNCTION public.record_search_document(title text, fields jsonb) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT setweight(to_tsvector('pg_catalog.simple'::regconfig,
                     left(coalesce(public.search_fold(left(title, 2000)), ''), 2000)), 'A')
      || setweight(to_tsvector('pg_catalog.simple'::regconfig,
                     left(coalesce(public.search_fold(left((
                       SELECT string_agg(s.value #>> '{}', ' ' ORDER BY s.n)
                       FROM jsonb_path_query(fields, 'strict $.** ? (@.type() == "string")')
                            WITH ORDINALITY AS s(value, n)), 100000)), ''), 100000)), 'C')
$$;

-- Rebuilds every stored search document and the index, by dropping and
-- re-adding the column: the only way to recompute a stored generated column
-- without an UPDATE of every record (which the version triggers of 0005
-- refuse, since every record write needs a version of its own, and which
-- would be a false edit in every record's history). The table is rewritten
-- under an ACCESS EXCLUSIVE lock, so no record can be read or written until
-- it commits; record versions, record_versions and every other column are
-- untouched, and no row trigger fires. Only the owner of public.records (the
-- role migrations run as) can run it: it runs with the caller's rights, and
-- for anyone else DROP INDEX fails ("must be owner") and nothing changes.
-- EXECUTE is left to PUBLIC like the other functions here, since a REVOKE
-- would stop a backup restoring with --no-privileges (D-064).
--
-- Run it, as that role, in a quiet moment:
--   * after a PostgreSQL major upgrade by pg_upgrade (normalize() follows the
--     server's Unicode tables, which a new major version may update);
--   * after the operating system's C library, ICU or the database's locale
--     changes (lower() of letters outside Latin, Greek and Cyrillic follows
--     the locale);
--   * in any later migration that changes search_fold or
--     record_search_document (CREATE OR REPLACE, then call this; an edited
--     IMMUTABLE function alone leaves old documents folded the old way).
-- A restore from a backup (D-064) needs nothing: generated columns are not
-- dumped, and are computed afresh as the rows are restored.
--   psql "$OCULUS_DATABASE_URL" -c 'SELECT public.rebuild_search_documents()'
-- This migration builds the column with it too, so there is one definition.
CREATE FUNCTION public.rebuild_search_documents() RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  LOCK TABLE public.records IN ACCESS EXCLUSIVE MODE;
  -- Searched with @@ and the organization in the same WHERE (searchRecords,
  -- search.ts): the index is shared, the organization filter never optional.
  DROP INDEX IF EXISTS public.records_search;
  ALTER TABLE public.records DROP COLUMN IF EXISTS search_document;
  ALTER TABLE public.records
    ADD COLUMN search_document tsvector NOT NULL
      GENERATED ALWAYS AS (public.record_search_document(title, fields)) STORED;
  CREATE INDEX records_search ON public.records USING gin (search_document);
END
$$;

SELECT public.rebuild_search_documents();
