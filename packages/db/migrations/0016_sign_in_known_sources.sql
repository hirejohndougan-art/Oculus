-- Sign-in from a known address, and a counter of its own for re-entering
-- the password (S-018, D-068 amendment). Numbered 0016: 0015 is T-039's
-- password resets (branch autopilot/T-039); the runner allows gaps.
--
-- Anyone can type anyone's address at sign-in, and the account counter
-- (keyed by the address typed) made the right password wait too, so one
-- wrong guess per wait from anywhere kept a person, including the install's
-- only system admin, out for good. Now a client address the account signed
-- in from with the right password in the last 30 days is "known" for it and
-- has a counter of its own for that account (core's decideSignInAttempt):
-- strangers elsewhere can't make it wait, and it gets no more guesses than
-- the account rule allows. Rows are keyed like sign_in_throttles (a hash of
-- the address typed, and the client address key); an unreadable client
-- address (source:other, shared by everyone) is never known.
CREATE TABLE public.sign_in_known_sources (
  account_key text NOT NULL CHECK (account_key ~ '^account:[0-9a-f]{64}$'),
  source_key text NOT NULL
    CHECK (source_key ~ '^source:(v4:[0-9.]{7,15}|v6:[0-9a-f:]{7,39}::/64)$'),
  -- The last right password from this address for this account.
  signed_in_at timestamptz NOT NULL,
  failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 1000000),
  last_failure_at timestamptz,
  PRIMARY KEY (account_key, source_key)
);

-- The cleanup (deleteExpiredSignInThrottles) finds old ones by time.
CREATE INDEX sign_in_known_sources_signed_in ON public.sign_in_known_sources (signed_in_at);

-- Re-entering the password in a signed-in session (reauthenticate) counts on
-- reauth:<user ID>, not on the account counter strangers can push. The
-- "reset:" keys (and reset:source:v6 /48 network keys) are 0015's (T-039,
-- D-078), kept as they are.
ALTER TABLE public.sign_in_throttles DROP CONSTRAINT sign_in_throttles_key_check;
ALTER TABLE public.sign_in_throttles ADD CONSTRAINT sign_in_throttles_key_check
  CHECK (key ~ '^((reset:)?(account:[0-9a-f]{64}|source:v4:[0-9.]{7,15}|source:v6:[0-9a-f:]{7,39}::/64|source:other)|reset:source:v6:[0-9a-f:]{5,29}::/48|reauth:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
