BEGIN;

-- Soft deletion is enforced explicitly by application queries using
-- deleted_at IS NULL. Keep the audit columns, but remove RLS so an
-- authorized application user can mark a row deleted normally.
ALTER TABLE time_entries DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS time_entries_active_select ON time_entries;
DROP POLICY IF EXISTS time_entries_active_insert ON time_entries;
DROP POLICY IF EXISTS time_entries_active_update ON time_entries;
DROP POLICY IF EXISTS time_entries_no_hard_delete ON time_entries;

-- Remove the temporary helper introduced for the RLS implementation.
DROP FUNCTION IF EXISTS soft_delete_time_entry(BIGINT,INTEGER,TEXT);

COMMENT ON COLUMN time_entries.deleted_at IS
  'Soft-delete timestamp. Normal application queries explicitly exclude rows where deleted_at is not null.';

COMMIT;
