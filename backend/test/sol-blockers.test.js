'use strict';

const assert=require('assert');
const {createEmployeeRouter}=require('../routes/employee');
const {createSupervisorRouter}=require('../routes/supervisor');
const {userHasPermission}=require('../lib/permissions');
const {canManageTeamStructureScope}=require('../lib/team-scope');
const {
  authorizationUrlFromDirectory,
  fetchPortalAuthorization,
}=require('../lib/portal-authorization');

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
  // Live authorization uses the single-user Portal endpoint derived from the
  // configured directory URL and fails closed if Portal cannot be reached.
  assert.strictEqual(
    authorizationUrlFromDirectory(
      'https://employee.edgefieldcountysc.org/api/internal/timeclock/directory',
      'abc-123',
    ),
    'https://employee.edgefieldcountysc.org/api/internal/timeclock/authorization/abc-123',
  );
  const live=await fetchPortalAuthorization({
    directoryUrl:'https://employee.edgefieldcountysc.org/api/internal/timeclock/directory',
    apiKey:'x'.repeat(64),
    portalUserId:'abc-123',
    fetchImpl:async(url,options)=>{
      assert.match(url,/authorization\/abc-123$/);
      assert.strictEqual(options.headers['x-internal-api-key'],'x'.repeat(64));
      return {
        ok:true,
        async json(){
          return {
            portal_user_id:'abc-123',
            timeclock_access:true,
            permissions:['access'],
            timeclock_role:'employee',
            app_admin_scope:'own',
          };
        },
      };
    },
  });
  assert.strictEqual(live.timeclock_access,true);
  await assert.rejects(
    fetchPortalAuthorization({
      directoryUrl:'https://employee.edgefieldcountysc.org/api/internal/timeclock/directory',
      apiKey:'x'.repeat(64),
      portalUserId:'abc-123',
      fetchImpl:async()=>{throw new Error('offline');},
    }),
    err=>err.statusCode===503,
  );

  // Team-structure mutation scope is management-only even if a custom
  // manage_supervisor_assignments checkbox is accidentally granted.
  assert.strictEqual(canManageTeamStructureScope({
    id:1,role:'employee',department_id:10,permissions:['manage_supervisor_assignments'],
  },10),false);
  assert.strictEqual(canManageTeamStructureScope({
    id:1,role:'supervisor',department_id:10,permissions:['manage_supervisor_assignments'],
  },10),false);
  assert.strictEqual(canManageTeamStructureScope({
    id:1,role:'department_head',department_id:10,permissions:['manage_supervisor_assignments'],
  },10),true);
  assert.strictEqual(canManageTeamStructureScope({
    id:1,role:'department_head',department_id:10,permissions:['manage_supervisor_assignments'],
  },11),false);
  assert.strictEqual(canManageTeamStructureScope({
    id:1,role:'admin',department_id:10,app_admin_scope:'all',permissions:['app_admin'],
  },99),true);

  // Legacy clock_in/clock_out add-time payload must reopen/invalidate the same
  // approval rows as the newer punch_at path.
  {
    const queries=[];
    const finalized={
      id:41,
      employee_id:8,
      pay_period_start:'2026-09-07',
      pay_period_end:'2026-09-20',
      employee_signed_at:'2026-09-20T17:00:00Z',
      supervisor_approved_at:'2026-09-21T08:00:00Z',
      payroll_finalized_at:'2026-09-21T09:00:00Z',
      status:'payroll_finalized',
    };
    const client={
      async query(sql,args){
        const q=compact(sql);queries.push(q);
        if(['BEGIN','COMMIT','ROLLBACK'].includes(q)) return {rows:[]};
        if(q.includes('FROM pay_period_approvals')&&q.includes('LIMIT 1')) return {rows:[finalized]};
        if(q.includes('FROM pay_period_approvals ppa')) return {rows:[finalized]};
        if(q.startsWith('INSERT INTO time_entries')) return {rows:[{id:90,employee_id:8,clock_in:args[1],clock_out:args[2]}]};
        if(q.startsWith('UPDATE pay_period_approvals')) return {rows:[{id:41}]};
        throw new Error('unexpected legacy add query: '+q);
      },
      release(){},
    };
    const router=createEmployeeRouter({
      requireUser:noop,
      requireAnyPermission:allow,
      pool:{connect:async()=>client,query:async()=>{throw new Error('pool query not expected');}},
      audit:async()=>{},
      canAccessEmployee:async(_user,_id,permissions)=>permissions.includes('reopen_timecard'),
      getRequestedPayPeriod:async()=>({pay_period_start:'2026-09-07',pay_period_end:'2026-09-20'}),
    });
    const res=makeRes();
    await handlerFor(router,'post','/supervisor/add-time-entry')({
      user:{id:2,role:'payroll',permissions:['edit_payroll_time','reopen_timecard']},
      body:{
        employee_id:8,
        clock_in:'2026-09-15 08:00:00',
        clock_out:'2026-09-15 17:00:00',
        reason:'Correction',
      },
    },res);
    assert.strictEqual(res.statusCode,200);
    assert(queries.some(q=>q.startsWith('UPDATE pay_period_approvals')));
    assert(queries.indexOf('COMMIT')>queries.findIndex(q=>q.startsWith('UPDATE pay_period_approvals')));
  }

  // Ordinary punch-correction approval cannot silently clear finalized payroll
  // without scoped reopen authority.
  {
    const client={
      async query(sql){
        const q=compact(sql);
        if(['BEGIN','ROLLBACK'].includes(q)) return {rows:[]};
        if(q.startsWith('SELECT * FROM time_change_requests')) return {rows:[{
          id:7,employee_id:8,time_entry_id:null,status:'pending',
          requested_clock_in:'2026-09-15 08:00:00',
          requested_clock_out:'2026-09-15 17:00:00',
          employee_reason:'Missed punches',
        }]};
        if(q.includes('FROM pay_period_approvals ppa')) return {rows:[{
          id:42,status:'payroll_finalized',payroll_finalized_at:'2026-09-21T09:00:00Z',
        }]};
        if(q.startsWith('SELECT id FROM time_entries')) return {rows:[]};
        throw new Error('unexpected correction approval query: '+q);
      },
      release(){},
    };
    const pool={
      async query(sql){
        const q=compact(sql);
        if(q.includes('FROM time_change_requests WHERE id=$1')) return {rows:[{employee_id:8,status:'pending'}]};
        throw new Error('unexpected preview query: '+q);
      },
      connect:async()=>client,
    };
    const router=createSupervisorRouter({
      requireUser:noop,
      requireAnyPermission:allow,
      pool,
      audit:async()=>{},
      canAccessEmployee:async(_user,_id,permissions)=>!permissions.includes('reopen_timecard'),
      getRequestedPayPeriod:async()=>({pay_period_start:'2026-09-07',pay_period_end:'2026-09-20'}),
      userHasPermission,
    });
    const res=makeRes();
    await handlerFor(router,'post','/supervisor/approve-change-request')({
      user:{id:2,role:'supervisor',permissions:['approve_punch_correction']},
      body:{request_id:7},
    },res);
    assert.strictEqual(res.statusCode,403);
    assert.match(res.body.error,/Reopen permission/i);
  }

  // Single-punch approval has the same finalized-payroll guard.
  {
    const client={
      async query(sql){
        const q=compact(sql);
        if(['BEGIN','ROLLBACK'].includes(q)) return {rows:[]};
        if(q.startsWith('SELECT * FROM time_change_requests')) return {rows:[{
          id:9,employee_id:8,time_entry_id:null,status:'pending',
          requested_clock_in:'2026-09-15 08:00:00',requested_clock_out:null,
          employee_reason:'Missed in',
        }]};
        if(q.startsWith('SELECT id FROM time_entries')) return {rows:[{id:50}]};
        if(q.includes('FROM pay_period_approvals ppa')) return {rows:[{
          id:43,status:'payroll_finalized',payroll_finalized_at:'2026-09-21T09:00:00Z',
        }]};
        throw new Error('unexpected single-punch query: '+q);
      },
      release(){},
    };
    const pool={
      async query(sql){
        const q=compact(sql);
        if(q.includes('FROM time_change_requests WHERE id=$1')) return {rows:[{
          employee_id:8,time_entry_id:null,requested_clock_in:'2026-09-15 08:00:00',
          requested_clock_out:null,status:'pending',
        }]};
        throw new Error('unexpected single preview query: '+q);
      },
      connect:async()=>client,
    };
    const router=createEmployeeRouter({
      requireUser:noop,
      requireAnyPermission:allow,
      pool,
      audit:async()=>{},
      canAccessEmployee:async(_user,_id,permissions)=>!permissions.includes('reopen_timecard'),
      getRequestedPayPeriod:async()=>({pay_period_start:'2026-09-07',pay_period_end:'2026-09-20'}),
    });
    const res=makeRes();
    await handlerFor(router,'post','/supervisor/approve-single-punch')({
      user:{id:2,role:'supervisor',permissions:['approve_punch_correction']},
      body:{request_id:9},
    },res);
    assert.strictEqual(res.statusCode,403);
    assert.match(res.body.error,/Reopen permission/i);
  }

  console.log('Sol blocker regression tests: PASS');
})().catch(err=>{console.error(err);process.exitCode=1;});
