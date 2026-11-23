-- Identifier types and the numbers records hold (T-026, D-061): each
-- organization's identifier types, every record's current and former
-- identifiers, and the counters auto-numbering gives numbers out from.
--
-- Uniqueness is the database's, not only the application's (D-009): every
-- value is stored with its comparison key (core's identifierKey, worked out
-- before writing and checked again after reading), and partial unique indexes
-- on (organization_id, type_key, key) enforce the `current` and `all_time`
-- rules, so two saves at the same moment can't both take a number. They are
-- scoped to the organization: two organizations can hold the same number
-- (D-019, D-030).
--
-- How the rules are indexed: identifier_holdings has one row per number a
-- record holds or held, per (type, key), whether current, former or both (one
-- record may hold a number as current and former: retired and reinstated, and
-- may list two spellings of one former number). Each holding carries its
-- type's uniqueness rule, which the database copies from identifier_types
-- (zzzz_identifier_holdings_take_rule, so no writer can choose it) and keeps
-- in step (the foreign key cascades a changed rule, and the unique indexes
-- then check every holding against it in the same statement: tightening a
-- type's rule over clashing values is refused). The exact values, the primary
-- mark, list order, retirement dates and notes live in record_identifiers and
-- former_identifiers, each pointing at its holding.
--
-- A former identifier may name a type that no longer exists or never did
-- (imported history, D-009); its holding's rule is then null and it counts
-- for nothing, as in core. When a type with that key is created later, its
-- rule is filled in (zzzz_identifier_types_adopt_holdings, however the type
-- is inserted), so the indexes then check those values too. A current
-- identifier always names an existing type.
--
-- Writes of holdings and of types meet at one lock per (organization, type
-- key bucket), a transaction-level advisory lock (identifier_type_lock_key,
-- 64 buckets per organization, so a transaction never holds more): every
-- holding write takes it shared, in its trigger, and every type insert,
-- update or delete takes it exclusive, in its trigger, so direct writers are
-- covered too. A type and a holding of its key are then never written at the
-- same moment: without it, a save that read "no such type" (null rule) and a
-- type created at the same moment could each miss the other, leaving a
-- number outside both unique indexes for good. allocateIdentifier takes the
-- lock exclusive too, so it waits for saves of the type that haven't
-- committed (and they wait for it). All of this needs each statement to take
-- a new snapshot, so these writes refuse to run outside Read Committed
-- (identifier_require_read_committed).
--
-- Nothing cascades on delete: a type, a record or a holding something points
-- at can't be deleted. Identity is fixed by catalog_keep_identity (0002), with
-- triggers named zzzz_* as there.

-- An organization's identifier type, as the JSON validateIdentifierType
-- accepted, one row per type, edited in place. Its uniqueness rule is also a
-- column, so holdings can point at it with a foreign key that cascades.
CREATE TABLE public.identifier_types (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  uniqueness text NOT NULL CHECK (uniqueness IN ('none', 'current', 'all_time')),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key),
  -- The target of identifier_holdings' foreign key.
  UNIQUE (organization_id, key, uniqueness),
  CHECK (definition ->> 'key' IS NOT DISTINCT FROM key),
  CHECK (definition ->> 'organizationId' IS NOT DISTINCT FROM organization_id::text),
  CHECK (definition ->> 'uniqueness' IS NOT DISTINCT FROM uniqueness)
);

