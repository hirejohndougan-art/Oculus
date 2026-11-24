-- Password reset tokens (T-039, D-052, D-068, D-069, D-078).
--
-- Numbered 0015, after T-041's 0013 and T-038's 0014 (whose second_factors
-- table this uses). The runner allows gaps, never two files
-- with one number.
--
-- A reset is a single-use link sent to the account's own address. Only the
-- SHA-256 of its token is stored. It lasts 5 to 60 minutes (30 by default),
-- one per account is pending at a time (a newer request revokes the older),
-- and it is settled once: used or revoked, it never changes again. Using it
-- (packages/db/src/password-resets.ts) sets the new password, ends every
-- session of the account (endAllSessionsForUser, D-069) and consumes the
-- token, in one transaction.
--
-- A link also dies when the account changes under it: a token is usable only
-- while the account is active and can sign in, and only if it was made after
-- the account's last password change (password_changed_at) and after its
-- sessions were last all ended (sessions_valid_after: "end all", disabling,
-- a change of system admin), so a link sent before any of those can't be
-- used after them.
--
-- The application keeps the rules; these checks back them up for any writer:
-- a token can't be reused, revived, extended or moved to another user, can't
-- be used after it expired, and a new one can only be pending, made now, for
-- an active account that can sign in, asked by the person (requested_by
-- NULL, only for an account with a second factor in use) or by an active
-- system admin.

CREATE TABLE public.password_resets (
  id uuid PRIMARY KEY
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  -- NULL when the person asked for it; otherwise the system admin who sent it.
  requested_by uuid REFERENCES public.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  -- Why it was revoked: a newer link replaced it, its message couldn't be
  -- sent, or the account lost its last membership.
  revoked_reason text CHECK (revoked_reason IN ('superseded', 'delivery_failed', 'no_membership')),
  CHECK (expires_at >= created_at + interval '5 minutes'
         AND expires_at <= created_at + interval '60 minutes'),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);

-- One pending link per account: a new request revokes the older first.
CREATE UNIQUE INDEX password_resets_one_pending ON public.password_resets (user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- The cleanup finds old rows by time.
CREATE INDEX password_resets_expires ON public.password_resets (expires_at);

-- Whether user u can be sent, or use, a reset link made at `made`: active,
-- able to sign in (a system admin, or a member of some organization), and
-- `made` after the last password change and the last "end all sessions".
CREATE FUNCTION public.password_reset_user_ok(u uuid, made timestamptz) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users x
    WHERE x.id = u AND x.disabled_at IS NULL
      AND x.password_changed_at < made AND x.sessions_valid_after < made
      AND (x.system_admin OR EXISTS (
        SELECT 1 FROM public.organization_members m WHERE m.user_id = u)))
$$;

-- Whether user u has a second factor in use (0014, T-038). A link the person
-- asks for themselves needs one: otherwise a mailbox alone would give a new
-- password and then the setting up of a new authenticator (D-078, review
-- L7). A system admin's link doesn't (they decide).
CREATE FUNCTION public.password_reset_has_factor(u uuid) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.second_factors f WHERE f.user_id = u AND f.state = 'active')
$$;

