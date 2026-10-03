BEGIN;

CREATE TABLE IF NOT EXISTS weekly_hours_cap_history (
  id bigserial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_date date NOT NULL,
  weekly_hours_cap numeric(5,2),
  source text NOT NULL DEFAULT 'timeclock',
  created_at timestamptz NOT NULL DEFAULT NOW(),
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

-- The first production payroll began 2026-09-14. Preserve the cap that was
-- current when effective-dated history was introduced as that payroll baseline.
INSERT INTO weekly_hours_cap_history(employee_id, effective_date, weekly_hours_cap, source)
SELECT id, DATE '2026-09-14', weekly_hours_cap, 'production-baseline'
FROM employees
ON CONFLICT (employee_id, effective_date) DO NOTHING;

COMMIT;
