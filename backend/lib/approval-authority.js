'use strict';

const { userPermissionSet, userHasPermission, roleCanSelfApprove } = require('./permissions');

function rawPermissions(user) {
  return userPermissionSet(user);
}

async function getApprovalAuthority(pool,user,employeeId){
  const target=await pool.query(
    `SELECT id,department_id FROM employees WHERE id=$1 LIMIT 1`,
    [employeeId],
  );
  if(!target.rows.length){
    return {allowed:false,isSelf:false,isDepartmentHead:false,isAssignedSupervisor:false,isCountywideRole:false};
  }

  const isSelf=Number(user?.id)===Number(employeeId);
  const departmentId=target.rows[0].department_id;
  const role=String(user?.role||'employee').toLowerCase();
  const appAdmin=userHasPermission(user,'app_admin');
  const appAdminInScope=appAdmin&&(
    user.app_admin_scope==='all'
    || (Number(user?.department_id)>0&&Number(user.department_id)===Number(departmentId))
  );
  const isCountywideRole=role==='payroll'||role==='timeclock_manager';

  // Organizational head status is additive to application role. Portal-synced
  // request users carry is_department_head. Preserve the legacy role fallback
  // during migration; do not turn ordinary employees/supervisors into a DB
  // lookup path merely because they happen to be in the same department.
  const sameDepartment=Number(user?.department_id)>0&&Number(user.department_id)===Number(departmentId);
  let isDepartmentHead=sameDepartment&&(
    Boolean(user?.is_department_head)||role==='department_head'
  );

  // Higher application roles can also be organizational Department Heads. If
  // their hydrated flag is unavailable, consult the relationship without
  // changing their application role or permissions.
  if(!isDepartmentHead&&sameDepartment&&user?.id&&(
    role==='timeclock_manager'||role==='payroll'||role==='admin'
  )){
    const head=await pool.query(
      `SELECT 1 FROM department_heads
        WHERE employee_id=$1 AND department_id=$2 AND active=TRUE LIMIT 1`,
      [user.id,departmentId],
    );
    isDepartmentHead=head.rows.length>0;
  }

  let isAssignedSupervisor=false;
  if(role==='supervisor'&&!isSelf){
    const assigned=await pool.query(
      `SELECT 1 FROM supervisor_employee_assignments
        WHERE supervisor_employee_id=$1 AND employee_id=$2 AND active=TRUE LIMIT 1`,
      [user.id,employeeId],
    );
    isAssignedSupervisor=assigned.rows.length>0;
  }

  return {
    allowed:appAdminInScope||isCountywideRole||isDepartmentHead||isAssignedSupervisor,
    isSelf,
    isDepartmentHead,
    isAssignedSupervisor,
    isCountywideRole,
    departmentId,
  };
}

async function canApprove(pool,user,employeeId,kind){
  const authority=await getApprovalAuthority(pool,user,employeeId);
  if(!authority.allowed)return false;

  if(authority.isSelf){
    if(!roleCanSelfApprove(user)) return false;
    if(kind==='punch')return userHasPermission(user,'approve_own_punch_corrections');
    if(kind==='timecard')return userHasPermission(user,'approve_own_timecard');
    if(kind==='leave')return userHasPermission(user,'approve_own_leave');
    if(kind==='lunch')return userHasPermission(user,'approve_own_lunch_waiver');
    return false;
  }

  if(kind==='punch')return userHasPermission(user,'approve_punch_correction');
  if(kind==='timecard')return userHasPermission(user,'approve_timecard');
  if(kind==='leave')return userHasPermission(user,'approve_leave');
  if(kind==='lunch')return userHasPermission(user,'approve_lunch_waiver');
  return false;
}

module.exports={rawPermissions,getApprovalAuthority,canApprove};
