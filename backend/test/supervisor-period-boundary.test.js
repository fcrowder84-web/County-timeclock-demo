'use strict';

const assert=require('assert');
const {createSupervisorRouter}=require('../routes/supervisor');
const {userHasPermission}=require('../lib/permissions');

function noop(_req,_res,next){if(next) next();}
function response(){return {statusCode:200,body:null,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}

async function edit(newClockIn,{newClockOut=`${newClockIn.slice(0,10)} 13:00:00`,otherEntries=[],dbConflict=false}={}){
  const queries=[];
  const client={
    async query(sql,args=[]){
      const q=String(sql).replace(/\s+/g,' ').trim();
      queries.push({q,args});
      if(q==='COMMIT'&&dbConflict){const error=new Error('overlap');error.code='23P01';throw error;}
      if(['BEGIN','ROLLBACK','COMMIT'].includes(q)) return {rows:[]};
      if(q.includes('FROM time_entries WHERE id=$1')) return {rows:[{
        id:5,employee_id:10,source_date_iso:'2026-09-20',
        clock_in:new Date('2026-09-20T06:00:00-04:00'),clock_out:new Date('2026-09-20T07:00:00-04:00'),
      }]};
      if(q.includes('FROM time_entries')&&q.includes('id<>$2')){
        assert(q.includes("clock_in < COALESCE($4::timestamp, 'infinity'::timestamp)"));
        assert(q.includes("COALESCE(clock_out, 'infinity'::timestamp) > $3::timestamp"));
        const overlaps=otherEntries.some(row=>new Date(row.start)<(args[3]?new Date(args[3]):Infinity)
          &&(row.end?new Date(row.end):Infinity)>new Date(args[2]));
        return {rows:overlaps?[{id:6}]:[]};
      }
      if(q.includes('FROM pay_period_approvals')) return {rows:[]};
      if(q.includes('FROM settings')) return {rows:[{anchor_date:new Date('2026-09-07T00:00:00Z'),period_days:14}]};
      if(q.includes('AS within_source_period')){
        assert.deepStrictEqual(args.slice(1),['2026-09-07','2026-09-20']);
        return {rows:[{within_source_period:args[0].slice(0,10)>='2026-09-07'&&args[0].slice(0,10)<='2026-09-20'}]};
      }
      if(q.startsWith('INSERT INTO time_entry_audit')) return {rows:[]};
      if(q.startsWith('UPDATE time_entries')) return {rows:[{id:5}]};
      if(q.startsWith('UPDATE pay_period_approvals')) return {rows:[]};
      throw new Error(`Unexpected query: ${q}`);
    },release(){},
  };
  const router=createSupervisorRouter({
    requireUser:noop,requireAnyPermission:()=>noop,pool:{connect:async()=>client},
    audit:async()=>{},canAccessEmployee:async()=>true,getRequestedPayPeriod:async()=>{},userHasPermission,
  });
  const handler=router.stack.find(layer=>layer.route?.path==='/supervisor/edit-time-entry')
    .route.stack.at(-1).handle;
  const res=response();
  await handler({user:{id:1,role:'timeclock_manager',permissions:['edit_employee_time']},
    body:{time_entry_id:5,new_clock_in:newClockIn,new_clock_out:newClockOut,reason:'Correction'}},res);
  return {res,queries};
}

(async()=>{
  const outside=await edit('2026-09-21 08:00:00');
  assert.strictEqual(outside.res.statusCode,409);
  assert.match(outside.res.body.error,/different pay period/);
  assert(!outside.queries.some(({q})=>q.startsWith('UPDATE time_entries')));
  const inside=await edit('2026-09-20 09:00:00');
  assert.strictEqual(inside.res.statusCode,200);
  assert(inside.queries.some(({q})=>q==='COMMIT'));
  const closed=[{start:'2026-09-20 08:00:00',end:'2026-09-20 12:00:00'}];
  for(const [start,end] of [
    ['2026-09-20 09:00:00','2026-09-20 11:00:00'],
    ['2026-09-20 07:00:00','2026-09-20 09:00:00'],
    ['2026-09-20 11:00:00','2026-09-20 13:00:00'],
    ['2026-09-20 07:00:00','2026-09-20 13:00:00'],
    ['2026-09-20 09:00:00',null],
  ]){
    const result=await edit(start,{newClockOut:end,otherEntries:closed});
    assert.strictEqual(result.res.statusCode,409);
  }
  assert.strictEqual((await edit('2026-09-20 12:00:00',{
    newClockOut:'2026-09-20 13:00:00',otherEntries:closed,
  })).res.statusCode,200);
  assert.strictEqual((await edit('2026-09-20 09:00:00',{
    newClockOut:'2026-09-20 11:00:00',otherEntries:[{start:'2026-09-20 08:00:00',end:null}],
  })).res.statusCode,409);
  assert.strictEqual((await edit('2026-09-20 23:00:00',{
    newClockOut:'2026-09-21 01:00:00',
    otherEntries:[{start:'2026-09-20 23:30:00',end:'2026-09-21 00:30:00'}],
  })).res.statusCode,409);
  const racing=await edit('2026-09-20 09:00:00',{dbConflict:true});
  assert.strictEqual(racing.res.statusCode,409);
  assert(racing.queries.some(({q})=>q==='ROLLBACK'));
  console.log('supervisor period boundary tests: PASS');
})().catch(err=>{console.error(err);process.exitCode=1;});
