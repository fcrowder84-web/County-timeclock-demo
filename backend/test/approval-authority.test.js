'use strict';

const assert=require('assert');
const {getApprovalAuthority,canApprove}=require('../lib/approval-authority');

function db({departmentId=10,assigned=false}={}){
  return {
    async query(sql){
      if(String(sql).includes('FROM employees WHERE id=$1')){
        return {rows:[{id:20,department_id:departmentId}]};
      }
      if(String(sql).includes('FROM supervisor_employee_assignments')){
        return {rows:assigned?[{ok:1}]:[]};
      }
      throw new Error('unexpected query');
    },
  };
}

(async()=>{
  assert.strictEqual(
    (await getApprovalAuthority(
      db({departmentId:11,assigned:true}),
      {id:1,role:'department_head',department_id:10,permissions:['approve_timecard']},
      20,
    )).allowed,
    false,
  );

  assert.strictEqual(
    (await getApprovalAuthority(
      db({departmentId:10,assigned:true}),
      {id:1,role:'employee',department_id:10,permissions:['approve_timecard']},
      20,
    )).allowed,
    false,
  );

  assert.strictEqual(
    (await getApprovalAuthority(
      db({departmentId:10,assigned:true}),
      {id:1,role:'supervisor',department_id:10,permissions:['approve_timecard']},
      20,
    )).allowed,
    true,
  );

  assert.strictEqual(
    await canApprove(
      db({departmentId:10}),
      {id:20,role:'supervisor',department_id:10,permissions:['approve_own_timecard']},
      20,
      'timecard',
    ),
    false,
  );

  assert.strictEqual(
    await canApprove(
      db({departmentId:10}),
      {id:20,role:'department_head',department_id:10,permissions:['approve_own_timecard']},
      20,
      'timecard',
    ),
    true,
  );

  console.log('approval authority tests: PASS');
})().catch(err=>{console.error(err);process.exitCode=1;});
