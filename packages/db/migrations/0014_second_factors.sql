-- Two-step sign-in: TOTP factors, recovery codes, and the record of each
-- second step that passed (T-038, D-052, D-069, D-077). Numbered 0014:
-- 0012 is main's workflow states (T-034), and 0011 and 0013 are taken by
-- T-041's work; the runner allows gaps but refuses one that sorts before a
-- migration already applied.
--
-- The application checks codes (packages/db/src/second-factor.ts with core's
-- totp.ts); the database can't, because a TOTP secret is sealed with a key it
-- never sees (OCULUS_SECRET_KEY). What the database does enforce, for every
-- writer, is that a session becomes full, or records the password entered
-- again, only in the same transaction as a row of second_step_passes for
-- that very session and its user, and that such a row can be written only
-- with proof that no direct SQL can make up:
--
--   totp      the next link of the factor's hash chain (S/KEY style, read
--             backwards). At set-up the application makes
--             L_0 = HMAC-SHA-256(TOTP secret, label, factor) and
--             L_{k+1} = sha256(L_k), and the factor stores L_N (N =
--             chain_length) as its anchor. A pass reveals the next link
--             back, which must hash to the stored anchor, and that link
--             itself becomes the new anchor: nothing the pass's writer
--             chooses. Only someone holding the TOTP secret (so the sealed
--             secret and OCULUS_SECRET_KEY) can compute a link not yet
--             revealed; SHA-256's preimage resistance keeps everyone else
--             out. A link that leaked unused (it was never stored, only
--             sent) gives at most the passes between it and the anchor,
--             never the chain beyond it. The code's step must also be after
--             the last one used (no replay). When the chain is used up the
--             factor takes no more TOTP passes (recovery codes, then a
--             reset); there is no re-seeding (D-077).
--   recovery  an unused recovery code of the factor, hashed here (SHA-256)
--             and compared with the stored hash. Works without the secret key.
--
-- Neither proof is ever stored: the triggers clear them before the row is
-- written. With only the writer role's password, then, nobody can promote a
-- session by UPDATE, insert a full session (a switch copy needs a live full
-- session with the same pass), fake a recent re-entry of the password,
-- make recovery codes, reset someone's factor, or replay a code: they need
-- the person's authenticator, one of their recovery codes, or the server's
-- secret key with the database. (Accounts that haven't set up their second
-- step yet are the exception, see D-077: the set-up itself is authorised by
-- the password alone, as D-052 decided.)

-- ---------------------------------------------------------------------------
-- Factors: one TOTP authenticator per person at a time.

CREATE TABLE public.second_factors (
  id uuid PRIMARY KEY
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind = 'totp'),
  -- pending: set up but not yet confirmed with a code; active: in use;
  -- revoked: reset by a system admin or replaced before it was confirmed.
  state text NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  -- The TOTP secret sealed with AES-256-GCM (secret-key.ts): version, key
  -- fingerprint, nonce, tag, then the 20-byte secret.
  secret_box bytea NOT NULL CHECK (octet_length(secret_box) BETWEEN 40 AND 200),
  -- The hash chain (above): the last link revealed (L_N at first), how
  -- many links have been revealed, and how long the chain is.
  ratchet_anchor bytea NOT NULL CHECK (octet_length(ratchet_anchor) = 32),
  ratchet_generation bigint NOT NULL CHECK (ratchet_generation >= 0),
  chain_length integer NOT NULL CHECK (chain_length BETWEEN 1 AND 1000000),
  -- The last TOTP step accepted (-1: none yet). Codes for it or earlier
  -- steps are never accepted again (RFC 6238 §5.2).
  last_step bigint NOT NULL CHECK (last_step >= -1),
  -- The session waiting for its second step that set this factor up; only
  -- a pass from that session can confirm it.
  enrol_session_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  -- When it was confirmed, in second_step_order (below): compared with
  -- enrolment tokens' order, never by the clock.
  confirmed_order bigint,
  confirmed_xact xid8,
  revoked_at timestamptz,
  -- The system admin's second step that reset it (NULL for a set-up
  -- replaced before it was confirmed). Checked by the trigger when set; no
  -- foreign key, so deleting that admin's account (owner only) doesn't
  -- take this record with it.
  revoked_by_pass uuid,
  UNIQUE (user_id, id),
  CHECK (ratchet_generation <= chain_length),
  CHECK (CASE state
    WHEN 'pending' THEN confirmed_at IS NULL AND revoked_at IS NULL AND ratchet_generation = 0
      AND last_step = -1
    WHEN 'active' THEN confirmed_at IS NOT NULL AND revoked_at IS NULL
    ELSE revoked_at IS NOT NULL
  END)
);

