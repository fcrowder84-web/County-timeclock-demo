'use strict';

const assert=require('assert');
const {createSupervisorRouter}=require('../routes/supervisor');
const {summarizeTimecard}=require('../lib/timecard-summary');

function noop(_req,_res,next){if(next)next();}
const entry={employee_id:7,entry_date_iso:'2026-10-11',
  clock_in:new Date('2026-10-12T00:30:00Z'),clock_out:new Date('2026-10-12T09:30:00Z')};
const lunchSettings=[{employee_id:7,effective_date_iso:'2026-10-05',enabled:true,minutes:60}];
const lunchWaivers=[{employee_id:7,work_date_iso:'2026-10-11',active:true}];
const period={pay_period_start:'2026-10-05',pay_period_end:'2026-10-18'};
const summary=summarizeTimecard({entries:[entry],payPeriodStart:period.pay_period_start,
  weeklyHoursCap:40,forcedLunchSettings:lunchSettings,lunchWaivers});
assert.strictEqual(summary.days[0].work_date,'2026-10-11');
assert.strictEqual(summary.weeks[0].total_paid_hours,9);
assert.strictEqual(summary.weeks[1].total_paid_hours,0);

const pool={async query(sql){
  const q=String(sql).replace(/\s+/g,' ');
  if(q.includes('FROM employees e'))return {rows:[{id:7,weekly_hours_cap:40}]};
  if(q.includes('FROM time_entries')&&q.includes('AS entry_date_iso')){
    assert(q.includes("to_char(clock_in::date,'YYYY-MM-DD') AS entry_date_iso"));
    return {rows:[entry]};
  }
  if(q.includes('FROM leave_entries'))return {rows:[]};
  if(q.includes('FROM forced_lunch_setting_history'))return {rows:lunchSettings};
  if(q.includes('FROM forced_lunch_waivers'))return {rows:lunchWaivers};
  throw new Error(`Unexpected query: ${q}`);
}};
const router=createSupervisorRouter({requireUser:noop,requireAnyPermission:()=>noop,pool,
  audit:async()=>{},canAccessEmployee:async()=>true,getRequestedPayPeriod:async()=>period,
  userHasPermission:()=>false});
const handler=router.stack.find(layer=>layer.route?.path==='/supervisor/pay-period-status')
  .route.stack.at(-1).handle;
const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
handler({user:{id:2}},res).then(()=>{
  assert.strictEqual(res.statusCode,200);
  assert.strictEqual(res.body.employees[0].payable_hours,summary.period.total_paid_hours);
  console.log('supervisor payable date tests: PASS');
}).catch(err=>{console.error(err);process.exitCode=1;});
