-- The records public on a site, for public counts (T-034d, D-095). Numbered
-- 0023: 0022 is M-002's (Chat A); renumbered at merge if needed.
--
-- Public Subjects counts (D-062) come from what is published, never from
-- the staff-only record_terms index. publicTermCounts
-- (packages/db/src/public-terms.ts) works them out from the public output
-- of each record public on the site, read through public_record_snapshot
-- (0017). The public reader role holds no table privilege, so it needs this
-- function to know which records those are. It returns IDs only, and only
-- of records public on the site by record_public_on_site, the one rule
-- 0017 put in place (T-041b adds records accepted into a site there, and
-- only there), so it tells a public site nothing a public site can't
-- already find by asking public_record_snapshot about every ID.
--
-- At most p_limit IDs (1 to 10,001) after p_after, in ID order, for reading
-- in pages; NULL p_after starts at the beginning. Anything else is refused.
-- EXECUTE stays granted to PUBLIC, as for every function here (see 0017).
CREATE FUNCTION public.public_site_record_ids(p_org uuid, p_site uuid, p_after uuid,
                                              p_limit integer)
RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_org IS NULL OR p_site IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 10001 THEN
    RAISE EXCEPTION 'public_site_record_ids: bad arguments' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT r.id FROM public.records r
    WHERE r.organization_id = p_org
      AND public.record_public_on_site(r, p_site)
      AND (p_after IS NULL OR r.id > p_after)
    ORDER BY r.id
    LIMIT p_limit;
END
$$;