-- At most one factor in use or being set up per person.
CREATE UNIQUE INDEX second_factors_one_live ON public.second_factors (user_id)
  WHERE state <> 'revoked';

-- ---------------------------------------------------------------------------
-- Passes: each second step that passed, for one purpose, in the transaction
-- that uses it. Append-only; nothing deletes them but the cascade from a
-- deleted user. They are also the log of every recovery code used (D-052).

CREATE TABLE public.second_step_passes (
  id uuid PRIMARY KEY
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  factor_id uuid NOT NULL,
  -- sign_in: the session waiting for its second step that it promotes;
  -- otherwise the person's own full session it was made in.
  session_id uuid NOT NULL,
  purpose text NOT NULL
    CHECK (purpose IN ('sign_in', 'reauth', 'recovery_codes', 'admin_reset')),
  method text NOT NULL CHECK (method IN ('totp', 'recovery')),
  -- admin_reset only: whose factor the system admin resets.
  target_user_id uuid REFERENCES public.users (id) ON DELETE CASCADE,
  -- totp only: the step of the code accepted.
  step bigint,
  created_at timestamptz NOT NULL,
  -- The transaction that made it: a pass counts only there.
  created_xact xid8 NOT NULL,
  -- The proof, given only in the INSERT; the trigger checks and clears it.
  reveal bytea,
  recovery_code text,
  FOREIGN KEY (user_id, factor_id) REFERENCES public.second_factors (user_id, id)
    ON DELETE CASCADE,
  CHECK (reveal IS NULL AND recovery_code IS NULL),
  CHECK ((purpose = 'admin_reset') = (target_user_id IS NOT NULL)),
  CHECK ((method = 'totp') = (step IS NOT NULL))
);

CREATE INDEX second_step_passes_user ON public.second_step_passes (user_id, created_at);
CREATE INDEX second_step_passes_factor ON public.second_step_passes (factor_id);
CREATE INDEX second_step_passes_target ON public.second_step_passes (target_user_id)
  WHERE target_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Recovery codes: 10 per set, SHA-256 of the canonical code, single use; a
-- new set supersedes the old one.

CREATE TABLE public.second_step_recovery_codes (
  user_id uuid NOT NULL,
  factor_id uuid NOT NULL,
  set_id uuid NOT NULL,
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  created_at timestamptz NOT NULL,
  created_xact xid8 NOT NULL,
  used_at timestamptz,
  superseded_at timestamptz,
  -- The code itself, given only in the UPDATE that uses it; checked against
  -- code_hash and cleared, never stored.
  presented text CHECK (presented IS NULL),
  PRIMARY KEY (user_id, code_hash),
  FOREIGN KEY (user_id, factor_id) REFERENCES public.second_factors (user_id, id)
    ON DELETE CASCADE
);

CREATE INDEX second_step_recovery_codes_set ON public.second_step_recovery_codes (set_id);
CREATE INDEX second_step_recovery_codes_factor ON public.second_step_recovery_codes (factor_id);

-- ---------------------------------------------------------------------------
-- Wrong-code counters: one per person for TOTP codes (user:<id>, core's
-- SECOND_STEP_THROTTLE), one per session (session:<id>: a waiting session
-- ends after 5 wrong codes; a full one takes no more), and one per client
-- address (core's SOURCE_THROTTLE keys, as sign_in_throttles).

CREATE TABLE public.second_step_throttles (
  key text PRIMARY KEY
    CHECK (key ~ '^((user|session):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|source:v4:[0-9.]{7,15}|source:v6:[0-9a-f:]{7,39}::/64|source:other)$'),
  failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 1000000),
  last_failure_at timestamptz
);

CREATE INDEX second_step_throttles_last_failure ON public.second_step_throttles (last_failure_at);

