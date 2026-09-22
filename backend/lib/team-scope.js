'use strict';

const { userHasPermission } = require('./permissions');

function canManageTeamStructureScope(user, departmentId = null) {
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
  if(role==='department_head'){
    if(departmentId==null) return Number(user.department_id)>0;
    return Number(user.department_id)>0&&Number(user.department_id)===Number(departmentId);
  }

  return false;
}

module.exports={canManageTeamStructureScope};
