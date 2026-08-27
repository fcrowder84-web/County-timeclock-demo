BEGIN;

-- Whole-day missing-time requests intentionally have no existing time entry.
-- In that case validate the requested pair directly instead of requiring
-- time_entry_id to point at an existing punch.
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
  IF NEW.time_entry_id IS NULL THEN
    effective_clock_in := NEW.requested_clock_in;
    effective_clock_out := NEW.requested_clock_out;
  ELSE
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
  END IF;

  IF effective_clock_out IS NOT NULL
     AND effective_clock_in IS NOT NULL
     AND effective_clock_out <= effective_clock_in THEN
    RAISE EXCEPTION 'Clock out must be after clock in. Check AM/PM and the date.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
