BEGIN;

-- The web application may append audit/history records and read them where the
-- UI permits, but it must not be able to rewrite or permanently erase them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'timeclock_app') THEN
    REVOKE UPDATE, DELETE ON TABLE time_entry_audit FROM timeclock_app;
    REVOKE UPDATE, DELETE ON TABLE time_punch_metadata FROM timeclock_app;
    REVOKE UPDATE, DELETE ON TABLE timeclock_audit_log FROM timeclock_app;

    -- Time-entry deletion is always a soft delete performed with UPDATE.
    REVOKE DELETE ON TABLE time_entries FROM timeclock_app;
  END IF;
END
$$;

COMMENT ON TABLE time_entry_audit IS
  'Append-only time-entry change history for the application role.';
COMMENT ON TABLE time_punch_metadata IS
  'Append-only punch network/GPS metadata for the application role.';
COMMENT ON TABLE timeclock_audit_log IS
  'Append-only application audit log for the application role.';

COMMIT;
