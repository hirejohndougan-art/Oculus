-- Sessions (T-037, D-019, D-052, D-069).
--
-- A session is one sign-in on one device, for one user, working in one
-- organization (D-019; switching organization makes a new session). Only the
-- SHA-256 of its token is stored (core's hashSessionToken). It is in one of
-- two stages:
--
--   second_step  the password was right, the second step (T-038) is still to
--                come. It lasts exactly 10 minutes from the password and
--                grants nothing but completing the second step.
--   full         the second step passed. It lasts absolute_seconds from the
--                password (12 hours by default) and ends after idle_seconds
--                without use (4 hours by default).
--
-- The application keeps the rules (packages/db/src/sessions.ts with core's
-- sessions.ts); the checks and triggers here back them up for any writer:
-- no session is revived once expired, a stage never goes back, promotion
-- always changes the token, times only move forward and never past the
-- database's clock, the organization never changes once set, and a disabled
-- account or a removed membership ends its sessions.

-- Whether user u may hold a session (in organization o, if not NULL): an
-- active account, an organization that exists, and a membership of it or
-- system admin (D-019).
CREATE FUNCTION public.session_access_ok(u uuid, o uuid) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users x
    WHERE x.id = u AND x.disabled_at IS NULL
      AND (o IS NULL OR (
        EXISTS (SELECT 1 FROM public.organizations g WHERE g.id = o)
        AND (x.system_admin OR EXISTS (
          SELECT 1 FROM public.organization_members m
          WHERE m.user_id = u AND m.organization_id = o)))))
$$;

CREATE TABLE public.sessions (
  id uuid PRIMARY KEY
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  -- NULL only while waiting for the second step, if none was chosen at the
  -- password; set at promotion and never changed after.
  organization_id uuid REFERENCES public.organizations (id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('second_step', 'full')),
  -- When the password was checked for this sign-in. Everything is timed from here.
  signed_in_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  -- When the token last changed (made, promoted or rotated).
  rotated_at timestamptz NOT NULL,
  -- When the password was last entered in this session: sign-in or re-entry
  -- for a sensitive change (D-052).
  password_at timestamptz NOT NULL,
  second_step_at timestamptz,
  idle_seconds integer NOT NULL CHECK (idle_seconds BETWEEN 300 AND 43200),
  absolute_seconds integer NOT NULL CHECK (absolute_seconds BETWEEN 3600 AND 86400),
  expires_at timestamptz NOT NULL,
  -- Shown in the person's own list ("Firefox on Linux"); never an address.
  client_label text CHECK (client_label IS NULL OR (
    client_label <> '' AND char_length(client_label) <= 200
    AND btrim(client_label) = client_label AND client_label !~ '[[:cntrl:]]')),
  CHECK (idle_seconds <= absolute_seconds),
  CHECK (created_at >= signed_in_at AND last_seen_at >= signed_in_at
         AND rotated_at >= signed_in_at AND password_at >= signed_in_at),
  CHECK (CASE stage
    WHEN 'second_step' THEN second_step_at IS NULL
      AND expires_at = signed_in_at + interval '10 minutes'
    ELSE second_step_at IS NOT NULL AND second_step_at >= signed_in_at
      AND organization_id IS NOT NULL
      AND expires_at = signed_in_at + make_interval(secs => absolute_seconds)
  END)
);

-- A person's list of their own sessions, and ending them all.
CREATE INDEX sessions_user ON public.sessions (user_id);

-- Whether a stored session is still usable at the database's clock.
CREATE FUNCTION public.session_live(s public.sessions) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.expires_at > clock_timestamp()
    AND (s.stage = 'second_step'
         OR s.last_seen_at + make_interval(secs => s.idle_seconds) > clock_timestamp())
$$;

-- A new session: made now, by an active user with access to its
-- organization. One waiting for its second step starts at its password. A
-- full one can only be born as a copy of a live full session of the same
-- user and sign-in (switching organization, sessions.ts), so no writer can
-- insert a full session out of nothing. (Before T-038, a writer with direct
-- SQL can still promote a waiting session by UPDATE; T-038's migration ties
-- promotion to its own record of the second step.)
CREATE FUNCTION public.sessions_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT (NEW.created_at >= now() AND NEW.created_at <= clock_timestamp()
          AND NEW.last_seen_at = NEW.created_at AND NEW.rotated_at = NEW.created_at) THEN
    RAISE EXCEPTION 'A new session is made now.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_new_now';
  END IF;
  IF NOT public.session_access_ok(NEW.user_id, NEW.organization_id) THEN
    RAISE EXCEPTION 'That account can''t hold a session there.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_access';
  END IF;
  IF NEW.stage = 'second_step' THEN
    IF NOT (NEW.signed_in_at = NEW.created_at AND NEW.password_at = NEW.signed_in_at) THEN
      RAISE EXCEPTION 'A session waiting for its second step starts at its password.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_new_pending';
    END IF;
  ELSIF NOT (NEW.password_at = NEW.signed_in_at AND EXISTS (
      SELECT 1 FROM public.sessions o
      WHERE o.user_id = NEW.user_id AND o.id <> NEW.id AND o.stage = 'full'
        AND o.signed_in_at = NEW.signed_in_at AND o.second_step_at = NEW.second_step_at
        AND o.idle_seconds = NEW.idle_seconds AND o.absolute_seconds = NEW.absolute_seconds
        AND public.session_live(o))) THEN
    RAISE EXCEPTION 'A full session is only made by promotion or by switching organization.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_new_full';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sessions_check_new BEFORE INSERT ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.sessions_check_new();

