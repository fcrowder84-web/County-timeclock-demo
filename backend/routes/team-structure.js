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
    '/supervisor/department-structure-access',
    requireUser,
    async (req, res) => {
      try {
        return res.json({ allowed: await canManageTeamStructure(req.user) });
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Department structure access check failed' });
      }
    },
  );

  router.get(
    '/supervisor/staff',
    requireUser,
    requireAnyPermission('view_assigned_employees', 'view_department_time', 'view_employee_leave', 'add_employee_leave', 'approve_leave', 'void_employee_leave', 'submit_employee_timecard', 'view_timeclock_audit', 'manage_employee_timeclock_settings', 'manage_supervisor_assignments', 'manage_employee_lunch_settings'),
    async (req, res) => {
      try {
        const role=String(req.user.role||'employee').toLowerCase();
        const permissions=userPermissionSet(req.user);
        const countywide=(permissions.has('app_admin')&&req.user.app_admin_scope==='all')
          || role==='timeclock_manager'||role==='payroll';
        const departmentBound=(permissions.has('app_admin')&&req.user.app_admin_scope!=='all')
          || role==='department_head';
        const assignmentBound=role==='supervisor'&&!permissions.has('app_admin');
        const result = await pool.query(
          `SELECT e.id,e.employee_number,e.first_name,e.last_name,e.department,e.department_id,
                  d.name AS department_name,e.role,e.active,e.must_change_pin,
                  e.forced_lunch_enabled,e.forced_lunch_minutes
             FROM employees e
             LEFT JOIN departments d ON d.id=e.department_id
            WHERE (
              $1::boolean=TRUE
              OR ($2::boolean=TRUE AND e.department_id=$3)
              OR ($5::boolean=TRUE AND e.id IN (
                SELECT employee_id FROM supervisor_employee_assignments
                WHERE supervisor_employee_id=$4 AND active=TRUE
              ))
            )
            ORDER BY d.name,e.active DESC,e.last_name,e.first_name`,
          [countywide,departmentBound,req.user.department_id,req.user.id,assignmentBound],
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
        const role=String(req.user.role||'employee').toLowerCase();
        const permissions=userPermissionSet(req.user);
        const countywide=(permissions.has('app_admin')&&req.user.app_admin_scope==='all')
          || role==='timeclock_manager'||role==='payroll';
        const departmentBound=(permissions.has('app_admin')&&req.user.app_admin_scope!=='all')
          || role==='department_head';
        const assignmentBound=role==='supervisor'&&!permissions.has('app_admin');
        const result = await pool.query(
          `SELECT d.id,d.name
             FROM departments d
            WHERE (
              $1::boolean=TRUE
              OR ($2::boolean=TRUE AND d.id=$3)
              OR ($5::boolean=TRUE AND d.id IN (
                SELECT department_id FROM supervisor_employee_assignments
                WHERE supervisor_employee_id=$4 AND active=TRUE
              ))
            )
            ORDER BY d.name`,
          [countywide,departmentBound,req.user.department_id,req.user.id,assignmentBound],
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
    requireAnyPermission('manage_supervisor_assignments', 'manage_employee_lunch_settings'),
    async (req, res) => {
      try {
        if (!(await canManageTeamStructure(req.user))) {
          return res.status(403).json({ error: 'Department Structure requires a structure or lunch-management permission within your authorized scope' });
        }
        const structurePermissions = userPermissionSet(req.user);
        const structureRole = String(req.user.role || '').toLowerCase();
        const canManageAll = (structurePermissions.has('app_admin')&&req.user.app_admin_scope==='all')
          || structureRole === 'timeclock_manager'
          || structureRole === 'payroll';
        const assignmentBound=structureRole==='supervisor'&&!structurePermissions.has('app_admin');

        const departments = await pool.query(
          `SELECT d.id,d.name,
                  he.id AS department_head_id,
                  he.first_name AS department_head_first_name,
                  he.last_name AS department_head_last_name
             FROM departments d
             LEFT JOIN LATERAL (
               SELECT e.id,e.first_name,e.last_name
                 FROM employees e
                WHERE e.department_id=d.id
                  AND e.role='department_head'
                  AND e.active=TRUE
                ORDER BY e.id
                LIMIT 1
             ) he ON TRUE
            WHERE $1::boolean=TRUE
               OR d.id=$2
               OR ($4::boolean=TRUE AND EXISTS (
                 SELECT 1 FROM supervisor_employee_assignments x
                 WHERE x.department_id=d.id AND x.supervisor_employee_id=$3 AND x.active=TRUE
               ))
            ORDER BY d.name`,
          [canManageAll, req.user.department_id, req.user.id, assignmentBound],
        );

        const employees = await pool.query(
          `SELECT e.id,e.employee_number,e.first_name,e.last_name,e.department_id,
                  d.name AS department_name,e.active,e.forced_lunch_enabled,e.forced_lunch_minutes,
                  (e.role='department_head') AS is_department_head,
                  EXISTS(SELECT 1 FROM supervisor_employee_assignments sea WHERE sea.supervisor_employee_id=e.id AND sea.active=TRUE) AS is_supervisor
             FROM employees e
             LEFT JOIN departments d ON d.id=e.department_id
            WHERE e.active=TRUE
              AND (
                $1::boolean=TRUE
                OR e.department_id=$2
                OR ($4::boolean=TRUE AND e.department_id IN (
                  SELECT department_id FROM supervisor_employee_assignments x
                  WHERE x.supervisor_employee_id=$3 AND x.active=TRUE
                ))
              )
            ORDER BY d.name,e.last_name,e.first_name`,
          [canManageAll, req.user.department_id, req.user.id, assignmentBound],
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
    requireAnyPermission('app_admin'),
    (_req,res)=>res.status(410).json({
      error:'Department Head is now a TimeClock role managed in Employee Portal > Access Matrix.'
    }),
  );

  router.post(
    '/supervisor/team-structure/assign',
    requireUser,
    requireAnyPermission('manage_supervisor_assignments'),
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
    requireAnyPermission('manage_supervisor_assignments'),
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
