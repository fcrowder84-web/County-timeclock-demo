BEGIN;

-- Office TimeClock rule: each calendar date is an independent workday.
-- An unresolved punch from a prior date remains an incomplete payroll item,
-- but it must not reserve the employee's active punch state forever.

DROP INDEX IF EXISTS idx_time_entries_one_active_open_per_employee;

-- At most one unresolved/open work session may exist for an employee on a
-- given calendar date. Historical incomplete dates are allowed to coexist.
CREATE UNIQUE INDEX idx_time_entries_one_active_open_per_employee_day
  ON time_entries(employee_id, (clock_in::date))
  WHERE deleted_at IS NULL
    AND clock_out IS NULL
    AND pending_clock_out IS NULL;

-- Open rows are operationally bounded by the end of their clock-in date.
-- This does NOT invent a payable clock-out; clock_out remains NULL and the
-- entry still has to be corrected before the affected timecard can close.
-- A pending/approved correction uses its requested/actual end and therefore
-- is still checked for overlap with other entries.
ALTER TABLE time_entries
  DROP CONSTRAINT IF EXISTS time_entries_no_active_overlap;

ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_no_active_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    tsrange(
      clock_in,
      COALESCE(
        clock_out,
        pending_clock_out,
        clock_in::date + INTERVAL '1 day'
      ),
      '[)'
    ) WITH &&
  ) WHERE (deleted_at IS NULL)
  DEFERRABLE INITIALLY DEFERRED;

COMMIT;
