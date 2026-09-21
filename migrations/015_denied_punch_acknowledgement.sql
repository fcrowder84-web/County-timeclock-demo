ALTER TABLE time_change_requests
ADD COLUMN IF NOT EXISTS employee_acknowledged_at TIMESTAMPTZ;

COMMENT ON COLUMN time_change_requests.employee_acknowledged_at IS
'When the employee acknowledged a denied punch request notification.';
