const express = require("express");
const { Pool } = require("pg");
const {
  PERMISSION_GROUPS,
  unique,
  normalizePermissions,
  legacyPermissionsForRole,
  deriveLegacyRole,
  currentAuthorizationForUser,
  roleCanSelfApprove,
  userPermissionSet,
  userHasPermission,
  userHasAnyPermission,
} = require("./lib/permissions");
const { verifyPortalToken } = require("./lib/portal-token");
const { createSessionStore, getBearerToken } = require("./lib/session-store");
const { formatDateOnly, resolvePayPeriod, shiftDate } = require("./lib/pay-period");
const { summarizeTimecard } = require("./lib/timecard-summary");
const { createAuthRouter } = require("./routes/auth");
const { createQuickPunchRouter } = require("./routes/quick-punch");
const { createEmployeeRouter } = require("./routes/employee");
const { createSupervisorRouter } = require("./routes/supervisor");
const { createPayrollRouter } = require("./routes/payroll");
const { createTeamStructureRouter } = require("./routes/team-structure");
const { createLeaveRouter } = require("./routes/leave");
const { createLunchRouter } = require("./routes/lunch");
const { createSettingsRouter } = require("./routes/settings");
const { fetchPortalAuthorization } = require("./lib/portal-authorization");
const { canManageTeamStructureScope } = require("./lib/team-scope");

