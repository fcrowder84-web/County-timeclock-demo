-- Per-employee forced lunch settings and dated waiver workflow.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS forced_lunch_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS forced_lunch_minutes integer NOT NULL DEFAULT 30;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_forced_lunch_minutes_check'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_forced_lunch_minutes_check
      CHECK (forced_lunch_minutes BETWEEN 1 AND 240);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS forced_lunch_waivers (
  id serial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  configured_lunch_minutes integer NOT NULL CHECK (configured_lunch_minutes BETWEEN 1 AND 240),
  reason text NOT NULL,
  source text NOT NULL CHECK (source IN ('employee_request','supervisor')),
  requested_by_employee_id integer REFERENCES employees(id) ON DELETE SET NULL,
  approved_by_employee_id integer NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  approved_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS forced_lunch_waiver_requests (
  id serial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  configured_lunch_minutes integer NOT NULL CHECK (configured_lunch_minutes BETWEEN 1 AND 240),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  requested_by_employee_id integer NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  reviewed_by_employee_id integer REFERENCES employees(id) ON DELETE SET NULL,
  review_note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  reviewed_at timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_forced_lunch_waiver_requests_one_pending
  ON forced_lunch_waiver_requests(employee_id, work_date)
  WHERE status='pending';

CREATE INDEX IF NOT EXISTS idx_forced_lunch_waivers_employee_date
  ON forced_lunch_waivers(employee_id, work_date);

CREATE INDEX IF NOT EXISTS idx_forced_lunch_requests_employee_date
  ON forced_lunch_waiver_requests(employee_id, work_date, status);
