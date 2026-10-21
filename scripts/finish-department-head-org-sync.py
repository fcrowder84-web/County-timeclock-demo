#!/usr/bin/env python3
from pathlib import Path

p=Path('backend/server.js')
s=p.read_text()

def once(old,new,label):
    global s
    n=s.count(old)
    if n!=1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {n}')
    s=s.replace(old,new,1)

once('const { canManageTeamStructureScope } = require("./lib/team-scope");','const { canManageTeamStructureScope, isOrganizationalDepartmentHead } = require("./lib/team-scope");','team-scope import')

once("    app_admin_scope: current.timeclock_access ? current.app_admin_scope : 'own',\n", "    app_admin_scope: current.timeclock_access ? current.app_admin_scope : 'own',\n    is_department_head: Boolean(current.is_department_head),\n", 'authorization head payload')

old="""async function isDepartmentHead(user,departmentId=null){
  const role=String(user?.role||'').toLowerCase();
  return role==='department_head'
    && (!departmentId||Number(user.department_id)===Number(departmentId));
}"""
new="""async function isDepartmentHead(user,departmentId=null){
  return isOrganizationalDepartmentHead(pool,user,departmentId);
}"""
once(old,new,'isDepartmentHead')

once('  return canManageTeamStructureScope(user,departmentId);','  return canManageTeamStructureScope(pool,user,departmentId);','team structure scope call')
once("  if(role==='department_head') return sameDepartment;","  if(await isDepartmentHead(user,targetDepartment)) return true;",'employee access head check')

marker="""function resolveApplicationRole(explicitRole,permissions){
  const normalizedPermissions=normalizePermissions(permissions||[]);
  if(normalizedPermissions.includes('app_admin')) return 'admin';
  const requested=String(explicitRole||'').toLowerCase();
  if(APPLICATION_ROLES.has(requested)&&requested!=='admin') return requested;
  return deriveLegacyRole(normalizedPermissions);
}
"""
helper=marker+"""
async function syncOrganizationalDepartmentHead(client,employeeId,departmentId,isDepartmentHead){
  if(!employeeId||!departmentId) return;
  await client.query(
    `UPDATE department_heads
        SET active=FALSE
      WHERE employee_id=$1
        AND active=TRUE
        AND (department_id<>$2 OR $3::boolean=FALSE)`,
    [employeeId,departmentId,Boolean(isDepartmentHead)],
  );
  if(!isDepartmentHead) return;
  await client.query(
    `UPDATE department_heads
        SET active=FALSE
      WHERE department_id=$1 AND employee_id<>$2 AND active=TRUE`,
    [departmentId,employeeId],
  );
  await client.query(
    `INSERT INTO department_heads(department_id,employee_id,active,assigned_by,assigned_at)
     VALUES($1,$2,TRUE,NULL,NOW())
     ON CONFLICT(department_id,employee_id)
     DO UPDATE SET active=TRUE,assigned_by=NULL,assigned_at=NOW()`,
    [departmentId,employeeId],
  );
}
"""
once(marker,helper,'head sync helper')

once("""    await client.query('COMMIT');
    return {user,permissions,appAdminScope};
""","""    if(Object.prototype.hasOwnProperty.call(payload,'is_department_head')){
      await syncOrganizationalDepartmentHead(client,user.id,departmentId,Boolean(payload.is_department_head));
    }
    await client.query('COMMIT');
    return {user,permissions,appAdminScope};
""",'auth sync relationship')

old="""    if(capFresh) await recordWeeklyCapChange(client,{employeeId:updated.rows[0].id,previousCap:existing.rows[0].weekly_hours_cap,weeklyHoursCap:item.weekly_hours_cap,source:'portal-directory-sync',targetPeriod:item.weekly_hours_cap_target_period||'auto',changedAt:item.weekly_hours_cap_changed_at||null});
    return {id:updated.rows[0].id,activated:!wasActive};
"""
new="""    if(capFresh) await recordWeeklyCapChange(client,{employeeId:updated.rows[0].id,previousCap:existing.rows[0].weekly_hours_cap,weeklyHoursCap:item.weekly_hours_cap,source:'portal-directory-sync',targetPeriod:item.weekly_hours_cap_target_period||'auto',changedAt:item.weekly_hours_cap_changed_at||null});
    if(Object.prototype.hasOwnProperty.call(item,'is_department_head')) await syncOrganizationalDepartmentHead(client,updated.rows[0].id,departmentId,Boolean(item.is_department_head));
    return {id:updated.rows[0].id,activated:!wasActive};
"""
once(old,new,'directory update relationship')

old="""  await recordWeeklyCapChange(client,{employeeId:inserted.rows[0].id,previousCap:null,weeklyHoursCap:item.weekly_hours_cap??null,source:'portal-directory-create',targetPeriod:item.weekly_hours_cap_target_period||'auto',changedAt:item.weekly_hours_cap_changed_at||null,force:true});
  return {id:inserted.rows[0].id,activated:true};
"""
new="""  await recordWeeklyCapChange(client,{employeeId:inserted.rows[0].id,previousCap:null,weeklyHoursCap:item.weekly_hours_cap??null,source:'portal-directory-create',targetPeriod:item.weekly_hours_cap_target_period||'auto',changedAt:item.weekly_hours_cap_changed_at||null,force:true});
  if(Object.prototype.hasOwnProperty.call(item,'is_department_head')) await syncOrganizationalDepartmentHead(client,inserted.rows[0].id,departmentId,Boolean(item.is_department_head));
  return {id:inserted.rows[0].id,activated:true};
"""
once(old,new,'directory insert relationship')

old="""const removed=await client.query(`UPDATE employees SET active=FALSE,is_active=FALSE,portal_permissions='[]'::jsonb,access_removed_at=COALESCE(access_removed_at,NOW()),directory_sync_state='removed',last_portal_sync_at=NOW() WHERE auth_source='portal' AND active=TRUE AND NOT (portal_user_id::text = ANY($1::text[])) RETURNING id`,[Array.from(ids)]);await client.query('COMMIT');"""
new="""const removed=await client.query(`UPDATE employees SET active=FALSE,is_active=FALSE,portal_permissions='[]'::jsonb,access_removed_at=COALESCE(access_removed_at,NOW()),directory_sync_state='removed',last_portal_sync_at=NOW() WHERE auth_source='portal' AND active=TRUE AND NOT (portal_user_id::text = ANY($1::text[])) RETURNING id`,[Array.from(ids)]);if(removed.rows.length)await client.query(`UPDATE department_heads SET active=FALSE WHERE active=TRUE AND employee_id=ANY($1::int[])`,[removed.rows.map(row=>row.id)]);await client.query('COMMIT');"""
once(old,new,'directory removal relationship')

p.write_text(s)

# Correct the source-of-truth wording anywhere the old Access Matrix wording remains.
for name in ['frontend/department-structure.html','backend/routes/team-structure.js']:
    q=Path(name)
    if q.exists():
        text=q.read_text()
        text=text.replace('Employee Portal → Access Matrix','Employee Portal → Departments')
        text=text.replace('Employee Portal > Access Matrix','Employee Portal > Departments')
        q.write_text(text)

print('Department Head organizational sync patch applied successfully.')