-- A person's TOTP codes started to be refused with a wait (and every 10
-- wrong codes after): someone who has their password is guessing. T-040 and
-- T-048 tell the person and the system admins from these rows; that notice
-- is required before deployment (D-077). Insert only.
CREATE TABLE public.second_step_alerts (
  id uuid PRIMARY KEY
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  failures integer NOT NULL CHECK (failures > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX second_step_alerts_user ON public.second_step_alerts (user_id, created_at);

-- Enrolment tokens: every system admin's reset makes one, sent to the
-- person's address (D-077). From then until a factor is confirmed, every
-- start of a set-up must present the newest one, unexpired, in its own
-- transaction, so the password alone (which the writer role can set,
-- D-068) isn't enough. 32 random bytes, stored as SHA-256, made only with
-- that admin_reset pass; usable for several starts until a factor is
-- confirmed or it expires.
CREATE TABLE public.second_step_enrolment_tokens (
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  -- The system admin's admin_reset pass that made it. Checked by the insert
  -- trigger; no foreign key, so deleting that pass (or, by cascade, that
  -- admin's account) can't take the token, and so the requirement, away.
  created_by_pass uuid NOT NULL,
  created_at timestamptz NOT NULL,
  -- Its place in second_step_order: "newest" and "confirmed since" are
  -- decided by this, never by the clock (a clock stepping back can't drop
  -- the requirement), and pg_dump keeps the sequence.
  order_no bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  -- First and latest presentation, and the latest one's transaction.
  used_at timestamptz,
  presented_at timestamptz,
  presented_xact xid8,
  -- The token itself, only in the UPDATE that uses it; checked and cleared.
  presented text CHECK (presented IS NULL),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days')
);

CREATE INDEX second_step_enrolment_tokens_user ON public.second_step_enrolment_tokens (user_id);

-- One increasing order for enrolment tokens and confirmations, taken only
-- by the triggers through this function (it runs as the owner, so the
-- writer role needs no privilege on the sequence; calling it directly only
-- skips numbers).
CREATE SEQUENCE public.second_step_order AS bigint;

CREATE FUNCTION public.second_step_next_order() RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT nextval('public.second_step_order'::regclass)
$$;

-- Whether person u must present an enrolment token to set up: a system
-- admin has reset them (every reset makes a token) and no factor has been
-- confirmed since the latest one.
CREATE FUNCTION public.second_step_token_required(u uuid) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.second_step_enrolment_tokens t
    WHERE t.user_id = u
      AND NOT EXISTS (SELECT 1 FROM public.second_factors c
                      WHERE c.user_id = u AND c.confirmed_order > t.order_no))
$$;

-- Whether person u's valid token was presented in this transaction (the
-- presentation's own trigger checked it was the newest, unexpired, and no
-- factor confirmed since).
CREATE FUNCTION public.second_step_token_here(u uuid) RETURNS boolean
LANGUAGE sql VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.second_step_enrolment_tokens t
    WHERE t.user_id = u AND t.presented_xact = pg_current_xact_id() AND t.presented_at >= now())
$$;

-- ---------------------------------------------------------------------------
-- The current TOTP step by the database's clock (30-second steps from the
-- epoch, RFC 6238 §4).

CREATE FUNCTION public.totp_step_now() RETURNS bigint
LANGUAGE sql VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT floor(extract(epoch FROM clock_timestamp()) / 30)::bigint
$$;

-- A pass made in the current transaction (and not restored from elsewhere:
-- it was made after this transaction started).
CREATE FUNCTION public.second_step_pass_here(p public.second_step_passes) RETURNS boolean
LANGUAGE sql VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p.created_xact = pg_current_xact_id() AND p.created_at >= now()
$$;

-- ---------------------------------------------------------------------------
-- Factor guards.

-- A new factor is being set up: pending, made now, no ratchet moved yet, by
-- a session of that person waiting for its second step. One live factor per
-- person (the unique index), so an active factor can't be replaced this way.
CREATE FUNCTION public.second_factors_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT (NEW.state = 'pending' AND NEW.ratchet_generation = 0 AND NEW.last_step = -1
          AND NEW.confirmed_at IS NULL AND NEW.confirmed_xact IS NULL
          AND NEW.confirmed_order IS NULL
          AND NEW.revoked_at IS NULL AND NEW.revoked_by_pass IS NULL) THEN
    RAISE EXCEPTION 'A new second factor starts pending, with its ratchet at the start.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_factors_new';
  END IF;
  NEW.created_at := clock_timestamp();
  PERFORM 1 FROM public.users WHERE id = NEW.user_id FOR SHARE;
  IF NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = NEW.enrol_session_id AND s.user_id = NEW.user_id
        AND s.stage = 'second_step' AND public.session_live(s)
        AND public.session_access_ok(s.user_id, s.organization_id, s.signed_in_at)) THEN
    RAISE EXCEPTION 'A second factor is set up from that person''s session waiting for its second step.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_factors_new_session';
  END IF;
  -- After a system admin's reset, every start presents the token in its
  -- own transaction (no exception for earlier starts: second review).
  IF public.second_step_token_required(NEW.user_id)
     AND NOT public.second_step_token_here(NEW.user_id) THEN
    RAISE EXCEPTION 'After a reset, setting up again needs the enrolment link sent to the person.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_factors_new_token';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER second_factors_check_new BEFORE INSERT ON public.second_factors
  FOR EACH ROW EXECUTE FUNCTION public.second_factors_check_new();