-- One number (by type and comparison key) a record holds or held.
CREATE TABLE public.identifier_holdings (
  organization_id uuid NOT NULL,
  record_id uuid NOT NULL,
  type_key text NOT NULL CHECK (type_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- identifierKey(value), computed by core: the database can't compute it.
  key text NOT NULL,
  -- The type's rule, copied by the trigger below; null when no such type exists.
  uniqueness text CHECK (uniqueness IN ('none', 'current', 'all_time')),
  -- True while the record holds the number as a current identifier.
  current boolean NOT NULL,
  PRIMARY KEY (organization_id, record_id, type_key, key),
  -- Target of record_identifiers' foreign key, which requires current.
  UNIQUE (organization_id, record_id, type_key, key, current),
  FOREIGN KEY (organization_id, record_id) REFERENCES public.records (organization_id, id),
  CONSTRAINT identifier_holdings_type_rule FOREIGN KEY (organization_id, type_key, uniqueness)
    REFERENCES public.identifier_types (organization_id, key, uniqueness)
    ON UPDATE CASCADE,
  CONSTRAINT identifier_holdings_current_has_type CHECK (NOT current OR uniqueness IS NOT NULL)
);

-- The rules themselves. `current`: no two records hold the number as current.
-- `all_time`: no two records ever held it, current or former.
CREATE UNIQUE INDEX identifier_holdings_current_unique
  ON public.identifier_holdings (organization_id, type_key, key)
  WHERE uniqueness = 'current' AND current;
CREATE UNIQUE INDEX identifier_holdings_all_time_unique
  ON public.identifier_holdings (organization_id, type_key, key)
  WHERE uniqueness = 'all_time';
-- Finding records by a number, current or former, in one organization (T-028).
CREATE INDEX identifier_holdings_lookup ON public.identifier_holdings (organization_id, key);

-- A record's current identifiers, in their order; exactly as typed.
CREATE TABLE public.record_identifiers (
  organization_id uuid NOT NULL,
  record_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 49),
  type_key text NOT NULL,
  value text NOT NULL
    CHECK (value <> '' AND length(value) <= 200 AND btrim(value) = value
           AND value !~ '[\t\n\r  ]'),
  key text NOT NULL,
  is_primary boolean NOT NULL,
  -- Always true: the foreign key below then requires a current holding.
  current boolean NOT NULL DEFAULT true CHECK (current),
  PRIMARY KEY (organization_id, record_id, position),
  -- No number twice as current on one record (core: `duplicate`).
  UNIQUE (organization_id, record_id, type_key, key),
  FOREIGN KEY (organization_id, record_id, type_key, key, current)
    REFERENCES public.identifier_holdings (organization_id, record_id, type_key, key, current)
);
-- At most one primary per record (core: exactly one when there are any).
CREATE UNIQUE INDEX record_identifiers_one_primary
  ON public.record_identifiers (organization_id, record_id) WHERE is_primary;
-- Auto-numbering reads every value of one type.
CREATE INDEX record_identifiers_type ON public.record_identifiers (organization_id, type_key);

-- A record's former identifiers, in their order, kept so old numbers still
-- find it. Exactly as typed; the type may no longer exist.
CREATE TABLE public.former_identifiers (
  organization_id uuid NOT NULL,
  record_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 499),
  type_key text NOT NULL,
  value text NOT NULL
    CHECK (value <> '' AND length(value) <= 200 AND btrim(value) = value
           AND value !~ '[\t\n\r  ]'),
  key text NOT NULL,
  -- Whole milliseconds, as core writes them, like records' timestamps.
  retired_at timestamptz
    CHECK (date_trunc('milliseconds', retired_at AT TIME ZONE 'UTC') = retired_at AT TIME ZONE 'UTC'),
  note text CHECK (note <> '' AND length(note) <= 1000),
  PRIMARY KEY (organization_id, record_id, position),
  -- The same exact value isn't listed twice (core: `duplicate`).
  UNIQUE (organization_id, record_id, type_key, value),
  FOREIGN KEY (organization_id, record_id, type_key, key)
    REFERENCES public.identifier_holdings (organization_id, record_id, type_key, key)
);
CREATE INDEX former_identifiers_type ON public.former_identifiers (organization_id, type_key);

-- The last number auto-numbering gave out for a type, per series: the year
-- for year-based numbering, '' for prefix numbering. allocateIdentifier locks
-- the row (FOR UPDATE) for the rest of its transaction, so two allocations of
-- one type never run at once, and a number given out whose save never came
-- is still never given out again.
CREATE TABLE public.identifier_counters (
  organization_id uuid NOT NULL,
  type_key text NOT NULL,
  series text NOT NULL CHECK (series = '' OR series ~ '^[0-9]{4}$'),
  last_value text
    CHECK (last_value <> '' AND length(last_value) <= 200 AND btrim(last_value) = last_value
           AND last_value !~ '[\t\n\r  ]'),
  PRIMARY KEY (organization_id, type_key, series),
  FOREIGN KEY (organization_id, type_key) REFERENCES public.identifier_types (organization_id, key)
);

-- The advisory lock key of one organization's identifier type key (see the
-- top of this file): one of 64 keys (buckets) per
-- organization, picked by a hash of the type key. However many type keys a
-- transaction writes (a record's former numbers may name up to 500 unknown
-- ones), it holds at most 64 of these locks per organization, so it can't
-- fill the server's shared lock table. Two types in one bucket only wait for
-- each other.
CREATE FUNCTION public.identifier_type_lock_bucket(type_key text)
RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT (hashtextextended(type_key, 0) & 63)::integer $$;

CREATE FUNCTION public.identifier_bucket_lock_key(organization_id uuid, bucket integer)
RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT hashtextextended(
    'oculus.identifier_type/' || organization_id::text || '/' || bucket::text, 0)
$$;

CREATE FUNCTION public.identifier_type_lock_key(organization_id uuid, type_key text)
RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT public.identifier_bucket_lock_key(
    organization_id, public.identifier_type_lock_bucket(type_key))
$$;

