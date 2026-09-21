'use strict';

const assert=require('assert');
const {canEditPunch,hasPayrollOverride}=require('../lib/punch-edit-authority');

(async()=>{
  const noScopeDb={async query(){return {rows:[]};}};

  // Countywide App Admin has every punch capability and countywide employee scope.
  assert.strictEqual(
    await canEditPunch(
      noScopeDb,
      {id:1,permissions:['app_admin'],role:'admin',app_admin_scope:'all',department_id:10},
      20,
      'edit',
    ),
    true,
  );
  assert.strictEqual(
    await canEditPunch(
      noScopeDb,
      {id:1,permissions:['app_admin'],role:'admin',app_admin_scope:'all',department_id:10},
      20,
      'add',
    ),
    true,
  );

  // Department-scoped App Admin still gets the master capability grant, but
  // employee scope is limited to the admin's home department.
  const sameDepartmentDb={
    async query(){
      return {rows:[{department_id:10,is_assigned:false}]};
    },
  };
  const otherDepartmentDb={
    async query(){
      return {rows:[{department_id:11,is_assigned:false}]};
    },
  };
  const scopedAdmin={id:1,permissions:['app_admin'],role:'admin',app_admin_scope:'own',department_id:10};
  assert.strictEqual(await canEditPunch(sameDepartmentDb,scopedAdmin,20,'edit'),true);
  assert.strictEqual(await canEditPunch(otherDepartmentDb,scopedAdmin,21,'edit'),false);

  // Ordinary supervisors need both the operational permission and assignment scope.
  assert.strictEqual(
    await canEditPunch(
      noScopeDb,
      {id:1,permissions:['edit_employee_time'],role:'supervisor',department_id:10},
      20,
      'edit',
    ),
    false,
  );
  const assignedDb={
    async query(){
      return {rows:[{department_id:10,is_assigned:true}]};
    },
  };
  assert.strictEqual(
    await canEditPunch(
      assignedDb,
      {id:1,permissions:['edit_employee_time'],role:'supervisor',department_id:10},
      20,
      'edit',
    ),
    true,
  );

  // Retained assignments cannot widen restrictive role scope after a role
  // change or department transfer.
  assert.strictEqual(
    await canEditPunch(
      otherDepartmentDb,
      {id:1,permissions:['edit_employee_time'],role:'department_head',department_id:10},
      21,
      'edit',
    ),
    false,
  );
  assert.strictEqual(
    await canEditPunch(
      assignedDb,
      {id:1,permissions:['edit_employee_time'],role:'employee',department_id:10},
      20,
      'edit',
    ),
    false,
  );

  // Payroll override is a capability check; scope is enforced separately.
  assert.strictEqual(hasPayrollOverride({permissions:['app_admin']}),true);
  assert.strictEqual(hasPayrollOverride({permissions:['edit_payroll_time']}),true);
  assert.strictEqual(hasPayrollOverride({permissions:['edit_employee_time']}),false);

  console.log('punch edit authority tests: PASS');
})().catch(err=>{console.error(err);process.exitCode=1;});
