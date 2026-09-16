'use strict';

// Technical administration and read permissions never authorize punch changes.
async function canEditPunch(db, user, employeeId, action = 'edit') {
  const permissions = new Set(user?.permissions || []);
  if (Number(user.id) === Number(employeeId)) return false;
  if (permissions.has('edit_payroll_time')) return true;
  const allowed = permissions.has('edit_employee_time')
    || (action === 'add' && permissions.has('add_employee_entry'));
  if (!allowed) return false;
  const result = await db.query(
    `SELECT 1 FROM employees target WHERE target.id=$1 AND (
       EXISTS (SELECT 1 FROM supervisor_employee_assignments sea
         WHERE sea.employee_id=target.id AND sea.supervisor_employee_id=$2 AND sea.active=TRUE)
       OR EXISTS (SELECT 1 FROM department_heads dh
         WHERE dh.department_id=target.department_id AND dh.employee_id=$2 AND dh.active=TRUE)
     ) LIMIT 1`, [employeeId, user.id]);
  return result.rows.length > 0;
}

function hasPayrollOverride(user) {
  return new Set(user?.permissions || []).has('edit_payroll_time');
}

module.exports = { canEditPunch, hasPayrollOverride };
