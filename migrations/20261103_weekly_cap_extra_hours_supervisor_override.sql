-- Apply before deploying the matching TimeClock application code.
BEGIN;
ALTER TABLE pay_period_approvals
  ADD COLUMN IF NOT EXISTS supervisor_override_reason TEXT;
CREATE TABLE IF NOT EXISTS weekly_cap_extra_hours (
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  pay_period_start DATE NOT NULL,
  week_number SMALLINT NOT NULL CHECK (week_number IN (1, 2)),
  extra_hours NUMERIC(7,2) NOT NULL DEFAULT 0 CHECK (extra_hours >= 0),
  updated_by INTEGER REFERENCES employees(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (employee_id, pay_period_start, week_number)
);
CREATE TABLE IF NOT EXISTS weekly_cap_extra_hours_audit (
  id BIGSERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  pay_period_start DATE NOT NULL,
  week_number SMALLINT NOT NULL CHECK (week_number IN (1, 2)),
  previous_hours NUMERIC(7,2) NOT NULL,
  new_hours NUMERIC(7,2) NOT NULL,
  changed_by INTEGER NOT NULL REFERENCES employees(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS weekly_cap_extra_hours_audit_employee_period_idx
 ON weekly_cap_extra_hours_audit(employee_id,pay_period_start,changed_at);
COMMIT;