-- A change to a factor:
--  * nothing changes once revoked;
--  * the chain and last_step move only together, one link back at a time:
--    the new anchor must hash to the old one, within the chain's length,
--    and only to a later step within two of the clock's;
--  * pending becomes active only with a ratchet move (a code checked);
--  * active becomes revoked only with a system admin's admin_reset pass for
--    this person, made in this transaction;
--  * pending may be revoked (a set-up replaced);
--  * the confirmation and revocation stamps are the trigger's own.
-- secret_box may change otherwise (re-sealing under a new key); a box that
-- doesn't open under the server's key for this factor and person is just a
-- factor that can't be used (GCM authenticates it with both IDs).
CREATE FUNCTION public.second_factors_check_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  moved boolean := NEW.ratchet_anchor IS DISTINCT FROM OLD.ratchet_anchor
    OR NEW.ratchet_generation IS DISTINCT FROM OLD.ratchet_generation
    OR NEW.last_step IS DISTINCT FROM OLD.last_step;
  now_step bigint := public.totp_step_now();
BEGIN
  IF OLD.state = 'revoked' THEN
    RAISE EXCEPTION 'A revoked second factor never changes.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_factors_revoked';
  END IF;
  IF NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.confirmed_xact IS DISTINCT FROM OLD.confirmed_xact
     OR NEW.confirmed_order IS DISTINCT FROM OLD.confirmed_order
     OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'A second factor''s confirmation and revocation are stamped by the database.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_factors_stamps';
  END IF;
  IF moved THEN
    IF NOT (sha256(NEW.ratchet_anchor) = OLD.ratchet_anchor) IS TRUE
       OR NEW.ratchet_generation IS DISTINCT FROM OLD.ratchet_generation + 1
       OR NEW.chain_length IS DISTINCT FROM OLD.chain_length
       OR NEW.state = 'revoked' THEN
      RAISE EXCEPTION 'The second step''s ratchet moves only with its next link.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_factors_ratchet';
    END IF;
    IF NOT (NEW.last_step > OLD.last_step
            AND NEW.last_step BETWEEN now_step - 2 AND now_step + 2) THEN
      RAISE EXCEPTION 'That code was used already, or is not for now.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_factors_step';
    END IF;
  ELSIF NEW.chain_length IS DISTINCT FROM OLD.chain_length THEN
    RAISE EXCEPTION 'The second step''s ratchet moves only with its next link.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_factors_ratchet';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state = 'pending' AND NEW.state = 'active' AND moved THEN
      NEW.confirmed_at := clock_timestamp();
      NEW.confirmed_xact := pg_current_xact_id();
      NEW.confirmed_order := public.second_step_next_order();
    ELSIF OLD.state = 'pending' AND NEW.state = 'revoked' AND NEW.revoked_by_pass IS NULL
          AND NOT moved
          AND (NOT public.second_step_token_required(OLD.user_id)
               OR public.second_step_token_here(OLD.user_id)
               OR EXISTS (
                 SELECT 1 FROM public.second_step_passes p
                 WHERE p.purpose = 'admin_reset' AND p.target_user_id = OLD.user_id
                   AND public.second_step_pass_here(p))) THEN
      -- A set-up replaced: freely before any reset; after one only by a
      -- start presenting the token, or by another reset.
      NEW.revoked_at := clock_timestamp();
    ELSIF OLD.state = 'active' AND NEW.state = 'revoked' AND NOT moved AND EXISTS (
        SELECT 1 FROM public.second_step_passes p JOIN public.users a ON a.id = p.user_id
        WHERE p.id = NEW.revoked_by_pass AND p.purpose = 'admin_reset'
          AND p.target_user_id = OLD.user_id AND public.second_step_pass_here(p)
          AND a.system_admin AND a.disabled_at IS NULL) THEN
      NEW.revoked_at := clock_timestamp();
    ELSE
      RAISE EXCEPTION 'A second factor is confirmed with a code, and reset only by a system admin''s second step.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_factors_state';
    END IF;
  ELSIF NEW.revoked_by_pass IS DISTINCT FROM OLD.revoked_by_pass THEN
    RAISE EXCEPTION 'A second factor is confirmed with a code, and reset only by a system admin''s second step.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_factors_state';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER second_factors_check_change BEFORE UPDATE ON public.second_factors
  FOR EACH ROW EXECUTE FUNCTION public.second_factors_check_change();

CREATE TRIGGER zzzz_second_factors_keep_identity BEFORE UPDATE ON public.second_factors
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity(
    'id', 'user_id', 'kind', 'enrol_session_id', 'created_at');

