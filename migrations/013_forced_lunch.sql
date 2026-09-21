-- Forced lunch policy and daily waiver workflow
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS forced_lunch_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS forced_lunch_minutes integer NOT NULL DEFAULT 30;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='employees_forced_lunch_minutes_check'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_forced_lunch_minutes_check
      CHECK (forced_lunch_minutes BETWEEN 1 AND 240);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS forced_lunch_waivers (
  id bigserial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'supervisor',
  request_id bigint,
  waived_by_employee_id integer NOT NULL REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT forced_lunch_waivers_source_check CHECK (source IN ('supervisor','approved_request'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_forced_lunch_waivers_one_active
  ON forced_lunch_waivers(employee_id,work_date)
  WHERE active=TRUE;

CREATE TABLE IF NOT EXISTS forced_lunch_waiver_requests (
  id bigserial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_by_employee_id integer NOT NULL REFERENCES employees(id),
  reviewed_by_employee_id integer REFERENCES employees(id),
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forced_lunch_waiver_requests_status_check
    CHECK (status IN ('pending','approved','denied'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_forced_lunch_waiver_requests_pending
  ON forced_lunch_waiver_requests(employee_id,work_date)
  WHERE status='pending';

CREATE INDEX IF NOT EXISTS idx_forced_lunch_waivers_employee_date
  ON forced_lunch_waivers(employee_id,work_date);

CREATE INDEX IF NOT EXISTS idx_forced_lunch_requests_employee_date
  ON forced_lunch_waiver_requests(employee_id,work_date);