-- A new link: pending, made now (by the clock: never back- or
-- forward-dated), for an account that can use it, asked by the person or by
-- an active system admin. The user row is held FOR SHARE first, so a disable
-- or "end all" under way finishes before the check reads the account.
CREATE FUNCTION public.password_resets_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.revoked_reason IS NOT NULL THEN
    RAISE EXCEPTION 'A new reset link is pending.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'password_resets_new_pending';
  END IF;
  IF NOT (NEW.created_at >= now() AND NEW.created_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'A new reset link is made now.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'password_resets_new_now';
  END IF;
  PERFORM 1 FROM public.users WHERE id = NEW.user_id FOR SHARE;
  IF NOT public.password_reset_user_ok(NEW.user_id, NEW.created_at) THEN
    RAISE EXCEPTION 'That account can''t be sent a reset link.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'password_resets_user';
  END IF;
  IF NEW.requested_by IS NULL AND NOT public.password_reset_has_factor(NEW.user_id) THEN
    RAISE EXCEPTION 'An account with no second factor in use gets a reset link only from a system admin.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'password_resets_needs_factor';
  END IF;
  IF NEW.requested_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users a
    WHERE a.id = NEW.requested_by AND a.system_admin AND a.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Only the person or an active system admin asks for a reset link.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'password_resets_requested_by';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER password_resets_check_new BEFORE INSERT ON public.password_resets
  FOR EACH ROW EXECUTE FUNCTION public.password_resets_check_new();

-- A link is settled once, now: used (only before it expires, by the
-- statement's time, and only while its account can use it) or revoked (at
-- any time, with a reason). Once settled it never changes, so a used or
-- revoked link never works again, and no UPDATE can move its expiry, user,
-- token, requester or times (zzzz_password_resets_keep_identity).
CREATE FUNCTION public.password_resets_check_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'A used or revoked reset link can''t change.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'password_resets_settled';
  END IF;
  IF NEW.used_at IS NOT NULL THEN
    IF OLD.expires_at <= statement_timestamp() THEN
      RAISE EXCEPTION 'An expired reset link can''t be used.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'password_resets_expired';
    END IF;
    IF NOT (NEW.used_at >= now() AND NEW.used_at <= clock_timestamp()) THEN
      RAISE EXCEPTION 'A reset link is used at the time it happens.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'password_resets_settled_now';
    END IF;
    IF NOT public.password_reset_user_ok(OLD.user_id, OLD.created_at) THEN
      RAISE EXCEPTION 'That account can''t use this reset link.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'password_resets_user';
    END IF;
  END IF;
  IF NEW.revoked_at IS NOT NULL
     AND NOT (NEW.revoked_at >= now() AND NEW.revoked_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'A reset link is revoked at the time it happens.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'password_resets_settled_now';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER password_resets_check_change BEFORE UPDATE ON public.password_resets
  FOR EACH ROW EXECUTE FUNCTION public.password_resets_check_change();

-- Named zzzz_ to run after password_resets_check_change (BEFORE triggers fire
-- in name order), as in 0002.
CREATE TRIGGER zzzz_password_resets_keep_identity BEFORE UPDATE ON public.password_resets
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity(
    'id', 'user_id', 'token_hash', 'requested_by', 'created_at', 'expires_at');

-- An account left with no organization (and not a system admin) can't sign
-- in, so its pending links are revoked, for good: inviting it back into an
-- organization later must not bring an old link back to life (a link is
-- otherwise only refused while the account has no membership). The user row
-- is locked first, as every path that makes or ends links does.
CREATE FUNCTION public.organization_members_end_resets() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM public.users WHERE id = OLD.user_id FOR NO KEY UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = OLD.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = OLD.user_id AND u.system_admin) THEN
    UPDATE public.password_resets
    SET revoked_at = clock_timestamp(), revoked_reason = 'no_membership'
    WHERE user_id = OLD.user_id AND used_at IS NULL AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER organization_members_end_resets AFTER DELETE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.organization_members_end_resets();

-- password_changed_at only moves forward, and never past the clock, for any
-- writer: a link made before a password change can't be brought back by
-- moving the change's time back (sessions_valid_after already only moves
-- forward, 0010).
CREATE FUNCTION public.users_password_changed_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.password_changed_at < OLD.password_changed_at
     OR (NEW.password_changed_at <> OLD.password_changed_at
         AND NEW.password_changed_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'password_changed_at only moves forward, to no later than now.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'users_password_changed_at';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER users_password_changed_at BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_password_changed_at();

-- Reset requests are throttled on counters of their own in the sign-in
-- counters' table (core's password-reset.ts): the sign-in keys with
-- "reset:" in front, so asking for links never makes anyone wait to sign in,
-- plus one per IPv6 /48 (reset:source:v6:…::/48) for resets only.
ALTER TABLE public.sign_in_throttles DROP CONSTRAINT sign_in_throttles_key_check;
ALTER TABLE public.sign_in_throttles ADD CONSTRAINT sign_in_throttles_key_check
  CHECK (key ~ '^((reset:)?(account:[0-9a-f]{64}|source:v4:[0-9.]{7,15}|source:v6:[0-9a-f:]{7,39}::/64|source:other)|reset:source:v6:[0-9a-f:]{5,29}::/48)$');

-- Every guard trigger fires in replica mode too (D-067, 0008 part 4).
ALTER TABLE public.password_resets ENABLE ALWAYS TRIGGER password_resets_check_new;
ALTER TABLE public.password_resets ENABLE ALWAYS TRIGGER password_resets_check_change;
ALTER TABLE public.password_resets ENABLE ALWAYS TRIGGER zzzz_password_resets_keep_identity;
ALTER TABLE public.users ENABLE ALWAYS TRIGGER users_password_changed_at;
ALTER TABLE public.organization_members ENABLE ALWAYS TRIGGER organization_members_end_resets;
