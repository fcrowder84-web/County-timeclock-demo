'use strict';

const express = require('express');

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`Valid ${label} is required`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function createTeamStructureRouter({
  requireUser,
  requireAnyPermission,
  pool,
  audit,
  canManageTeamStructure,
  userPermissionSet,
}) {
  const router = express.Router();

  router.get(
    '/supervisor/staff',
    requireUser,
    requireAnyPermission('view_assigned_employees', 'view_department_time', 'manage_employee_timeclock_settings', 'manage_supervisor_assignments'),
    async (req, res) => {
      try {
        const result = await pool.query(
          `SELECT e.id,e.employee_number,e.first_name,e.last_name,e.department,e.department_id,
                  d.name AS department_name,e.role,e.active,e.must_change_pin
             FROM employees e
             LEFT JOIN departments d ON d.id=e.department_id
            WHERE (
              $1::text IN ('admin','payroll')
              OR e.id IN (
                SELECT employee_id FROM supervisor_employee_assignments
                WHERE supervisor_employee_id=$2 AND active=TRUE
              )
              OR e.department_id IN (
                SELECT department_id FROM department_heads
                WHERE employee_id=$2 AND active=TRUE
              )
            )
            ORDER BY d.name,e.active DESC,e.last_name,e.first_name`,
          [req.user.role, req.user.id],
        );
        return res.json(result.rows);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Staff list error' });
      }
    },
  );

  const portalManaged = (_req, res) => res.status(410).json({
    error: 'Employee accounts are created, enabled, and disabled in the Employee Portal.',
  });

  router.post(
    '/supervisor/create-staff',
    requireUser,
    requireAnyPermission('manage_employee_timeclock_settings'),
    portalManaged,
  );
  router.post(
    '/supervisor/deactivate-staff',
    requireUser,
    requireAnyPermission('manage_employee_timeclock_settings'),
    portalManaged,
  );
  router.post(
    '/supervisor/reactivate-staff',
    requireUser,
    requireAnyPermission('manage_employee_timeclock_settings'),
    portalManaged,
  );

  router.get(
    '/supervisor/departments',
    requireUser,
    requireAnyPermission('view_department_time', 'manage_employee_timeclock_settings', 'manage_supervisor_assignments'),
    async (req, res) => {
      try {
        const result = await pool.query(
          `SELECT d.id,d.name
             FROM departments d
            WHERE (
              $1::text IN ('admin','payroll')
              OR d.id IN (
                SELECT department_id FROM department_heads
                WHERE employee_id=$2 AND active=TRUE
              )
              OR d.id IN (
                SELECT department_id FROM supervisor_employee_assignments
                WHERE supervisor_employee_id=$2 AND active=TRUE
              )
            )
            ORDER BY d.name`,
          [req.user.role, req.user.id],
        );
        return res.json(result.rows);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Departments error' });
      }
    },
  );

  router.get(
    '/supervisor/team-structure',
    requireUser,
    requireAnyPermission('view_assigned_employees', 'view_department_time', 'manage_supervisor_assignments'),
    async (req, res) => {
      try {
        const structurePermissions = userPermissionSet(req.user);
        const canManageAll = req.user.app_admin_scope === 'all' &&
          (structurePermissions.has('app_admin') || structurePermissions.has('manage_supervisor_assignments'));

        const departments = await pool.query(
          `SELECT d.id,d.name,
                  dh.employee_id AS department_head_id,
                  he.first_name AS department_head_first_name,
                  he.last_name AS department_head_last_name
             FROM departments d
             LEFT JOIN department_heads dh ON dh.department_id=d.id AND dh.active=TRUE
             LEFT JOIN employees he ON he.id=dh.employee_id
            WHERE $1::boolean=TRUE
               OR d.id=$2
               OR EXISTS (
                 SELECT 1 FROM department_heads x
                 WHERE x.department_id=d.id AND x.employee_id=$3 AND x.active=TRUE
               )
               OR EXISTS (
                 SELECT 1 FROM supervisor_employee_assignments x
                 WHERE x.department_id=d.id AND x.supervisor_employee_id=$3 AND x.active=TRUE
               )
            ORDER BY d.name`,
          [canManageAll, req.user.department_id, req.user.id],
        );

        const employees = await pool.query(
          `SELECT e.id,e.employee_number,e.first_name,e.last_name,e.department_id,
                  d.name AS department_name,e.active,
                  EXISTS(SELECT 1 FROM department_heads dh WHERE dh.employee_id=e.id AND dh.active=TRUE) AS is_department_head,
                  EXISTS(SELECT 1 FROM supervisor_employee_assignments sea WHERE sea.supervisor_employee_id=e.id AND sea.active=TRUE) AS is_supervisor
             FROM employees e
             LEFT JOIN departments d ON d.id=e.department_id
            WHERE e.active=TRUE
              AND ($1::boolean=TRUE OR e.department_id IN (
                SELECT id FROM departments d2
                WHERE d2.id=$2
                   OR EXISTS (
                     SELECT 1 FROM department_heads x
                     WHERE x.department_id=d2.id AND x.employee_id=$3 AND x.active=TRUE
                   )
                   OR EXISTS (
                     SELECT 1 FROM supervisor_employee_assignments x
                     WHERE x.department_id=d2.id AND x.supervisor_employee_id=$3 AND x.active=TRUE
                   )
              ))
            ORDER BY d.name,e.last_name,e.first_name`,
          [canManageAll, req.user.department_id, req.user.id],
        );

        const visibleDepartmentIds = departments.rows.map((department) => department.id);
        const assignments = visibleDepartmentIds.length
          ? await pool.query(
              `SELECT sea.id,sea.department_id,sea.supervisor_employee_id,sea.employee_id,sea.is_primary,
                      s.first_name AS supervisor_first_name,s.last_name AS supervisor_last_name,
                      e.first_name AS employee_first_name,e.last_name AS employee_last_name
                 FROM supervisor_employee_assignments sea
                 JOIN employees s ON s.id=sea.supervisor_employee_id
                 JOIN employees e ON e.id=sea.employee_id
                WHERE sea.active=TRUE AND sea.department_id=ANY($1::int[])
                ORDER BY sea.department_id,s.last_name,e.last_name`,
              [visibleDepartmentIds],
            )
          : { rows: [] };

        return res.json({
          departments: departments.rows,
          employees: employees.rows,
          assignments: assignments.rows,
          can_manage_all: canManageAll,
        });
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Team structure error' });
      }
    },
  );

  router.post(
    '/supervisor/team-structure/department-head',
    requireUser,
    requireAnyPermission('manage_supervisor_assignments'),
    async (req, res) => {
      let client = null;
      try {
        const departmentId = parsePositiveInt(req.body?.department_id, 'department');
        const employeeId = req.body?.employee_id ? parsePositiveInt(req.body.employee_id, 'employee') : null;
        if (!(await canManageTeamStructure(req.user, departmentId))) {
          return res.status(403).json({ error: 'You cannot manage this department' });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        await client.query(
          `UPDATE department_heads SET active=FALSE WHERE department_id=$1 AND active=TRUE`,
          [departmentId],
        );

        if (employeeId) {
          const employee = await client.query(
            `SELECT id FROM employees WHERE id=$1 AND department_id=$2 AND active=TRUE`,
            [employeeId, departmentId],
          );
          if (!employee.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Department head must be an active employee in the department' });
          }
          await client.query(
            `INSERT INTO department_heads(department_id,employee_id,active,assigned_by)
             VALUES($1,$2,TRUE,$3)
             ON CONFLICT(department_id,employee_id)
             DO UPDATE SET active=TRUE,assigned_by=EXCLUDED.assigned_by,assigned_at=NOW()`,
            [departmentId, employeeId, req.user.id],
          );
        }
        await client.query('COMMIT');
        await audit(req.user.id, 'assign_department_head', 'department', departmentId, { employee_id: employeeId });
        return res.json({ message: 'Department head updated' });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(400).json({ error: err.message || 'Department head update failed' });
      } finally {
        if (client) client.release();
      }
    },
  );

  router.post(
    '/supervisor/team-structure/assign',
    requireUser,
    requireAnyPermission('manage_supervisor_assignments', 'view_department_time'),
    async (req, res) => {
      let client = null;
      try {
        const supervisorEmployeeId = parsePositiveInt(req.body?.supervisor_employee_id, 'supervisor');
        const employeeId = parsePositiveInt(req.body?.employee_id, 'employee');
        const departmentId = parsePositiveInt(req.body?.department_id, 'department');
        if (supervisorEmployeeId === employeeId) {
          return res.status(400).json({ error: 'An employee cannot be assigned as their own supervisor' });
        }
        if (!(await canManageTeamStructure(req.user, departmentId))) {
          return res.status(403).json({ error: 'You cannot manage this department' });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        const valid = await client.query(
          `SELECT COUNT(*)::int AS count
             FROM employees
            WHERE id IN ($1,$2) AND department_id=$3 AND active=TRUE`,
          [supervisorEmployeeId, employeeId, departmentId],
        );
        if (valid.rows[0].count !== 2) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Supervisor and employee must be active members of the department' });
        }

        await client.query(
          `UPDATE supervisor_employee_assignments
              SET active=FALSE,ended_at=NOW()
            WHERE employee_id=$1 AND active=TRUE AND is_primary=TRUE`,
          [employeeId],
        );
        await client.query(
          `INSERT INTO supervisor_employee_assignments(
             supervisor_employee_id,employee_id,department_id,is_primary,active,assigned_by
           ) VALUES($1,$2,$3,TRUE,TRUE,$4)
           ON CONFLICT(supervisor_employee_id,employee_id)
           DO UPDATE SET department_id=EXCLUDED.department_id,is_primary=TRUE,active=TRUE,
                         assigned_by=EXCLUDED.assigned_by,assigned_at=NOW(),ended_at=NULL`,
          [supervisorEmployeeId, employeeId, departmentId, req.user.id],
        );
        await client.query('COMMIT');
        await audit(req.user.id, 'assign_supervisor', 'employee', employeeId, {
          supervisor_employee_id: supervisorEmployeeId,
          department_id: departmentId,
        });
        return res.json({ message: 'Employee assigned to supervisor' });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(400).json({ error: err.message || 'Assignment failed' });
      } finally {
        if (client) client.release();
      }
    },
  );

  router.post(
    '/supervisor/team-structure/unassign',
    requireUser,
    requireAnyPermission('manage_supervisor_assignments', 'view_department_time'),
    async (req, res) => {
      try {
        const employeeId = parsePositiveInt(req.body?.employee_id, 'employee');
        const departmentId = parsePositiveInt(req.body?.department_id, 'department');
        if (!(await canManageTeamStructure(req.user, departmentId))) {
          return res.status(403).json({ error: 'You cannot manage this department' });
        }
        await pool.query(
          `UPDATE supervisor_employee_assignments
              SET active=FALSE,ended_at=NOW()
            WHERE employee_id=$1 AND department_id=$2 AND active=TRUE`,
          [employeeId, departmentId],
        );
        await audit(req.user.id, 'unassign_supervisor', 'employee', employeeId, { department_id: departmentId });
        return res.json({ message: 'Employee removed from supervisor' });
      } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(400).json({ error: err.message || 'Unassign failed' });
      }
    },
  );

  router.get(
    '/supervisor/next-employee-number',
    requireUser,
    requireAnyPermission('manage_employee_timeclock_settings'),
    async (_req, res) => {
      try {
        const result = await pool.query(
          `SELECT employee_number
             FROM employees
            WHERE employee_number ~ '^[0-9]+$'
            ORDER BY employee_number::int DESC
            LIMIT 1`,
        );
        const nextNumber = result.rows.length ? Number(result.rows[0].employee_number) + 1 : 1;
        return res.json({ next_employee_number: String(nextNumber).padStart(3, '0') });
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Next employee number error' });
      }
    },
  );

  return router;
}

module.exports = { createTeamStructureRouter };
