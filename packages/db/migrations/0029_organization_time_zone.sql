-- Each organization's time zone and its local day (T-034e, D-103).
--
-- D-056: an access restriction `closed_until` ends on a calendar day, and
-- that day must be the organization's own, never the server's UTC day (a
-- Texas evening is already tomorrow in UTC, which would let records out a
-- day early). The publish check and the public output build the accession
-- register with the day organization_local_day gives.
--
-- time_zone is an IANA name PostgreSQL knows (checked against
-- pg_timezone_names on every insert and change, so a misspelt zone can't be
-- stored and quietly fall back to something else). 'UTC' for existing
-- organizations until a system manager sets theirs.

ALTER TABLE public.organizations
  ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC'
    CHECK (length(time_zone) BETWEEN 1 AND 64 AND time_zone ~ '^[A-Za-z0-9_+./-]+$');

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
-- transaction sees one day), as YYYY-MM-DD. For the public reader too
-- (D-080), which can read no table: it learns only a date, and the same
-- date for an unknown organization as for one in UTC, so it can't tell
-- which organizations exist.
CREATE FUNCTION public.organization_local_day(p_org uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT to_char(
    (now() AT TIME ZONE coalesce(
      (SELECT o.time_zone FROM public.organizations o WHERE o.id = p_org), 'UTC'))::date,
    'YYYY-MM-DD')
$$;
