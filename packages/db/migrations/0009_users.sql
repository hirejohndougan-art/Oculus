-- Users, organization memberships, invitations and sign-in throttles (T-036,
-- D-068).
--
-- Numbered 0009: main holds 0001–0007 and branch autopilot/T-032 holds
-- 0008_record_deletion.sql. The runner allows gaps, never two files with one
-- number.
--
-- A user is one sign-in for the whole install (D-019: a person who works
-- for two organizations has one sign-in with separate roles in each), so
-- users and sign_in_throttles carry no organization. Everything a user may
-- reach goes through organization_members, one row per organization, and
-- every membership is made by accepting an invitation bound to that
-- organization and that email address. No public sign-up: apart from one
-- first system admin per install (bootstrap), every user row names the
-- invitation it was made from, and that invitation must have been accepted
-- by it, for its email address.
--
-- The application keeps the rules (packages/db/src/accounts.ts, with
-- packages/core's accounts.ts, passwords.ts and sign-in-throttle.ts); these
-- checks back them up for any writer.

-- One person's sign-in. The email is stored in lower case (core's
-- normalizeEmail) and is unique in the install. password_hash is a PHC
-- string made by core's hashPassword (scrypt today; U-004 widens the check
-- for Argon2id).
CREATE TABLE public.users (
  id uuid PRIMARY KEY
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  email text NOT NULL UNIQUE
    CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email) AND email ~ '^[!-?A-~]+@[a-z0-9.-]+$'),
  display_name text NOT NULL
    CHECK (display_name <> '' AND length(display_name) <= 200 AND btrim(display_name) = display_name
           AND display_name !~ '[[:cntrl:]]'),
  password_hash text NOT NULL
    CHECK (password_hash ~ '^\$scrypt\$ln=[0-9]{1,2},r=[0-9]{1,2},p=[0-9]{1,2}\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$'),
  -- D-019: system admins manage every user and every organization. Until
  -- a supported way to make or remove system admins exists (T-041, T-048),
  -- the bootstrap account is the only one (CHECK below) and the flag can't
  -- change (zzzz_users_keep_identity), so even a writer with direct SQL
  -- can't make itself one.
  system_admin boolean NOT NULL DEFAULT false,
  -- The install's first system admin, made without an invitation. At most
  -- one row ever (users_one_bootstrap).
  bootstrap boolean NOT NULL DEFAULT false,
  -- The invitation this account was made from (every account but bootstrap).
  created_by_invitation uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz,
  -- A disabled user can't sign in (D-019: system admins deactivate).
  disabled_at timestamptz,
  CHECK (bootstrap <> (created_by_invitation IS NOT NULL)),
  CHECK (system_admin = bootstrap)
);

CREATE UNIQUE INDEX users_one_bootstrap ON public.users ((true)) WHERE bootstrap;

