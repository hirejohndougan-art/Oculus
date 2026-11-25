-- A wrong sign-in code is never lost between its check and its count
-- (S-054d, D-077 amended). Numbered 0059 above main's 0058 and the numbers
-- reserved on the work board (up to 0058).
--
-- Since S-054b a sign-in's TOTP code goes on the person's unexplained
-- counter (`wrong:`) only once it is known to be wrong, in a transaction of
-- its own after the check. If that count failed (a lock timeout under a
-- flood of attempts, a full pool, a restart in between), the code had been
-- checked but was never told: S-045's gap again.
--
-- second_step_code_checks: one row per sign-in code being checked, written
-- in the attempt's own transaction (takeCodeAttempt), before the check. The
-- count after the check deletes it in the count's transaction, so a code is
-- counted exactly once; a right code (or one that couldn't be checked)
-- deletes it too. A row still here an hour later was checked but never
-- settled: the cleanup (sessions.ts `runCleanup`) tells it as an alert,
-- unless its session got its sign-in pass (a right code explained it) or
-- its factor was revoked (a reset; as S-054b, such codes aren't told).
--
-- `told`: a wait's alert counts every code the person's counter counted,
-- codes still being checked included (S-054c), so it marks them told and
-- the count after their check leaves them off the unexplained counter
-- (they would be told twice otherwise).
--
-- The writer inserts, marks told and deletes (roles.ts). Rows go with their
-- person or factor.

CREATE TABLE public.second_step_code_checks (
  id uuid PRIMARY KEY
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  factor_id uuid NOT NULL,
  -- The waiting session the code was typed in.
  session_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  told boolean NOT NULL DEFAULT false,
  FOREIGN KEY (user_id, factor_id) REFERENCES public.second_factors (user_id, id)
    ON DELETE CASCADE
);

CREATE INDEX second_step_code_checks_user ON public.second_step_code_checks (user_id);
CREATE INDEX second_step_code_checks_started ON public.second_step_code_checks (started_at);