-- A reset factor ends every session of its person (D-052): their sessions
-- were all signed in with it. Moving sessions_valid_after makes 0010's
-- triggers delete them.
CREATE FUNCTION public.second_factors_reset_ends_sessions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.users SET sessions_valid_after = greatest(sessions_valid_after, clock_timestamp())
  WHERE id = NEW.user_id;
  DELETE FROM public.sessions WHERE user_id = NEW.user_id;
  RETURN NULL;
END
$$;

CREATE TRIGGER second_factors_reset_ends_sessions AFTER UPDATE ON public.second_factors
  FOR EACH ROW WHEN (OLD.state = 'active' AND NEW.state = 'revoked')
  EXECUTE FUNCTION public.second_factors_reset_ends_sessions();

-- No factor is ever deleted except with its user (the writer has no DELETE).

-- ---------------------------------------------------------------------------
-- Pass guards.

-- A pass is written only with its proof (above), now, in this transaction,
-- by an active account, from the right kind of session of that account:
-- sign_in from a session waiting for its second step, everything else from
-- a full session. admin_reset only by a system admin. A pending factor can
-- only be confirmed, with a TOTP code at sign-in.
CREATE FUNCTION public.second_step_passes_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  f public.second_factors;
  n integer;
BEGIN
  NEW.created_at := clock_timestamp();
  NEW.created_xact := pg_current_xact_id();
  IF NOT EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = NEW.user_id AND u.disabled_at IS NULL
        AND (NEW.purpose <> 'admin_reset' OR u.system_admin)) THEN
    RAISE EXCEPTION 'That account can''t pass a second step for that.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_passes_user';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = NEW.session_id AND s.user_id = NEW.user_id
        AND s.stage = CASE WHEN NEW.purpose = 'sign_in' THEN 'second_step' ELSE 'full' END
        AND public.session_live(s)
        AND public.session_access_ok(s.user_id, s.organization_id, s.signed_in_at)) THEN
    RAISE EXCEPTION 'A second step passes only in that person''s own live session.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_passes_session';
  END IF;
  SELECT * INTO f FROM public.second_factors
  WHERE id = NEW.factor_id AND user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND OR f.state = 'revoked'
     OR (f.state = 'pending' AND NOT (NEW.purpose = 'sign_in' AND NEW.method = 'totp'
                                      AND NEW.session_id = f.enrol_session_id)) THEN
    RAISE EXCEPTION 'That second factor can''t be used for that.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_passes_factor';
  END IF;
  IF NEW.method = 'totp' THEN
    -- second_factors_check_change checks the link and the step.
    UPDATE public.second_factors
    SET ratchet_anchor = NEW.reveal,
        ratchet_generation = ratchet_generation + 1, last_step = NEW.step, state = 'active'
    WHERE id = f.id;
  ELSE
    -- second_step_recovery_codes_check_change checks the code against its hash.
    UPDATE public.second_step_recovery_codes
    SET used_at = clock_timestamp(), presented = NEW.recovery_code
    WHERE user_id = NEW.user_id AND factor_id = f.id
      AND code_hash = sha256(convert_to(NEW.recovery_code, 'UTF8'))
      AND used_at IS NULL AND superseded_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN
      RAISE EXCEPTION 'That recovery code isn''t one this person can use.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_passes_code';
    END IF;
  END IF;
  NEW.reveal := NULL;
  NEW.recovery_code := NULL;
  RETURN NEW;
END
$$;

CREATE TRIGGER second_step_passes_check_new BEFORE INSERT ON public.second_step_passes
  FOR EACH ROW EXECUTE FUNCTION public.second_step_passes_check_new();