-- An invitation to join one organization, for one email address. Only the
-- SHA-256 of its token is stored (core's hashInvitationToken). It can be
-- accepted once, before it expires, unless revoked; then it never changes.
-- One pending invitation per organization and address
-- (invitations_one_pending): a new one revokes the old.
CREATE TABLE public.invitations (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL UNIQUE
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  email text NOT NULL
    CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email) AND email ~ '^[!-?A-~]+@[a-z0-9.-]+$'),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  invited_by uuid NOT NULL REFERENCES public.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  -- Deferred: accepting claims the invitation before the new user row exists.
  accepted_by uuid REFERENCES public.users (id) DEFERRABLE INITIALLY DEFERRED,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.users (id),
  PRIMARY KEY (organization_id, id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '14 days'),
  CHECK ((accepted_at IS NULL) = (accepted_by IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX invitations_one_pending ON public.invitations (organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE public.users
  ADD FOREIGN KEY (created_by_invitation) REFERENCES public.invitations (id);

-- Who belongs to which organization. Roles within it are T-041's.
CREATE TABLE public.organization_members (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  user_id uuid NOT NULL REFERENCES public.users (id),
  -- The invitation, of this same organization, that made the membership.
  invitation_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  UNIQUE (invitation_id),
  FOREIGN KEY (organization_id, invitation_id) REFERENCES public.invitations (organization_id, id)
);

CREATE INDEX organization_members_user ON public.organization_members (user_id);

-- Sign-in failure counters (core's sign-in-throttle.ts): one per account key
-- (a hash of the email typed, whether or not an account has it) and one per
-- client address key. Install-wide like users.
CREATE TABLE public.sign_in_throttles (
  key text PRIMARY KEY
    CHECK (key ~ '^(account:[0-9a-f]{64}|source:v4:[0-9.]{7,15}|source:v6:[0-9a-f:]{7,39}::/64|source:other)$'),
  failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 1000000),
  last_failure_at timestamptz
);

-- The cleanup (deleteExpiredSignInThrottles) finds old counters by time.
CREATE INDEX sign_in_throttles_last_failure ON public.sign_in_throttles (last_failure_at);

-- Identity never changes (as in 0002): a user's ID, sign-in address,
-- system admin flag and origin; an invitation's organization, ID, address,
-- token, inviter and times; a membership's keys. There is no supported way
-- to change a sign-in address yet (D-052 asks for the password and second
-- factor again when there is, which needs T-037 and T-038), so it is refused
-- outright: an address can't drift from the invitations that made the
-- account and its memberships.
CREATE TRIGGER zzzz_users_keep_identity BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity(
    'id', 'email', 'system_admin', 'bootstrap', 'created_by_invitation', 'created_at');
CREATE TRIGGER zzzz_invitations_keep_identity BEFORE UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity(
    'organization_id', 'id', 'email', 'token_hash', 'invited_by', 'created_at', 'expires_at');
CREATE TRIGGER zzzz_organization_members_keep_identity BEFORE UPDATE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity(
    'organization_id', 'user_id', 'invitation_id', 'added_at');

-- An invitation is settled once: accepted or revoked, it never changes
-- again, and it can't be accepted after it expired (by the database's
-- clock at the statement).
CREATE FUNCTION public.invitations_settle_once() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'An accepted or revoked invitation can''t change.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invitations_settled';
  END IF;
  IF NEW.accepted_at IS NOT NULL AND OLD.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'An expired invitation can''t be accepted.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invitations_expired';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER invitations_settle_once BEFORE UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.invitations_settle_once();

-- An invited account and a membership need their invitation, accepted by
-- that user, and an account's email must be its invitation's.
CREATE FUNCTION public.users_check_invitation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.created_by_invitation IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.invitations i
    WHERE i.id = NEW.created_by_invitation AND i.accepted_by = NEW.id AND i.email = NEW.email
  ) THEN
    RAISE EXCEPTION 'An account needs an invitation for its address, accepted by it.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'users_invitation_accepted';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER users_check_invitation BEFORE INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_check_invitation();

CREATE FUNCTION public.organization_members_check_invitation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.invitations i JOIN public.users u ON u.id = i.accepted_by
    WHERE i.organization_id = NEW.organization_id AND i.id = NEW.invitation_id
      AND i.accepted_by = NEW.user_id AND i.email = u.email
  ) THEN
    RAISE EXCEPTION 'A membership needs an invitation of that organization, accepted by that user.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'organization_members_invitation_accepted';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER organization_members_check_invitation BEFORE INSERT ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.organization_members_check_invitation();

-- Every guard trigger fires in replica mode too (D-067, 0008 part 4): a
-- session that starts with session_replication_role = replica must not skip
-- them.
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
      AND c.relname IN ('users', 'invitations', 'organization_members', 'sign_in_throttles')
    ORDER BY c.relname, tg.tgname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t.relname, t.tgname);
  END LOOP;
END
$$;
