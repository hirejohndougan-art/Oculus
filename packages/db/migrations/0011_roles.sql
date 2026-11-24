-- Sites, roles per organization and per site, collection-level grants, and
-- System settings (T-041, D-072, D-025, D-036).
--
-- Numbered 0011: 0010 is branch autopilot/T-037's (sessions). The runner
-- allows gaps, never two files with one number.
--
-- Follows D-060: organization_id in every key and every foreign key between
-- an organization's rows, identity fixed by catalog_keep_identity (zzzz_*),
-- nothing cascading. Every trigger here is ENABLE ALWAYS (D-067), at the end.
-- The service (packages/service) and packages/db's permissions.ts keep the
-- rules; these checks back them up for any writer.

-- A public (or password-protected, T-019d) website of one organization
-- (D-019, D-030's Site). Keyed with its organization; no key on id alone,
-- as for records (D-060). The name can change; the ID and organization never.
CREATE TABLE public.sites (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  -- As organizations.name (0002), core's name rule (organizations.ts).
  name text NOT NULL
    CHECK (name <> '' AND length(name) <= 200 AND btrim(name) = name
           AND name !~ '[\t\n\r  ]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);

-- One built-in role held by one member of an organization (D-036; custom
-- roles are T-041a's, after launch). On one site, or on every site of the
-- organization (site_id NULL); for the whole catalog, or for one archival
-- unit and everything below it (scope_record_id). A membership is needed
-- (composite foreign key), so nobody holds a role in an organization they
-- don't belong to, and the site and the unit are the organization's own.
-- Revoking a role deletes its row; changing one is a delete and an insert.
-- Nothing else changes a row (zzzz_role_assignments_keep_identity).
CREATE TABLE public.role_assignments (
  organization_id uuid NOT NULL,
  id uuid NOT NULL
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  user_id uuid NOT NULL,
  role text NOT NULL
    CHECK (role IN ('site_manager', 'cataloger', 'reviewer', 'read_only', 'scanner',
                    'donor_relations')),
  site_id uuid,
  scope_record_id uuid,
  granted_by uuid NOT NULL REFERENCES public.users (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES public.organization_members (organization_id, user_id),
  FOREIGN KEY (organization_id, site_id) REFERENCES public.sites (organization_id, id),
  -- A unit's grants keep it from being deleted (the service says so first).
  FOREIGN KEY (organization_id, scope_record_id) REFERENCES public.records (organization_id, id),
  -- A site manager manages a whole site, never a collection (D-025).
  CONSTRAINT role_assignments_site_manager_whole CHECK (role <> 'site_manager' OR scope_record_id IS NULL),
  CONSTRAINT role_assignments_once
    UNIQUE NULLS NOT DISTINCT (organization_id, user_id, role, site_id, scope_record_id)
);

-- A person's grants are read on every write (permissions.ts).
CREATE INDEX role_assignments_user ON public.role_assignments (user_id, organization_id);
-- Deleting a unit looks for grants scoped to it.
CREATE INDEX role_assignments_scope ON public.role_assignments (organization_id, scope_record_id)
  WHERE scope_record_id IS NOT NULL;
CREATE INDEX role_assignments_site ON public.role_assignments (organization_id, site_id)
  WHERE site_id IS NOT NULL;

-- A grant's scope is an archival unit (a record's kind never changes, 0005,
-- so checking at insert is enough), and is granted now.
CREATE FUNCTION public.role_assignments_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.scope_record_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.records r
    WHERE r.organization_id = NEW.organization_id AND r.id = NEW.scope_record_id
      AND r.kind = 'archival_unit'
  ) THEN
    RAISE EXCEPTION 'A role is scoped to an archival unit.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'role_assignments_scope_is_unit';
  END IF;
  IF NOT (NEW.granted_at >= now() AND NEW.granted_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'A role is granted at the time it happens.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'role_assignments_granted_now';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER role_assignments_check_new BEFORE INSERT ON public.role_assignments
  FOR EACH ROW EXECUTE FUNCTION public.role_assignments_check_new();

-- The install-wide System settings (D-019): one row, a JSON document core's
-- validateSystemSettings accepts, with a version number for edit conflicts
-- and who changed it last. Read and changed only by system managers (the
-- service); every change adds exactly 1 to the version.
CREATE TABLE public.system_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  version integer NOT NULL CHECK (version >= 1),
  changed_by uuid NOT NULL REFERENCES public.users (id),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.system_settings_version_step() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.version <> 1 THEN
    RAISE EXCEPTION 'System settings start at version 1.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'system_settings_version_step';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Every change of the System settings adds 1 to their version.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'system_settings_version_step';
  END IF;
  IF NOT (NEW.changed_at >= now() AND NEW.changed_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'System settings are stamped at the time they change.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'system_settings_changed_now';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER system_settings_version_step BEFORE INSERT OR UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.system_settings_version_step();

-- The organization's arrangement lock (0006) in shared mode: taken by a
-- check that only reads where records sit (a scoped person's readRecord),
-- so such checks run side by side, while a move (which takes
-- arrangement_lock, exclusive, as do scoped writes) waits for them and they
-- wait for it. The same key as arrangement_lock.
CREATE FUNCTION public.arrangement_lock_shared(organization_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.arrangement_require_read_committed();
  PERFORM pg_advisory_xact_lock_shared(65, hashtext(organization_id::text));
END
$$;

-- Identity never changes (0002's catalog_keep_identity): a site's
-- organization, ID and creation; every column of a role assignment.
CREATE TRIGGER zzzz_sites_keep_identity BEFORE UPDATE ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'id', 'created_at');
CREATE TRIGGER zzzz_role_assignments_keep_identity BEFORE UPDATE ON public.role_assignments
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity(
    'organization_id', 'id', 'user_id', 'role', 'site_id', 'scope_record_id', 'granted_by',
    'granted_at');

-- Every guard trigger fires in replica mode too (D-067).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname, tg.tgname
    FROM pg_catalog.pg_trigger tg
    JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT tg.tgisinternal
      AND c.relname IN ('sites', 'role_assignments', 'system_settings')
    ORDER BY c.relname, tg.tgname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t.relname, t.tgname);
  END LOOP;
END
$$;
