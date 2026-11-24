-- The approval queue (T-043, D-082): the service's reviewQueue lists an
-- organization's records sent for review in ID order (recordsInState), so a
-- partial index like 0012's records_published serves it without reading
-- every record of the organization. No new table, trigger or grant.
CREATE INDEX records_ready_for_review
  ON public.records (organization_id, id) WHERE workflow_state = 'ready_for_review';
