'use strict';

const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const permissions=require('../lib/permissions');
const {syncOrganizationalDepartmentHead}=require('../lib/department-head-sync');
const server=fs.readFileSync(require.resolve('../server'),'utf8');
const syncSource=server.slice(server.indexOf('const APPLICATION_ROLES='),server.indexOf("app.post('/admin/sync-portal-directory'"));
const compact=sql=>String(sql).replace(/\s+/g,' ').trim();

// Execute the production auth and full-directory entry points against one
// transactional database double, rejecting any unexpected/nontransactional SQL.
function database(initial=[]){
  let committed={employees:structuredClone(initial),heads:[],history:[]};
  let transaction=null;
  const db={queries:[],releases:0,failHead:false,
    get state(){return committed;},
    get current(){return transaction||committed;},
  };
  const client={
    async query(sql,args=[]){
      const q=compact(sql);db.queries.push(q);
      if(q==='BEGIN'){assert.strictEqual(transaction,null);transaction=structuredClone(committed);return {rows:[]};}
      if(q==='COMMIT'){assert(transaction);committed=transaction;transaction=null;return {rows:[]};}
      if(q==='ROLLBACK'){transaction=null;return {rows:[]};}
      assert(transaction,'all synchronization writes/reads must use the transaction client');
      const state=transaction;
      if(q.includes('FROM departments')||q.startsWith('INSERT INTO departments'))return {rows:[{id:args[0]||10}]};
      if(q.startsWith('SELECT COUNT(*)'))return {rows:[{count:state.employees.filter(e=>e.active).length}]};
      if(q.includes('FROM employees WHERE portal_user_id=$1'))return {rows:state.employees.filter(e=>e.portal_user_id===args[0])};
      if(q.includes('FROM employees WHERE portal_user_id IS NULL'))return {rows:state.employees.filter(e=>!e.portal_user_id&&e.employee_number===args[0])};
      if(q.startsWith('UPDATE employees SET portal_user_id=')){
        const row=state.employees.find(e=>e.id===args[13]);assert(row);
        Object.assign(row,{portal_user_id:args[0],first_name:args[2],last_name:args[3],department_id:args[6],
          role:args[8],portal_permissions:JSON.parse(args[9]),app_admin_scope:args[10],active:true});
        return {rows:[{...row}]};
      }
      if(q.startsWith('INSERT INTO employees')){
        const row={id:Math.max(0,...state.employees.map(e=>e.id))+1,portal_user_id:args[0],
          first_name:args[2],last_name:args[3],role:args[5],department_id:args[7],
          portal_permissions:JSON.parse(args[9]),app_admin_scope:args[10],active:true};
        state.employees.push(row);return {rows:[{...row}]};
      }
      if(q.startsWith('UPDATE employees SET active=FALSE')){
        const removed=state.employees.filter(e=>e.active&&!args[0].includes(e.portal_user_id));
        removed.forEach(e=>{e.active=false;});return {rows:removed,rowCount:removed.length};
      }
      if(q.startsWith('UPDATE department_heads')){
        for(const h of state.heads){
          const remove=q.includes('employee_id=ANY') ? args[0].includes(h.employee_id)
            :q.includes('department_id<>$2') ? h.employee_id===args[0]&&(h.department_id!==args[1]||args[2]===false)
            :h.department_id===args[0]&&h.employee_id!==args[1];
          if(remove)h.active=false;
        }
        return {rows:[]};
      }
      if(q.startsWith('INSERT INTO department_heads')){
        if(db.failHead)throw new Error('relationship write failed');
        assert(!state.heads.some(h=>h.active&&h.department_id===args[0]&&h.employee_id!==args[1]));
        let h=state.heads.find(h=>h.department_id===args[0]&&h.employee_id===args[1]);
        if(h)h.active=true;else state.heads.push({department_id:args[0],employee_id:args[1],active:true});
        return {rows:[]};
      }
      throw new Error('Unexpected query: '+q);
    },
    release(){db.releases++;},
  };
  db.pool={
    connect:async()=>client,
    async query(sql){
      assert.match(sql,/portal_directory_sync_log/,'only directory logging may use the pool');
      return {rows:[{id:1}]};
    },
  };
  return db;
}
function functions(db){
  const context={
    pool:db.pool,...permissions,syncOrganizationalDepartmentHead,
    portalCapSnapshotIsFresh:()=>true,
    recordWeeklyCapChange:async(client,change)=>{db.current.history.push({...change});},
    process:{env:{PORTAL_DIRECTORY_URL:'https://portal.test/directory',PORTAL_DIRECTORY_API_KEY:'test'}},
    fetch:async()=>({ok:true,json:async()=>({employees:context.directory})}),
    AbortSignal,console,directory:[],
  };
  return {...vm.runInNewContext(syncSource+';({syncPortalUser,syncPortalDirectory})',context),context};
}
const records=[
  {portal_user_id:'david',first_name:'David',last_name:'Caddell',timeclock_role:'timeclock_manager'},
  {portal_user_id:'doc',first_name:'Hart "Doc"',last_name:'Clark',timeclock_role:'timeclock_manager'},
  {portal_user_id:'foster',first_name:'Foster',last_name:'Crowder',timeclock_role:'admin',app_admin_scope:'all'},
  {portal_user_id:'payroll',first_name:'Payroll',last_name:'Head',timeclock_role:'payroll'},
].map((r,i)=>({...r,portal_department_id:10+i,is_department_head:true,permissions:[...permissions.ROLE_PRESETS[r.timeclock_role]]}));
function checkRoles(db){
  for(const r of records){
    const e=db.state.employees.find(e=>e.portal_user_id===r.portal_user_id);
    assert.strictEqual(e.role,r.timeclock_role,r.first_name);
    assert.deepStrictEqual(e.portal_permissions,r.permissions,r.first_name);
    assert.strictEqual(e.app_admin_scope,r.app_admin_scope||'own');
  }
}
(async()=>{
  const db=database(records.map((r,i)=>({id:i+1,portal_user_id:r.portal_user_id,role:r.timeclock_role,active:true})));
  const api=functions(db);
  api.context.directory=records;
  await api.syncPortalDirectory();
  checkRoles(db);
  assert.strictEqual(db.state.heads.filter(h=>h.active).length,4);
  await api.syncPortalDirectory();
  assert.strictEqual(db.state.heads.length,4,'repeated directory sync must not duplicate relationships');

  // An old Portal payload omitting the field must preserve migrated links.
  api.context.directory=records.map(({is_department_head,...r})=>r);
  await api.syncPortalDirectory();
  assert.strictEqual(db.state.heads.filter(h=>h.active).length,4);
  api.context.directory=records.map(r=>({...r,is_department_head:false}));
  await api.syncPortalDirectory();
  assert.strictEqual(db.state.heads.filter(h=>h.active).length,0);
  checkRoles(db);

  // SSO/authorization uses the same transactional sync and preserves every
  // explicit role and permission set when assignment toggles.
  for(const r of records){
    for(const isHead of [true,false]){
      await api.syncPortalUser({...r,sub:r.portal_user_id,department_id:r.portal_department_id,is_department_head:isHead});
      checkRoles(db);
      assert.strictEqual(db.state.heads.find(h=>h.employee_id===records.indexOf(r)+1).active,isHead);
    }
  }

  // Live authorization forwards the organizational field independently of
  // timeclock_role. Omitted fields from older Portal versions preserve links.
  const refreshSource=server.slice(server.indexOf('async function refreshPortalAuthorization('),
    server.indexOf('async function getUserById(id)'));
  for(const flag of [true,undefined,false]){
    const current={...records[0],exists:true,is_active:true,timeclock_access:true};
    if(flag===undefined)delete current.is_department_head;else current.is_department_head=flag;
    const refresh=vm.runInNewContext(refreshSource+';refreshPortalAuthorization',{
      pool:db.pool,PORTAL_AUTH_CACHE_TTL_MS:60000,portalAuthorizationCache:new Map(),
      PORTAL_DIRECTORY_URL:'https://portal.test/directory',PORTAL_DIRECTORY_API_KEY:'test',
      fetchPortalAuthorization:async()=>current,syncPortalUser:api.syncPortalUser,
      getUserByIdLocal:async id=>db.state.employees.find(e=>e.id===id),
    });
    await refresh({...db.state.employees[0],auth_source:'portal'});
    assert.strictEqual(db.state.heads.find(h=>h.employee_id===1).active,flag!==false);
    checkRoles(db);
  }

  // Charles is created through the actual directory path, never a manual link.
  const charles={portal_user_id:'charles-fixture',first_name:'Charles',last_name:'Reel',
    portal_department_id:20,timeclock_role:'supervisor',permissions:['access','approve_timecard'],is_department_head:true};
  api.context.directory=[...records,charles];
  await api.syncPortalDirectory();
  const employee=db.state.employees.find(e=>e.portal_user_id===charles.portal_user_id);
  assert(employee);
  assert(db.state.heads.some(h=>h.employee_id===employee.id&&h.department_id===20&&h.active));
  assert.strictEqual(employee.role,'supervisor');

  // Transfer and replacement deactivate stale links, regardless of row order.
  api.context.directory=[...records,{...charles,portal_department_id:21}];
  await api.syncPortalDirectory();
  assert(!db.state.heads.some(h=>h.employee_id===employee.id&&h.department_id===20&&h.active));
  const replacement={...charles,portal_user_id:'replacement',first_name:'Next',portal_department_id:21};
  api.context.directory=[...records,replacement,{...charles,portal_department_id:21,is_department_head:false}];
  await api.syncPortalDirectory();
  assert.strictEqual(db.state.heads.filter(h=>h.department_id===21&&h.active).length,1);
  assert(!db.state.heads.some(h=>h.employee_id===employee.id&&h.active));

  // A relationship failure must roll back the whole batch, including employee
  // updates, new users, earlier links and cap-history writes, then release.
  const snapshot=structuredClone(db.state);
  const releasesBeforeFailure=db.releases;
  db.failHead=true;
  api.context.directory=[...records,{...charles,weekly_hours_cap:32}];
  await assert.rejects(api.syncPortalDirectory(),/relationship write failed/);
  assert.deepStrictEqual(db.state,snapshot);
  assert.strictEqual(db.queries.at(-1),'ROLLBACK');
  await assert.rejects(api.syncPortalUser({...records[0],sub:'new-auth',department_id:30}),/relationship write failed/);
  assert.deepStrictEqual(db.state,snapshot);
  assert.strictEqual(db.queries.at(-1),'ROLLBACK');
  assert.strictEqual(db.releases,releasesBeforeFailure+2,'both failed transactions release their clients');
  db.failHead=false;
  await assert.rejects(api.syncPortalUser({...records[0],sub:'david',department_id:10,is_department_head:'false'}),/must be a boolean/);
  assert.deepStrictEqual(db.state,snapshot);

  api.context.directory=[records[0]];
  await assert.rejects(api.syncPortalDirectory(),/50% safety threshold/);
  assert.deepStrictEqual(db.state,snapshot);

  // Missing records are deactivated with their links in the same transaction;
  // malformed/empty/shrunken snapshots retain the existing safety guards.
  api.context.directory=records;
  await api.syncPortalDirectory();
  assert(!db.state.heads.some(h=>h.department_id===21&&h.active));
  const final=structuredClone(db.state);
  api.context.directory=[];
  await assert.rejects(api.syncPortalDirectory(),/refusing mass deactivation/);
  assert.deepStrictEqual(db.state,final);
  api.context.directory=[records[0],records[0]];
  await assert.rejects(api.syncPortalDirectory(),/duplicate portal_user_id/);
  assert.deepStrictEqual(db.state,final);
  console.log('organizational Department Head sync tests: PASS');
})().catch(err=>{console.error(err);process.exitCode=1;});