-- Passes never change (the writer has no UPDATE or DELETE; this holds for
-- any role that can't disable triggers).
CREATE FUNCTION public.second_step_passes_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'A passed second step is never changed or removed.'
    USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_passes_append_only';
END
$$;

CREATE TRIGGER second_step_passes_append_only BEFORE UPDATE ON public.second_step_passes
  FOR EACH ROW EXECUTE FUNCTION public.second_step_passes_append_only();
CREATE TRIGGER second_step_passes_no_truncate BEFORE TRUNCATE ON public.second_step_passes
  FOR EACH STATEMENT EXECUTE FUNCTION public.second_step_passes_append_only();

-- ---------------------------------------------------------------------------
-- Recovery code guards.

-- New codes only for an active factor, either confirmed in this very
-- transaction (set-up) or with a recovery_codes pass of that person made in
-- it; at most 10 to a set, and a set is made in one transaction.
CREATE FUNCTION public.second_step_recovery_codes_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT (NEW.used_at IS NULL AND NEW.superseded_at IS NULL AND NEW.presented IS NULL) THEN
    RAISE EXCEPTION 'A new recovery code is unused.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_recovery_codes_new';
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.created_xact := pg_current_xact_id();
  IF NOT EXISTS (
      SELECT 1 FROM public.second_factors f
      WHERE f.id = NEW.factor_id AND f.user_id = NEW.user_id AND f.state = 'active'
        AND ((f.confirmed_xact = pg_current_xact_id() AND f.confirmed_at >= now())
             OR EXISTS (
               SELECT 1 FROM public.second_step_passes p
               WHERE p.user_id = NEW.user_id AND p.factor_id = f.id
                 AND p.purpose = 'recovery_codes' AND public.second_step_pass_here(p)))) THEN
    RAISE EXCEPTION 'Recovery codes are made at set-up or with a second step.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_recovery_codes_new';
  END IF;
  IF EXISTS (
      SELECT 1 FROM public.second_step_recovery_codes c
      WHERE c.set_id = NEW.set_id
        AND (c.user_id <> NEW.user_id OR c.created_xact <> pg_current_xact_id()))
     OR (SELECT count(*) FROM public.second_step_recovery_codes c
         WHERE c.set_id = NEW.set_id) >= 10 THEN
    RAISE EXCEPTION 'A set of recovery codes is at most 10, made together.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_recovery_codes_set';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER second_step_recovery_codes_check_new BEFORE INSERT
  ON public.second_step_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION public.second_step_recovery_codes_check_new();

-- A new set supersedes every older code of that person.
CREATE FUNCTION public.second_step_recovery_codes_supersede() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.second_step_recovery_codes SET superseded_at = clock_timestamp()
  WHERE user_id = NEW.user_id AND set_id <> NEW.set_id AND superseded_at IS NULL;
  RETURN NULL;
END
$$;

CREATE TRIGGER second_step_recovery_codes_supersede AFTER INSERT
  ON public.second_step_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION public.second_step_recovery_codes_supersede();

-- A code is used only by presenting it (checked against its hash, then
-- cleared), once, while it is current and its factor active; it is
-- superseded only by a newer set made in this transaction. Nothing else
-- changes.
CREATE FUNCTION public.second_step_recovery_codes_check_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.used_at IS DISTINCT FROM OLD.used_at THEN
    IF NOT (OLD.used_at IS NULL AND OLD.superseded_at IS NULL
            AND NEW.superseded_at IS NULL AND NEW.used_at IS NOT NULL
            AND (sha256(convert_to(NEW.presented, 'UTF8')) = OLD.code_hash) IS TRUE
            AND EXISTS (SELECT 1 FROM public.second_factors f
                        WHERE f.id = OLD.factor_id AND f.state = 'active')) THEN
      RAISE EXCEPTION 'A recovery code is used once, by presenting it.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_recovery_codes_use';
    END IF;
    NEW.used_at := clock_timestamp();
  ELSIF NEW.presented IS NOT NULL THEN
    RAISE EXCEPTION 'A recovery code is used once, by presenting it.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_recovery_codes_use';
  END IF;
  NEW.presented := NULL;
  IF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    IF NOT (OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.second_step_recovery_codes c
        WHERE c.user_id = OLD.user_id AND c.set_id <> OLD.set_id
          AND c.created_xact = pg_current_xact_id() AND c.created_at >= now())) THEN
      RAISE EXCEPTION 'Recovery codes are superseded only by a new set.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_recovery_codes_use';
    END IF;
    NEW.superseded_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER second_step_recovery_codes_check_change BEFORE UPDATE
  ON public.second_step_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION public.second_step_recovery_codes_check_change();

CREATE TRIGGER zzzz_second_step_recovery_codes_keep_identity BEFORE UPDATE
  ON public.second_step_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity(
    'user_id', 'factor_id', 'set_id', 'code_hash', 'created_at', 'created_xact');

-- ---------------------------------------------------------------------------
-- Enrolment token guards.

