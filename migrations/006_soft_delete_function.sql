BEGIN;

CREATE OR REPLACE FUNCTION soft_delete_time_entry(
  p_entry_id BIGINT,
  p_deleted_by_employee_id INTEGER,
  p_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected INTEGER;
BEGIN
  IF p_entry_id IS NULL OR p_entry_id <= 0 THEN
    RAISE EXCEPTION 'Valid time entry is required';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Deletion reason is required';
  END IF;

  IF length(p_reason) > 500 THEN
    RAISE EXCEPTION 'Deletion reason must be 500 characters or less';
  END IF;

  UPDATE time_entries
     SET deleted_at = NOW(),
         deleted_by_employee_id = p_deleted_by_employee_id,
         deletion_reason = btrim(p_reason)
   WHERE id = p_entry_id
     AND deleted_at IS NULL;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

REVOKE ALL ON FUNCTION soft_delete_time_entry(BIGINT, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_delete_time_entry(BIGINT, INTEGER, TEXT) TO timeclock_app;

COMMENT ON FUNCTION soft_delete_time_entry(BIGINT, INTEGER, TEXT) IS
  'RLS-safe soft delete for TimeClock punches. Authorization is performed by the application before invocation; the function only marks an existing active row deleted and never hard-deletes data.';

COMMIT;
