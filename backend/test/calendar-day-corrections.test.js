'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {createEmployeeRouter}=require('../routes/employee');
const {createSupervisorRouter}=require('../routes/supervisor');

const migration=fs.readFileSync(path.resolve(__dirname,'../../migrations/021_calendar_day_punch_state.sql'),'utf8');
assert.match(migration,/^BEGIN;/);
assert.match(migration,/more than one unresolved time entry exists/);
assert.match(migration,/overlapping time entries must be corrected first/);
assert.match(migration,/ON time_entries\(employee_id, \(clock_in::date\)\)/);
assert.match(migration,/WHERE deleted_at IS NULL\s+AND clock_out IS NULL;/);
assert.match(migration,/COALESCE\(clock_out, clock_in::date \+ INTERVAL '1 day'\)/);
assert(!migration.includes('COALESCE(\n        clock_out,\n        pending_clock_out'),
  'a requested clock-out cannot end an unresolved interval');

function noop(_req,_res,next){if(next)next();}
function response(){return {statusCode:200,body:null,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}
function handler(router,route){
  const layer=router.stack.find(row=>row.route?.path===route&&row.route.methods.post);
  assert(layer,route);
  return layer.route.stack.at(-1).handle;
}
function compact(sql){return String(sql).replace(/\s+/g,' ').trim();}
function options(pool){return {
  requireUser:noop,requireAnyPermission:()=>noop,pool,audit:async()=>{},
  canAccessEmployee:async()=>true,getRequestedPayPeriod:async()=>({pay_period_start:'2026-10-12',pay_period_end:'2026-10-25'}),
};}

(async()=>{
  // Approval of an earlier clock-in creates that day's incomplete entry while
  // leaving the newer open day alone.
  {
    const request={id:9,employee_id:7,time_entry_id:null,status:'pending',
      requested_clock_in:'2026-10-16 08:00:00',requested_clock_out:null,employee_reason:'Missed in'};
    const entries=[{id:90,employee_id:7,clock_in:'2026-10-18 08:00:00',clock_out:null}];
    const queries=[];
    const client={
      async query(sql,args=[]){
        const q=compact(sql);queries.push({q,args});
        if(['BEGIN','COMMIT','ROLLBACK'].includes(q))return {rows:[]};
        if(q.startsWith('SELECT * FROM time_change_requests WHERE id=$1 FOR UPDATE'))return {rows:[request]};
        if(q.startsWith('SELECT id FROM time_entries')&&q.includes('clock_in::date')){
          assert.match(q,/clock_in::date=\$2::timestamp::date/);
          return {rows:[]};
        }
        if(q.includes('FROM time_change_requests')&&q.includes('id<>$2'))return {rows:[]};
        if(q.includes('FROM pay_period_approvals ppa'))return {rows:[]};
        if(q.includes('(clock_in=$2::timestamp OR clock_out=$2::timestamp)'))return {rows:[]};
        if(q.includes('FROM time_entries')&&q.includes('clock_in::date=$2::timestamp::date')){
          return {rows:entries.filter(row=>row.clock_in.slice(0,10)===String(args[1]).slice(0,10))};
        }
        if(q.startsWith('INSERT INTO time_entries')){
          const row={id:91,employee_id:7,clock_in:args[1],clock_out:null};
          entries.push(row);return {rows:[row]};
        }
        if(q.startsWith('INSERT INTO time_entry_audit'))return {rows:[]};
        if(q.startsWith('UPDATE time_change_requests'))return {rows:[{id:9}]};
        throw new Error('Unexpected approval SQL: '+q);
      },release(){},
    };
    const pool={query:async()=>({rows:[request]}),connect:async()=>client};
    const router=createEmployeeRouter(options(pool));
    const res=response();
    await handler(router,'/supervisor/approve-single-punch')(
      {user:{id:2},body:{request_id:9}},res);
    assert.strictEqual(res.statusCode,200);
    assert.strictEqual(res.body.inferred_punch_type,'clock_in');
    assert.deepStrictEqual(entries.map(row=>row.id),[90,91]);
    assert.strictEqual(entries[0].clock_out,null);
    assert(queries.some(({q})=>q==='COMMIT'));
  }

  // Denial clears only its linked old-day pending marker; today's entry is
  // neither queried nor updated.
  {
    const request={id:10,employee_id:7,time_entry_id:41,status:'pending',
      requested_clock_in:null,requested_clock_out:'2026-10-16 17:00:00'};
    const queries=[];
    const client={
      async query(sql,args=[]){
        const q=compact(sql);queries.push({q,args});
        if(['BEGIN','COMMIT','ROLLBACK'].includes(q))return {rows:[]};
        if(q.startsWith('SELECT * FROM time_change_requests WHERE id=$1 FOR UPDATE'))return {rows:[request]};
        if(q.startsWith('UPDATE time_entries'))return {rows:[{id:41}]};
        if(q.startsWith('UPDATE time_change_requests'))return {rows:[{id:10}]};
        throw new Error('Unexpected denial SQL: '+q);
      },release(){},
    };
    const pool={query:async()=>({rows:[{employee_id:7,status:'pending'}]}),connect:async()=>client};
    const router=createSupervisorRouter(options(pool));
    const res=response();
    await handler(router,'/supervisor/deny-change-request')(
      {user:{id:2},body:{request_id:10,supervisor_note:'Incorrect time'}},res);
    assert.strictEqual(res.statusCode,200);
    const clearing=queries.find(({q})=>q.startsWith('UPDATE time_entries'));
    assert.deepStrictEqual(clearing.args,[null,request.requested_clock_out,41,7]);
    assert(queries.some(({q})=>q==='COMMIT'));
  }

  // Withdrawal is similarly limited to the linked entry.
  {
    const request={id:11,employee_id:7,time_entry_id:41,status:'pending',
      requested_clock_in:null,requested_clock_out:'2026-10-16 17:00:00'};
    const queries=[];
    const client={
      async query(sql,args=[]){
        const q=compact(sql);queries.push({q,args});
        if(['BEGIN','COMMIT','ROLLBACK'].includes(q))return {rows:[]};
        if(q.startsWith('SELECT * FROM time_change_requests'))return {rows:[request]};
        if(q.startsWith('UPDATE time_entries'))return {rows:[{id:41}]};
        if(q.startsWith('UPDATE time_change_requests'))return {rows:[{...request,status:'withdrawn'}]};
        throw new Error('Unexpected withdrawal SQL: '+q);
      },release(){},
    };
    const router=createEmployeeRouter(options({connect:async()=>client}));
    const res=response();
    await handler(router,'/employee/withdraw-time-change')(
      {user:{id:7},body:{request_id:11,reason:'Wrong time'}},res);
    assert.strictEqual(res.statusCode,200);
    const clearing=queries.find(({q})=>q.startsWith('UPDATE time_entries'));
    assert.deepStrictEqual(clearing.args,[null,request.requested_clock_out,41,7]);
    assert(queries.some(({q})=>q==='COMMIT'));
  }

  console.log('calendar-day correction tests: PASS');
})().catch(err=>{console.error(err);process.exitCode=1;});
