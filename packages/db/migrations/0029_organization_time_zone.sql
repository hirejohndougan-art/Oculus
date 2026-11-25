-- Each organization's time zone and its local day (T-034e, D-103).
--
-- D-056: an access restriction `closed_until` ends on a calendar day, and
-- that day must be the organization's own, never the server's UTC day (a
-- Texas evening is already tomorrow in UTC, which would let records out a
-- day early). The publish check and the public output build the accession
-- register with the day organization_local_day gives.
--
-- time_zone is 'UTC' or a canonical IANA Area/Location name (America/Chicago,
-- Europe/London...), and one PostgreSQL knows (checked against
-- pg_timezone_names on every insert and change, so a misspelt zone can't be
-- stored and quietly fall back to something else). Names like 'localtime'
-- (the server's own zone), 'posixrules', 'US/Central' or 'EST5EDT' are
-- refused: the first is exactly what D-103 rules out, and the legacy ones
-- can vanish when the operating system's time zone data changes. 'UTC' for
-- existing organizations until a system manager sets theirs. Who changed it
-- and when are kept, since the zone decides the day restrictions end.

ALTER TABLE public.organizations
  ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC'
    CHECK (length(time_zone) <= 64 AND time_zone ~
      '^(UTC|(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)/[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)?)$'),
  ADD COLUMN time_zone_changed_by uuid REFERENCES public.users (id),
  ADD COLUMN time_zone_changed_at timestamptz;

CREATE FUNCTION public.organizations_check_time_zone() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- The common case (a new organization in 'UTC') skips the slow catalog view.
  IF NEW.time_zone = 'UTC' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone) THEN
    RAISE EXCEPTION 'unknown time zone' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER organizations_check_time_zone
  BEFORE INSERT OR UPDATE OF time_zone ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_check_time_zone();
ALTER TABLE public.organizations ENABLE ALWAYS TRIGGER organizations_check_time_zone;

-- The organization's calendar day now (the transaction's start, so one
-- transaction sees one day), as YYYY-MM-DD; NULL if its stored zone is one
-- PostgreSQL no longer knows (time zone data changed under it), so the
-- publish check and the public output refuse rather than guess or throw.
-- For the public reader too (D-080), which can read no table: it learns
-- only a date. An unknown organization gets the UTC day; an organization
-- outside UTC can thus show, to someone who already holds its ID, that it
-- exists and roughly its offset, during the hours its day differs from
-- UTC's. That is all, and a public site's own pages say more.
CREATE FUNCTION public.organization_local_day(p_org uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  zone text := coalesce(
    (SELECT o.time_zone FROM public.organizations o WHERE o.id = p_org), 'UTC');
BEGIN
  RETURN to_char((now() AT TIME ZONE zone)::date, 'YYYY-MM-DD');
EXCEPTION WHEN invalid_parameter_value THEN
  RETURN NULL;
END
$$;
