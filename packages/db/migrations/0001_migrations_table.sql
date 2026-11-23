-- The empty schema: only the migration runner's own bookkeeping table (D-050, D-053).
-- One row per applied migration file, written by the runner in the same
-- transaction as the file. Applied files never change; write a new file instead.
CREATE TABLE public.oculus_migrations (
  name text PRIMARY KEY CHECK (name ~ '^[0-9]{4}_[a-z0-9]+(_[a-z0-9]+)*\.sql$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
