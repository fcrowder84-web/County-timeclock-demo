'use strict';

const assert=require('assert');
const {canEditPunch,hasPayrollOverride}=require('../lib/punch-edit-authority');

(async()=>{
  const noScopeDb={async query(){return {rows:[]};}};

  assert.strictEqual(
    await canEditPunch(noScopeDb,{id:1,permissions:['app_admin'],role:'admin',department_id:10},20,'edit'),
    true,
  );
  assert.strictEqual(
    await canEditPunch(noScopeDb,{id:1,permissions:['app_admin'],role:'admin',department_id:10},20,'add'),
    true,
  );
  assert.strictEqual(
    await canEditPunch(noScopeDb,{id:1,permissions:['edit_employee_time'],role:'supervisor',department_id:10},20,'edit'),
    false,
  );

  const assignedDb={
    async query(){
      return {rows:[{department_id:10,is_assigned:true}]};
    },
  };
  assert.strictEqual(
    await canEditPunch(assignedDb,{id:1,permissions:['edit_employee_time'],role:'supervisor',department_id:10},20,'edit'),
    true,
  );
  assert.strictEqual(hasPayrollOverride({permissions:['app_admin']}),true);
  assert.strictEqual(hasPayrollOverride({permissions:['edit_payroll_time']}),true);
  assert.strictEqual(hasPayrollOverride({permissions:['edit_employee_time']}),false);

  console.log('punch edit authority tests: PASS');
})().catch(err=>{console.error(err);process.exitCode=1;});
