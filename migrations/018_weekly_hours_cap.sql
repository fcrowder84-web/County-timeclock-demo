ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS weekly_hours_cap numeric(5,2);

ALTER TABLE employees
  DROP CONSTRAINT IF EXISTS employees_weekly_hours_cap_check;

ALTER TABLE employees
  ADD CONSTRAINT employees_weekly_hours_cap_check
  CHECK (
    weekly_hours_cap IS NULL
    OR (
      weekly_hours_cap >= 0
      AND weekly_hours_cap <= 168
      AND weekly_hours_cap * 4 = trunc(weekly_hours_cap * 4)
    )
  );
