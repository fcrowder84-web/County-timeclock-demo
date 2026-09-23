'use strict';

const assert=require('assert');
const {createSupervisorRouter}=require('../routes/supervisor');
const {createLeaveRouter}=require('../routes/leave');
const {userHasPermission,userHasAnyPermission}=require('../lib/permissions');

function noop(req,res,next){if(next)next();}
function allow(){return noop;}
function makeRes(){
  return {
    statusCode:200,
    body:null,
    status(code){this.statusCode=code;return this;},
    json(body){this.body=body;return this;},
    send(body){this.body=body;return this;},
  };
}
function handlerFor(router,method,path){
  const layer=router.stack.find(x=>x.route&&x.route.path===path&&x.route.methods[method]);
  assert(layer,`${method.toUpperCase()} ${path} missing`);
  return layer.route.stack[layer.route.stack.length-1].handle;
}
function compact(sql){return String(sql).replace(/\s+/g,' ').trim();}

(async()=>{
  const period={pay_period_start:'2026-09-07',pay_period_end:'2026-09-20'};

  // Approvals may omit the optional note. The handler should progress to the
  // request lookup rather than incorrectly applying denial validation.
  {
    const pool={
      async query(sql){
        if(compact(sql).includes('FROM time_change_requests WHERE id=$1')) return {rows:[]};
        throw new Error('unexpected approval query: '+compact(sql));
      },
      async connect(){throw new Error('connect should not be reached');},
    };
    const router=createSupervisorRouter({
      requireUser:noop,
      requireAnyPermission:allow,
      pool,
      audit:async()=>{},
      canAccessEmployee:async()=>true,
      getRequestedPayPeriod:async()=>period,
      userHasPermission,
    });
    const res=makeRes();
    await handlerFor(router,'post','/supervisor/approve-change-request')(
      {user:{id:1,role:'supervisor',permissions:['approve_punch_correction']},body:{request_id:99}},
      res,
    );
    assert.strictEqual(res.statusCode,404);
    assert.strictEqual(res.body.error,'Request not found');
  }

  // Denials still require a reason.
  {
    const router=createSupervisorRouter({
      requireUser:noop,
      requireAnyPermission:allow,
      pool:{query:async()=>{throw new Error('query should not run');},connect:async()=>{throw new Error('connect should not run');}},
      audit:async()=>{},
      canAccessEmployee:async()=>true,
      getRequestedPayPeriod:async()=>period,
      userHasPermission,
    });
    const res=makeRes();
    await handlerFor(router,'post','/supervisor/deny-change-request')(
      {user:{id:1,role:'supervisor',permissions:['approve_punch_correction']},body:{request_id:99,supervisor_note:''}},
      res,
    );
    assert.strictEqual(res.statusCode,400);
    assert.match(res.body.error,/reason is required/i);
  }

  // return_to_supervisor alone cannot reopen a payroll-finalized card.
  {
    let released=false;
    const client={
      async query(sql){
        const q=compact(sql);
        if(q==='BEGIN'||q==='ROLLBACK') return {rows:[]};
        if(q.includes('FROM pay_period_approvals')) return {rows:[{
          id:10,employee_id:8,status:'payroll_finalized',
          employee_signed_at:'2026-09-20T17:00:00Z',
          supervisor_approved_at:'2026-09-21T08:00:00Z',
          payroll_finalized_at:'2026-09-21T09:00:00Z',
        }]};
        throw new Error('unexpected return query: '+q);
      },
      release(){released=true;},
    };
    const router=createSupervisorRouter({
      requireUser:noop,
      requireAnyPermission:allow,
      pool:{connect:async()=>client,query:async()=>{throw new Error('pool query not expected');}},
      audit:async()=>{},
      canAccessEmployee:async()=>true,
      getRequestedPayPeriod:async()=>period,
      userHasPermission,
    });
    const res=makeRes();
    await handlerFor(router,'post','/supervisor/return-timecard')(
      {user:{id:2,role:'payroll',permissions:['return_to_supervisor']},body:{employee_id:8,target_stage:'supervisor'}},
      res,
    );
    assert.strictEqual(res.statusCode,403);
    assert.match(res.body.error,/Reopen permission/i);
    assert.strictEqual(released,true);
  }

  // Submit-on-behalf may not clear a finalized payroll card without reopen.
  {
    let released=false;
    const client={
      async query(sql){
        const q=compact(sql);
        if(q==='BEGIN'||q==='ROLLBACK') return {rows:[]};
        if(q.includes('FROM pay_period_approvals')) return {rows:[{
          id:11,employee_id:8,status:'payroll_finalized',
          payroll_finalized_at:'2026-09-21T09:00:00Z',
        }]};
        throw new Error('unexpected submit-on-behalf query: '+q);
      },
      release(){released=true;},
    };
    const router=createLeaveRouter({
      requireUser:noop,
      pool:{connect:async()=>client,query:async()=>{throw new Error('pool query not expected');}},
      audit:async()=>{},
      canAccessEmployee:async()=>true,
      getRequestedPayPeriod:async()=>period,
      userHasAnyPermission,
    });
    const res=makeRes();
    await handlerFor(router,'post','/leave/submit-timecard-on-behalf')(
      {user:{id:2,role:'supervisor',permissions:['submit_employee_timecard']},body:{employee_id:8}},
      res,
    );
    assert.strictEqual(res.statusCode,403);
    assert.match(res.body.error,/Reopen permission/i);
    assert.strictEqual(released,true);
  }

  // Approving leave inside a finalized period requires reopen authority.
  {
    let released=false;
    const client={
      async query(sql){
        const q=compact(sql);
        if(q==='BEGIN'||q==='ROLLBACK') return {rows:[]};
        if(q.startsWith('SELECT * FROM leave_entries')) return {rows:[{
          id:5,employee_id:8,leave_date:'2026-09-15',status:'pending',
        }]};
        if(q.includes('FROM pay_period_approvals ppa')) return {rows:[{
          id:12,employee_id:8,status:'payroll_finalized',
          payroll_finalized_at:'2026-09-21T09:00:00Z',
        }]};
        throw new Error('unexpected leave review query: '+q);
      },
      release(){released=true;},
    };
    const router=createLeaveRouter({
      requireUser:noop,
      pool:{connect:async()=>client,query:async()=>{throw new Error('pool query not expected');}},
      audit:async()=>{},
      canAccessEmployee:async()=>true,
      getRequestedPayPeriod:async()=>period,
      userHasAnyPermission,
    });
    const res=makeRes();
    await handlerFor(router,'post','/leave/:id/review')(
      {
        user:{id:2,role:'department_head',permissions:['approve_leave']},
        params:{id:'5'},
        body:{status:'approved'},
      },
      res,
    );
    assert.strictEqual(res.statusCode,403);
    assert.match(res.body.error,/Reopen permission/i);
    assert.strictEqual(released,true);
  }

  // Voiding approved leave inside a finalized period also requires reopen.
  {
    let released=false;
    const client={
      async query(sql){
        const q=compact(sql);
        if(q==='BEGIN'||q==='ROLLBACK') return {rows:[]};
        if(q.startsWith('SELECT * FROM leave_entries')) return {rows:[{
          id:6,employee_id:8,leave_date:'2026-09-15',status:'approved',
        }]};
        if(q.includes('FROM pay_period_approvals ppa')) return {rows:[{
          id:13,employee_id:8,status:'payroll_finalized',
          payroll_finalized_at:'2026-09-21T09:00:00Z',
        }]};
        throw new Error('unexpected leave void query: '+q);
      },
      release(){released=true;},
    };
    const router=createLeaveRouter({
      requireUser:noop,
      pool:{connect:async()=>client,query:async()=>{throw new Error('pool query not expected');}},
      audit:async()=>{},
      canAccessEmployee:async()=>true,
      getRequestedPayPeriod:async()=>period,
      userHasAnyPermission,
    });
    const res=makeRes();
    await handlerFor(router,'delete','/leave/:id')(
      {
        user:{id:2,role:'department_head',permissions:['void_employee_leave']},
        params:{id:'6'},
        body:{reason:'Correction'},
      },
      res,
    );
    assert.strictEqual(res.statusCode,403);
    assert.match(res.body.error,/Reopen permission/i);
    assert.strictEqual(released,true);
  }

  // Leave management regression: approved leave has an audited edit route.
  {
    const fs=require('fs');
    const leaveSource=fs.readFileSync(require.resolve('../routes/leave'),'utf8');
    assert.match(leaveSource,/router\.patch\('\/leave\/:id'/);
    assert.match(leaveSource,/edit_leave_entry/);
    assert.match(leaveSource,/Reason is required when voiding leave/);
  }

  console.log('authorization regression tests: PASS');
})().catch(err=>{console.error(err);process.exitCode=1;});
