'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {load,source,routerMock,response}=require('./helpers.cjs');
async function punch(user,{assigned=false,head=false,approval=null,action='delete',self=false}={}){
 const mock=routerMock(),writes=[];
 const entry={id:10,employee_id:self?user.id:20,clock_in:'2026-09-01T08:00:00',clock_out:'2026-09-01T16:00:00'};
 const db={async query(sql){
   if(/FROM employees target/.test(sql))return {rows:(assigned||head||(/target.department_id=\$2/.test(sql)&&user.department_id===1))?[{}]:[]};
   if(/SELECT \* FROM time_entries/.test(sql))return {rows:[entry]};
   if(/FROM pay_period_approvals/.test(sql))return {rows:approval?[approval]:[]};
   if(/UPDATE|INSERT/.test(sql)){writes.push(sql);return {rows:[{id:10}]};}
   return {rows:[]};
 },release(){}};
 const factory=load('backend/routes/quick-punch.js',{'express':mock.express,'../lib/punch-metadata':{recordPunchMetadata:async()=>{}}});
 factory.createQuickPunchRouter({pool:{...db,connect:async()=>db},audit:async()=>{},requireUser:()=>{},requireAnyPermission:()=>()=>{}});
 const route=mock.routes.find(r=>r.route===(action==='delete'?'/delete-punch':'/supervisor/add-time-entry'));
 const req={user,body:{time_entry_id:10,employee_id:20,reason:'correct punch',clock_in:'2026-09-01T08:00:00',clock_out:'2026-09-01T16:00:00'}};
 const res=response();await route.handlers.at(-1)(req,res);return {res,writes};
}
const signed={id:1,status:'employee_submitted',employee_signed_at:'2026-09-02',supervisor_approved_at:null,payroll_finalized_at:null};
for(const action of ['delete','add']){
 for(const permissions of [['view_all_timeclock_records'],['app_admin'],['edit_employee_time']]){
 test(action+' denies read/admin/unassigned peer '+permissions,async()=>{
 const {res,writes}=await punch({id:1,role:'admin',department_id:1,app_admin_scope:'all',permissions},{action,approval:signed});
 assert.equal(res.statusCode,403);assert.equal(writes.length,0);
 });}
 for(const scope of ['assigned','head'])test(action+' allows explicit operational permission and '+scope,async()=>{
 const {res,writes}=await punch({id:1,department_id:1,permissions:['edit_employee_time']},{action,[scope]:true,approval:signed});
 assert.equal(res.statusCode,action==="add"?201:200);assert.ok(writes.length);
 });
 test(action+' denies supervisor after supervisory approval',async()=>{
 const {res,writes}=await punch({id:1,department_id:1,permissions:['edit_employee_time']},{action,assigned:true,approval:{...signed,status:'supervisor_approved',supervisor_approved_at:'2026-09-02'}});
 assert.ok([403,409].includes(res.statusCode));assert.equal(writes.length,0);
 });
 test(action+' payroll requires reopen grant on finalized card',async()=>{
 const {res,writes}=await punch({id:1,permissions:['edit_payroll_time']},{action,approval:{...signed,status:'payroll_finalized',payroll_finalized_at:'2026-09-03'}});
 assert.ok([403,409].includes(res.statusCode));assert.equal(writes.length,0);
 });
 test(action+' explicit payroll edit remains available',async()=>{
 const {res}=await punch({id:1,permissions:['edit_payroll_time']},{action,approval:signed});assert.equal(res.statusCode,action==="add"?201:200);
 });
}
test('own unsigned deletion requires own-edit permission',async()=>{
 const denied=await punch({id:1,permissions:[]},{self:true});assert.equal(denied.res.statusCode,403);
 const allowed=await punch({id:1,permissions:['edit_own_pending_entry']},{self:true});assert.equal(allowed.res.statusCode,200);
});
function expressionRender(html,expression,objects){
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 return vm.runInNewContext(expression,{...objects,esc:escape});
}
const malicious='<img src=x onerror="alert(1)">Employee note & reason';
for(const [file,fields] of [
 ['employee.html',['entry.note','request.employee_reason','request.supervisor_note']],
 ['supervisor.html',['entry.note','request.employee_reason','request.supervisor_note','item.reason']],
 ['payroll.html',['request.employee_reason','request.supervisor_note']]
])for(const field of fields)test('HTML sink escapes and retains '+file+' '+field,()=>{
 const html=source('frontend/'+file);

 const expressions=[...html.matchAll(/\$\{([^{}]+)\}/g)].map(m=>m[1]).filter(x=>x.includes(field));
 assert.ok(expressions.length);
 const [object,key]=field.split('.');
 for(const expression of expressions){const rendered=expressionRender(html,expression,{[object]:{[key]:malicious}});assert.ok(!rendered.includes('<img'));assert.ok(rendered.includes('&lt;img'));assert.ok(rendered.includes('Employee note &amp; reason'));}
});
test('leave notes are escaped in actual leave renderer',async()=>{
 const html=source('frontend/leave.html'),body=html.match(/async function loadLeave\(\)[\s\S]*?(?=async function addLeave)/)[0];
 const rows={innerHTML:''};
 const context={rows,period:{value:'2026-09-01'},holidayCalendar:{year:2026},selectedEmployee:()=>1,canManage:false,esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),msg:e=>{throw Error(e)},request:async()=>({pay_period_start:'2026-09-01',leave_entries:[{id:1,leave_date:'2026-09-01',leave_type:'annual',hours:8,status:'pending',created_by_first_name:'Employee',created_by_last_name:'One',note:malicious}]})};
 await vm.runInNewContext(body+';loadLeave()',context);
 assert.ok(!rows.innerHTML.includes('<img'));assert.ok(rows.innerHTML.includes('&lt;img'));assert.ok(rows.innerHTML.includes('Employee note'));
});
