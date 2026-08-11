BEGIN;

CREATE TABLE IF NOT EXISTS department_heads (
  id BIGSERIAL PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_by INTEGER REFERENCES employees(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (department_id, employee_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_department_heads_one_active_per_department
  ON department_heads(department_id)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_department_heads_employee
  ON department_heads(employee_id)
  WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS supervisor_employee_assignments (
  id BIGSERIAL PRIMARY KEY,
  supervisor_employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_by INTEGER REFERENCES employees(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  CHECK (supervisor_employee_id <> employee_id),
  UNIQUE (supervisor_employee_id, employee_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_primary_supervisor_per_employee
  ON supervisor_employee_assignments(employee_id)
  WHERE active = TRUE AND is_primary = TRUE;

CREATE INDEX IF NOT EXISTS idx_supervisor_assignments_supervisor
  ON supervisor_employee_assignments(supervisor_employee_id)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_supervisor_assignments_department
  ON supervisor_employee_assignments(department_id)
  WHERE active = TRUE;

COMMIT;
