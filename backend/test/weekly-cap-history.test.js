'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const {recordWeeklyCapChange}=require('../lib/weekly-cap-history');

const server=fs.readFileSync(path.resolve(__dirname,'..','server.js'),'utf8');
const authSource=server.slice(server.indexOf('async function syncPortalUser(payload){'),server.indexOf('const PORTAL_DIRECTORY_URL='));
const directorySource=server.slice(server.indexOf('async function upsertDirectoryEmployee(client,item){'),server.indexOf('async function syncPortalDirectory('));
assert(authSource.includes("await client.query('BEGIN')"));
assert(authSource.includes('FOR UPDATE'));
assert(directorySource.includes('FOR UPDATE'));

function fakeDatabase(initialEmployees=[]){
  let committed={employees:initialEmployees.map(row=>({...row})),history:[],nextId:10};
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
            row.active=true;
            return {rows:[{...row}]};
          }
          if(q.startsWith('INSERT INTO employees')){
            const row={id:state.nextId++,portal_user_id:args[0],employee_number:args[1],weekly_hours_cap:args[11],active:true};
            state.employees.push(row);return {rows:[{...row}]};
          }
          if(q.startsWith('INSERT INTO weekly_hours_cap_history')){
            if(failHistory)throw new Error('history write failed');
            const date=args[1]||'2026-10-05';
            const prior=state.history.find(row=>row.employee_id===args[0]&&row.effective_date===date);
            if(prior){if(prior.weekly_hours_cap!==args[2]){prior.weekly_hours_cap=args[2];prior.source=args[3];}}
            else state.history.push({employee_id:args[0],effective_date:date,weekly_hours_cap:args[2],source:args[3]});
            return {rows:[]};
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
    pool:db.pool,normalizePermissions:value=>value,resolveApplicationRole:()=> 'employee',recordWeeklyCapChange,
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
  assert.strictEqual(db.state.history.length,2);
  await syncPortalUser({...payload,weekly_hours_cap:32});
  assert.strictEqual(db.state.history.length,2,'repeated sync must be idempotent');
  await syncPortalUser({...payload,weekly_hours_cap:40});
  assert.strictEqual(db.state.history.length,2,'same-day change must update one effective-date row');
  assert.strictEqual(db.state.history.at(-1).weekly_hours_cap,40);
  await syncPortalUser({...payload,weekly_hours_cap:null});
  assert.strictEqual(db.state.employees[0].weekly_hours_cap,null);
  assert.strictEqual(db.state.history.at(-1).weekly_hours_cap,null);

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
  assert(created.queries.some(({q})=>q.includes('EXTRACT(ISODOW FROM CURRENT_DATE)')),
    'new employee history must cover the current payroll week');
  await createAuth({sub:'new-auth-no-cap',first_name:'N',last_name:'Uncapped'});
  assert.strictEqual(created.state.history.length,2);
  assert.strictEqual(created.state.history.at(-1).weekly_hours_cap,null);
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
  console.log('weekly cap history sync tests: PASS');
})().catch(err=>{console.error(err);process.exitCode=1;});
