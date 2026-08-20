BEGIN;
CREATE TABLE IF NOT EXISTS time_punch_metadata (
 id BIGSERIAL PRIMARY KEY,
 time_entry_id BIGINT NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
 employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 punch_type TEXT NOT NULL CHECK (punch_type IN ('clock_in','clock_out')),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 source_ip INET,
 forwarded_for TEXT,
 latitude DOUBLE PRECISION,
 longitude DOUBLE PRECISION,
 accuracy_meters DOUBLE PRECISION,
 location_status TEXT NOT NULL DEFAULT 'unavailable' CHECK (location_status IN ('captured','denied','unavailable','timeout','error')),
 client_source TEXT NOT NULL DEFAULT 'web',
 CONSTRAINT time_punch_metadata_location_pair CHECK ((latitude IS NULL AND longitude IS NULL) OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)),
 CONSTRAINT time_punch_metadata_accuracy CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0)
);
CREATE INDEX IF NOT EXISTS idx_time_punch_metadata_entry ON time_punch_metadata(time_entry_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_time_punch_metadata_employee ON time_punch_metadata(employee_id, recorded_at DESC);
COMMENT ON TABLE time_punch_metadata IS 'Audit-only network/GPS metadata captured at clock-in and clock-out. No whitelist or geofence enforcement is performed by this table.';
COMMIT;
