BEGIN;

-- Office TimeClock rule: each calendar date is an independent workday.
-- An unresolved punch from a prior date remains an incomplete payroll item,
-- but it must not reserve the employee's active punch state forever.

-- Check existing production rows before changing either protection. The
-- transaction leaves the old index and exclusion constraint intact on failure.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM time_entries
    WHERE deleted_at IS NULL AND clock_out IS NULL
    GROUP BY employee_id,clock_in::date HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot apply calendar-day punch state: more than one unresolved time entry exists for an employee on one date.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM time_entries a JOIN time_entries b
      ON a.employee_id=b.employee_id AND a.id<b.id
     AND a.deleted_at IS NULL AND b.deleted_at IS NULL
     AND tsrange(a.clock_in,COALESCE(a.clock_out,a.clock_in::date + INTERVAL '1 day'),'[)')
         && tsrange(b.clock_in,COALESCE(b.clock_out,b.clock_in::date + INTERVAL '1 day'),'[)')
  ) THEN
    RAISE EXCEPTION 'Cannot apply calendar-day punch state: overlapping time entries must be corrected first.';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_time_entries_one_active_open_per_employee;
DROP INDEX IF EXISTS idx_time_entries_one_active_open_per_employee_day;

-- At most one unresolved/open work session may exist for an employee on a
-- given calendar date. Historical incomplete dates are allowed to coexist.
CREATE UNIQUE INDEX idx_time_entries_one_active_open_per_employee_day
  ON time_entries(employee_id, (clock_in::date))
  WHERE deleted_at IS NULL
    AND clock_out IS NULL;

-- Open rows are operationally bounded by the end of their clock-in date.
-- This does NOT invent a payable clock-out; clock_out remains NULL and the
-- entry still has to be corrected before the affected timecard can close.
-- A requested clock-out is not an actual clock-out. It cannot release the
-- same-day open slot or shrink the protected interval before approval.
ALTER TABLE time_entries
  DROP CONSTRAINT IF EXISTS time_entries_no_active_overlap;

ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_no_active_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    tsrange(
      clock_in,
      COALESCE(clock_out, clock_in::date + INTERVAL '1 day'),
      '[)'
    ) WITH &&
  ) WHERE (deleted_at IS NULL)
  DEFERRABLE INITIALLY DEFERRED;

COMMIT;
