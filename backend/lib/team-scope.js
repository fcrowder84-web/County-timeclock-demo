'use strict';

const { userHasPermission } = require('./permissions');

function canManageTeamStructureScope(user,departmentId = null) {
  const role=String(user?.role||'').toLowerCase();
  const canManage=
    userHasPermission(user,'manage_supervisor_assignments')
    || userHasPermission(user,'manage_employee_lunch_settings');
  if(!canManage) return false;

  if(userHasPermission(user,'app_admin')){
    if(user.app_admin_scope==='all') return true;
    if(departmentId==null) return Number(user.department_id)>0;
    return Number(user.department_id)>0&&Number(user.department_id)===Number(departmentId);
  }

  if(role==='timeclock_manager'||role==='payroll') return true;

  // Preserve the existing synchronous authorization contract. Organizational
  // Department Head membership is hydrated onto the request user separately.
  // Keep the legacy role fallback during migration so existing heads do not
  // unexpectedly lose access before all directory records have synchronized.
  const organizationalHead=user?.is_department_head===true||role==='department_head';
  if(!organizationalHead) return false;
  if(departmentId==null) return Number(user.department_id)>0;
  return Number(user.department_id)>0&&Number(user.department_id)===Number(departmentId);
}

module.exports={canManageTeamStructureScope};
