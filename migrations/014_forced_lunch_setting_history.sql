BEGIN;

CREATE TABLE IF NOT EXISTS forced_lunch_setting_history (
    id BIGSERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    effective_date DATE NOT NULL,
    enabled BOOLEAN NOT NULL,
    minutes INTEGER NOT NULL DEFAULT 30,
    changed_by_employee_id INTEGER REFERENCES employees(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT forced_lunch_setting_history_minutes_check CHECK (minutes >= 1 AND minutes <= 240),
    CONSTRAINT forced_lunch_setting_history_employee_date_key UNIQUE (employee_id, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_forced_lunch_setting_history_lookup
    ON forced_lunch_setting_history (employee_id, effective_date DESC);

-- Existing enabled policies become effective on the deployment date. This prevents
-- the new history model from retroactively changing earlier timecards.
INSERT INTO forced_lunch_setting_history (employee_id, effective_date, enabled, minutes)
SELECT id, DATE '2026-09-21', forced_lunch_enabled, forced_lunch_minutes
FROM employees
WHERE forced_lunch_enabled = TRUE
ON CONFLICT (employee_id, effective_date) DO NOTHING;

COMMIT;
