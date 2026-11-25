-- Public EAD exports (T-059b, D-120). Numbered 0067: above main's 0058 and every
-- number other chats hold on the work board (up to 0066, 2026-11-25 17:45 CT).
--
-- A finding aid's "Download EAD" on a public host needs the archival units
-- below a unit, and the public reader (D-080) can read no table. This
-- function gives it the units' IDs and places in the tree only (no title,
-- no value): the top unit and every archival unit below it that is public
-- on the site asked about and its own home site there, reached only through
-- units that are themselves such units, so nothing below an unpublished,
-- held-back or other site's unit is even counted. Each unit's values are
-- then read one by one through public_record_snapshot, with every check a
-- public record read makes (readPublicFindingAid in workflow.ts).
--
-- NULL unless the top unit is an archival unit public on the site (as
-- public_record_snapshot answers for a record it won't show), and
-- {"tooMany": true} past 1,000 units, so a public request can't make the
-- server walk a huge tree. SECURITY DEFINER with search_path pinned and
-- every name qualified, as 0017's functions; EXECUTE stays PUBLIC's (0017's
-- reasons).
CREATE FUNCTION public.public_finding_aid_units(p_org uuid, p_site uuid, p_root uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH RECURSIVE
  tree(id, parent_id, level, depth) AS (
    SELECT r.id, NULL::uuid, r.level, 0
    FROM public.records r
    WHERE r.organization_id = p_org AND r.id = p_root
      AND r.kind = 'archival_unit' AND r.site_id = p_site
      AND public.record_public_on_site(r, p_site)
    UNION ALL
    SELECT c.id, c.parent_id, c.level, tree.depth + 1
    FROM tree
    JOIN public.records c ON c.organization_id = p_org AND c.parent_id = tree.id
    WHERE c.kind = 'archival_unit' AND c.site_id = p_site
      AND public.record_public_on_site(c, p_site)
      AND tree.depth < 64
  ),
  limited AS (SELECT * FROM tree LIMIT 1001)
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM limited) THEN NULL
    WHEN (SELECT count(*) FROM limited) > 1000 THEN jsonb_build_object('tooMany', true)
    ELSE jsonb_build_object('units', (
      SELECT jsonb_agg(jsonb_build_object('id', l.id::text, 'parentId', l.parent_id::text,
                                          'level', l.level) ORDER BY l.depth, l.id)
      FROM limited l))
  END
$$;
