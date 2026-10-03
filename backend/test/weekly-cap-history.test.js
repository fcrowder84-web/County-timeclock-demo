'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const {recordWeeklyCapChange,portalCapSnapshotIsFresh}=require('../lib/weekly-cap-history');
const {summarizeTimecard}=require('../lib/timecard-summary');
const migration=fs.readFileSync(path.resolve(__dirname,'..','..','migrations','020_weekly_hours_cap_history.sql'),'utf8');
assert(!migration.includes("DATE '2026-09-14'"),'migration must not invent a fixed historical baseline');
assert(migration.includes("NOW() AT TIME ZONE 'America/New_York'"));
assert(migration.includes('WHERE NOT EXISTS ('),'rerun must not add a later baseline');
assert(migration.includes('e.weekly_hours_cap'),'baseline must preserve explicit NULL caps');
assert(migration.includes('ON DELETE RESTRICT'));
assert(migration.includes('UNIQUE (employee_id, effective_date)'));
assert(migration.includes('weekly_hours_cap * 4 = trunc(weekly_hours_cap * 4)'));
assert(migration.includes('GRANT SELECT, INSERT, UPDATE ON weekly_hours_cap_history TO timeclock_app'));
assert(migration.includes('GRANT USAGE, SELECT ON SEQUENCE weekly_hours_cap_history_id_seq TO timeclock_app'));

const server=fs.readFileSync(path.resolve(__dirname,'..','server.js'),'utf8');
const authSource=server.slice(server.indexOf('async function syncPortalUser(payload){'),server.indexOf('const PORTAL_DIRECTORY_URL='));
const directorySource=server.slice(server.indexOf('async function upsertDirectoryEmployee(client,item){'),server.indexOf('async function syncPortalDirectory('));
assert(authSource.includes("await client.query('BEGIN')"));
assert(authSource.includes('FOR UPDATE'));
assert(directorySource.includes('FOR UPDATE'));

function fakeDatabase(initialEmployees=[],{currentDate='2026-10-07',approvals=[]}={}){
  let committed={employees:initialEmployees.map(row=>({...row})),history:[],approvals:structuredClone(approvals),nextId:10};
  const queries=[];
  let failHistory=false;
  const pool={
    async connect(){
      let transaction=null;
      const client={
        async query(sql,args=[]){
          const q=String(sql).replace(/\s+/g,' ').trim();queries.push({q,args});
          if(q==='BEGIN'){transaction=structuredClone(committed);return {rows:[]};}
          if(q==='COMMIT'){committed=transaction;transaction=null;return {rows:[]};}
          if(q==='ROLLBACK'){transaction=null;return {rows:[]};}
          const state=transaction||committed;
          if(q.includes('FROM settings')) return {rows:[{anchor_date_iso:'2026-09-14',period_days:14,
            current_date_iso:args[0] ? args[0].slice(0,10) : currentDate}]};
          if(q.includes('FROM departments'))return {rows:[]};
          if(q.startsWith('INSERT INTO departments'))return {rows:[{id:1}]};
          if(q.includes('FROM employees WHERE portal_user_id=$1')){
            return {rows:state.employees.filter(row=>row.portal_user_id===args[0]).map(row=>({...row}))};
          }
          if(q.includes('FROM employees WHERE portal_user_id IS NULL')){
            return {rows:state.employees.filter(row=>row.portal_user_id==null&&row.employee_number===args[0]).map(row=>({...row}))};
          }
          if(q.startsWith('UPDATE employees SET')){
            const row=state.employees.find(item=>item.id===args[13]);
            assert(row);
            row.portal_user_id=args[0];
            if(args[11])row.weekly_hours_cap=args[12];
            if(args[14])row.portal_weekly_hours_cap_changed_at=args[15];
            row.active=true;
            return {rows:[{...row}]};
          }
          if(q.startsWith('INSERT INTO employees')){
            const row={id:state.nextId++,portal_user_id:args[0],employee_number:args[1],
              weekly_hours_cap:args[11],portal_weekly_hours_cap_changed_at:args[12],active:true};
            state.employees.push(row);return {rows:[{...row}]};
          }
          if(q.startsWith('INSERT INTO weekly_hours_cap_history')){
            if(failHistory)throw new Error('history write failed');
            const date=args[1];
            const prior=state.history.find(row=>row.employee_id===args[0]&&row.effective_date===date);
            if(prior){if(prior.weekly_hours_cap!==args[2]){prior.weekly_hours_cap=args[2];prior.source=args[3];}}
            else state.history.push({employee_id:args[0],effective_date:date,weekly_hours_cap:args[2],source:args[3]});
            return {rows:[]};
          }
          if(q.includes('FROM weekly_hours_cap_history')){
            const next=state.history.filter(row=>row.employee_id===args[0]&&row.effective_date>args[1])
              .sort((a,b)=>a.effective_date.localeCompare(b.effective_date))[0];
            return {rows:next?[{effective_date_iso:next.effective_date}]:[]};
          }
          if(q.includes('FROM pay_period_approvals')){
            return {rows:state.approvals.filter(row=>row.employee_id===args[0]&&row.pay_period_end_iso>=args[1]&&
              (!args[2]||row.pay_period_start<args[2])).map(row=>({...row}))};
          }
          throw new Error(`Unexpected query: ${q}`);
        },release(){},
      };
      return client;
    },
    async query(){throw new Error('Authentication sync must use one transaction client');},
  };
  return {pool,queries,get state(){return committed;},set failHistory(value){failHistory=value;}};
}

