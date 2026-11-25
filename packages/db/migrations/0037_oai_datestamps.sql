-- Stored OAI-PMH datestamps (S-041, D-108).
--
-- oai_datestamps: for each public site, one row per record whose public
-- output the site has shown: when that output last changed (`stamp`) and a
-- SHA-256 of its oai_dc record (`fingerprint`), so a change anywhere that
-- alters what the public sees (the record itself, a parent's or linked
-- record's title, a vocabulary label, its mapping, its coming out of being
-- held back) moves the stamp, and nothing else does. When a record stops
-- being shown, its row stays, marked `deleted`, with the time it went: OAI-PMH
-- harvesters learn to drop it (`deletedRecord` transient). A row is only ever
-- made for a record whose public output the site showed, so the table holds
-- no ID of a record that was never public there.
--
-- Written by the server's background pass (public-subjects.ts), on the staff
-- role: INSERT and UPDATE only (roles.ts); rows are never deleted by the app.
-- No foreign key to records, so the mark of a deleted record survives it.

CREATE TABLE public.oai_datestamps (
  organization_id uuid NOT NULL,
  site_id uuid NOT NULL,
  record_id uuid NOT NULL
    CHECK (record_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  stamp timestamptz NOT NULL
    CHECK (date_trunc('milliseconds', stamp AT TIME ZONE 'UTC') = stamp AT TIME ZONE 'UTC'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organization_id, site_id, record_id),
  FOREIGN KEY (organization_id, site_id) REFERENCES public.sites (organization_id, id)
);

-- The lists page by (stamp, record_id) within a site.
CREATE INDEX oai_datestamps_by_stamp
  ON public.oai_datestamps (organization_id, site_id, stamp, record_id);
