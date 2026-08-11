BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS access_removed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS directory_sync_state TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_employees_active_directory
  ON employees(active,directory_sync_state);

CREATE TABLE IF NOT EXISTS portal_directory_sync_log (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  received_count INTEGER NOT NULL DEFAULT 0,
  activated_count INTEGER NOT NULL DEFAULT 0,
  deactivated_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

COMMIT;
