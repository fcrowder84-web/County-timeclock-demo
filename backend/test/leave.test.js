'use strict';
const assert = require('assert');
const {
  parseQuarterHours,
  datesBetween,
  assessDailyPaidHours,
  validateFixedHolidayDates,
  validateFloatingHolidayRequest,
  LEAVE_TYPES,
  createLeaveRouter,
} = require('../routes/leave');
const { getHolidayCalendar, findFixedHoliday, isWorkday, FLOATING_HOLIDAY_POLICY } = require('../lib/holiday-calendar');

assert.strictEqual(parseQuarterHours(0.25), 1);
assert.strictEqual(parseQuarterHours(4), 16);
assert.strictEqual(parseQuarterHours(7.75), 31);
assert.throws(() => parseQuarterHours(1.1), /15-minute/);
assert.throws(() => parseQuarterHours(0), /15-minute/);
assert.deepStrictEqual(datesBetween('2026-08-13','2026-08-13'), ['2026-08-13']);
assert.deepStrictEqual(datesBetween('2026-08-14','2026-08-17',true), ['2026-08-14','2026-08-17']);
assert(LEAVE_TYPES.includes('sick') && LEAVE_TYPES.includes('vacation'));
assert(LEAVE_TYPES.includes('holiday') && LEAVE_TYPES.includes('floating_holiday'));

const holidays = getHolidayCalendar(2026);
assert.strictEqual(holidays.length, 12);
assert.strictEqual(findFixedHoliday('2026-11-26').name, 'Thanksgiving');
assert.strictEqual(findFixedHoliday('2026-12-28').name, 'Christmas');
assert.strictEqual(findFixedHoliday('2026-08-17'), null);
assert.strictEqual(isWorkday('2026-08-17'), true);
assert.strictEqual(isWorkday('2026-08-16'), false);
assert.strictEqual(FLOATING_HOLIDAY_POLICY.hours_flexible, true);
assert.doesNotThrow(() => validateFixedHolidayDates(['2026-01-01','2026-12-28']));
assert.throws(() => validateFixedHolidayDates(['2026-08-17']), /County holiday calendar/);
assert.doesNotThrow(() => validateFloatingHolidayRequest(['2026-08-17']));
assert.throws(() => validateFloatingHolidayRequest(['2026-08-16']), /workday/);
assert.throws(() => validateFloatingHolidayRequest(['2026-08-17','2026-08-18']), /one workday/);
assert.strictEqual(parseQuarterHours(7), 28);
assert.strictEqual(parseQuarterHours(10), 40);

let check = assessDailyPaidHours({ workedQuarterHours: 8, proposedQuarterHours: 24 });
assert.strictEqual(check.total_hours, 8);
assert.strictEqual(check.exceeds_standard_day, false);
assert.strictEqual(check.recommended_leave_hours, 6);
check = assessDailyPaidHours({ workedQuarterHours: 8, proposedQuarterHours: 28 });
assert.strictEqual(check.total_hours, 9);
assert.strictEqual(check.exceeds_standard_day, true);
assert.strictEqual(check.recommended_leave_hours, 6);
check = assessDailyPaidHours({ workedQuarterHours: 16, existingLeaveQuarterHours: 8, proposedQuarterHours: 16 });
assert.strictEqual(check.total_hours, 10);
assert.strictEqual(check.recommended_leave_hours, 2);
console.log('leave tests passed');

