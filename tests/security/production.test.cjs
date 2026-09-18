'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),vm=require('node:vm');
const {root}=require('./helpers.cjs');

test('single-punch approval allows department-head self-approval with normal approval grant',async()=>{
 const source=fs.readFileSync(path.join(root,'backend/lib/approve-single-punch.js'),'utf8');
 const start=source.indexOf('async function canReviewEmployee(');
 const end=source.indexOf('\nfunction punchTimestamp',start);
 assert.ok(start>=0&&end>start,'canReviewEmployee source');
 const fn=source.slice(start,end);
 const check=vm.runInNewContext(fn+';canReviewEmployee',{permissionSet:u=>new Set(Array.isArray(u?.permissions)?u.permissions:[])});
 const headPool={query:async(sql,params)=>{
   if(/SELECT department_id FROM employees/.test(sql))return{rows:[{department_id:1}]};
   if(/FROM department_heads/.test(sql))return{rows:[{one:1}]};
   if(/FROM supervisor_employee_assignments/.test(sql))return{rows:[]};
   throw new Error('Unexpected query: '+sql);
 }};
 assert.equal(await check(headPool,{id:2,permissions:['approve_punch_correction']},2),true);
 assert.equal(await check(headPool,{id:2,permissions:['approve_own_punch_corrections']},2),true);
 assert.equal(await check(headPool,{id:2,permissions:['app_admin']},2),false);
});

test('production approval transform preserves one supervisory stage and head self-approval',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'timeclock-build-check-'));
 // Reproduce the Docker transform on disposable copies, never source files.
 for(const dir of ['routes','lib','scripts'])fs.cpSync(path.join(root,'backend',dir),path.join(temp,dir),{recursive:true});
 fs.copyFileSync(path.join(root,'backend/server.js'),path.join(temp,'server.js'));
 // Git's Windows checkout uses CRLF; Docker's Linux checkout uses LF.
 function normalize(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())normalize(p);else if(p.endsWith('.js'))fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n'));}}
 normalize(temp);
 cp.execFileSync(process.execPath,[path.join(temp,'scripts/apply-approval-model.js')]);
 for(const file of ['server.js','routes/supervisor.js','routes/leave.js','lib/approve-single-punch.js'])cp.execFileSync(process.execPath,['--check',path.join(temp,file)]);
 const server=fs.readFileSync(path.join(temp,'server.js'),'utf8');
 const fn=server.slice(server.indexOf('async function canAccessEmployee('),server.indexOf('async function syncPortalUser'));
 const check=vm.runInNewContext(fn+';canAccessEmployee',{
 userPermissionSet:u=>new Set(u.permissions),pool:{query:async()=>({rows:[{department_id:1}]})},
 isDepartmentHead:async u=>u.head===true,isAssignedEmployee:async u=>u.assigned===true,
 isSameDepartment:async()=>true});
 return (async()=>{
 assert.equal(await check({id:1,permissions:['approve_timecard'],assigned:true},2,['approve_timecard']),true);
 assert.equal(await check({id:1,permissions:['approve_timecard'],head:true},2,['approve_timecard']),true);
 assert.equal(await check({id:1,permissions:['approve_own_timecard'],head:true},1,['approve_timecard']),true);
 assert.equal(await check({id:1,permissions:['approve_timecard'],assigned:true},1,['approve_timecard']),false);
 assert.equal(await check({id:1,permissions:['app_admin'],head:false},2,['approve_timecard']),false);
 assert.equal(await check({id:1,permissions:['edit_payroll_time'],head:false},2,['approve_timecard']),false);
 const supervisor=fs.readFileSync(path.join(temp,'routes/supervisor.js'),'utf8');
 const start=supervisor.indexOf("'/supervisor/employee-timecard/:employeeId'");
 const end=supervisor.indexOf("'/supervisor/approve-timecard'",start);
 const timecardRoute=supervisor.slice(start,end);
 assert.match(timecardRoute,/userHasPermission\(req\.user, 'view_all_timeclock_records'\)/);
 assert.match(timecardRoute,/userHasPermission\(req\.user, 'app_admin'\) && req\.user\.app_admin_scope === 'all'/);
 assert.match(timecardRoute,/if \(!countywideRead && !\(await canAccessEmployee\(req\.user, employeeId\)\)\)/);
 })();
});
test('deployed frontend inline scripts parse and load escaping helper first',()=>{
 for(const name of ['employee','supervisor','payroll','payroll-timecards','leave']){
 const html=fs.readFileSync(path.join(root,'frontend',name+'.html'),'utf8');
 const helper=html.indexOf('src="/safe-html.js"'),definition=html.search(/const esc\s*=\s*SafeHtml.escape/);
 assert.ok(helper>=0&&definition>helper,name+' helper order');
 for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1],{filename:name+'.html'});
 }
});
