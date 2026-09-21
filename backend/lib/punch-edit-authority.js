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

  if(userHasPermission(user,'app_admin')&&user.app_admin_scope==='all') return true;

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

  if(userHasPermission(user,'app_admin')) return sameDepartment;

  // Department Head has a hard department boundary. A retained
  // supervisor assignment outside that department must not widen scope.
  if(role==='department_head') return sameDepartment;

  // Employee is always self-only. Supervisor is assigned-employees-only and
  // never implicitly gets self edit authority.
  if(role==='employee') return false;
  if(role==='supervisor'){
    return Number(user.id)!==Number(employeeId)&&target.is_assigned;
  }

  return false;
}

function hasPayrollOverride(user){
  return userHasPermission(user,'edit_payroll_time');
}

module.exports={canEditPunch,hasPayrollOverride};
