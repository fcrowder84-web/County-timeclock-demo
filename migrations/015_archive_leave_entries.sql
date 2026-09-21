BEGIN;

ALTER TABLE leave_entries
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by_employee_id integer,
  ADD COLUMN IF NOT EXISTS archive_reason text;

ALTER TABLE leave_entries
  DROP CONSTRAINT IF EXISTS leave_entries_status_check;

ALTER TABLE leave_entries
  ADD CONSTRAINT leave_entries_status_check
  CHECK (status IN ('pending','approved','denied','withdrawn','voided'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname='leave_entries_archived_by_employee_id_fkey'
  ) THEN
    ALTER TABLE leave_entries
      ADD CONSTRAINT leave_entries_archived_by_employee_id_fkey
      FOREIGN KEY (archived_by_employee_id) REFERENCES employees(id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_leave_entries_active_status
  ON leave_entries(employee_id,leave_date,status);

COMMIT;
