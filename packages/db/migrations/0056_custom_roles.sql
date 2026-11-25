-- Custom roles (T-041a, D-036, D-120; core: permissions.ts).
--
-- custom_roles: one row per role a system manager made for one organization:
-- its key (lower case letters and underscores, never a built-in role's
-- name), label, optional description and permissions (catalog permissions
-- and site.settings only: never a system permission, and not site.people,
-- which 0018's grant guard knows for site managers only; S-067). The key
-- and organization never change; the version goes up by one on every
-- change. A role is deleted only while nobody holds it (the service moves
-- its holders to another role first, in the same transaction).
--
-- custom_role_events: the change log of custom roles (made, changed,
-- deleted), insert only: who, when, the role's label and permissions after
-- the change, how many grants it had, and for a deletion the role its
-- holders were moved to.
--
-- role_assignments: a grant's role is a built-in role or one of the
-- grant's organization's custom roles. The built-in list in 0013's CHECK
-- becomes a shape check plus a trigger that looks the custom role up and
-- locks it FOR KEY SHARE, so a role can't be deleted under a grant being
-- made (the deletion waits, then sees the grant and is refused).
-- Every trigger here is ENABLE ALWAYS (D-067).

CREATE TABLE public.custom_roles (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  key text NOT NULL
    CHECK (key ~ '^[a-z][a-z_]{0,39}$'
           AND key NOT IN ('site_manager', 'cataloger', 'reviewer', 'read_only', 'scanner',
                           'donor_relations', 'constructor', 'prototype')),
  label text NOT NULL CHECK (label <> '' AND char_length(label) <= 100),
  description text CHECK (description IS NULL OR (description <> '' AND char_length(description) <= 500)),
  permissions text[] NOT NULL
    CHECK (cardinality(permissions) >= 1
           AND array_position(permissions, NULL) IS NULL
           AND permissions <@ ARRAY['records.view', 'records.create', 'records.edit',
                                    'records.delete', 'records.history', 'records.publish',
                                    'media.attach', 'donors.view', 'donors.edit',
                                    'site.settings']::text[]),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid NOT NULL REFERENCES public.users (id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, key)
);

CREATE TABLE public.custom_role_events (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid NOT NULL REFERENCES public.users (id),
  kind text NOT NULL CONSTRAINT custom_role_events_kind
    CHECK (kind IN ('role_created', 'role_changed', 'role_deleted')),
  role_key text NOT NULL CHECK (role_key ~ '^[a-z][a-z_]{0,39}$'),
  label text NOT NULL CHECK (char_length(label) <= 100),
  permissions text[] NOT NULL,
  grants integer NOT NULL CHECK (grants >= 0),
  moved_to text CHECK (moved_to IS NULL OR moved_to ~ '^[a-z][a-z_]{0,39}$'),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT custom_role_events_moved CHECK (moved_to IS NULL OR kind = 'role_deleted')
);

CREATE INDEX custom_role_events_time
  ON public.custom_role_events (organization_id, occurred_at DESC, id DESC);

-- The organization and key never change.
CREATE TRIGGER zzzz_custom_roles_keep_identity BEFORE UPDATE ON public.custom_roles
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'key');

-- A role nobody holds is the only one that can be deleted.
CREATE FUNCTION public.custom_roles_check_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.role_assignments a
    WHERE a.organization_id = OLD.organization_id AND a.role = OLD.key
  ) THEN
    RAISE EXCEPTION 'A role people hold can''t be deleted; move them to another role first.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'custom_roles_in_use';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER custom_roles_check_delete BEFORE DELETE ON public.custom_roles
  FOR EACH ROW EXECUTE FUNCTION public.custom_roles_check_delete();

-- A grant names a built-in role or one of its organization's custom roles.
ALTER TABLE public.role_assignments DROP CONSTRAINT role_assignments_role_check;
ALTER TABLE public.role_assignments ADD CONSTRAINT role_assignments_role_shape
  CHECK (role ~ '^[a-z][a-z_]{0,39}$');

CREATE FUNCTION public.role_assignments_check_role() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.role IN ('site_manager', 'cataloger', 'reviewer', 'read_only', 'scanner',
                  'donor_relations') THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.custom_roles c
  WHERE c.organization_id = NEW.organization_id AND c.key = NEW.role
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A role is a built-in role or one of the organization''s own.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'role_assignments_known_role';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER role_assignments_check_role BEFORE INSERT ON public.role_assignments
  FOR EACH ROW EXECUTE FUNCTION public.role_assignments_check_role();

ALTER TABLE public.custom_roles ENABLE ALWAYS TRIGGER zzzz_custom_roles_keep_identity;
ALTER TABLE public.custom_roles ENABLE ALWAYS TRIGGER custom_roles_check_delete;
ALTER TABLE public.role_assignments ENABLE ALWAYS TRIGGER role_assignments_check_role;
