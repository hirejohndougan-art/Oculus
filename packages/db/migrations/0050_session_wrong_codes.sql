-- Each sign-in's own unexplained wrong codes (S-054b, D-077 amended).
--
-- A right code used to take its session's whole code count off the person's
-- `wrong:` counter, which could include recovery codes and codes another
-- session's alert had already told, and so wipe codes of a session started
-- since. Now each `session:` row keeps `unexplained`, the session's wrong
-- TOTP codes that are on the person's `wrong:` counter, and the round they
-- were counted in. `told_round` on a `wrong:` row goes up by one each time
-- its codes are told (an alert, a wait, the cleanup); a session's count is
-- its own only while its round is the counter's. A right code takes off
-- exactly that. Both columns are 0 on every other kind of row.
ALTER TABLE public.second_step_throttles
  ADD COLUMN unexplained integer NOT NULL DEFAULT 0
    CHECK (unexplained BETWEEN 0 AND 1000000),
  ADD COLUMN told_round bigint NOT NULL DEFAULT 0
    CHECK (told_round >= 0);
