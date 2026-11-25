-- Shared items on the public sites (T-041f, D-074, D-094, D-111). Numbered
-- 0036 (0031 to 0035 are reserved by other branches; the runner allows gaps).
--
-- An item accepted into a second site (record_shares, 0024) shows on that
-- site's public pages exactly as its home site shows it, with its home site
-- and organization named. shared_record_home answers, for a record ID asked
-- for on public site p_site of organization p_org, where its home is, and
-- only while all of these hold:
--   - a share of the record into (p_org, p_site) is accepted (offered,
--     declined, withdrawn and removed shares show nothing);
--   - the record is public on its own home site now (record_public_on_site,
--     0017: published, and on a site), so withdrawing it from publication,
--     or moving it onto no site, hides it at once on the second site too;
--   - the record isn't already the second site's own item (moved onto it,
--     D-094): then it is read as the site's own, or not at all.
-- Otherwise NULL, the same NULL for a record that doesn't exist, isn't
-- shared, is another site's, and for a site that isn't p_org's.
--
-- It returns names and IDs only, never a value of the record: the output
-- itself is read with public_record_snapshot (0017) for the home
-- organization and site, the very read the home site's public pages make,
-- so the second site shows nothing its home site's public doesn't.
--
-- record_public_on_site keeps its meaning (public on the record's own home
-- site). D-080's note said shared items would be added there; D-111 records
-- why not: that function also decides the second organization's snapshot
-- rows, its OAI-PMH lists (D-105) and its subject counts (D-095), and a
-- shared item belongs in neither feed of the second site (harvesters get it
-- from its home site, once, under one identifier).
--
-- SECURITY DEFINER, owned by the migrating owner, with a pinned search_path
-- and every name qualified ("Writing SECURITY DEFINER Functions Safely",
-- PostgreSQL 16), so the public reader, which can read no table (D-080),
-- can call it; PUBLIC_READER_FUNCTIONS in roles.ts lists it.
CREATE FUNCTION public.shared_record_home(p_org uuid, p_site uuid, p_record uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
           'organizationId', r.organization_id::text,
           'siteId', r.site_id::text,
           'organizationName', o.name,
           'siteName', st.name)
  FROM public.record_shares sh
  JOIN public.records r
    ON r.organization_id = sh.organization_id AND r.id = sh.record_id
  JOIN public.organizations o ON o.id = r.organization_id
  JOIN public.sites st ON st.organization_id = r.organization_id AND st.id = r.site_id
  WHERE sh.target_organization_id = p_org
    AND sh.target_site_id = p_site
    AND sh.record_id = p_record
    AND sh.state = 'accepted'
    AND public.record_public_on_site(r, r.site_id)
    AND NOT (r.organization_id = p_org AND r.site_id = p_site)
  LIMIT 1
$$;
