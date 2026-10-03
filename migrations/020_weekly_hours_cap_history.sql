BEGIN;

CREATE TABLE IF NOT EXISTS weekly_hours_cap_history (
  id bigserial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  effective_date date NOT NULL,
  weekly_hours_cap numeric(5,2),
  source text NOT NULL DEFAULT 'timeclock',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT weekly_hours_cap_history_source_check CHECK (length(btrim(source)) > 0),
  CONSTRAINT weekly_hours_cap_history_value_check CHECK (
    weekly_hours_cap IS NULL
    OR (
      weekly_hours_cap >= 0
      AND weekly_hours_cap <= 168
      AND weekly_hours_cap * 4 = trunc(weekly_hours_cap * 4)
    )
  ),
  CONSTRAINT weekly_hours_cap_history_employee_date_key UNIQUE (employee_id, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_weekly_hours_cap_history_lookup
  ON weekly_hours_cap_history(employee_id, effective_date DESC);

-- Migrations run as timeclock_user, while the backend connects as timeclock_app.
-- Sync needs INSERT/UPDATE for same-day changes; payroll needs SELECT.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'timeclock_app') THEN
    GRANT SELECT, INSERT, UPDATE ON weekly_hours_cap_history TO timeclock_app;
    GRANT USAGE, SELECT ON SEQUENCE weekly_hours_cap_history_id_seq TO timeclock_app;
  END IF;
END
$$;

-- The first production payroll began 2026-09-14. Preserve the cap that was
-- current when effective-dated history was introduced as that payroll baseline.
INSERT INTO weekly_hours_cap_history(employee_id, effective_date, weekly_hours_cap, source)
SELECT id, DATE '2026-09-14', weekly_hours_cap, 'production-baseline'
FROM employees
ON CONFLICT (employee_id, effective_date) DO NOTHING;

COMMIT;
