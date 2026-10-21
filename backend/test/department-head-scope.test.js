'use strict';

const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const permissions=require('../lib/permissions');
const {canApprove,getApprovalAuthority}=require('../lib/approval-authority');
const {canEditPunch}=require('../lib/punch-edit-authority');
const {canManageTeamStructureScope}=require('../lib/team-scope');
const {createTeamStructureRouter}=require('../routes/team-structure');
const server=fs.readFileSync(require.resolve('../server'),'utf8');
const accessSource=server.slice(server.indexOf('async function isAssignedEmployee('),server.indexOf('const APPLICATION_ROLES='));
const users=[
  {name:'David Caddell',role:'timeclock_manager',all:true},
  {name:'Hart "Doc" Clark',role:'timeclock_manager',all:true},
  {name:'Foster Crowder',role:'admin',app_admin_scope:'all',all:true},
  {name:'Payroll',role:'payroll',all:true},
  {name:'Department App Admin',role:'admin',app_admin_scope:'own',all:false},
  {name:'Legacy head',role:'department_head',all:false},
  {name:'Organizational head',role:'employee',all:false},
  {name:'Supervisor head',role:'supervisor',all:false},
];
const actionPermissions=['approve_timecard','edit_employee_time','manage_supervisor_assignments'];
function scopeDb(departmentId,assigned=false){
  return {async query(sql){
    if(sql.includes('FROM supervisor_employee_assignments sea WHERE'))return {rows:assigned?[{}]:[]};
    if(sql.includes('FROM supervisor_employee_assignments\n'))return {rows:assigned?[{}]:[]};
    if(sql.includes('FROM employees')||sql.includes('FROM employees target')){
      return {rows:[{id:20,department_id:departmentId,is_assigned:assigned,is_department_head:departmentId===10}]};
    }
    throw new Error('Unexpected scope query: '+sql);
  }};
}
function response(){return {statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};}
function handler(router,route){return router.stack.find(x=>x.route?.path===route).route.stack.at(-1).handle;}

(async()=>{
  for(const item of users){
    const user={id:1,department_id:10,is_department_head:true,
      permissions:[...permissions.ROLE_PRESETS[item.role],...actionPermissions],...item};
    const original=JSON.stringify(user);
    for(const departmentId of [10,11]){
      const pool=scopeDb(departmentId,true);
      const {canAccessEmployee}=vm.runInNewContext(accessSource+";({canAccessEmployee})",{pool,...permissions,canManageTeamStructureScope});
      const expected=item.all||departmentId===10;
      assert.strictEqual(await canAccessEmployee(user,20,['edit_employee_time']),expected,item.name);
      assert.strictEqual(await canEditPunch(pool,user,20),expected,item.name);
      assert.strictEqual(await canApprove(pool,user,20,'timecard'),expected,item.name);
      assert.strictEqual(canManageTeamStructureScope(user,departmentId),expected,item.name);
      assert.strictEqual((await getApprovalAuthority(pool,user,20)).isDepartmentHead,departmentId===10);
    }
    // Staff/departments retain countywide roles, while organizational heads
    // cannot inherit unrelated supervisor assignments outside their department.
    const queries=[];
    const router=createTeamStructureRouter({
      requireUser:()=>{},requireAnyPermission:()=>()=>{},
      pool:{async query(sql,args){queries.push({sql,args});return {rows:[]};}},
      audit:async()=>{},canManageTeamStructure:canManageTeamStructureScope,
      userPermissionSet:permissions.userPermissionSet,
    });
    for(const path of ['/supervisor/staff','/supervisor/departments','/supervisor/team-structure']){
      queries.length=0;
      const res=response();
      await handler(router,path)({user},res);
      assert.strictEqual(res.statusCode,200,item.name+path);
      assert.strictEqual(queries[0].args[0],item.all,item.name+path);
      assert.strictEqual(queries[0].args[1],true,item.name+path);
      assert.strictEqual(queries[0].args[2],10);
      if(path!=='/supervisor/team-structure')assert.strictEqual(queries[0].args[4],false);
      else{
        assert.match(queries[0].sql,/FROM department_heads/);
        assert.match(queries[1].sql,/FROM department_heads/);
      }
    }
    assert.strictEqual(JSON.stringify(user),original,'scope checks must not mutate role or permissions');
  }

  // Legacy heads work before a relationship has ever synchronized.
  const legacy={id:1,role:'department_head',department_id:10,permissions:actionPermissions};
  const db={async query(){return {rows:[{id:20,department_id:10,is_assigned:false,is_department_head:false}]};}};
  assert.strictEqual(await canEditPunch(db,legacy,20),true);
  assert.strictEqual(await canApprove(db,legacy,20,'timecard'),true);
  assert.strictEqual(canManageTeamStructureScope(legacy,10),true);

  // No organizational flag: supervisors stay assigned-only, employees self-only.
  for(const role of ['supervisor','employee']){
    for(const assigned of [false,true]){
      const user={id:1,role,department_id:10,permissions:actionPermissions};
      const pool={async query(sql){
        if(sql.includes('FROM supervisor_employee_assignments'))return {rows:assigned?[{}]:[]};
        return {rows:[{department_id:10,is_assigned:assigned,is_department_head:false}]};
      }};
      const {canAccessEmployee}=vm.runInNewContext(accessSource+";({canAccessEmployee})",{pool,...permissions,canManageTeamStructureScope});
      const expected=role==='supervisor'&&assigned;
      assert.strictEqual(await canAccessEmployee(user,20,['edit_employee_time']),expected);
      assert.strictEqual(await canApprove(pool,user,20,'timecard'),expected);
      // Punch query includes assignment EXISTS, so use its returned target row.
      assert.strictEqual(await canEditPunch({query:async()=>({rows:[{department_id:10,is_assigned:assigned}]})},user,20),expected);
      assert.strictEqual(canManageTeamStructureScope(user,10),false);
    }
  }
  // Being a head supplies scope, not unchecked capabilities or self approval.
  const head={id:1,role:'employee',department_id:10,is_department_head:true,permissions:['access']};
  assert.strictEqual(await canEditPunch(db,head,20),false);
  assert.strictEqual(await canApprove(db,head,20,'timecard'),false);
  assert.strictEqual(canManageTeamStructureScope(head,10),false);
  assert.strictEqual(await canApprove(db,{...head,permissions:['approve_own_timecard']},1,'timecard'),false);
  console.log('organizational Department Head scope tests: PASS');
})().catch(err=>{console.error(err);process.exitCode=1;});
