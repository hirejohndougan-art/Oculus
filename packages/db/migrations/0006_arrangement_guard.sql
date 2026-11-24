-- The arrangement guard (T-030 review, D-065): no archival unit is ever filed
-- inside itself, and no unit sits deeper than core's MAX_ARRANGEMENT_DEPTH
-- (64), whoever writes, even two writers at the same moment. (Levels are
-- the writer's check, below.)
--
-- Two transactions that each file one unit under the other (A under B, B
-- under A) each see a tree without a loop, because neither sees the other's
-- uncommitted change. So every insert of a unit with a parent, and every
-- update that changes a unit's parent or level, first takes one exclusive
-- transaction-level advisory lock per organization (arrangement_lock), held
-- until COMMIT or ROLLBACK, and only then walks up from the unit through
-- the rows as now committed. The second writer waits for the first to
-- finish; its walk, a new statement under Read Committed, then sees the
-- first's change and refuses the loop. Other organizations never wait.
--
-- Read Committed is required, as for identifiers (D-061, SQLSTATE OC061):
-- under Repeatable Read the walk would read the transaction's first
-- snapshot and miss what committed while it waited.
--
-- Checks back up core, never go beyond it (D-060): core's
-- validateArrangement refuses loops and units deeper than 64. Here, the walk
-- up from the written unit refuses a loop and more than 63 ancestors, and
-- when a unit's parent changes, a bounded walk down its own subtree refuses
-- a move that would put any of its descendants deeper than 64. Whether
-- levels fit (a unit under its parent, its children under it) is not
-- checked here: the writer checks it (restoreVersion now, the service
-- layer, T-032), after taking arrangement_lock.

-- Read Committed only, with its own message (the code is the identifiers'
-- OC061, which the data-access layer maps to read_committed_required).
CREATE FUNCTION public.arrangement_require_read_committed() RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Arrangement writes must run in a Read Committed transaction, not %.',
        current_setting('transaction_isolation')
      USING ERRCODE = 'OC061';
  END IF;
END
$$;

-- One lock key per organization, in the two-int key space (classid 65 for
-- D-065), which never meets the single-bigint keys of the identifier locks
-- (0003) or the migration lock.
CREATE FUNCTION public.arrangement_lock(organization_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.arrangement_require_read_committed();
  PERFORM pg_advisory_xact_lock(65, hashtext(organization_id::text));
END
$$;

CREATE FUNCTION public.records_arrangement_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_parent uuid;
  ancestors integer := 0;
  room integer;
BEGIN
  PERFORM public.arrangement_lock(NEW.organization_id);
  -- Up from the unit's parent, through rows as now committed (and this
  -- transaction's own), stopping at the top, at the unit itself (a loop) or
  -- past the depth limit.
  current_parent := NEW.parent_id;
  WHILE current_parent IS NOT NULL LOOP
    IF current_parent = NEW.id THEN
      RAISE EXCEPTION 'An archival unit can''t be filed inside itself.'
        USING ERRCODE = 'integrity_constraint_violation',
              CONSTRAINT = 'records_arrangement_loop';
    END IF;
    ancestors := ancestors + 1;
    -- The unit sits at depth ancestors + 1; the limit is 64.
    IF ancestors > 63 THEN
      RAISE EXCEPTION 'An archival unit can be at most 64 levels deep.'
        USING ERRCODE = 'integrity_constraint_violation',
              CONSTRAINT = 'records_arrangement_too_deep';
    END IF;
    SELECT parent_id INTO current_parent FROM public.records
    WHERE organization_id = NEW.organization_id AND id = current_parent;
  END LOOP;
  -- A moved unit takes its subtree with it: no descendant may then sit
  -- deeper than 64. Walk down only as far as the room left below the unit,
  -- stopping at the first unit past it. (A new row has no children yet.)
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    room := 63 - ancestors;
    IF EXISTS (
      WITH RECURSIVE down(id, depth) AS (
        SELECT r.id, 1 FROM public.records r
        WHERE r.organization_id = NEW.organization_id AND r.parent_id = NEW.id
        UNION ALL
        SELECT r.id, down.depth + 1
        FROM down JOIN public.records r
          ON r.organization_id = NEW.organization_id AND r.parent_id = down.id
        WHERE down.depth <= room
      )
      SELECT 1 FROM down WHERE depth > room
    ) THEN
      RAISE EXCEPTION 'Moved there, a unit inside this one would be more than 64 levels deep.'
        USING ERRCODE = 'integrity_constraint_violation',
              CONSTRAINT = 'records_arrangement_too_deep';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- AFTER, so the walk sees the row as written; not deferred, so a refusal is
-- the writing statement's (inside the writer's savepoint, a clean issue) and
-- the lock is held from the write to the end of the transaction.
CREATE TRIGGER zzzz_records_arrangement_insert AFTER INSERT ON public.records
  FOR EACH ROW WHEN (NEW.parent_id IS NOT NULL)
  EXECUTE FUNCTION public.records_arrangement_guard();
CREATE TRIGGER zzzz_records_arrangement_update AFTER UPDATE OF parent_id, level ON public.records
  FOR EACH ROW WHEN (NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.level IS DISTINCT FROM OLD.level)
  EXECUTE FUNCTION public.records_arrangement_guard();
