-- Which "someone is guessing your two-step codes" alerts (0014's
-- second_step_alerts, D-077) have been handled by the notice sender
-- (T-040, D-085). Numbered 0021: main has 0019 and T-048 takes 0020; the
-- runner allows gaps (renumber at merge if needed).
--
-- Every alert gets exactly one row, written once and never changed:
-- 'notified' if it led to an email to the person and the system admins,
-- 'folded' if another alert of the same person was notified within the
-- window (so each person's mailbox, and the admins', gets at most one such
-- email per window), or if it was older than the window when first seen.
-- The database enforces "one per alert" (the primary key), "the alert's own
-- person", "at most one notified per person per window" and "folded only
-- into a notice within the window, or when already older than it" (the
-- trigger, under a per-person lock), whoever writes the row.
CREATE TABLE public.second_step_alert_notices (
  alert_id uuid PRIMARY KEY REFERENCES public.second_step_alerts (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('notified', 'folded')),
  -- The window it was judged by, in seconds (1 hour to 7 days).
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 3600 AND 604800),
  noticed_at timestamptz NOT NULL
);

CREATE INDEX second_step_alert_notices_notified
  ON public.second_step_alert_notices (user_id, noticed_at) WHERE outcome = 'notified';

CREATE FUNCTION public.second_step_alert_notices_check_new() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- One person's notices are decided one at a time (classid 85, D-085).
  PERFORM pg_advisory_xact_lock(85, hashtext(NEW.user_id::text));
  IF NOT EXISTS (SELECT 1 FROM public.second_step_alerts a
                 WHERE a.id = NEW.alert_id AND a.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'A notice belongs to its alert''s own person.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'second_step_alert_notices_user';
  END IF;
  IF NOT (NEW.noticed_at >= now() AND NEW.noticed_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'A notice is recorded at the time it happens.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'second_step_alert_notices_now';
  END IF;
  IF NEW.outcome = 'notified' AND EXISTS (
       SELECT 1 FROM public.second_step_alert_notices n
       WHERE n.user_id = NEW.user_id AND n.outcome = 'notified'
         AND n.noticed_at > NEW.noticed_at - make_interval(secs => NEW.window_seconds)) THEN
    RAISE EXCEPTION 'This person was already notified within the window.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'second_step_alert_notices_window';
  END IF;
  -- Folding needs a reason: a notice to this person within the window, or
  -- an alert already older than the window.
  IF NEW.outcome = 'folded'
     AND NOT EXISTS (
       SELECT 1 FROM public.second_step_alert_notices n
       WHERE n.user_id = NEW.user_id AND n.outcome = 'notified'
         AND n.noticed_at > NEW.noticed_at - make_interval(secs => NEW.window_seconds))
     AND NOT EXISTS (
       SELECT 1 FROM public.second_step_alerts a
       WHERE a.id = NEW.alert_id
         AND a.created_at <= NEW.noticed_at - make_interval(secs => NEW.window_seconds)) THEN
    RAISE EXCEPTION 'An alert is folded only into a notice within the window.'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'second_step_alert_notices_fold';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER second_step_alert_notices_check_new BEFORE INSERT ON public.second_step_alert_notices
  FOR EACH ROW EXECUTE FUNCTION public.second_step_alert_notices_check_new();

-- Rows are never changed (the writer has INSERT only; this holds for any
-- role that does have UPDATE).
CREATE FUNCTION public.second_step_alert_notices_no_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'An alert notice is never changed.'
    USING ERRCODE = 'integrity_constraint_violation',
          CONSTRAINT = 'second_step_alert_notices_fixed';
END
$$;

CREATE TRIGGER second_step_alert_notices_no_change BEFORE UPDATE ON public.second_step_alert_notices
  FOR EACH ROW EXECUTE FUNCTION public.second_step_alert_notices_no_change();

-- Every guard trigger fires in replica mode too (D-067, 0008 part 4).
ALTER TABLE public.second_step_alert_notices
  ENABLE ALWAYS TRIGGER second_step_alert_notices_check_new;
ALTER TABLE public.second_step_alert_notices
  ENABLE ALWAYS TRIGGER second_step_alert_notices_no_change;
