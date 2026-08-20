BEGIN;

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_time_entries_active_employee_clock_in
  ON time_entries(employee_id, clock_in DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS time_entries_active_select ON time_entries;
DROP POLICY IF EXISTS time_entries_active_insert ON time_entries;
DROP POLICY IF EXISTS time_entries_active_update ON time_entries;
DROP POLICY IF EXISTS time_entries_no_hard_delete ON time_entries;

CREATE POLICY time_entries_active_select
  ON time_entries
  FOR SELECT
  TO timeclock_app
  USING (deleted_at IS NULL);

CREATE POLICY time_entries_active_insert
  ON time_entries
  FOR INSERT
  TO timeclock_app
  WITH CHECK (deleted_at IS NULL);

CREATE POLICY time_entries_active_update
  ON time_entries
  FOR UPDATE
  TO timeclock_app
  USING (deleted_at IS NULL)
  WITH CHECK (TRUE);

CREATE POLICY time_entries_no_hard_delete
  ON time_entries
  FOR DELETE
  TO timeclock_app
  USING (FALSE);

COMMENT ON COLUMN time_entries.deleted_at IS
  'Soft-delete timestamp. Deleted punches remain available to database administrators and audit records but are hidden from normal application reads by RLS.';
COMMENT ON COLUMN time_entries.deleted_by_employee_id IS
  'Employee account that soft-deleted this time entry.';
COMMENT ON COLUMN time_entries.deletion_reason IS
  'Required reason supplied when a punch is soft-deleted.';

COMMIT;