function functionsFor(db){
  return vm.runInNewContext(`${authSource}\n${directorySource}\n({syncPortalUser,upsertDirectoryEmployee})`,{
    pool:db.pool,normalizePermissions:value=>value,resolveApplicationRole:()=> 'employee',
    recordWeeklyCapChange,portalCapSnapshotIsFresh,
  });
}

(async()=>{
  const db=fakeDatabase([{id:7,portal_user_id:'person',employee_number:'7',weekly_hours_cap:40,active:true}]);
  db.state.history.push({employee_id:7,effective_date:'2026-09-14',weekly_hours_cap:40,source:'production-baseline'});
  const {syncPortalUser,upsertDirectoryEmployee}=functionsFor(db);
  const payload={sub:'person',first_name:'A',last_name:'Person',employee_number:'7',weekly_hours_cap:40};
  await syncPortalUser(payload);
  assert.strictEqual(db.state.history.length,1,'unchanged cap must not add history');
  await syncPortalUser({...payload,weekly_hours_cap:32});
  assert.strictEqual(db.state.employees[0].weekly_hours_cap,32);
  assert.strictEqual(db.state.history.at(-1).weekly_hours_cap,32);
  assert.strictEqual(db.state.history.at(-1).effective_date,'2026-09-28','week-2 sync must target the period start');
  assert.strictEqual(db.state.history.length,2);
  await syncPortalUser({...payload,weekly_hours_cap:32});
  assert.strictEqual(db.state.history.length,2,'repeated sync must be idempotent');
  await syncPortalUser({...payload,weekly_hours_cap:40});
  assert.strictEqual(db.state.history.length,2,'same-day change must update one effective-date row');
  assert.strictEqual(db.state.history.at(-1).weekly_hours_cap,40);
  await syncPortalUser({...payload,weekly_hours_cap:null});
  assert.strictEqual(db.state.employees[0].weekly_hours_cap,null);
  assert.strictEqual(db.state.history.at(-1).weekly_hours_cap,null);

  const periodEntries=[{entry_date_iso:'2026-09-28',hours_worked:36},{entry_date_iso:'2026-10-05',hours_worked:36}];
  const periodSummary=summarizeTimecard({payPeriodStart:'2026-09-28',entries:periodEntries,
    weeklyHoursCapHistory:db.state.history.map(row=>({effective_date_iso:row.effective_date,weekly_hours_cap:row.weekly_hours_cap}))});
  assert.deepStrictEqual(periodSummary.weekly_hours_caps,[null,null]);
  assert.strictEqual(periodSummary.period.total_paid_hours,72);

  db.failHistory=true;
  await assert.rejects(syncPortalUser({...payload,weekly_hours_cap:32}),/history write failed/);
  db.failHistory=false;
  assert.strictEqual(db.state.employees[0].weekly_hours_cap,null,'failed history write must roll back cache');
  assert.strictEqual(db.state.history.at(-1).weekly_hours_cap,null);
  assert(db.queries.some(({q})=>q==='ROLLBACK'));

  const created=fakeDatabase();
  const {syncPortalUser:createAuth,upsertDirectoryEmployee:createDirectory}=functionsFor(created);
  await createAuth({sub:'new-auth',first_name:'N',last_name:'Person',weekly_hours_cap:null});
  assert.strictEqual(created.state.history.length,1);
  assert.strictEqual(created.state.history[0].weekly_hours_cap,null,'new uncapped employee needs explicit history');
  assert.strictEqual(created.state.history[0].effective_date,'2026-09-28',
    'new employee history must cover the current two-week payroll period');
  await createAuth({sub:'new-auth-no-cap',first_name:'N',last_name:'Uncapped'});
  assert.strictEqual(created.state.history.length,2);
  assert.strictEqual(created.state.history.at(-1).weekly_hours_cap,null);

  const future=fakeDatabase([{id:7,portal_user_id:'person',employee_number:'7',weekly_hours_cap:40,active:true}]);
  future.state.history.push({employee_id:7,effective_date:'2026-09-28',weekly_hours_cap:40,source:'production-baseline'});
  const {syncPortalUser:futureSync}=functionsFor(future);
  await futureSync({...payload,weekly_hours_cap:32,weekly_hours_cap_target_period:'next'});
  assert.strictEqual(future.state.history.at(-1).effective_date,'2026-10-12');
  const futureHistory=future.state.history.map(row=>({effective_date_iso:row.effective_date,weekly_hours_cap:row.weekly_hours_cap}));
  const unchangedCurrent=summarizeTimecard({payPeriodStart:'2026-09-28',entries:periodEntries,weeklyHoursCapHistory:futureHistory});
  assert.deepStrictEqual(unchangedCurrent.weekly_hours_caps,[40,40]);
  assert.strictEqual(unchangedCurrent.period.total_paid_hours,72);
  const changedNext=summarizeTimecard({payPeriodStart:'2026-10-12',entries:[{entry_date_iso:'2026-10-12',hours_worked:36}],weeklyHoursCapHistory:futureHistory});
  assert.deepStrictEqual(changedNext.weekly_hours_caps,[32,32]);
  assert.strictEqual(changedNext.period.total_paid_hours,32);

  const weekOne=fakeDatabase([{id:7,portal_user_id:'person',employee_number:'7',weekly_hours_cap:40,active:true}],
    {currentDate:'2026-09-30'});
  weekOne.state.history.push({employee_id:7,effective_date:'2026-09-28',weekly_hours_cap:40,source:'production-baseline'});
  await functionsFor(weekOne).syncPortalUser({...payload,weekly_hours_cap:32});
  assert.strictEqual(weekOne.state.history.length,1,'same-period change must update one row');
  assert.strictEqual(weekOne.state.history[0].effective_date,'2026-09-28');
  assert.deepStrictEqual(summarizeTimecard({payPeriodStart:'2026-09-28',entries:periodEntries,
    weeklyHoursCapHistory:[{effective_date_iso:'2026-09-28',weekly_hours_cap:weekOne.state.history[0].weekly_hours_cap}]}).weekly_hours_caps,[32,32]);
  const weekOnePayable=summarizeTimecard({payPeriodStart:'2026-09-28',entries:periodEntries,
    leaveEntries:[{leave_date_iso:'2026-10-06',leave_type:'holiday',hours:8,status:'approved'}],
    weeklyHoursCapHistory:[{effective_date_iso:'2026-09-28',weekly_hours_cap:32}]});
  assert.strictEqual(weekOnePayable.weeks[0].total_paid_hours,32);
  assert.strictEqual(weekOnePayable.weeks[1].total_paid_hours,32);
  assert.strictEqual(weekOnePayable.weeks[1].adjusted_leave_hours_by_type.holiday,8);

  const uncappedToCapped=fakeDatabase([{id:7,portal_user_id:'person',employee_number:'7',weekly_hours_cap:null,active:true}]);
  uncappedToCapped.state.history.push({employee_id:7,effective_date:'2026-09-28',weekly_hours_cap:null,source:'production-baseline'});
  await functionsFor(uncappedToCapped).syncPortalUser({...payload,weekly_hours_cap:40});
  assert.strictEqual(uncappedToCapped.state.history.length,1);
  assert.strictEqual(uncappedToCapped.state.history[0].weekly_hours_cap,40);
  assert.deepStrictEqual(summarizeTimecard({payPeriodStart:'2026-09-28',entries:periodEntries,
    weeklyHoursCapHistory:[{effective_date_iso:'2026-09-28',weekly_hours_cap:40}]}).weekly_hours_caps,[40,40]);

  const finalized=fakeDatabase([{id:7,portal_user_id:'person',employee_number:'7',weekly_hours_cap:40,active:true}],{
    approvals:[{employee_id:7,pay_period_start:'2026-09-28',pay_period_end_iso:'2026-10-11',status:'payroll_finalized',payroll_finalized_at:'2026-10-07'}],
  });
  finalized.state.history.push({employee_id:7,effective_date:'2026-09-28',weekly_hours_cap:40,source:'production-baseline'});
  const {syncPortalUser:finalizedSync}=functionsFor(finalized);
  await assert.rejects(finalizedSync({...payload,weekly_hours_cap:32,weekly_hours_cap_target_period:'current'}),
    /selected payroll period affects/);
  assert.strictEqual(finalized.state.employees[0].weekly_hours_cap,40,'locked target must roll back cache');
  await finalizedSync({...payload,weekly_hours_cap:32});
  assert.strictEqual(finalized.state.history.at(-1).effective_date,'2026-10-12');
  const lockedHistory=finalized.state.history.map(row=>({effective_date_iso:row.effective_date,weekly_hours_cap:row.weekly_hours_cap}));
  assert.deepStrictEqual(summarizeTimecard({payPeriodStart:'2026-09-28',entries:periodEntries,weeklyHoursCapHistory:lockedHistory}).weekly_hours_caps,[40,40]);

  const signed=fakeDatabase([{id:7,portal_user_id:'person',employee_number:'7',weekly_hours_cap:40,active:true}],{
    approvals:[{employee_id:7,pay_period_start:'2026-09-28',pay_period_end_iso:'2026-10-11',status:'employee_submitted',employee_signed_at:'2026-10-07'}],
  });
  signed.state.history.push({employee_id:7,effective_date:'2026-09-28',weekly_hours_cap:40,source:'production-baseline'});
  await functionsFor(signed).syncPortalUser({...payload,weekly_hours_cap:32});
  assert.strictEqual(signed.state.history.at(-1).effective_date,'2026-10-12','signed period is locked too');

  const returned=fakeDatabase([{id:7,portal_user_id:'person',employee_number:'7',weekly_hours_cap:40,active:true}],{
    approvals:[{employee_id:7,pay_period_start:'2026-09-28',pay_period_end_iso:'2026-10-11',status:'returned_to_employee',employee_signed_at:'2026-10-07'}],
  });
  returned.state.history.push({employee_id:7,effective_date:'2026-09-28',weekly_hours_cap:40,source:'production-baseline'});
  await functionsFor(returned).syncPortalUser({...payload,weekly_hours_cap:32});
  assert.strictEqual(returned.state.history[0].weekly_hours_cap,32,'returned timecard is open for changes');

  const futureLocked=fakeDatabase([{id:7,portal_user_id:'person',employee_number:'7',weekly_hours_cap:40,active:true}],{
    approvals:[{employee_id:7,pay_period_start:'2026-10-12',pay_period_end_iso:'2026-10-25',status:'payroll_finalized',payroll_finalized_at:'2026-10-07'}],
  });
  futureLocked.state.history.push({employee_id:7,effective_date:'2026-09-28',weekly_hours_cap:40,source:'production-baseline'});
  await assert.rejects(functionsFor(futureLocked).syncPortalUser({...payload,weekly_hours_cap:32,
    weekly_hours_cap_target_period:'next'}),/selected payroll period affects/);
  assert.strictEqual(futureLocked.state.employees[0].weekly_hours_cap,40);
  await functionsFor(futureLocked).syncPortalUser({...payload,weekly_hours_cap:32});
  assert.strictEqual(futureLocked.state.history.at(-1).effective_date,'2026-10-26',
    'a cap must not flow forward into a finalized future period');
  assert(futureLocked.queries.some(({q})=>q.includes('FROM pay_period_approvals')&&q.includes('FOR UPDATE')));
  const client=await created.pool.connect();
  await client.query('BEGIN');
  await createDirectory(client,{portal_user_id:'new-directory',first_name:'D',last_name:'Person',weekly_hours_cap:40});
  await client.query('COMMIT');
  assert.strictEqual(created.state.history.length,3);
  assert.strictEqual(created.state.history.at(-1).weekly_hours_cap,40);
  const directoryClient=await created.pool.connect();
  await directoryClient.query('BEGIN');
  await createDirectory(directoryClient,{portal_user_id:'new-directory',first_name:'D',last_name:'Person',weekly_hours_cap:null});
  await directoryClient.query('COMMIT');
  assert.strictEqual(created.state.history.length,3);
  assert.strictEqual(created.state.history.at(-1).weekly_hours_cap,null);
  const unchangedDirectory=await created.pool.connect();
  await unchangedDirectory.query('BEGIN');
  await createDirectory(unchangedDirectory,{portal_user_id:'new-directory',first_name:'D',last_name:'Person',weekly_hours_cap:null});
  await unchangedDirectory.query('COMMIT');
  assert.strictEqual(created.state.history.length,3);
  const failingDirectory=await created.pool.connect();
  await failingDirectory.query('BEGIN');
  created.failHistory=true;
  await assert.rejects(createDirectory(failingDirectory,{portal_user_id:'new-directory',first_name:'D',last_name:'Person',weekly_hours_cap:32}),/history write failed/);
  await failingDirectory.query('ROLLBACK');
  assert.strictEqual(created.state.employees.find(row=>row.portal_user_id==='new-directory').weekly_hours_cap,null);
  assert.strictEqual(created.state.history.at(-1).weekly_hours_cap,null);

  const directoryFuture=fakeDatabase([{id:7,portal_user_id:'person',employee_number:'7',weekly_hours_cap:40,active:true}]);
  directoryFuture.state.history.push({employee_id:7,effective_date:'2026-09-28',weekly_hours_cap:40,source:'production-baseline'});
  const directoryFutureClient=await directoryFuture.pool.connect();
  await directoryFutureClient.query('BEGIN');
  await functionsFor(directoryFuture).upsertDirectoryEmployee(directoryFutureClient,{
    portal_user_id:'person',first_name:'A',last_name:'Person',weekly_hours_cap:32,
    weekly_hours_cap_target_period:'next',
  });
  await directoryFutureClient.query('COMMIT');
  assert.strictEqual(directoryFuture.state.history.at(-1).effective_date,'2026-10-12');

  const rollover=fakeDatabase([{id:7,portal_user_id:'person',employee_number:'7',weekly_hours_cap:40,active:true}],
    {currentDate:'2026-10-20'});
  rollover.state.history.push({employee_id:7,effective_date:'2026-09-28',weekly_hours_cap:40,source:'production-baseline'});
  const scheduled={...payload,weekly_hours_cap:32,weekly_hours_cap_target_period:'next',
    weekly_hours_cap_changed_at:'2026-10-07T16:00:00.000Z',weekly_hours_cap_previous:40};
  const rolloverSync=functionsFor(rollover).syncPortalUser;
  await rolloverSync(scheduled);
  assert.strictEqual(rollover.state.history.at(-1).effective_date,'2026-10-12',
    'a delayed Next snapshot must use the period containing the edit, not the sync');
  await rolloverSync(scheduled);
  await rolloverSync({...scheduled,first_name:'Updated'});
  assert.strictEqual(rollover.state.history.length,2,
    'repeated snapshots and unrelated profile edits must not schedule another period');
  await rolloverSync({...scheduled,weekly_hours_cap:36,
    weekly_hours_cap_changed_at:'2026-10-08T16:00:00.000Z'});
  assert.strictEqual(rollover.state.employees[0].weekly_hours_cap,36);
  await rolloverSync(scheduled);
  assert.strictEqual(rollover.state.employees[0].weekly_hours_cap,36,
    'an older SSO snapshot must not undo a newer Portal cap event');
  assert.strictEqual(rollover.state.history.at(-1).weekly_hours_cap,36);
  const sameValueNewer=fakeDatabase([{id:7,portal_user_id:'person',employee_number:'7',
    weekly_hours_cap:40,active:true}],{currentDate:'2026-10-20'});
  sameValueNewer.state.history.push({employee_id:7,effective_date:'2026-09-28',
    weekly_hours_cap:40,source:'production-baseline'});
  const sameValueSync=functionsFor(sameValueNewer).syncPortalUser;
  await sameValueSync({...scheduled,weekly_hours_cap:40,
    weekly_hours_cap_changed_at:'2026-10-08T16:00:00.000Z'});
  await sameValueSync(scheduled);
  assert.strictEqual(sameValueNewer.state.employees[0].weekly_hours_cap,40,
    'a newer same-value event still fences off an older changed-value snapshot');
  assert.strictEqual(sameValueNewer.state.history.length,1);
  assert.deepStrictEqual(summarizeTimecard({payPeriodStart:'2026-09-28',entries:periodEntries,
    weeklyHoursCapHistory:rollover.state.history.map(row=>({effective_date_iso:row.effective_date,weekly_hours_cap:row.weekly_hours_cap}))}).weekly_hours_caps,[40,40]);

  const firstSeen=fakeDatabase([],{currentDate:'2026-10-20'});
  await functionsFor(firstSeen).syncPortalUser({...scheduled,sub:'first-seen'});
  assert.deepStrictEqual(firstSeen.state.history.map(row=>[row.effective_date,row.weekly_hours_cap]),
    [['2026-09-28',40],['2026-10-12',32]],
    'first sync after rollover must retain the prior cap for the earlier period');

  const firstSeenDirectory=fakeDatabase([],{currentDate:'2026-10-20'});
  const firstSeenClient=await firstSeenDirectory.pool.connect();
  await firstSeenClient.query('BEGIN');
  await functionsFor(firstSeenDirectory).upsertDirectoryEmployee(firstSeenClient,{
    ...scheduled,portal_user_id:'first-seen-directory'});
  await firstSeenClient.query('COMMIT');
  assert.deepStrictEqual(firstSeenDirectory.state.history.map(row=>[row.effective_date,row.weekly_hours_cap]),
    [['2026-09-28',40],['2026-10-12',32]]);
  console.log('weekly cap history sync tests: PASS');
})().catch(err=>{console.error(err);process.exitCode=1;});