-- Made only with a system admin's admin_reset pass for that person, in the
-- same transaction; unused, stamped now.
CREATE FUNCTION public.second_step_enrolment_tokens_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT (NEW.used_at IS NULL AND NEW.presented_at IS NULL AND NEW.presented_xact IS NULL
          AND NEW.presented IS NULL) THEN
    RAISE EXCEPTION 'A new enrolment token is unused.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_enrolment_tokens_new';
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.order_no := public.second_step_next_order();
  IF NOT EXISTS (
      SELECT 1 FROM public.second_step_passes p JOIN public.users a ON a.id = p.user_id
      WHERE p.id = NEW.created_by_pass AND p.purpose = 'admin_reset'
        AND p.target_user_id = NEW.user_id AND public.second_step_pass_here(p)
        AND a.system_admin AND a.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'Enrolment tokens are made only by a system admin''s reset.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_enrolment_tokens_new';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER second_step_enrolment_tokens_check_new BEFORE INSERT
  ON public.second_step_enrolment_tokens
  FOR EACH ROW EXECUTE FUNCTION public.second_step_enrolment_tokens_check_new();

-- Presented (checked against its hash, then cleared) only while it is the
-- person's newest token, unexpired, with no factor confirmed since it was
-- made; each presentation is stamped with its transaction. Nothing else
-- changes.
CREATE FUNCTION public.second_step_enrolment_tokens_check_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT (OLD.expires_at > clock_timestamp()
          AND (sha256(convert_to(NEW.presented, 'UTF8')) = OLD.token_hash) IS TRUE
          AND NEW.expires_at = OLD.expires_at
          AND NOT EXISTS (SELECT 1 FROM public.second_step_enrolment_tokens n
                          WHERE n.user_id = OLD.user_id AND n.order_no > OLD.order_no)
          AND NOT EXISTS (SELECT 1 FROM public.second_factors c
                          WHERE c.user_id = OLD.user_id AND c.confirmed_order > OLD.order_no)) THEN
    RAISE EXCEPTION 'An enrolment token is presented, before it expires, until a factor is confirmed.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'second_step_enrolment_tokens_use';
  END IF;
  NEW.used_at := coalesce(OLD.used_at, clock_timestamp());
  NEW.presented_at := clock_timestamp();
  NEW.presented_xact := pg_current_xact_id();
  NEW.presented := NULL;
  RETURN NEW;
END
$$;

CREATE TRIGGER second_step_enrolment_tokens_check_change BEFORE UPDATE
  ON public.second_step_enrolment_tokens
  FOR EACH ROW EXECUTE FUNCTION public.second_step_enrolment_tokens_check_change();

CREATE TRIGGER zzzz_second_step_enrolment_tokens_keep_identity BEFORE UPDATE
  ON public.second_step_enrolment_tokens
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity(
    'user_id', 'token_hash', 'created_by_pass', 'created_at', 'order_no');

-- ---------------------------------------------------------------------------
-- Sessions: promotion, the switch copy and re-entering the password are tied
-- to passes.

-- Sessions made before two-step sign-in existed were promoted without one;
-- nothing is deployed yet (D-077), so they simply end.
DELETE FROM public.sessions;

ALTER TABLE public.sessions
  ADD COLUMN second_step_pass uuid REFERENCES public.second_step_passes (id) ON DELETE CASCADE,
  ADD COLUMN reauth_pass uuid REFERENCES public.second_step_passes (id) ON DELETE CASCADE,
  ADD CONSTRAINT sessions_full_has_pass CHECK ((stage = 'full') = (second_step_pass IS NOT NULL));

CREATE INDEX sessions_second_step_pass ON public.sessions (second_step_pass);
CREATE INDEX sessions_reauth_pass ON public.sessions (reauth_pass);

-- 0010's sessions_check_new, with: a session waiting for its second step
-- has no pass, and a full one (only ever a switch copy) carries the same
-- second_step_pass as its live source, and no re-entry pass.
CREATE OR REPLACE FUNCTION public.sessions_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT (NEW.created_at >= now() AND NEW.created_at <= clock_timestamp()
          AND NEW.last_seen_at = NEW.created_at AND NEW.rotated_at = NEW.created_at) THEN
    RAISE EXCEPTION 'A new session is made now.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_new_now';
  END IF;
  -- Waits for any transaction disabling the account or ending its sessions,
  -- and holds them off until this one commits; the check below then reads
  -- the account as it is after them.
  PERFORM 1 FROM public.users WHERE id = NEW.user_id FOR SHARE;
  IF NOT public.session_access_ok(NEW.user_id, NEW.organization_id, NEW.signed_in_at) THEN
    RAISE EXCEPTION 'That account can''t hold a session there.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_access';
  END IF;
  IF NEW.reauth_pass IS NOT NULL THEN
    RAISE EXCEPTION 'A new session hasn''t had the password entered again yet.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_new_full';
  END IF;
  IF NEW.stage = 'second_step' THEN
    IF NOT (NEW.signed_in_at = NEW.created_at AND NEW.password_at = NEW.signed_in_at
            AND NEW.second_step_pass IS NULL) THEN
      RAISE EXCEPTION 'A session waiting for its second step starts at its password.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_new_pending';
    END IF;
  ELSIF NOT (NEW.password_at = NEW.signed_in_at AND NEW.second_step_pass IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.sessions o
      WHERE o.user_id = NEW.user_id AND o.id <> NEW.id AND o.stage = 'full'
        AND o.signed_in_at = NEW.signed_in_at AND o.second_step_at = NEW.second_step_at
        AND o.second_step_pass = NEW.second_step_pass
        AND o.idle_seconds = NEW.idle_seconds AND o.absolute_seconds = NEW.absolute_seconds
        AND public.session_live(o))) THEN
    RAISE EXCEPTION 'A full session is only made by promotion or by switching organization.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_new_full';
  END IF;
  RETURN NEW;
