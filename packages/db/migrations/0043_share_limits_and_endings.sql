-- Share limits and endings (S-036b, D-094 amended). Numbered 0043: it was
-- written as 0040, which a build run's S-045 took first on main, and 0041
-- and 0042 are reserved by another branch (S-040, S-052).
--
-- 1. Two new final states, both set only by the database itself, below:
--      offered | accepted -> deleted  (the record was deleted at home)
--      offered | accepted -> moved    (the record was moved onto the second site)
--    Each keeps its decision (who accepted it, and when) and is stamped
--    `ended_at` with no `ended_by`: who deleted or moved the record is in the
--    record's own history. Neither is ever live again, so a record moved
--    back off the second site doesn't show there again (it must be offered
--    anew).
-- 2. The second organization keeps its record of its decisions when the
--    home side deletes the item: the shares no longer go with their record
--    (0024's ON DELETE CASCADE is dropped). A live share becomes `deleted`;
--    a declined, withdrawn or removed one stays as it was. A deleted
--    record's ID is never used again (catalog.ts), and every reader joins
--    the record, so such rows show nowhere. The record must still exist when
--    an offer is made (the insert check reads it).
-- 3. Limits on offers, checked when one is made, under a lock per offering
--    organization and second site so two offers at once can't both pass:
--    at most 100 open offers (`offered`, of a record published on a site
--    now) from one organization into one site (SQLSTATE OC071), and no offer of a record to a site that declined
--    it in the last 30 days (OC072). The numbers are `MAX_OPEN_OFFERS` and
--    `DECLINE_COOLDOWN_DAYS` in shares.ts (a test checks they match).
-- 4. The site lists' index in their order (`offered_at DESC, id DESC`,
--    S-036a), and one for counting a site's open offers by organization.
--
-- Every new trigger is ENABLE ALWAYS (D-067).

-- 2: the shares outlive their record.
DO $$
DECLARE
  fk text;
BEGIN
  SELECT c.conname INTO STRICT fk
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.record_shares'::regclass AND c.contype = 'f'
    AND c.confrelid = 'public.records'::regclass;
  EXECUTE format('ALTER TABLE public.record_shares DROP CONSTRAINT %I', fk);
END
$$;

ALTER TABLE public.record_shares
  ADD CONSTRAINT record_shares_organization
    FOREIGN KEY (organization_id) REFERENCES public.organizations (id);

-- 1: the new states and their shape.
ALTER TABLE public.record_shares DROP CONSTRAINT record_shares_state_known;
ALTER TABLE public.record_shares ADD CONSTRAINT record_shares_state_known
  CHECK (state IN ('offered', 'accepted', 'declined', 'withdrawn', 'removed', 'deleted', 'moved'));

ALTER TABLE public.record_shares DROP CONSTRAINT record_shares_shape;
ALTER TABLE public.record_shares ADD CONSTRAINT record_shares_shape CHECK (
  CASE state
    WHEN 'offered' THEN decided_by IS NULL AND decided_at IS NULL
                        AND ended_by IS NULL AND ended_at IS NULL
    WHEN 'accepted' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
                         AND ended_by IS NULL AND ended_at IS NULL
    WHEN 'declined' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
                         AND ended_by IS NULL AND ended_at IS NULL
    WHEN 'deleted' THEN ended_by IS NULL AND ended_at IS NOT NULL
                        AND (decided_by IS NULL) = (decided_at IS NULL)
    WHEN 'moved' THEN ended_by IS NULL AND ended_at IS NOT NULL
                      AND (decided_by IS NULL) = (decided_at IS NULL)
    ELSE ended_by IS NOT NULL AND ended_at IS NOT NULL
         AND (decided_by IS NULL) = (decided_at IS NULL)
  END);

-- 4: the lists' order, and counting open offers.
DROP INDEX public.record_shares_target;
CREATE INDEX record_shares_target
  ON public.record_shares (target_organization_id, target_site_id, state, offered_at DESC, id DESC);