const app = express();
app.use(express.json({ limit: "1mb" }));
if (!process.env.PGPASSWORD) throw new Error("PGPASSWORD is required");
const pool = new Pool({ user: process.env.PGUSER || "timeclock_user", host: process.env.PGHOST || "postgres", database: process.env.PGDATABASE || "county_timeclock", password: process.env.PGPASSWORD, port: Number(process.env.PGPORT || 5432), options: "-c timezone=America/New_York" });
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 8) * 60 * 60 * 1000;
const PORTAL_ISSUER = process.env.TIMECLOCK_SSO_ISSUER || "edgefield-employee-portal";
const PORTAL_AUDIENCE = process.env.TIMECLOCK_SSO_AUDIENCE || "edgefield-timeclock";
const sessionStore = createSessionStore({ ttlMs: SESSION_TTL_MS });
async function audit(actorEmployeeId, action, targetType = null, targetId = null, details = null) { try { await pool.query(`INSERT INTO timeclock_audit_log(actor_employee_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)`, [actorEmployeeId || null, action, targetType, targetId == null ? null : String(targetId), details || null]); } catch (err) { console.error("Audit log error", err); } }
async function getPayPeriodConfig() { const result = await pool.query(`SELECT MAX(CASE WHEN key = 'pay_period_start_date' THEN value END)::date AS anchor_date, MAX(CASE WHEN key = 'pay_period_length_days' THEN value END)::int AS period_days, CURRENT_DATE AS current_date FROM settings`); const config = result.rows[0]; if (!config?.anchor_date || !config?.period_days) throw new Error("Pay period settings are incomplete"); return config; }
async function getPayPeriod(requestedStart = null) { const config = await getPayPeriodConfig(); return resolvePayPeriod({ anchorDate: config.anchor_date, periodDays: config.period_days, targetDate: config.current_date, requestedStart }); }
async function getCurrentPayPeriod() { return getPayPeriod(); }
async function getRequestedPayPeriod(req) { return getPayPeriod(req.query?.period_start || req.body?.period_start || null); }
async function getUserByIdLocal(id) {
  const result = await pool.query(
    `SELECT e.*, d.name AS department_name
       FROM employees e
       LEFT JOIN departments d ON d.id=e.department_id
      WHERE e.id=$1`,
    [id],
  );
  return result.rows[0] || null;
}
async function refreshPortalAuthorization(user) {
  if (!user || String(user.auth_source || '').toLowerCase() !== 'portal' || !user.portal_user_id) {
    return user;
  }

  const current = await fetchPortalAuthorization({
    directoryUrl: PORTAL_DIRECTORY_URL,
    apiKey: PORTAL_DIRECTORY_API_KEY,
    portalUserId: user.portal_user_id,
  });

  if (!current.exists) {
    await pool.query(
      `UPDATE employees
          SET portal_permissions='[]'::jsonb,
              role='employee',
              app_admin_scope='own',
              active=FALSE,
              is_active=FALSE,
              access_removed_at=COALESCE(access_removed_at,NOW()),
              directory_sync_state='removed',
              last_portal_sync_at=NOW()
        WHERE id=$1`,
      [user.id],
    );
    return getUserByIdLocal(user.id);
  }

  const synced = await syncPortalUser({
    sub: current.portal_user_id,
    employee_number: current.employee_number,
    email: current.email,
    first_name: current.first_name,
    last_name: current.last_name,
    department_id: current.portal_department_id,
    department_name: current.department_name,
    permissions: current.timeclock_access ? current.permissions : [],
    timeclock_role: current.timeclock_access ? current.timeclock_role : 'employee',
    app_admin_scope: current.timeclock_access ? current.app_admin_scope : 'own',
  });

  if (!current.is_active || !current.timeclock_access) {
    await pool.query(
      `UPDATE employees
          SET portal_permissions='[]'::jsonb,
              role='employee',
              app_admin_scope='own',
              active=FALSE,
              is_active=FALSE,
              access_removed_at=COALESCE(access_removed_at,NOW()),
              directory_sync_state='removed',
              last_portal_sync_at=NOW()
        WHERE id=$1`,
      [synced.user.id],
    );
  }

  return getUserByIdLocal(synced.user.id);
}
async function getUserById(id) {
  const user = await getUserByIdLocal(id);
  if (!user) return null;
  return refreshPortalAuthorization(user);
}
async function requireUser(req,res,next) {
  try {
    const token=getBearerToken(req);
    const session=sessionStore.getActive(token);
    if(!session||session.expires_at<=Date.now()){
      if(token)sessionStore.destroy(token);
      return res.status(401).json({error:"Login required"});
    }
    const user=await getUserById(session.employee_id);
    if(!user||!user.active||user.is_active===false){
      sessionStore.destroy(token);
      return res.status(401).json({error:"Invalid session"});
    }

    // The bearer session identifies the employee; authorization comes from the
    // current employee record so Portal role/permission/scope reductions take
    // effect on the very next request instead of waiting for session expiry.
    const authorization=currentAuthorizationForUser(
      user,session.permissions,session.app_admin_scope,
    );
    if(String(user.auth_source||'').toLowerCase()==='portal'
      && !authorization.permissions.includes('access')
      && !authorization.permissions.includes('app_admin')){
      sessionStore.destroy(token);
      return res.status(403).json({error:"TimeClock access has been removed"});
    }
    user.permissions=authorization.permissions;
    user.app_admin_scope=authorization.appAdminScope;
    req.user=user;
    req.sessionToken=token;
    next();
  } catch(err){
    if (err?.statusCode === 503) {
      return res.status(503).json({error:err.message});
    }
    next(err);
  }
}
function selfApprovalRouteAllowed(req,keys){
  if(String(req.method||"").toUpperCase()!=="POST"||!roleCanSelfApprove(req.user)) return false;
  const path=String(req.originalUrl||req.url||"").split("?")[0];
  if(keys.includes("approve_punch_correction")
    && userHasPermission(req.user,"approve_own_punch_corrections")
    && (
      path.endsWith("/supervisor/approve-change-request")
      || path.endsWith("/supervisor/deny-change-request")
      || path.endsWith("/supervisor/approve-single-punch")
    )) return true;
  if(keys.includes("approve_timecard")
    && userHasPermission(req.user,"approve_own_timecard")
    && path.endsWith("/supervisor/approve-timecard")) return true;
  return false;
}
function requireAnyPermission(...permissionKeys){const keys=permissionKeys.flat();return(req,res,next)=>{if(userHasAnyPermission(req.user,keys)||selfApprovalRouteAllowed(req,keys))return next();return res.status(403).json({error:`Permission required: ${keys.join(" or ")}`,required_permissions:keys});};}
function requireSupervisor(req,res,next){if(userHasAnyPermission(req.user,PERMISSION_GROUPS.supervisor))return next();return res.status(403).json({error:"Supervisor permission required"});}
function requirePayroll(req,res,next){if(userHasAnyPermission(req.user,PERMISSION_GROUPS.payroll))return next();return res.status(403).json({error:"Payroll permission required"});}
async function isSameDepartment(user,employeeId){const result=await pool.query(`SELECT 1 FROM employees target WHERE target.id=$1 AND target.department_id=$2 LIMIT 1`,[employeeId,user.department_id]);return result.rows.length>0;}
async function isDepartmentHead(user,departmentId=null){
  const role=String(user?.role||'').toLowerCase();
  return role==='department_head'
    && (!departmentId||Number(user.department_id)===Number(departmentId));
}
async function isAssignedEmployee(user,employeeId){const result=await pool.query(`SELECT 1 FROM supervisor_employee_assignments sea WHERE sea.employee_id=$1 AND sea.supervisor_employee_id=$2 AND sea.active=TRUE LIMIT 1`,[employeeId,user.id]);return result.rows.length>0;}
async function canManageTeamStructure(user,departmentId=null){
  return canManageTeamStructureScope(user,departmentId);
}
// Supervisor/dept-head scope is explicit. Permission grants no longer create
// hidden structural assignments as a side effect of portal synchronization.
async function canAccessEmployee(user,employeeId,actionPermissions=[]){
  const role=String(user?.role||'employee').toLowerCase();
  const requested=Array.isArray(actionPermissions)?actionPermissions.filter(Boolean):[];
  const isSelf=Number(user.id)===Number(employeeId);

  // Self approval requires both the dedicated capability and a role that is
  // eligible to perform self-approval. Supervisor and Employee remain barred
  // even if someone accidentally/customarily grants a self-approval tick.
  if(isSelf&&requested.includes('approve_punch_correction')){
    return roleCanSelfApprove(user)
      && userHasPermission(user,'approve_own_punch_corrections');
  }
  if(isSelf&&requested.includes('approve_timecard')){
    return roleCanSelfApprove(user)
      && userHasPermission(user,'approve_own_timecard');
  }
  if(isSelf&&requested.includes('approve_leave')){
    return roleCanSelfApprove(user)
      && userHasPermission(user,'approve_own_leave');
  }
  if(isSelf&&requested.includes('approve_lunch_waiver')){
    return roleCanSelfApprove(user)
      && userHasPermission(user,'approve_own_lunch_waiver');
  }

  if(requested.length&&!userHasAnyPermission(user,requested)) return false;

  if(userHasPermission(user,'app_admin')&&user.app_admin_scope==='all') return true;

  const selfServicePermissions=new Set([
    'access','clock_in_out','view_own_time','request_punch_correction',
    'request_leave','request_lunch_waiver','void_own_unapproved_punch',
    'withdraw_own_pending_request','submit_timecard',
  ]);
  if(isSelf&&(requested.length===0||requested.every(key=>selfServicePermissions.has(key)))) return true;

  if(role==='timeclock_manager'||role==='payroll') return true;

  const target=await pool.query(
    `SELECT department_id FROM employees WHERE id=$1 LIMIT 1`,
    [employeeId],
  );
  if(!target.rows.length) return false;
  const targetDepartment=target.rows[0].department_id;
  const sameDepartment=
    Number(user.department_id)>0
    && Number(user.department_id)===Number(targetDepartment);

  // Department-scoped App Admin and Department Head have hard department
  // boundaries. Retained supervisor assignments must never widen that scope.
  if(userHasPermission(user,'app_admin')) return sameDepartment;
  if(role==='department_head') return sameDepartment;

  // Employee is always self-only. Supervisor is assigned-employees-only.
  if(role==='employee') return false;
  if(role==='supervisor'){
    return !isSelf && await isAssignedEmployee(user,employeeId);
  }

  return false;
}

