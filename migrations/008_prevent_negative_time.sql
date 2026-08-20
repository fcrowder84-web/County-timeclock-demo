BEGIN;

-- Absolute database safety rule: an active closed punch must end after it starts.
-- Deleted historical/test rows are exempt so their audit history can be retained.
ALTER TABLE time_entries
  DROP CONSTRAINT IF EXISTS time_entries_clock_order_check;

ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_clock_order_check
  CHECK (
    deleted_at IS NOT NULL
    OR clock_out IS NULL
    OR clock_out > clock_in
  );

-- Validate the effective clock-in/clock-out pair before a correction request
-- is stored. A request may change only one side, so combine the requested
-- value with the existing time entry before checking the result.
CREATE OR REPLACE FUNCTION validate_time_change_request_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  existing_clock_in timestamp;
  existing_clock_out timestamp;
  effective_clock_in timestamp;
  effective_clock_out timestamp;
BEGIN
  SELECT clock_in, clock_out
    INTO existing_clock_in, existing_clock_out
    FROM time_entries
   WHERE id = NEW.time_entry_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original time entry not found or has been deleted'
      USING ERRCODE = '23514';
  END IF;

  effective_clock_in := COALESCE(NEW.requested_clock_in, existing_clock_in);
  effective_clock_out := COALESCE(NEW.requested_clock_out, existing_clock_out);

  IF effective_clock_out IS NOT NULL
     AND effective_clock_out <= effective_clock_in THEN
    RAISE EXCEPTION 'Clock out must be after clock in. Check AM/PM and the date.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_time_change_request_order
  ON time_change_requests;

CREATE TRIGGER trg_validate_time_change_request_order
BEFORE INSERT OR UPDATE OF requested_clock_in, requested_clock_out, time_entry_id
ON time_change_requests
FOR EACH ROW
EXECUTE FUNCTION validate_time_change_request_order();

COMMENT ON CONSTRAINT time_entries_clock_order_check ON time_entries IS
  'Prevents active time entries from having a clock-out equal to or earlier than clock-in.';

COMMIT;
