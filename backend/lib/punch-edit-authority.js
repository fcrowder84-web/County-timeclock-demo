'use strict';

const { userHasPermission } = require('./permissions');

// Editing authority is capability + scope. App Admin has every application
// capability, but normal workflow locks are still enforced by the route.
async function canEditPunch(db,user,employeeId,action='edit'){
  const canEdit=
    userHasPermission(user,'edit_employee_time')
    || userHasPermission(user,'edit_payroll_time')
    || (action==='add'&&userHasPermission(user,'add_employee_entry'));
  if(!canEdit) return false;

  if(userHasPermission(user,'app_admin')) return true;

  const role=String(user?.role||'employee').toLowerCase();
  if(role==='timeclock_manager'||role==='payroll') return true;

  const result=await db.query(
    `SELECT target.department_id,
            EXISTS (
              SELECT 1 FROM supervisor_employee_assignments sea
               WHERE sea.employee_id=target.id
                 AND sea.supervisor_employee_id=$2
                 AND sea.active=TRUE
            ) AS is_assigned
       FROM employees target
      WHERE target.id=$1
      LIMIT 1`,
    [employeeId,user.id],
  );
  if(!result.rows.length) return false;

  const target=result.rows[0];
  const sameDepartment=
    Number(user?.department_id)>0
    && Number(user.department_id)===Number(target.department_id);

  // Department Head scope includes every employee in the department,
  // including the Department Head's own record.
  if(role==='department_head'&&sameDepartment) return true;

  // Supervisor scope is assigned employees only and never self.
  if(Number(user.id)!==Number(employeeId)&&target.is_assigned) return true;

  return false;
}

function hasPayrollOverride(user){
  return userHasPermission(user,'edit_payroll_time');
}

module.exports={canEditPunch,hasPayrollOverride};
