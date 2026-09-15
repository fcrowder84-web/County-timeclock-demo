BEGIN;

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS pending_clock_in TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS pending_clock_out TIMESTAMP NULL;

DROP INDEX IF EXISTS idx_time_entries_one_active_open_per_employee;
CREATE UNIQUE INDEX idx_time_entries_one_active_open_per_employee
  ON time_entries(employee_id)
  WHERE deleted_at IS NULL
    AND clock_out IS NULL
    AND pending_clock_out IS NULL;

COMMIT;