CREATE INDEX record_shares_open_offers
  ON public.record_shares (target_organization_id, target_site_id, organization_id)
  WHERE state = 'offered';
-- Recent declines of a record into a site.
CREATE INDEX record_shares_declined
  ON public.record_shares (organization_id, record_id, target_organization_id, target_site_id,
                           decided_at)
  WHERE state = 'declined';

CREATE OR REPLACE FUNCTION public.record_shares_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  home uuid;
  record_exists boolean;
  open_offers bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'offered' THEN
      RAISE EXCEPTION 'A share starts as an offer.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'record_shares_life';
    END IF;
    IF NEW.offered_at < now() OR NEW.offered_at > clock_timestamp() THEN
      RAISE EXCEPTION 'An offer is stamped when it is made.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'record_shares_now';
    END IF;
    -- FOR SHARE (which a move's FOR NO KEY UPDATE and a deletion wait for),
    -- so a move or deletion of the record can't slip past this check.
    SELECT r.site_id, true INTO home, record_exists FROM public.records r
      WHERE r.organization_id = NEW.organization_id AND r.id = NEW.record_id FOR SHARE;
    IF record_exists IS NOT TRUE THEN
      RAISE EXCEPTION 'Only an existing record is offered.'
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'record_shares_record';
    END IF;
    IF NEW.target_organization_id = NEW.organization_id AND home IS NOT DISTINCT FROM NEW.target_site_id
    THEN
      RAISE EXCEPTION 'A record is not offered to its own home site.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'record_shares_not_home';
    END IF;
    -- The count below is exact only in Read Committed, where each statement
    -- sees what committed before it (after the lock): a Repeatable Read
    -- snapshot taken before the lock would miss an offer made meanwhile. The
    -- server always writes in Read Committed; anything else is refused, as
    -- for identifiers (OC061, 0003).
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'An offer must be made in a Read Committed transaction.'
        USING ERRCODE = 'OC061';
    END IF;
    -- One offer at a time per offering organization and second site, so the
    -- count below can't be passed by two offers at once. A transaction-level
    -- advisory lock: released at COMMIT or ROLLBACK.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'record_shares:' || NEW.organization_id::text || ':' || NEW.target_organization_id::text
        || ':' || NEW.target_site_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM public.record_shares d
      WHERE d.organization_id = NEW.organization_id AND d.record_id = NEW.record_id
        AND d.target_organization_id = NEW.target_organization_id
        AND d.target_site_id = NEW.target_site_id
        AND d.state = 'declined' AND d.decided_at > now() - interval '30 days')
    THEN
      RAISE EXCEPTION 'That site declined this record in the last 30 days.'
        USING ERRCODE = 'OC072', CONSTRAINT = 'record_shares_cooldown';
    END IF;
    -- Only offers the second site can see and answer count: their record is
    -- published on a site now. One the home side unpublished since (which
    -- the second site's list leaves out) never fills the site's places.
    SELECT count(*) INTO open_offers FROM public.record_shares o
      JOIN public.records r ON r.organization_id = o.organization_id AND r.id = o.record_id
      WHERE o.target_organization_id = NEW.target_organization_id
        AND o.target_site_id = NEW.target_site_id
        AND o.organization_id = NEW.organization_id AND o.state = 'offered'
        AND r.workflow_state = 'published' AND r.site_id IS NOT NULL;
    IF open_offers >= 100 THEN
      RAISE EXCEPTION 'Too many open offers into that site.'
        USING ERRCODE = 'OC071', CONSTRAINT = 'record_shares_offer_limit';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
     OR NEW.record_id <> OLD.record_id
     OR NEW.target_organization_id <> OLD.target_organization_id
     OR NEW.target_site_id <> OLD.target_site_id
     OR NEW.offered_by <> OLD.offered_by OR NEW.offered_at <> OLD.offered_at
  THEN
    RAISE EXCEPTION 'A share''s record, site and offer never change.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'record_shares_identity';
  END IF;
  IF NOT (
    (OLD.state = 'offered' AND NEW.state IN ('accepted', 'declined', 'withdrawn', 'deleted', 'moved'))
    OR (OLD.state = 'accepted' AND NEW.state IN ('withdrawn', 'removed', 'deleted', 'moved'))
  ) THEN
    RAISE EXCEPTION 'That change of a share is not allowed.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'record_shares_life';
  END IF;
  -- `deleted` and `moved` say what happened to the record, and the database
  -- checks it happened: the record is gone, or is on the second site now.
  IF NEW.state = 'deleted' AND EXISTS (
    SELECT 1 FROM public.records r
    WHERE r.organization_id = NEW.organization_id AND r.id = NEW.record_id)
  THEN
    RAISE EXCEPTION 'A share ends as deleted only when its record is.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'record_shares_life';
  END IF;
  IF NEW.state = 'moved' AND NOT EXISTS (
    SELECT 1 FROM public.records r
    WHERE r.organization_id = NEW.organization_id AND r.id = NEW.record_id
      AND NEW.target_organization_id = NEW.organization_id
      AND r.site_id = NEW.target_site_id)
  THEN
    RAISE EXCEPTION 'A share ends as moved only when its record is on that site.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'record_shares_life';
  END IF;
  -- A decision is made only by accepting or declining, and then stays as it
  -- was: no ending ever sets or changes one.
  IF NEW.state IN ('withdrawn', 'removed', 'deleted', 'moved')
     AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by
          OR NEW.decided_at IS DISTINCT FROM OLD.decided_at)
  THEN
    RAISE EXCEPTION 'A share''s decision never changes.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'record_shares_identity';
  END IF;
  -- Each new time is the moment of the change.
  IF (NEW.decided_at IS DISTINCT FROM OLD.decided_at
      AND (NEW.decided_at < now() OR NEW.decided_at > clock_timestamp()))
     OR (NEW.ended_at IS DISTINCT FROM OLD.ended_at
         AND (NEW.ended_at < now() OR NEW.ended_at > clock_timestamp()))
  THEN
    RAISE EXCEPTION 'A decision or an end is stamped when it is made.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'record_shares_now';
  END IF;
  RETURN NEW;
