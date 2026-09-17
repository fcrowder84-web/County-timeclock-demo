'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {load,source,routerMock,response}=require('./helpers.cjs');
const submitted={id:5,status:'employee_submitted',employee_signed_at:'2026-09-01',supervisor_approved_at:null,payroll_finalized_at:null,pay_period_start:'2026-09-01',pay_period_end:'2026-09-14',source_period:true,destination_period:true};
const approved={...submitted,status:'supervisor_approved',supervisor_approved_at:'2026-09-02'};
const finalized={...approved,status:'payroll_finalized',payroll_finalized_at:'2026-09-03'};
async function edit(user,{card=submitted,assigned=false,head=false,employeeId=20,destination=null}={}){
 const mock=routerMock(),writes=[],audits=[],queries=[];
 const entry={id:10,employee_id:employeeId,clock_in:'2026-09-02T08:00:00',clock_out:'2026-09-02T16:00:00'};
 const db={async query(sql,params){
 queries.push(sql);
 if(/FROM employees target/.test(sql))return {rows:assigned||head?[{}]:[]};
 if(/FROM time_entries/.test(sql))return {rows:[entry]};
 if(/FROM pay_period_approvals/.test(sql))return {rows:card?[...(destination?[{...card,destination_period:false},destination]:[card])]:[]};
 if(/INSERT|UPDATE/.test(sql)){writes.push(sql);return {rows:[{id:10}]}};
 return {rows:[]};
 },release(){}};
 const {createSupervisorRouter}=load('backend/routes/supervisor.js',{'express':mock.express});
 createSupervisorRouter({pool:{...db,connect:async()=>db},requireUser:()=>{},requireAnyPermission:()=>()=>{},
 audit:async(...args)=>audits.push(args),canAccessEmployee:async()=>true,getRequestedPayPeriod:async()=>({}),
 userHasPermission:(u,k)=>(u.permissions||[]).includes(k)});
 const handler=mock.routes.find(r=>r.route==='/supervisor/edit-time-entry').handlers.at(-1);
 const res=response();await handler({user,body:{time_entry_id:10,new_clock_in:destination?'2026-09-16T08:00:00':'2026-09-02T08:30:00',new_clock_out:destination?'2026-09-16T16:00:00':'2026-09-02T16:00:00',reason:'Correct entry after review'}},res);
 return {res,writes,audits,queries};
}
const supervisor={id:1,permissions:['edit_employee_time']};
const payroll={id:1,permissions:['edit_payroll_time']};
for(const [name,user,options] of [
 ['supervisor self',supervisor,{employeeId:1,assigned:true}],
 ['department-head self',{...supervisor,permissions:[...supervisor.permissions,'approve_own_timecard','approve_own_punch_corrections']},{employeeId:1,head:true}],
 ['unassigned peer',supervisor,{}],
 ['technical admin',{id:1,role:'admin',permissions:['app_admin'],app_admin_scope:'all'},{}],
 ['read-only',{id:1,permissions:['view_all_timeclock_records']},{}],
 ['payroll before supervisor approval',payroll,{}],
 ['payroll on finalized card',payroll,{card:finalized}],
 ['payroll on status-only finalized card',payroll,{card:{...finalized,payroll_finalized_at:null}}],
 ['payroll without card',payroll,{card:null}],
 ['payroll with approval timestamp but wrong stage',payroll,{card:{...approved,status:'returned_to_supervisor'}}],
 ['supervisor after supervisory approval',supervisor,{assigned:true,card:approved}],
 ['payroll moving into finalized card',payroll,{card:approved,destination:{...finalized,id:6,source_period:false,destination_period:true}}],
 ['payroll moving into unapproved card',payroll,{card:approved,destination:{...submitted,id:6,source_period:false,destination_period:true}}]
])test('edit rejects '+name+' before any write',async()=>{
 const r=await edit(user,options);assert.ok([403,409].includes(r.res.statusCode),JSON.stringify(r.res));assert.equal(r.writes.length,0);assert.equal(r.audits.length,0);
});
for(const [name,user,options] of [
 ['assigned supervisor',supervisor,{assigned:true}],
 ['department-head backup',supervisor,{head:true}],
 ['payroll after one supervisory approval',payroll,{card:approved}],
 ['deliberate finalized reopen',{...payroll,permissions:['edit_payroll_time','reopen_timecard']},{card:finalized}]
])test('edit permits '+name,async()=>{
 const r=await edit(user,options);assert.equal(r.res.statusCode,200,JSON.stringify(r.res));assert.ok(r.writes.some(s=>/UPDATE time_entries/.test(s)));assert.ok(r.queries.some(s=>/FOR UPDATE/.test(s)));
 if(options.card===finalized)assert.deepEqual(r.audits[0].at(-1).reopened_finalized_card_ids,[5]);
});
test('external compatibility renderer escapes names, department, reason and punch displays',async()=>{
 const malicious='<img src=x onerror="alert(1)"> employee & reason';
 const rows=[{id:9,first_name:malicious,last_name:malicious,department:malicious,employee_reason:malicious,time_entry_id:null,requested_clock_in:'2026-09-01',requested_clock_in_display:malicious}];
 const box={innerHTML:''};let onLoad;
 const window={addEventListener:(name,fn)=>onLoad=fn,apiFetch:async()=>({json:async()=>rows})};
 const context=vm.createContext({window,document:{getElementById:id=>id==='requestsBox'?box:null}});
 vm.runInContext(source('frontend/timecard-summary-ui.js'),context);
 vm.runInContext(source('frontend/safe-html.js'),context);
 onLoad();await window.loadRequests();
 assert.ok(!box.innerHTML.includes('<img'));assert.ok(box.innerHTML.includes('&lt;img'));
 assert.equal(box.innerHTML.split('employee &amp; reason').length-1,5);
 assert.match(box.innerHTML,/approveRequest\(9\)/);
 rows[0].time_entry_id=10;rows[0].requested_clock_out_display=malicious;
 await window.loadRequests();assert.ok(!box.innerHTML.includes('<img'));assert.equal(box.innerHTML.split('employee &amp; reason').length-1,6);
});
