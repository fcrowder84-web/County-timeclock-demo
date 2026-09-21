BEGIN;

ALTER TABLE forced_lunch_waiver_requests
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by_employee_id integer,
  ADD COLUMN IF NOT EXISTS archive_reason text;

ALTER TABLE forced_lunch_waiver_requests
  DROP CONSTRAINT IF EXISTS forced_lunch_waiver_requests_status_check;

ALTER TABLE forced_lunch_waiver_requests
  ADD CONSTRAINT forced_lunch_waiver_requests_status_check
  CHECK (status IN ('pending','approved','denied','withdrawn','voided'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname='forced_lunch_waiver_requests_archived_by_employee_id_fkey'
  ) THEN
    ALTER TABLE forced_lunch_waiver_requests
      ADD CONSTRAINT forced_lunch_waiver_requests_archived_by_employee_id_fkey
      FOREIGN KEY (archived_by_employee_id) REFERENCES employees(id);
  END IF;
END
$$;

COMMIT;
