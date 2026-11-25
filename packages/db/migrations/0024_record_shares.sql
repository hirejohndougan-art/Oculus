-- Sharing items between sites (T-041b, D-074, D-094). Numbered 0024 (0022
-- and 0023 are reserved by other branches; the runner allows gaps).
--
-- record_shares: one row per offer of a record from its home site to
-- another site, of the same organization or another one. Its life:
--   offered  -> accepted | declined | withdrawn
--   accepted -> withdrawn (by the home side) | removed (by the second site)
-- declined, withdrawn and removed are final; offering again makes a new
-- row. At most one live offer (offered or accepted) per record and site.
-- The record's own organization is `organization_id` (the home side); the
-- second site is (`target_organization_id`, `target_site_id`), a composite
-- key, so it is always a real site of that organization.
--
-- The database checks the shape and the life: the identity columns never
-- change, a state moves only along the arrows above with who and when
-- (stamped at the moment of the change), a decision is made only by
-- accepting or declining, and a record is never offered to its own home
-- site (read under the record's key-share lock). A share into a site the
-- record was moved to later is left out by every reader (shares.ts). Who may offer, decide
-- and end a share is the service's (shares.ts). Rows go when their record
-- is deleted (ON DELETE CASCADE): a deleted record is shown nowhere. The
-- writer has SELECT, INSERT and UPDATE (roles.ts), never DELETE.
--
-- Every trigger here is ENABLE ALWAYS (D-067), so replica mode skips none.

CREATE TABLE public.record_shares (
  id uuid PRIMARY KEY
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  organization_id uuid NOT NULL,
  record_id uuid NOT NULL,
  target_organization_id uuid NOT NULL,
  target_site_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'offered'
    CONSTRAINT record_shares_state_known
    CHECK (state IN ('offered', 'accepted', 'declined', 'withdrawn', 'removed')),
  offered_by uuid NOT NULL REFERENCES public.users (id),
  offered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Accepted or declined: by whom and when.
  decided_by uuid REFERENCES public.users (id),
  decided_at timestamptz,
  -- Withdrawn or removed: by whom and when.
  ended_by uuid REFERENCES public.users (id),
  ended_at timestamptz,
  FOREIGN KEY (organization_id, record_id)
    REFERENCES public.records (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (target_organization_id, target_site_id)
    REFERENCES public.sites (organization_id, id),
  CONSTRAINT record_shares_shape CHECK (
    CASE state
      WHEN 'offered' THEN decided_by IS NULL AND decided_at IS NULL
                          AND ended_by IS NULL AND ended_at IS NULL
      WHEN 'accepted' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
                           AND ended_by IS NULL AND ended_at IS NULL
      WHEN 'declined' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
                           AND ended_by IS NULL AND ended_at IS NULL
      ELSE ended_by IS NOT NULL AND ended_at IS NOT NULL
           AND (decided_by IS NULL) = (decided_at IS NULL)
    END)
);

-- One live offer per record and site.
CREATE UNIQUE INDEX record_shares_one_live
  ON public.record_shares (organization_id, record_id, target_organization_id, target_site_id)
  WHERE state IN ('offered', 'accepted');
-- A site's offers and accepted items.
CREATE INDEX record_shares_target
  ON public.record_shares (target_organization_id, target_site_id, state, offered_at DESC, id);
-- A record's shares.
CREATE INDEX record_shares_record ON public.record_shares (organization_id, record_id);

CREATE FUNCTION public.record_shares_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  home uuid;
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
    -- Locked, so a move of the record can't slip past this check.
    SELECT r.site_id INTO home FROM public.records r
      WHERE r.organization_id = NEW.organization_id AND r.id = NEW.record_id FOR KEY SHARE;
    IF NEW.target_organization_id = NEW.organization_id AND home IS NOT DISTINCT FROM NEW.target_site_id
    THEN
      RAISE EXCEPTION 'A record is not offered to its own home site.'
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'record_shares_not_home';
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
    (OLD.state = 'offered' AND NEW.state IN ('accepted', 'declined', 'withdrawn'))
    OR (OLD.state = 'accepted' AND NEW.state IN ('withdrawn', 'removed'))
  ) THEN
    RAISE EXCEPTION 'That change of a share is not allowed.'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'record_shares_life';
  END IF;
  -- A decision is made only by accepting or declining, and then stays as it
  -- was: withdrawing an offer or ending an item never sets or changes one.
  IF NEW.state IN ('withdrawn', 'removed')
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

CREATE TRIGGER record_shares_check
  BEFORE INSERT OR UPDATE ON public.record_shares
  FOR EACH ROW EXECUTE FUNCTION public.record_shares_check();

ALTER TABLE public.record_shares ENABLE ALWAYS TRIGGER record_shares_check;
