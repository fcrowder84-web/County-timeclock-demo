'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
function patch(rel,fn){const file=path.join(root,rel);const before=fs.readFileSync(file,'utf8');const after=fn(before);if(after===before)throw new Error('No change: '+rel);fs.writeFileSync(file,after);}
patch('server.js',s=>{const p=/async function canAccessEmployee\(user,\s*employeeId,\s*actionPermissions\s*=\s*\[\]\)\s*\{[\s\S]*?\}\s*\n\s*async function syncPortalUser/;if(!p.test(s))throw new Error('canAccessEmployee not found');const r=`async function canAccessEmployee(user, employeeId, actionPermissions = []) {
  const permissions=userPermissionSet(user);
  const isSelf=Number(user.id)===Number(employeeId);
  const requested=actionPermissions.length?actionPermissions:["view_assigned_employees","view_department_time","view_payroll_records","review_approved_timecards","edit_employee_time","edit_payroll_time","approve_punch_correction","approve_timecard","return_timecard","return_to_supervisor"];
  const approvalKind=requested.includes("approve_punch_correction")?"punch":(requested.includes("approve_timecard")?"timecard":null);
  const target=await pool.query(\`SELECT department_id FROM employees WHERE id=$1 LIMIT 1\`,[employeeId]);
  if(!target.rows.length)return false;
  const departmentHead=await isDepartmentHead(user,target.rows[0].department_id);
  if(approvalKind){
    if(isSelf){if(!departmentHead)return false;return approvalKind==="punch"?permissions.has("approve_own_punch_corrections"):permissions.has("approve_own_timecard");}
    const key=approvalKind==="punch"?"approve_punch_correction":"approve_timecard";
    if(!permissions.has(key))return false;
    return departmentHead||isAssignedEmployee(user,employeeId);
  }
  if(isSelf)return true;
  const payrollKeys=new Set(["view_payroll_records","review_approved_timecards","edit_payroll_time","return_to_supervisor","reopen_timecard","finalize_timecard","export_payroll","view_payroll_reports"]);
  if(requested.some(k=>permissions.has(k)&&payrollKeys.has(k)))return true;
  if(permissions.has("app_admin")){if(user.app_admin_scope==="all")return true;return isSameDepartment(user,employeeId);}
  if(departmentHead&&requested.some(k=>permissions.has(k)))return true;
  if(permissions.has("view_assigned_employees")&&await isAssignedEmployee(user,employeeId))return true;
  if(requested.some(k=>["edit_employee_time","return_timecard"].includes(k)&&permissions.has(k)))return isAssignedEmployee(user,employeeId);
  return false;
}

async function syncPortalUser`;return s.replace(p,r);});
patch('routes/supervisor.js',s=>{let o=s;
const a=`             $3::text IN ('admin','payroll')
             OR e.id IN (
               SELECT employee_id
               FROM supervisor_employee_assignments
               WHERE supervisor_employee_id=$4 AND active=TRUE
             )
             OR e.department_id IN (
               SELECT department_id
               FROM department_heads
               WHERE employee_id=$4 AND active=TRUE
             )`;
const b=`             (COALESCE($3::boolean,FALSE)=TRUE)
             OR e.id IN (
               SELECT employee_id
               FROM supervisor_employee_assignments
               WHERE supervisor_employee_id=$4 AND active=TRUE
             )
             OR e.department_id IN (
               SELECT department_id
               FROM department_heads
               WHERE employee_id=$4 AND active=TRUE
             )`;
if(!o.includes(a))throw new Error('status scope not found');
o=o.replace(a,b);
o=o.replace(`[period.pay_period_start, period.pay_period_end, req.user.role, req.user.id],`,`[period.pay_period_start, period.pay_period_end, userHasPermission(req.user, 'app_admin'), req.user.id],`);
const c=`               $1::text IN ('admin','payroll')
               OR e.id IN (
                 SELECT employee_id FROM supervisor_employee_assignments
                 WHERE supervisor_employee_id=$2 AND active=TRUE
               )
               OR e.department_id IN (
                 SELECT department_id FROM department_heads
                 WHERE employee_id=$2 AND active=TRUE
               )`;
const d=`               (COALESCE($1::boolean,FALSE)=TRUE)
               OR e.id IN (
                 SELECT employee_id FROM supervisor_employee_assignments
                 WHERE supervisor_employee_id=$2 AND active=TRUE
               )
               OR e.department_id IN (
                 SELECT department_id FROM department_heads
                 WHERE employee_id=$2 AND active=TRUE
               )`;
if(!o.includes(c))throw new Error('request scope not found');
o=o.replace(c,d);
o=o.replace(`[req.user.role, req.user.id],`,`[userHasPermission(req.user, 'app_admin'), req.user.id],`);
const timecardMarker=`  router.get(\n    '/supervisor/employee-timecard/:employeeId',`;
const markerIndex=o.indexOf(timecardMarker);
if(markerIndex<0)throw new Error('employee timecard route not found');
const beforeTimecard=o.slice(0,markerIndex);
let timecardTail=o.slice(markerIndex);
const oldAccess=`        if (!(await canAccessEmployee(req.user, employeeId))) {\n          return res.status(403).json({ error: 'Access denied' });\n        }`;
const newAccess=`        const countywideRead =\n          userHasPermission(req.user, 'view_all_timeclock_records') ||\n          (userHasPermission(req.user, 'app_admin') && req.user.app_admin_scope === 'all');\n        if (!countywideRead && !(await canAccessEmployee(req.user, employeeId))) {\n          return res.status(403).json({ error: 'Access denied' });\n        }`;
if(!timecardTail.includes(oldAccess))throw new Error('employee timecard access check not found');
timecardTail=timecardTail.replace(oldAccess,newAccess);
o=beforeTimecard+timecardTail;
return o;});
patch('routes/leave.js',s=>{const a=`      const reviewingOwnLeave = Number(existing.rows[0].employee_id) === Number(req.user.id);\n      const canReviewOwnLeave = reviewingOwnLeave && userHasAnyPermission(req.user, ['approve_own_timecard']);\n      if (!isSupervisor(req.user) && !canReviewOwnLeave) {\n        return res.status(403).json({ error: 'Supervisor access required' });\n      }\n\n      await assertAccess(req.user, existing.rows[0].employee_id);`;const b=`      if (!(await canAccessEmployee(req.user, existing.rows[0].employee_id, ['approve_timecard']))) {\n        return res.status(403).json({ error: 'You cannot review leave for this employee' });\n      }`;if(!s.includes(a))throw new Error('leave review block not found');return s.replace(a,b);});
