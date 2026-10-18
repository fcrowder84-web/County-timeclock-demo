-- Manual reversal of migration 021, for rehearsal before production only.
-- Run with psql -v ON_ERROR_STOP=1 during a maintenance window after a backup.
-- This deliberately fails once calendar-day use has produced rows that the
-- former global-open and infinite-overlap rules cannot represent.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM time_entries
    WHERE deleted_at IS NULL AND clock_out IS NULL AND pending_clock_out IS NULL
    GROUP BY employee_id HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot reverse migration 021: employee has multiple globally open entries. Correct historical rows first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM time_entries a JOIN time_entries b
      ON a.employee_id=b.employee_id AND a.id<b.id
     AND a.deleted_at IS NULL AND b.deleted_at IS NULL
     AND tsrange(a.clock_in,COALESCE(a.clock_out,'infinity'::timestamp),'[)')
         && tsrange(b.clock_in,COALESCE(b.clock_out,'infinity'::timestamp),'[)')
  ) THEN
    RAISE EXCEPTION 'Cannot reverse migration 021: rows overlap under the former global rule. Correct them first.';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_time_entries_one_active_open_per_employee_day;
DROP INDEX IF EXISTS idx_time_entries_one_active_open_per_employee;
CREATE UNIQUE INDEX idx_time_entries_one_active_open_per_employee
  ON time_entries(employee_id)
  WHERE deleted_at IS NULL AND clock_out IS NULL AND pending_clock_out IS NULL;

ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_no_active_overlap;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_no_active_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    tsrange(clock_in,COALESCE(clock_out,'infinity'::timestamp),'[)') WITH &&
  ) WHERE (deleted_at IS NULL)
  DEFERRABLE INITIALLY DEFERRED;

DELETE FROM schema_migrations WHERE filename='021_calendar_day_punch_state.sql';
COMMIT;
