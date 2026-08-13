CREATE TABLE IF NOT EXISTS leave_entries (
  id BIGSERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_date DATE NOT NULL,
  leave_type TEXT NOT NULL CHECK (leave_type IN ('vacation','sick','bereavement','jury_duty','administrative','other')),
  quarter_hours INTEGER NOT NULL CHECK (quarter_hours BETWEEN 1 AND 96),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  created_by_employee_id INTEGER NOT NULL REFERENCES employees(id),
  reviewed_by_employee_id INTEGER REFERENCES employees(id),
  review_note TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS leave_entries_employee_date_idx ON leave_entries(employee_id, leave_date);
