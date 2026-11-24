-- Public reads by site, through one function (S-019, D-080). Numbered 0017:
-- 0015 is T-039's password resets and 0016 S-018's known addresses.
--
-- The public output (readPublicRecord, packages/db/src/workflow.ts) used to
-- read the tables directly, so the public sites' connection needed SELECT on
-- every table (users' password hashes, sessions, sealed second factors and
-- every staff value included), and it never looked at a record's site. Now
-- it reads only through public_record_snapshot, which runs as the owner
-- (SECURITY DEFINER, search_path pinned, every name qualified) and returns
-- something only for a record public on the site asked for: exactly the rows
-- that record's public output is computed from (core then keeps only what is
-- public). The public reader role (roles.ts: grantPublicReaderRole,
-- checkPublicReaderConnection) holds no table privilege at all.
--
-- EXECUTE stays granted to PUBLIC, as for every function here: a revoke from
-- PUBLIC would be a revoke the backup module refuses to restore (D-064), and
-- what the function returns is no more than a public site may compute from.
-- Only trusted roles may connect at all (D-067).

-- Whether record r is public on site s. Today: published, and s is its home
-- site; a record on no site is never public. T-041b (offering items to other
-- sites, D-074) adds records accepted into s here, and only here.
CREATE FUNCTION public.record_public_on_site(r public.records, s uuid) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r.workflow_state = 'published' AND r.site_id IS NOT NULL AND r.site_id = s
$$;

-- Everything the public output of record p_record on site p_site needs, as
-- one jsonb value, or NULL unless the record is public on that site:
--   records          the record's ancestry and what it represents (the
--                    chain), and the records their values link to (with
--                    their ancestry), in the columns readRecordClosure
--                    reads, by ID. Rows outside the chain carry only what
--                    core reads of them (kind, place in the tree, template,
--                    state): their fields are {}, their title a fixed
--                    placeholder and their coordinates empty, so no staff
--                    value or unpublished title of a link target leaves.
--   public           which of those are public on p_site
--   templates        the current version of each of their templates
--   identifierTypes  the organization's identifier types
--   identifiers      the current and former numbers of the record's ancestry
-- or {"tooMany": true} when either closure has more than 10,000 records
-- (MAX_CLOSURE_RECORDS). Linked IDs are found as core's linkedIds finds them:
-- a field's value, or an item of a field's array, that is an object whose
-- recordId is a lower-case version 4 UUID.
CREATE FUNCTION public.public_record_snapshot(p_org uuid, p_site uuid, p_record uuid)
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
        FROM chain c WHERE EXISTS (SELECT 1 FROM wanted w WHERE w.id = c.id)))
  END
$$;
