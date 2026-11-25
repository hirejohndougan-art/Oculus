-- Unexplained wrong two-step codes (S-045, D-077 amended).
--
-- second_step_throttles gains a fourth kind of row, `wrong:<user ID>`: the
-- wrong TOTP codes typed after a person's right password that no right code
-- in the same session explained (a typo followed by the right code is
-- explained). It is never a wait. It is kept for 30 days without a new
-- wrong code (the cleanup command deletes it after that), and the next
-- sign-in's first code writes a row in second_step_alerts for the codes
-- other sessions left, so a password holder trying a few codes a day, below
-- the person's wait, is still told to the person and the system admins.

ALTER TABLE public.second_step_throttles DROP CONSTRAINT second_step_throttles_key_check;

ALTER TABLE public.second_step_throttles ADD CONSTRAINT second_step_throttles_key_check
  CHECK (key ~ '^((user|session|wrong):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|source:v4:[0-9.]{7,15}|source:v6:[0-9a-f:]{7,39}::/64|source:other)$');