-- A change to a session: only a live one, of an active user with access;
-- the stage only goes forward, and promotion changes the token; the
-- organization is set at most once, at promotion; times move forward only
-- and never past the clock; a token change is stamped now.
CREATE FUNCTION public.sessions_check_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  promoted boolean := OLD.stage = 'second_step' AND NEW.stage = 'full';
BEGIN
  IF NOT public.session_live(OLD) THEN
    RAISE EXCEPTION 'An ended session can''t change.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_ended';
  END IF;
  IF OLD.stage = 'full' AND NEW.stage <> 'full' THEN
    RAISE EXCEPTION 'A session never goes back a stage.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_stage';
  END IF;
  IF NOT public.session_access_ok(NEW.user_id, NEW.organization_id) THEN
    RAISE EXCEPTION 'That account can''t hold a session there.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_access';
  END IF;
  IF promoted THEN
    IF NEW.token_hash = OLD.token_hash THEN
      RAISE EXCEPTION 'Promotion gives the session a new token.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_promotion_rotates';
    END IF;
    IF NOT (NEW.second_step_at >= now() AND NEW.second_step_at <= clock_timestamp()) THEN
      RAISE EXCEPTION 'The second step is recorded when it happens.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_second_step_now';
    END IF;
    IF OLD.organization_id IS NOT NULL AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'A session''s organization never changes.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_organization';
    END IF;
  ELSIF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.second_step_at IS DISTINCT FROM OLD.second_step_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'A session''s organization, second step and end never change.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_organization';
  END IF;
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    IF NOT (NEW.rotated_at >= now() AND NEW.rotated_at <= clock_timestamp()) THEN
      RAISE EXCEPTION 'A new token is stamped when it is made.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_rotated_now';
    END IF;
  ELSIF NEW.rotated_at IS DISTINCT FROM OLD.rotated_at THEN
    RAISE EXCEPTION 'rotated_at changes only with the token.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_rotated_now';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at OR NEW.last_seen_at > clock_timestamp()
     OR NEW.password_at < OLD.password_at OR NEW.password_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Session times move forward, never past now.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_times';
  END IF;
  IF NEW.password_at <> OLD.password_at AND NEW.stage <> 'full' THEN
    RAISE EXCEPTION 'Only a full session records the password entered again.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_times';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sessions_check_change BEFORE UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.sessions_check_change();

-- Named zzzz_ to run after sessions_check_change (BEFORE triggers fire in
-- name order), as in 0002.
CREATE TRIGGER zzzz_sessions_keep_identity BEFORE UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity(
    'id', 'user_id', 'signed_in_at', 'created_at', 'idle_seconds', 'absolute_seconds',
    'client_label');

-- A disabled account, or a change of its system admin flag (a change of
-- what it may reach), ends all of its sessions (D-052, ASVS 5.0 7.4.2).
CREATE FUNCTION public.users_end_sessions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM public.sessions WHERE user_id = NEW.id;
  RETURN NULL;
END
$$;

CREATE TRIGGER users_end_sessions AFTER UPDATE ON public.users
  FOR EACH ROW
  WHEN ((NEW.disabled_at IS NOT NULL AND OLD.disabled_at IS NULL)
        OR NEW.system_admin IS DISTINCT FROM OLD.system_admin)
  EXECUTE FUNCTION public.users_end_sessions();

-- A removed membership ends the user's sessions in that organization.
CREATE FUNCTION public.organization_members_end_sessions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM public.sessions
  WHERE user_id = OLD.user_id AND organization_id = OLD.organization_id;
  RETURN NULL;
END
$$;

CREATE TRIGGER organization_members_end_sessions AFTER DELETE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.organization_members_end_sessions();

-- Every guard trigger fires in replica mode too (D-067, 0008 part 4).
ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER sessions_check_new;
ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER sessions_check_change;
ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER zzzz_sessions_keep_identity;
ALTER TABLE public.users ENABLE ALWAYS TRIGGER users_end_sessions;
ALTER TABLE public.organization_members ENABLE ALWAYS TRIGGER organization_members_end_sessions;
