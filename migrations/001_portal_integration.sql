BEGIN;

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS portal_department_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_portal_department_id
  ON departments(portal_department_id)
  WHERE portal_department_id IS NOT NULL;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS portal_user_id UUID,
  ADD COLUMN IF NOT EXISTS portal_department_id UUID,
  ADD COLUMN IF NOT EXISTS portal_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS app_admin_scope TEXT NOT NULL DEFAULT 'own',
  ADD COLUMN IF NOT EXISTS auth_source TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS last_portal_sync_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_portal_user_id
  ON employees(portal_user_id)
  WHERE portal_user_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='employees_app_admin_scope_check'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_app_admin_scope_check
      CHECK (app_admin_scope IN ('own','all'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS timeclock_audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_employee_id INTEGER REFERENCES employees(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_timeclock_audit_actor
  ON timeclock_audit_log(actor_employee_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_timeclock_audit_action
  ON timeclock_audit_log(action,created_at DESC);

COMMIT;