function noop(_req,_res,next){if(next)next();}
function response(){return {statusCode:200,body:null,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}
async function submitHoliday({employeeId=7,type='holiday',start='2026-11-26',end=start,existing=[],conflictOnInsertDate=null}){
  const queries=[];
  const client={
    async query(sql,args=[]){
      const q=String(sql).replace(/\s+/g,' ').trim();queries.push(q);
      if(['BEGIN','COMMIT','ROLLBACK'].includes(q))return {rows:[]};
      if(q.includes('FROM leave_entries')&&q.includes("leave_type='holiday'")){
        const found=existing.find(row=>row.employee_id===args[0]&&args[1].includes(row.date)
          &&['pending','approved'].includes(row.status)&&row.type==='holiday');
        return {rows:found?[{leave_date:found.date}]:[]};
      }
      if(q.includes('FROM pay_period_approvals ppa'))return {rows:[]};
      if(q.includes('AS worked_quarters'))return {rows:[{worked_quarters:0,leave_quarters:0}]};
      if(q.startsWith('INSERT INTO leave_entries')){
        if(args[1]===conflictOnInsertDate){
          const error=new Error('duplicate key');error.code='23505';
          error.constraint='idx_leave_one_regular_holiday_per_day';throw error;
        }
        return {rows:[{id:1}]};
      }
      if(q.includes("leave_type='floating_holiday'"))return {rows:[]};
      throw new Error(`Unexpected leave query: ${q}`);
    },release(){},
  };
  const router=createLeaveRouter({requireUser:noop,pool:{connect:async()=>client},audit:async()=>{},
    canAccessEmployee:async()=>true,getRequestedPayPeriod:async()=>{},userHasAnyPermission:()=>true});
  const handler=router.stack.find(layer=>layer.route?.path==='/leave'&&layer.route.methods.post).route.stack.at(-1).handle;
  const res=response();
  await handler({user:{id:7},body:{employee_id:employeeId,leave_type:type,start_date:start,end_date:end,hours:8}},res);
  return {res,queries};
}

(async()=>{
  for(const status of ['approved','pending']){
    const {res,queries}=await submitHoliday({existing:[{employee_id:7,date:'2026-11-26',status,type:'holiday'}]});
    assert.strictEqual(res.statusCode,409);
    assert(!queries.includes('BEGIN'));
    assert(!queries.some(q=>q.startsWith('UPDATE pay_period_approvals')||q.startsWith('INSERT INTO leave_entries')));
  }
  const multi=await submitHoliday({start:'2026-11-26',end:'2026-11-27',existing:[{employee_id:7,date:'2026-11-27',status:'approved',type:'holiday'}]});
  assert.strictEqual(multi.res.statusCode,409);
  assert(!multi.queries.some(q=>q.startsWith('INSERT INTO leave_entries')));
  const racing=await submitHoliday({start:'2026-11-26',end:'2026-11-27',conflictOnInsertDate:'2026-11-27'});
  assert.strictEqual(racing.res.statusCode,409);
  assert(racing.queries.includes('ROLLBACK'));
  assert(!racing.queries.includes('COMMIT'));
  for(const status of ['denied','withdrawn','voided']){
    assert.strictEqual((await submitHoliday({existing:[{employee_id:7,date:'2026-11-26',status,type:'holiday'}]})).res.statusCode,201);
  }
  assert.strictEqual((await submitHoliday({existing:[{employee_id:8,date:'2026-11-26',status:'approved',type:'holiday'}]})).res.statusCode,201);
  assert.strictEqual((await submitHoliday({existing:[{employee_id:7,date:'2026-11-26',status:'approved',type:'floating_holiday'}]})).res.statusCode,201);
  assert.strictEqual((await submitHoliday({start:'2026-11-27',existing:[{employee_id:7,date:'2026-11-26',status:'approved',type:'holiday'}]})).res.statusCode,201);
  const editQueries=[];
  const editClient={async query(sql){
    const q=String(sql).replace(/\s+/g,' ').trim();editQueries.push(q);
    if(['BEGIN','ROLLBACK'].includes(q))return {rows:[]};
    if(q==='SELECT * FROM leave_entries WHERE id=$1 FOR UPDATE')return {rows:[{id:1,employee_id:7,status:'approved'}]};
    if(q.includes("leave_type='holiday'")&&q.includes('id<>$3'))return {rows:[{id:2}]};
    throw new Error(`Unexpected edit query: ${q}`);
  },release(){}};
  const editRouter=createLeaveRouter({requireUser:noop,pool:{connect:async()=>editClient},audit:async()=>{},
    canAccessEmployee:async()=>true,getRequestedPayPeriod:async()=>{},userHasAnyPermission:()=>true});
  const editHandler=editRouter.stack.find(layer=>layer.route?.path==='/leave/:id'&&layer.route.methods.patch)
    .route.stack.at(-1).handle;
  const edited=response();
  await editHandler({user:{id:2},params:{id:'1'},body:{reason:'Correction',leave_type:'holiday',
    leave_date:'2026-11-26',hours:8}},edited);
  assert.strictEqual(edited.statusCode,409);
  assert(!editQueries.some(q=>q.startsWith('UPDATE pay_period_approvals')||q.startsWith('UPDATE leave_entries')));
  console.log('holiday duplicate route tests: PASS');
})().catch(err=>{console.error(err);process.exitCode=1;});
