-- Loans in and out, and condition checks (T-018b with T-018a and S-013,
-- D-118; core: loans.ts and condition-checks.ts, D-044). Numbered 0058:
-- main has 0050 and 0055, and 0051 to 0057 are reserved on the work board by
-- other chats (the runner allows gaps).
--
-- STAFF ONLY: loans name lenders, borrowers, values, insurance and dates;
-- condition checks name checkers. The public reader (D-080) has no
-- privilege on any table here, and nothing public reads them.
--
-- loans: one row per loan, the core Loan as `definition`, checked by core
-- against the whole move log and every other loan (indexLoans, withLoan)
-- under the organization's storage lock before every save. Its direction
-- and agent are generated from `definition`; the direction never changes
-- (the trigger). `number_key` is core's fold of the number, unique per
-- organization and direction. `version` goes up by one on every update;
-- who made and last changed it, and when, are stamped here. Loans are never
-- deleted (a loan that didn't happen is cancelled or declined).
--
-- loan_records: the records on each loan, kept by a trigger from
-- definition.items (the writer has no privilege on it), with foreign keys
-- to records: a record on a loan can't be deleted.
--
-- loan_versions: every definition saved, with who and when, written by a
-- trigger (insert only), so every explicit way an item was settled (D-118)
-- is in the history.
--
-- condition_checks: the core ConditionCheck as `definition`, insert only
-- (a later check supersedes an earlier one); its record, checker and loan
-- generated from it, with foreign keys; written down at the database's time
-- (the trigger checks it, as for moves).
--
-- Every trigger here is ENABLE ALWAYS (D-067).

CREATE TABLE public.loans (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  direction text NOT NULL GENERATED ALWAYS AS (definition ->> 'direction') STORED,
  agent_id uuid NOT NULL GENERATED ALWAYS AS ((definition ->> 'agentId')::uuid) STORED,
  number_key text NOT NULL CHECK (length(number_key) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES public.users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL REFERENCES public.users (id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT loans_number_unique UNIQUE (organization_id, direction, number_key),
  CONSTRAINT loans_identity CHECK (
    definition ->> 'id' = id::text AND definition ->> 'organizationId' = organization_id::text),
  CONSTRAINT loans_direction_known CHECK (direction IN ('in', 'out')),
  CONSTRAINT loans_items_list CHECK (jsonb_typeof(definition -> 'items') = 'array'),
  FOREIGN KEY (organization_id, agent_id) REFERENCES public.records (organization_id, id)
);

CREATE INDEX loans_agent ON public.loans (organization_id, agent_id);

CREATE TABLE public.loan_records (
  organization_id uuid NOT NULL,
  loan_id uuid NOT NULL,
  record_id uuid NOT NULL,
  PRIMARY KEY (organization_id, loan_id, record_id),
  FOREIGN KEY (organization_id, loan_id) REFERENCES public.loans (organization_id, id),
  FOREIGN KEY (organization_id, record_id) REFERENCES public.records (organization_id, id)
);

CREATE INDEX loan_records_record ON public.loan_records (organization_id, record_id);

CREATE TABLE public.loan_versions (
  organization_id uuid NOT NULL,
  loan_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  definition jsonb NOT NULL,
  saved_by uuid NOT NULL REFERENCES public.users (id),
  saved_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, loan_id, version),
  FOREIGN KEY (organization_id, loan_id) REFERENCES public.loans (organization_id, id)
);

CREATE TABLE public.condition_checks (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  id uuid NOT NULL
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  record_id uuid NOT NULL GENERATED ALWAYS AS ((definition ->> 'recordId')::uuid) STORED,
  checker_id uuid GENERATED ALWAYS AS ((definition ->> 'checkerId')::uuid) STORED,
  loan_id uuid GENERATED ALWAYS AS ((definition ->> 'loanId')::uuid) STORED,
  recorded_by uuid NOT NULL REFERENCES public.users (id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT condition_checks_identity CHECK (
    definition ->> 'id' = id::text AND definition ->> 'organizationId' = organization_id::text),
  FOREIGN KEY (organization_id, record_id) REFERENCES public.records (organization_id, id),
  FOREIGN KEY (organization_id, checker_id) REFERENCES public.records (organization_id, id),
  FOREIGN KEY (organization_id, loan_id) REFERENCES public.loans (organization_id, id)
);

CREATE INDEX condition_checks_record ON public.condition_checks (organization_id, record_id);
CREATE INDEX condition_checks_checker ON public.condition_checks (organization_id, checker_id);
CREATE INDEX condition_checks_loan ON public.condition_checks (organization_id, loan_id);

-- Identity, direction and creation never change; the version goes up by
-- exactly one; the change is stamped now.
CREATE FUNCTION public.loans_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'a new loan starts at version 1' USING ERRCODE = 'OC081';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    NEW.updated_by := NEW.created_by;
    RETURN NEW;
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.id <> OLD.id
     OR NEW.definition ->> 'direction' IS DISTINCT FROM OLD.direction
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a loan''s identity, direction and creation never change' USING ERRCODE = 'OC082';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a loan''s version goes up by one on every change' USING ERRCODE = 'OC083';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER loans_guard BEFORE INSERT OR UPDATE ON public.loans
  FOR EACH ROW EXECUTE FUNCTION public.loans_guard();
ALTER TABLE public.loans ENABLE ALWAYS TRIGGER loans_guard;

-- The records on the loan and the history, from the saved row (as the
-- owner: the writer can't write either table itself).
CREATE FUNCTION public.loans_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM public.loan_records
  WHERE organization_id = NEW.organization_id AND loan_id = NEW.id;
  INSERT INTO public.loan_records (organization_id, loan_id, record_id)
  SELECT DISTINCT NEW.organization_id, NEW.id, (item.value ->> 'recordId')::uuid
  FROM jsonb_array_elements(NEW.definition -> 'items') AS item(value);
  INSERT INTO public.loan_versions
    (organization_id, loan_id, version, definition, saved_by, saved_at)
  VALUES (NEW.organization_id, NEW.id, NEW.version, NEW.definition, NEW.updated_by,
          NEW.updated_at);
  RETURN NULL;
END
$$;

CREATE TRIGGER loans_after AFTER INSERT OR UPDATE ON public.loans
  FOR EACH ROW EXECUTE FUNCTION public.loans_after();
ALTER TABLE public.loans ENABLE ALWAYS TRIGGER loans_after;

-- A check's written-down time is the database's, and matches the core
-- check's recordedAt (set by the service from the same clock).
CREATE FUNCTION public.condition_checks_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.definition ->> 'recordedAt'
     IS DISTINCT FROM to_char(NEW.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RAISE EXCEPTION 'a check''s recordedAt must be when it was written down' USING ERRCODE = 'OC084';
  END IF;
  IF NEW.recorded_at > clock_timestamp()
     OR NEW.recorded_at < clock_timestamp() - interval '1 minute' THEN
    RAISE EXCEPTION 'a check is written down at the database''s time' USING ERRCODE = 'OC085';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER condition_checks_guard BEFORE INSERT ON public.condition_checks
  FOR EACH ROW EXECUTE FUNCTION public.condition_checks_guard();
ALTER TABLE public.condition_checks ENABLE ALWAYS TRIGGER condition_checks_guard;