END
$$;

-- 0010's sessions_check_change, with: promotion needs a sign_in pass for
-- this session and its user made in this transaction; recording the
-- password entered again needs a reauth pass likewise; the passes never
-- change otherwise.
CREATE OR REPLACE FUNCTION public.sessions_check_change() RETURNS trigger
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
  IF NOT public.session_access_ok(NEW.user_id, NEW.organization_id, NEW.signed_in_at) THEN
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
    IF NOT EXISTS (
        SELECT 1 FROM public.second_step_passes p
        WHERE p.id = NEW.second_step_pass AND p.user_id = OLD.user_id AND p.session_id = OLD.id
          AND p.purpose = 'sign_in' AND public.second_step_pass_here(p)) THEN
      RAISE EXCEPTION 'A session becomes full only with its own second step, passed now.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_second_step_pass';
    END IF;
  ELSIF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.second_step_at IS DISTINCT FROM OLD.second_step_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'A session''s organization, second step and end never change.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_organization';
  ELSIF NEW.second_step_pass IS DISTINCT FROM OLD.second_step_pass THEN
    RAISE EXCEPTION 'A session becomes full only with its own second step, passed now.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_second_step_pass';
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
  -- Re-entering the password always gives a new token (reauthenticate),
  -- so a stolen token can't be marked recently authenticated without
  -- also being replaced.
  IF NEW.password_at <> OLD.password_at
     AND (NEW.stage <> 'full' OR NEW.token_hash = OLD.token_hash) THEN
    RAISE EXCEPTION 'Only a full session records the password entered again, with a new token.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_times';
  END IF;
  -- ... and the second step with it (D-052): a reauth pass for this session,
  -- made now.
  IF NEW.password_at <> OLD.password_at THEN
    IF NEW.reauth_pass IS NOT DISTINCT FROM OLD.reauth_pass OR NOT EXISTS (
        SELECT 1 FROM public.second_step_passes p
        WHERE p.id = NEW.reauth_pass AND p.user_id = OLD.user_id AND p.session_id = OLD.id
          AND p.purpose = 'reauth' AND public.second_step_pass_here(p)) THEN
      RAISE EXCEPTION 'Entering the password again needs the second step too, passed now.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_reauth_pass';
    END IF;
  ELSIF NEW.reauth_pass IS DISTINCT FROM OLD.reauth_pass THEN
    RAISE EXCEPTION 'Entering the password again needs the second step too, passed now.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'sessions_reauth_pass';
  END IF;
  RETURN NEW;
END
$$;

-- Every guard trigger fires in replica mode too (D-067, 0008 part 4).
ALTER TABLE public.second_factors ENABLE ALWAYS TRIGGER second_factors_check_new;
ALTER TABLE public.second_factors ENABLE ALWAYS TRIGGER second_factors_check_change;
ALTER TABLE public.second_factors ENABLE ALWAYS TRIGGER zzzz_second_factors_keep_identity;
ALTER TABLE public.second_factors ENABLE ALWAYS TRIGGER second_factors_reset_ends_sessions;
ALTER TABLE public.second_step_passes ENABLE ALWAYS TRIGGER second_step_passes_check_new;
ALTER TABLE public.second_step_passes ENABLE ALWAYS TRIGGER second_step_passes_append_only;
ALTER TABLE public.second_step_passes ENABLE ALWAYS TRIGGER second_step_passes_no_truncate;
ALTER TABLE public.second_step_recovery_codes
  ENABLE ALWAYS TRIGGER second_step_recovery_codes_check_new;
ALTER TABLE public.second_step_recovery_codes
  ENABLE ALWAYS TRIGGER second_step_recovery_codes_supersede;
ALTER TABLE public.second_step_recovery_codes
  ENABLE ALWAYS TRIGGER second_step_recovery_codes_check_change;
ALTER TABLE public.second_step_recovery_codes
  ENABLE ALWAYS TRIGGER zzzz_second_step_recovery_codes_keep_identity;
ALTER TABLE public.second_step_enrolment_tokens
  ENABLE ALWAYS TRIGGER second_step_enrolment_tokens_check_new;
ALTER TABLE public.second_step_enrolment_tokens
  ENABLE ALWAYS TRIGGER second_step_enrolment_tokens_check_change;
ALTER TABLE public.second_step_enrolment_tokens
  ENABLE ALWAYS TRIGGER zzzz_second_step_enrolment_tokens_keep_identity;
