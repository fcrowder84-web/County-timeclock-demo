BEGIN;

ALTER TABLE time_change_requests
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by_employee_id integer,
  ADD COLUMN IF NOT EXISTS archive_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname='time_change_requests_archived_by_employee_id_fkey'
  ) THEN
    ALTER TABLE time_change_requests
      ADD CONSTRAINT time_change_requests_archived_by_employee_id_fkey
      FOREIGN KEY (archived_by_employee_id) REFERENCES employees(id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_time_change_requests_employee_status
  ON time_change_requests(employee_id,status,created_at DESC);

COMMIT;