END
$$;

-- 1 and 2: what happens to a record's live shares when it is deleted or
-- moved. SECURITY DEFINER is not needed: whoever may delete or move a record
-- is the writer, which may update shares (roles.ts).
CREATE FUNCTION public.record_shares_follow_record() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.record_shares
      SET state = 'deleted', ended_at = clock_timestamp()
      WHERE organization_id = OLD.organization_id AND record_id = OLD.id
        AND state IN ('offered', 'accepted');
    RETURN OLD;
  END IF;
  IF NEW.site_id IS DISTINCT FROM OLD.site_id AND NEW.site_id IS NOT NULL THEN
    UPDATE public.record_shares
      SET state = 'moved', ended_at = clock_timestamp()
      WHERE organization_id = NEW.organization_id AND record_id = NEW.id
        AND target_organization_id = NEW.organization_id AND target_site_id = NEW.site_id
        AND state IN ('offered', 'accepted');
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER zzzz_records_shares_follow_delete AFTER DELETE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.record_shares_follow_record();
CREATE TRIGGER zzzz_records_shares_follow_move AFTER UPDATE OF site_id ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.record_shares_follow_record();

ALTER TABLE public.records ENABLE ALWAYS TRIGGER zzzz_records_shares_follow_delete;
ALTER TABLE public.records ENABLE ALWAYS TRIGGER zzzz_records_shares_follow_move;

-- Shares left live by moves made before this file: end them now, as a move
-- from here on does.
UPDATE public.record_shares sh
  SET state = 'moved', ended_at = clock_timestamp()
  FROM public.records r
  WHERE r.organization_id = sh.organization_id AND r.id = sh.record_id
    AND sh.target_organization_id = sh.organization_id AND r.site_id = sh.target_site_id
    AND sh.state IN ('offered', 'accepted');
