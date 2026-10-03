BEGIN;

-- Fail with an actionable message if historical rows violate the new rules.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM leave_entries
    WHERE leave_type='holiday' AND status IN ('pending','approved')
    GROUP BY employee_id, leave_date HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce Holiday uniqueness: duplicate pending/approved Holiday entries exist.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_one_regular_holiday_per_day
  ON leave_entries(employee_id, leave_date)
  WHERE leave_type='holiday' AND status IN ('pending','approved');

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM time_entries a JOIN time_entries b
      ON a.employee_id=b.employee_id AND a.id<b.id
     AND a.deleted_at IS NULL AND b.deleted_at IS NULL
     AND tsrange(a.clock_in, COALESCE(a.clock_out,'infinity'::timestamp),'[)')
         && tsrange(b.clock_in, COALESCE(b.clock_out,'infinity'::timestamp),'[)')
  ) THEN
    RAISE EXCEPTION 'Cannot enforce time-entry overlap rule: overlapping active entries exist. Correct or soft-delete them first.';
  END IF;
END $$;

ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_no_active_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    tsrange(clock_in, COALESCE(clock_out,'infinity'::timestamp),'[)') WITH &&
  ) WHERE (deleted_at IS NULL)
  DEFERRABLE INITIALLY DEFERRED;

COMMIT;
