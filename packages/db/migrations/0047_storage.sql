-- Storage levels, locations and moves (T-018d, D-115; core: storage.ts,
-- D-040).
--
-- STAFF ONLY: shelf and box locations tell a thief where to look, and moves
-- name conservators, borrowers and dates. The public reader (D-080) has no
-- privilege on any table here, and nothing public reads them.
--
-- storage_levels: one row per organization, the core StorageLevels as
-- `definition`. storage_locations: one row per location, the core
-- StorageLocation as `definition`, its outside agent generated from it
-- (with a foreign key, so an agent a location names can't be deleted).
-- Both are versioned (the version goes up by one on every change) and never
-- deleted here (core: a used location is renamed or left empty).
--
-- storage_moves: the move log, the only truth of where a record is (D-040):
-- one row per move, the core StorageMove as `definition`, insert only
-- (a mistake is put right by a later `correction` move). Its record and
-- location are generated from `definition`, with foreign keys, so a record
-- that has moved can't be deleted and a move can't name a missing location.
--
-- Every save validates the organization's whole storage in core first
-- (indexLocations, indexMoves, withMove, reindexLocations) under the
-- organization's storage lock (storage.ts in packages/db).
-- Every trigger here is ENABLE ALWAYS (D-067).

CREATE TABLE public.storage_levels (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations (id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  updated_by uuid NOT NULL REFERENCES public.users (id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT storage_levels_identity
    CHECK (definition ->> 'organizationId' = organization_id::text)
);

CREATE TABLE public.storage_locations (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  agent_id uuid GENERATED ALWAYS AS ((definition ->> 'agentId')::uuid) STORED,
  updated_by uuid NOT NULL REFERENCES public.users (id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT storage_locations_identity CHECK (
    definition ->> 'id' = id::text AND definition ->> 'organizationId' = organization_id::text),
  FOREIGN KEY (organization_id, agent_id) REFERENCES public.records (organization_id, id)
);

CREATE TABLE public.storage_moves (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  record_id uuid NOT NULL GENERATED ALWAYS AS ((definition ->> 'recordId')::uuid) STORED,
  location_id uuid NOT NULL GENERATED ALWAYS AS ((definition ->> 'locationId')::uuid) STORED,
  recorded_by uuid NOT NULL REFERENCES public.users (id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT storage_moves_identity CHECK (
    definition ->> 'id' = id::text AND definition ->> 'organizationId' = organization_id::text),
  FOREIGN KEY (organization_id, record_id) REFERENCES public.records (organization_id, id),
  FOREIGN KEY (organization_id, location_id)
    REFERENCES public.storage_locations (organization_id, id)
);

CREATE INDEX storage_moves_record ON public.storage_moves (organization_id, record_id);
CREATE INDEX storage_locations_agent ON public.storage_locations (organization_id, agent_id);

-- Identity never changes; a version goes up by exactly one; the change is
-- stamped now.
CREATE FUNCTION public.storage_versioned_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'a new storage row starts at version 1' USING ERRCODE = 'OC081';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.organization_id <> OLD.organization_id
     OR (TG_TABLE_NAME = 'storage_locations' AND NEW.definition ->> 'id' <> OLD.definition ->> 'id') THEN
    RAISE EXCEPTION 'a storage row''s identity never changes' USING ERRCODE = 'OC082';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a storage row''s version goes up by one on every change' USING ERRCODE = 'OC083';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER storage_levels_guard BEFORE INSERT OR UPDATE ON public.storage_levels
  FOR EACH ROW EXECUTE FUNCTION public.storage_versioned_guard();
ALTER TABLE public.storage_levels ENABLE ALWAYS TRIGGER storage_levels_guard;
CREATE TRIGGER storage_locations_guard BEFORE INSERT OR UPDATE ON public.storage_locations
  FOR EACH ROW EXECUTE FUNCTION public.storage_versioned_guard();
ALTER TABLE public.storage_locations ENABLE ALWAYS TRIGGER storage_locations_guard;

-- A move's written-down time is the database's, and it matches the core
-- move's recordedAt (set by the service from the same clock).
CREATE FUNCTION public.storage_moves_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.definition ->> 'recordedAt'
     IS DISTINCT FROM to_char(NEW.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RAISE EXCEPTION 'a move''s recordedAt must be when it was written down' USING ERRCODE = 'OC084';
  END IF;
  -- Written down now, by the database's clock: never back- or forward-dated
  -- (same-day moves are ordered by it).
  IF NEW.recorded_at > clock_timestamp()
     OR NEW.recorded_at < clock_timestamp() - interval '1 minute' THEN
    RAISE EXCEPTION 'a move is written down at the database''s time' USING ERRCODE = 'OC085';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER storage_moves_guard BEFORE INSERT ON public.storage_moves
  FOR EACH ROW EXECUTE FUNCTION public.storage_moves_guard();
ALTER TABLE public.storage_moves ENABLE ALWAYS TRIGGER storage_moves_guard;
