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
  const organizationalHead=Boolean(user?.is_department_head)||role==='department_head';
  if(!organizationalHead) return false;
  if(departmentId==null) return Number(user.department_id)>0;
  return Number(user.department_id)>0&&Number(user.department_id)===Number(departmentId);
}

module.exports={canManageTeamStructureScope,isOrganizationalDepartmentHead};
