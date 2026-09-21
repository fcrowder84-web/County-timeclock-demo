'use strict';

const assert=require('assert');
const {finalizationState}=require('../routes/payroll');

const period={pay_period_start:'2026-09-07',pay_period_end:'2026-09-20'};

function fakeDb({
  approval={
    id:10,
    employee_signed_at:'2026-09-20T17:00:00',
    supervisor_approved_at:'2026-09-21T08:00:00',
    payroll_finalized_at:null,
    status:'supervisor_approved',
  },
  openPunches=0,
  pendingChanges=0,
  pendingLeave=0,
  pendingLunch=0,
}={}){
  return {
    async query(sql){
      if(sql.includes('FROM pay_period_approvals')) return {rows:approval?[approval]:[]};
      if(sql.includes('FROM time_entries')&&sql.includes('clock_out IS NULL')) return {rows:[{count:openPunches}]};
      if(sql.includes('FROM time_change_requests')) return {rows:[{count:pendingChanges}]};
      if(sql.includes('FROM leave_entries')) return {rows:[{count:pendingLeave}]};
      if(sql.includes('FROM forced_lunch_waiver_requests')) return {rows:[{count:pendingLunch}]};
      throw new Error('Unexpected test query: '+sql);
    },
  };
}

(async()=>{
  let state=await finalizationState(fakeDb(),2,period,{lock:true});
  assert.deepStrictEqual(state.blockers,[]);
  assert.strictEqual(state.approval.id,10);

  state=await finalizationState(fakeDb({approval:null}),2,period);
  assert(state.blockers.includes('Timecard has not been submitted'));

  state=await finalizationState(fakeDb({
    approval:{
      id:11,
      employee_signed_at:null,
      supervisor_approved_at:null,
      payroll_finalized_at:null,
      status:'open',
    },
    openPunches:1,
    pendingChanges:1,
    pendingLeave:1,
    pendingLunch:1,
  }),2,period);
  assert(state.blockers.includes('Employee has not submitted the timecard'));
  assert(state.blockers.includes('Supervisor approval is missing'));
  assert(state.blockers.includes('Open punch remains in the pay period'));
  assert(state.blockers.includes('Pending punch correction remains'));
  assert(state.blockers.includes('Pending leave request remains'));
  assert(state.blockers.includes('Pending lunch-waiver request remains'));

  state=await finalizationState(fakeDb({
    approval:{
      id:12,
      employee_signed_at:'2026-09-20T17:00:00',
      supervisor_approved_at:'2026-09-21T08:00:00',
      payroll_finalized_at:'2026-09-21T09:00:00',
      status:'payroll_finalized',
    },
  }),2,period);
  assert.deepStrictEqual(state.blockers,[]);

  console.log('payroll-finalization tests: PASS');
})().catch(err=>{
  console.error(err);
  process.exitCode=1;
});
