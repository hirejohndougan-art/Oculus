-- People and roles in the change log, and the last system manager (T-048,
-- D-084). Numbered 0020 after main's 0019.
--
-- 1. people_events: one row per change an administrator makes to a person
--    in an organization: an invitation sent, an account disabled or
--    re-enabled, a role granted or revoked, two-step sign-in reset, a
--    password reset link sent, every session ended. The audit trail (with
--    record_versions) reads it. Append-only for every writer: the writer
--    has INSERT only (roles.ts), and triggers refuse UPDATE, DELETE and
--    TRUNCATE for anyone who can't turn triggers off. A row is stamped now
--    (occurred_at between the transaction's start and the statement's
--    clock), its actor must be an account, and a role row must name a role
--    and (for a site grant) one of the organization's sites. What the
--    database can't check is that the change it describes happened: a
--    writer with direct SQL can add false rows (never change or remove
--    true ones).
-- 2. users_last_system_admin: an active system admin can't be disabled
--    while no other active system admin exists (D-072's "at least one
--    active manager left"). Today the bootstrap account is the only system
--    admin there can be (0009), so it can't be disabled at all. The other
--    active admins' rows are locked first, so two admins disabling each
--    other at once can't both win (one waits, then sees the other disabled,
--    or the deadlock detector ends one).
--
-- Every trigger here is ENABLE ALWAYS (D-067), so replica mode skips none.

CREATE TABLE public.people_events (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid NOT NULL REFERENCES public.users (id),
  -- The person the change was made to (none yet for an invitation).
  subject_id uuid REFERENCES public.users (id),
  kind text NOT NULL CONSTRAINT people_events_kind_known
    CHECK (kind IN ('invited', 'account_disabled', 'account_enabled', 'role_granted',
                    'role_revoked', 'second_factor_reset', 'password_reset_sent',
                    'sessions_ended')),
  role text CHECK (role IS NULL OR role ~ '^[a-z][a-z_]{0,39}$'),
  site_id uuid,
  scope_record_id uuid
    CHECK (scope_record_id IS NULL
           OR scope_record_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  invitation_id uuid,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, site_id) REFERENCES public.sites (organization_id, id),
  FOREIGN KEY (organization_id, invitation_id) REFERENCES public.invitations (organization_id, id),
  CONSTRAINT people_events_shape CHECK (
    CASE kind
      WHEN 'invited' THEN invitation_id IS NOT NULL AND role IS NULL AND site_id IS NULL
                          AND scope_record_id IS NULL
      WHEN 'role_granted' THEN subject_id IS NOT NULL AND role IS NOT NULL AND invitation_id IS NULL
      WHEN 'role_revoked' THEN subject_id IS NOT NULL AND role IS NOT NULL AND invitation_id IS NULL
      ELSE subject_id IS NOT NULL AND role IS NULL AND site_id IS NULL AND scope_record_id IS NULL
           AND invitation_id IS NULL
    END)
);

-- The audit trail pages newest first, per organization.
CREATE INDEX people_events_time ON public.people_events (organization_id, occurred_at DESC, id DESC);
-- The audit trail's other way in: record_versions by organization and time.
CREATE INDEX record_versions_time
  ON public.record_versions (organization_id, recorded_at DESC, record_id DESC, version DESC);

CREATE FUNCTION public.people_events_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.occurred_at < now() OR NEW.occurred_at > clock_timestamp() THEN
    RAISE EXCEPTION 'A change is logged when it is made.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'people_events_now';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER people_events_check_new
  BEFORE INSERT ON public.people_events
  FOR EACH ROW EXECUTE FUNCTION public.people_events_check_new();

CREATE FUNCTION public.people_events_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'The change log is never changed or emptied.'
    USING ERRCODE = 'integrity_constraint_violation',
          CONSTRAINT = 'people_events_append_only';
END
$$;

CREATE TRIGGER people_events_append_only
  BEFORE UPDATE OR DELETE ON public.people_events
  FOR EACH ROW EXECUTE FUNCTION public.people_events_append_only();

CREATE TRIGGER people_events_no_truncate
  BEFORE TRUNCATE ON public.people_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.people_events_append_only();

ALTER TABLE public.people_events ENABLE ALWAYS TRIGGER people_events_check_new;
ALTER TABLE public.people_events ENABLE ALWAYS TRIGGER people_events_append_only;
ALTER TABLE public.people_events ENABLE ALWAYS TRIGGER people_events_no_truncate;

CREATE FUNCTION public.users_last_system_admin() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.system_admin AND OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL THEN
    PERFORM 1 FROM public.users u
    WHERE u.system_admin AND u.disabled_at IS NULL AND u.id <> OLD.id
    ORDER BY u.id
    FOR NO KEY UPDATE;
    IF NOT EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.system_admin AND u.disabled_at IS NULL AND u.id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'The last active system admin can''t be disabled.'
        USING ERRCODE = 'integrity_constraint_violation',
              CONSTRAINT = 'users_last_system_admin';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER users_last_system_admin
  BEFORE UPDATE OF disabled_at ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_last_system_admin();

ALTER TABLE public.users ENABLE ALWAYS TRIGGER users_last_system_admin;
