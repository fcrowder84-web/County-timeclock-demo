BEGIN;

-- Do not allow more than one active/open work interval per employee.  This
-- preflight intentionally fails instead of guessing which historical row to
-- keep if duplicate open punches already exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM time_entries
     WHERE deleted_at IS NULL
       AND clock_out IS NULL
     GROUP BY employee_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce one-open-punch rule: duplicate active open punches exist. Correct or soft-delete the duplicates first.';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_one_active_open_per_employee
  ON time_entries(employee_id)
  WHERE deleted_at IS NULL AND clock_out IS NULL;

-- Soft deletion is the only supported application deletion path.  RLS was
-- deliberately removed in migration 007, so keep an independent database
-- safeguard against accidental hard DELETE statements by the application.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'timeclock_app') THEN
    EXECUTE 'REVOKE DELETE ON TABLE time_entries FROM timeclock_app';
  END IF;
END
$$;

-- Keep the database leave-type rule aligned with the application.  Holiday
-- and floating_holiday were added after the original leave-table migration.
ALTER TABLE leave_entries
  DROP CONSTRAINT IF EXISTS leave_entries_leave_type_check;

ALTER TABLE leave_entries
  ADD CONSTRAINT leave_entries_leave_type_check
  CHECK (
    leave_type IN (
      'vacation',
      'sick',
      'holiday',
      'floating_holiday',
      'bereavement',
      'jury_duty',
      'administrative',
      'other'
    )
  );

-- A person may have only one pending/approved floating holiday in a calendar
-- year.  As with open punches, fail clearly if old duplicate data exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM leave_entries
     WHERE leave_type = 'floating_holiday'
       AND status IN ('pending', 'approved')
     GROUP BY employee_id, EXTRACT(YEAR FROM leave_date)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce floating-holiday uniqueness: duplicate pending/approved floating holidays exist.';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_one_floating_holiday_per_year
  ON leave_entries(employee_id, (EXTRACT(YEAR FROM leave_date)))
  WHERE leave_type = 'floating_holiday'
    AND status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS idx_time_change_requests_pending_entry
  ON time_change_requests(time_entry_id, id)
  WHERE status = 'pending';

COMMIT;
