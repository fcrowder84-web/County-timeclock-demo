'use strict';

const { userHasPermission } = require('./permissions');

async function isOrganizationalDepartmentHead(db,user,departmentId=null){
  if(!user?.id) return false;
  const params=[user.id];
  let departmentFilter='';
  if(departmentId!=null){
    params.push(departmentId);
    departmentFilter=' AND dh.department_id=$2';
  }
  const result=await db.query(
    `SELECT 1 FROM department_heads dh
      WHERE dh.employee_id=$1 AND dh.active=TRUE${departmentFilter}
      LIMIT 1`,
    params,
  );
  return result.rows.length>0;
}

async function canManageTeamStructureScope(db,user,departmentId = null) {
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
  return isOrganizationalDepartmentHead(db,user,departmentId);
}

module.exports={canManageTeamStructureScope,isOrganizationalDepartmentHead};