-- Every write here relies on each statement taking a new snapshot (it reads
-- what was committed while it waited for a lock). Under Repeatable Read or
-- Serializable a statement reads the transaction's first snapshot instead,
-- and a type and a holding written at the same moment could miss each other
-- again, so writes are refused there (SQLSTATE OC061).
CREATE FUNCTION public.identifier_require_read_committed() RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Identifier writes must run in a Read Committed transaction, not %.',
        current_setting('transaction_isolation')
      USING ERRCODE = 'OC061';
  END IF;
END
$$;

-- Takes the lock of every given type key of one organization, shared or
-- exclusive, each bucket once, in bucket order (the same in every
-- organization): two callers never take two buckets in opposite orders.
CREATE FUNCTION public.identifier_type_locks(organization_id uuid, type_keys text[], exclusive boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  bucket integer;
BEGIN
  PERFORM public.identifier_require_read_committed();
  FOR bucket IN
    SELECT DISTINCT public.identifier_type_lock_bucket(k) FROM unnest(type_keys) AS k ORDER BY 1
  LOOP
    IF exclusive THEN
      PERFORM pg_advisory_xact_lock(public.identifier_bucket_lock_key(organization_id, bucket));
    ELSE
      PERFORM pg_advisory_xact_lock_shared(public.identifier_bucket_lock_key(organization_id, bucket));
    END IF;
  END LOOP;
END
$$;

-- Types take their key's lock exclusive before they change. On update and
-- delete the row is already locked when a BEFORE trigger runs, so a save
-- holding the type FOR SHARE is waited for first, in the same order a save
-- takes them (type rows, then this lock).
CREATE FUNCTION public.identifier_types_lock() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.identifier_require_read_committed();
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(public.identifier_type_lock_key(OLD.organization_id, OLD.key));
    RETURN OLD;
  END IF;
  PERFORM pg_advisory_xact_lock(public.identifier_type_lock_key(NEW.organization_id, NEW.key));
  RETURN NEW;
END
$$;

CREATE TRIGGER zzzz_identifier_types_lock BEFORE INSERT OR UPDATE OR DELETE ON public.identifier_types
  FOR EACH ROW EXECUTE FUNCTION public.identifier_types_lock();

-- A new type adopts the holdings already stored under its key (former numbers
-- of a deleted or imported type, D-009): their rule is filled in by the
-- holdings' trigger below, and the unique indexes check them in this same
-- statement, so a clash refuses the type. In the database, not the
-- application, so a type inserted by direct SQL adopts them too. It runs
-- after the type's lock was taken (BEFORE trigger above), so its own
-- statement sees every holding committed before then.
CREATE FUNCTION public.identifier_types_adopt_holdings() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.identifier_holdings h SET uniqueness = NULL
  WHERE h.organization_id = NEW.organization_id AND h.type_key = NEW.key
    AND h.uniqueness IS NULL;
  RETURN NULL;
END
$$;

CREATE TRIGGER zzzz_identifier_types_adopt_holdings AFTER INSERT ON public.identifier_types
  FOR EACH ROW EXECUTE FUNCTION public.identifier_types_adopt_holdings();

-- A holding's rule is always its type's, never what the writer sent: set on
-- every insert and update (including the foreign key's cascade, which runs
-- after the type row changed, so it reads the new rule), after taking the
-- type key's lock shared, so a type being created or changed at the same
-- moment is waited for and then seen (each statement here takes a new
-- snapshot, which is why Read Committed is required). Fixed search path, as
-- catalog_keep_identity.
CREATE FUNCTION public.identifier_holdings_take_rule() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.identifier_require_read_committed();
  PERFORM pg_advisory_xact_lock_shared(
    public.identifier_type_lock_key(NEW.organization_id, NEW.type_key));
  NEW.uniqueness := (
    SELECT t.uniqueness FROM public.identifier_types t
    WHERE t.organization_id = NEW.organization_id AND t.key = NEW.type_key
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER zzzz_identifier_holdings_take_rule BEFORE INSERT OR UPDATE ON public.identifier_holdings
  FOR EACH ROW EXECUTE FUNCTION public.identifier_holdings_take_rule();

CREATE TRIGGER zzzz_identifier_types_keep_identity BEFORE UPDATE ON public.identifier_types
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'key');
CREATE TRIGGER zzzz_identifier_holdings_keep_identity BEFORE UPDATE ON public.identifier_holdings
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'record_id', 'type_key', 'key');
CREATE TRIGGER zzzz_record_identifiers_keep_identity BEFORE UPDATE ON public.record_identifiers
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'record_id', 'position');
CREATE TRIGGER zzzz_former_identifiers_keep_identity BEFORE UPDATE ON public.former_identifiers
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'record_id', 'position');
CREATE TRIGGER zzzz_identifier_counters_keep_identity BEFORE UPDATE ON public.identifier_counters
  FOR EACH ROW EXECUTE FUNCTION public.catalog_keep_identity('organization_id', 'type_key', 'series');
