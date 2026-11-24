-- Who may grant a role, backed up by the database for any writer (S-022,
-- D-072 amendment), as invitations_check_new does for invited_by (0009).
-- Numbered 0018: 0015 is T-039's, 0016 and 0017 S-018's and S-019's.
--
-- The service decides (admin.ts mayManage, D-025, D-072): a system manager
-- grants any role on any site or on every site; anyone else grants roles
-- below site manager, on one site, where they hold site.people (today only
-- site managers do: a whole-catalog site_manager grant on that site or on
-- every site, in the same organization). A role scoped to a unit is scoped
-- to a unit of the grant's site (any site of the organization for a grant
-- on every site). Until now the database checked only the scope's kind and
-- the time, so a writer could record a grant "by" anyone. This trigger
-- refuses, for every writer and in replica mode too:
--   role_assignments_granted_by   the granter is not an active user who may
--                                 grant this role on this site
--   role_assignments_scope_site   the scope unit is not on the grant's site
-- The granter's user row is locked FOR SHARE, so a change to their own
-- roles that locks it (the service locks both people's rows) waits.
CREATE FUNCTION public.role_assignments_check_grant() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  granter_admin boolean;
BEGIN
  SELECT u.system_admin INTO granter_admin
  FROM public.users u
  WHERE u.id = NEW.granted_by AND u.disabled_at IS NULL
  FOR SHARE;
  IF granter_admin IS NULL OR NOT (
    granter_admin
    OR (NEW.role <> 'site_manager' AND NEW.site_id IS NOT NULL AND EXISTS (
          SELECT 1
          FROM public.role_assignments g
          JOIN public.organization_members m
            ON m.organization_id = g.organization_id AND m.user_id = g.user_id
          WHERE g.organization_id = NEW.organization_id AND g.user_id = NEW.granted_by
            -- The roles holding site.people (core's ROLE_PERMISSIONS; a test
            -- compares the two lists).
            AND g.role IN ('site_manager')
            AND g.scope_record_id IS NULL
            AND (g.site_id IS NULL OR g.site_id = NEW.site_id)))
  ) THEN
    RAISE EXCEPTION 'The person recorded as granting this role may not grant it here.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'role_assignments_granted_by';
  END IF;
  IF NEW.scope_record_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.records r
    WHERE r.organization_id = NEW.organization_id AND r.id = NEW.scope_record_id
      AND r.site_id IS NOT NULL
      AND (NEW.site_id IS NULL OR r.site_id = NEW.site_id)
  ) THEN
    RAISE EXCEPTION 'A role is scoped to a unit of its own site.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'role_assignments_scope_site';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER role_assignments_check_grant BEFORE INSERT ON public.role_assignments
  FOR EACH ROW EXECUTE FUNCTION public.role_assignments_check_grant();

-- Every guard trigger fires in replica mode too (D-067, 0008 part 4).
ALTER TABLE public.role_assignments ENABLE ALWAYS TRIGGER role_assignments_check_grant;