const APPLICATION_ROLES=new Set(['employee','supervisor','department_head','payroll','timeclock_manager','admin']);
function resolveApplicationRole(explicitRole,permissions){
  const normalizedPermissions=normalizePermissions(permissions||[]);
  if(normalizedPermissions.includes('app_admin')) return 'admin';
  const requested=String(explicitRole||'').toLowerCase();
  if(APPLICATION_ROLES.has(requested)&&requested!=='admin') return requested;
  return deriveLegacyRole(normalizedPermissions);
}

async function syncPortalUser(payload){if(!payload.sub||!payload.first_name||!payload.last_name)throw new Error("Employee Portal token is missing required employee identity details");const permissions=normalizePermissions(payload.permissions||[]);const departmentName=payload.department_name||"Unassigned";let departmentId=null;if(payload.department_id){const byPortalId=await pool.query(`SELECT id FROM departments WHERE portal_department_id=$1 LIMIT 1`,[payload.department_id]);departmentId=byPortalId.rows[0]?.id||null;}if(!departmentId){const departmentResult=await pool.query(`INSERT INTO departments(name,active,portal_department_id) VALUES($1,TRUE,$2) ON CONFLICT (name) DO UPDATE SET active=TRUE, portal_department_id=COALESCE(departments.portal_department_id,EXCLUDED.portal_department_id) RETURNING id`,[departmentName,payload.department_id||null]);departmentId=departmentResult.rows[0].id;}let existing=await pool.query(`SELECT id FROM employees WHERE portal_user_id=$1 LIMIT 1`,[payload.sub]);if(!existing.rows.length&&payload.employee_number)existing=await pool.query(`SELECT id FROM employees WHERE portal_user_id IS NULL AND employee_number=$1 LIMIT 1`,[String(payload.employee_number)]);const appAdminScope=permissions.includes('app_admin')&&payload.app_admin_scope==='all'?'all':'own';const role=resolveApplicationRole(payload.timeclock_role,permissions);if(existing.rows.length){const result=await pool.query(`UPDATE employees SET portal_user_id=$1,employee_number=$2,first_name=$3,last_name=$4,email=$5,department=$6,department_id=$7,portal_department_id=$8,role=$9,active=TRUE,is_active=TRUE,must_change_pin=FALSE,portal_permissions=$10::jsonb,app_admin_scope=$11,auth_source='portal',last_portal_sync_at=NOW() WHERE id=$12 RETURNING *`,[payload.sub,payload.employee_number?String(payload.employee_number):null,payload.first_name,payload.last_name,payload.email||null,departmentName,departmentId,payload.department_id||null,role,JSON.stringify(permissions),appAdminScope,existing.rows[0].id]);return{user:result.rows[0],permissions,appAdminScope};}const result=await pool.query(`INSERT INTO employees(portal_user_id,employee_number,first_name,last_name,email,role,is_active,pin,department,active,department_id,must_change_pin,portal_department_id,portal_permissions,app_admin_scope,auth_source,last_portal_sync_at) VALUES($1,$2,$3,$4,$5,$6,TRUE,NULL,$7,TRUE,$8,FALSE,$9,$10::jsonb,$11,'portal',NOW()) RETURNING *`,[payload.sub,payload.employee_number?String(payload.employee_number):null,payload.first_name,payload.last_name,payload.email||null,role,departmentName,departmentId,payload.department_id||null,JSON.stringify(permissions),appAdminScope]);return{user:result.rows[0],permissions,appAdminScope};}
const PORTAL_DIRECTORY_URL=process.env.PORTAL_DIRECTORY_URL||"";const PORTAL_DIRECTORY_API_KEY=process.env.PORTAL_DIRECTORY_API_KEY||"";const PORTAL_SYNC_INTERVAL_MINUTES=Math.max(1,Number(process.env.PORTAL_SYNC_INTERVAL_MINUTES||5));let portalSyncRunning=false;let lastPortalSync=null;
async function upsertDirectoryEmployee(client,item){const departmentName=item.department_name||"Unassigned";let departmentId=null;if(item.portal_department_id){const found=await client.query(`SELECT id FROM departments WHERE portal_department_id=$1 LIMIT 1`,[item.portal_department_id]);departmentId=found.rows[0]?.id||null;}if(!departmentId){const department=await client.query(`INSERT INTO departments(name,active,portal_department_id) VALUES($1,TRUE,$2) ON CONFLICT(name) DO UPDATE SET active=TRUE, portal_department_id=COALESCE(departments.portal_department_id,EXCLUDED.portal_department_id) RETURNING id`,[departmentName,item.portal_department_id||null]);departmentId=department.rows[0].id;}const permissions=normalizePermissions(item.permissions||[]);const appAdminScope=permissions.includes('app_admin')&&item.app_admin_scope==='all'?'all':'own';const role=resolveApplicationRole(item.timeclock_role,permissions);let existing=await client.query(`SELECT id,active FROM employees WHERE portal_user_id=$1 LIMIT 1`,[item.portal_user_id]);if(!existing.rows.length&&item.employee_number)existing=await client.query(`SELECT id,active FROM employees WHERE portal_user_id IS NULL AND employee_number=$1 LIMIT 1`,[String(item.employee_number)]);if(existing.rows.length){const wasActive=existing.rows[0].active===true;const updated=await client.query(`UPDATE employees SET portal_user_id=$1,employee_number=$2,first_name=$3,last_name=$4,email=$5,department=$6,department_id=$7,portal_department_id=$8,role=$9,active=TRUE,is_active=TRUE,must_change_pin=FALSE,portal_permissions=$10::jsonb,app_admin_scope=$11,auth_source='portal',last_portal_sync_at=NOW(),access_removed_at=NULL,directory_sync_state='active' WHERE id=$12 RETURNING id`,[item.portal_user_id,item.employee_number?String(item.employee_number):null,item.first_name,item.last_name,item.email||null,departmentName,departmentId,item.portal_department_id||null,role,JSON.stringify(permissions),appAdminScope,existing.rows[0].id]);return{id:updated.rows[0].id,activated:!wasActive};}const inserted=await client.query(`INSERT INTO employees(portal_user_id,employee_number,first_name,last_name,email,role,is_active,pin,department,active,department_id,must_change_pin,portal_department_id,portal_permissions,app_admin_scope,auth_source,last_portal_sync_at,access_removed_at,directory_sync_state) VALUES($1,$2,$3,$4,$5,$6,TRUE,NULL,$7,TRUE,$8,FALSE,$9,$10::jsonb,$11,'portal',NOW(),NULL,'active') RETURNING id`,[item.portal_user_id,item.employee_number?String(item.employee_number):null,item.first_name,item.last_name,item.email||null,role,departmentName,departmentId,item.portal_department_id||null,JSON.stringify(permissions),appAdminScope]);return{id:inserted.rows[0].id,activated:true};}
async function syncPortalDirectory(trigger="scheduled"){if(portalSyncRunning)return{skipped:true,reason:"sync already running",lastPortalSync};if(!PORTAL_DIRECTORY_URL||!PORTAL_DIRECTORY_API_KEY)throw new Error("Portal directory sync is not configured");portalSyncRunning=true;let logId=null;let client=null;try{const log=await pool.query(`INSERT INTO portal_directory_sync_log(status) VALUES('running') RETURNING id`);logId=log.rows[0].id;const response=await fetch(PORTAL_DIRECTORY_URL,{headers:{"x-internal-api-key":PORTAL_DIRECTORY_API_KEY,accept:"application/json"},signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error(`Portal directory returned HTTP ${response.status}`);const body=await response.json();if(!body||!Array.isArray(body.employees))throw new Error("Portal directory response is missing the employees array; refusing destructive sync");const employees=body.employees;const ids=new Set();for(const item of employees){if(!item||!item.portal_user_id||!item.first_name||!item.last_name)throw new Error("Portal directory contains an incomplete employee record; refusing destructive sync");const id=String(item.portal_user_id);if(ids.has(id))throw new Error(`Portal directory contains duplicate portal_user_id ${id}`);ids.add(id);}client=await pool.connect();await client.query('BEGIN');const current=await client.query(`SELECT COUNT(*)::int AS count FROM employees WHERE auth_source='portal' AND active=TRUE`);const currentActive=Number(current.rows[0]?.count||0);if(currentActive>0&&employees.length===0)throw new Error("Portal directory returned zero employees while active Portal users exist; refusing mass deactivation");if(currentActive>=5&&employees.length<Math.ceil(currentActive*0.5))throw new Error(`Portal directory shrank from ${currentActive} active users to ${employees.length}; refusing automatic deactivation below 50% safety threshold`);let activated=0;for(const item of employees){const result=await upsertDirectoryEmployee(client,item);if(result.activated)activated+=1;}const removed=await client.query(`UPDATE employees SET active=FALSE,is_active=FALSE,portal_permissions='[]'::jsonb,access_removed_at=COALESCE(access_removed_at,NOW()),directory_sync_state='removed',last_portal_sync_at=NOW() WHERE auth_source='portal' AND active=TRUE AND NOT (portal_user_id::text = ANY($1::text[])) RETURNING id`,[Array.from(ids)]);await client.query('COMMIT');client.release();client=null;const deactivated=removed.rowCount;lastPortalSync={at:new Date().toISOString(),trigger,received:employees.length,activated,deactivated,ok:true};await pool.query(`UPDATE portal_directory_sync_log SET completed_at=NOW(),status='success',received_count=$1,activated_count=$2,deactivated_count=$3 WHERE id=$4`,[employees.length,activated,deactivated,logId]);return lastPortalSync;}catch(err){if(client){await client.query('ROLLBACK').catch(()=>{});client.release();client=null;}lastPortalSync={at:new Date().toISOString(),trigger,ok:false,error:err.message};if(logId!=null)await pool.query(`UPDATE portal_directory_sync_log SET completed_at=NOW(),status='failed',error_message=$1 WHERE id=$2`,[err.message,logId]).catch(logErr=>console.error('Portal directory failure log error:',logErr.message));throw err;}finally{portalSyncRunning=false;}}
app.post('/admin/sync-portal-directory',requireUser,requireAnyPermission('app_admin'),async(req,res)=>{try{res.json(await syncPortalDirectory('manual'));}catch(err){res.status(502).json({error:err.message,last_sync:lastPortalSync});}});
app.get('/admin/portal-sync-status',requireUser,requireAnyPermission('app_admin'),async(req,res)=>{const recent=await pool.query(`SELECT * FROM portal_directory_sync_log ORDER BY id DESC LIMIT 10`);res.json({configured:!!PORTAL_DIRECTORY_URL&&!!PORTAL_DIRECTORY_API_KEY,running:portalSyncRunning,last_sync:lastPortalSync,recent:recent.rows});});
setTimeout(()=>syncPortalDirectory('startup').catch(err=>console.error('Portal directory startup sync failed:',err.message)),10000);setInterval(()=>syncPortalDirectory('scheduled').catch(err=>console.error('Portal directory scheduled sync failed:',err.message)),PORTAL_SYNC_INTERVAL_MINUTES*60*1000);
app.get("/healthz",async(_req,res)=>{try{await pool.query("SELECT 1");return res.json({ok:true,service:"county-timeclock"});}catch(err){console.error("Health check failed",err);return res.status(503).json({ok:false,service:"county-timeclock"});}});app.get("/",(req,res)=>res.send("County Timeclock API Running"));
app.use(createAuthRouter({requireUser,sessionStore,getBearerToken,verifyPortalToken,portalIssuer:PORTAL_ISSUER,portalAudience:PORTAL_AUDIENCE,syncPortalUser,getUserById,audit}));app.use(createQuickPunchRouter({requireUser,requireAnyPermission,pool,audit}));app.use(createLeaveRouter({requireUser,requireAnyPermission,pool,audit,canAccessEmployee,getRequestedPayPeriod,userHasAnyPermission}));app.use(createLunchRouter({requireUser,requireAnyPermission,pool,audit,canAccessEmployee}));app.use(createSettingsRouter({requireUser,requireAnyPermission,pool,audit}));app.use(createSupervisorRouter({requireUser,requireAnyPermission,pool,audit,canAccessEmployee,getRequestedPayPeriod,userHasPermission}));app.use(createPayrollRouter({requireUser,requireAnyPermission,pool,audit,canAccessEmployee,getRequestedPayPeriod}));app.use(createTeamStructureRouter({requireUser,requireAnyPermission,pool,audit,canManageTeamStructure,userPermissionSet}));
app.get("/pay-periods",requireUser,async(req,res)=>{try{const current=await getCurrentPayPeriod();const config=await getPayPeriodConfig();const periodDays=Number(config.period_days);const periods=[];for(let offset=-52;offset<=1;offset+=1){const start=shiftDate(current.pay_period_start,offset*periodDays);periods.push({pay_period_start:start,pay_period_end:shiftDate(start,periodDays-1),is_current:offset===0,is_future:offset>0});}res.json({current,periods:periods.reverse()});}catch(err){console.error(err);res.status(err.statusCode||500).json({error:err.message||"Pay period lookup failed"});}});app.use(createEmployeeRouter({requireUser,requireAnyPermission,pool,audit,canAccessEmployee,getRequestedPayPeriod}));
app.post("/employee/change-pin",requireUser,async(req,res)=>{if(req.user.auth_source==="portal")return res.status(400).json({error:"Employee Portal users manage their password in Employee Portal"});const{new_pin}=req.body;if(!new_pin||new_pin.length<4)return res.status(400).json({error:"New PIN must be at least 4 digits"});try{await pool.query(`UPDATE employees SET pin=$1,must_change_pin=false WHERE id=$2`,[new_pin,req.user.id]);res.json({message:"PIN changed successfully"});}catch(err){console.error(err);res.status(500).send("Change PIN error");}});
app.post("/supervisor/reset-pin",requireUser,requireAnyPermission("manage_employee_timeclock_settings"),async(req,res)=>{const{employee_id}=req.body;try{const targetResult=await pool.query(`SELECT auth_source FROM employees WHERE id=$1`,[employee_id]);if(!targetResult.rows.length)return res.status(404).json({error:"Employee not found"});if(targetResult.rows[0].auth_source==="portal")return res.status(400).json({error:"Employee Portal users do not use a TimeClock PIN"});const access=await canAccessEmployee(req.user,employee_id,["manage_employee_timeclock_settings"]);if(!access)return res.status(403).json({error:"Access denied"});await pool.query(`UPDATE employees SET pin='1111',must_change_pin=true WHERE id=$1`,[employee_id]);res.json({message:"PIN reset to 1111. Employee must change PIN at next login."});}catch(err){console.error(err);res.status(500).send("Reset PIN error");}});
app.listen(3000,()=>console.log("Server running on port 3000"));
