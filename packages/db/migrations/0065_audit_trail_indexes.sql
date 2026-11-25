-- The audit trail's newer kinds, read newest first per organization (S-066).
-- Numbered 0065, above main's 0058 and the numbers reserved on the work
-- board.
--
-- S-064 put file attaches and removals, moves, accession saves and share
-- steps in the audit trail (people.ts `readAuditTrail`). Each kind is now read
-- one page at a time, newest first, so each needs an index in that order:
-- without one, every page read every row of the organization's history in
-- that table. Record versions, people events, system events and definition
-- events have theirs already (0020, 0030, 0058).
--
-- A share has three steps, each with its own time (offered, decided,
-- ended); the trail reads each step as its own part, through its own index.
-- Decided and ended are empty until they happen, so those indexes leave out
-- the shares without them.

CREATE INDEX stored_file_events_time
  ON public.stored_file_events (organization_id, occurred_at DESC, id DESC);

CREATE INDEX storage_moves_time
  ON public.storage_moves (organization_id, recorded_at DESC, id DESC);

CREATE INDEX accession_versions_time
  ON public.accession_versions (organization_id, saved_at DESC, accession_id DESC, version DESC);

CREATE INDEX record_shares_offered_time
  ON public.record_shares (organization_id, offered_at DESC, id DESC);

CREATE INDEX record_shares_decided_time
  ON public.record_shares (organization_id, decided_at DESC, id DESC)
  WHERE decided_at IS NOT NULL;

CREATE INDEX record_shares_ended_time
  ON public.record_shares (organization_id, ended_at DESC, id DESC)
  WHERE ended_at IS NOT NULL;
