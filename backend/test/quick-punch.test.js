'use strict';
const assert=require('assert');
const {createQuickPunchRouter}=require('../routes/quick-punch');

function noop(req,res,next){if(next)next();}
function allow(){return noop;}
function makeRes(){return {statusCode:200,body:null,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}
function handlerFor(router,method,path){const layer=router.stack.find(x=>x.route&&x.route.path===path&&x.route.methods[method]);assert(layer,`${method.toUpperCase()} ${path} missing`);return layer.route.stack[layer.route.stack.length-1].handle;}

(async()=>{
  const queries=[];
  const pool={query:async(sql,args)=>{queries.push({sql,args});if(sql.startsWith('SELECT id, clock_in'))return {rows:[{id:1,clock_in:'2026-08-12T12:00:00Z',clock_out:null}]};if(sql.startsWith('SELECT id FROM time_entries'))return {rows:[{id:1}]};if(sql.startsWith('UPDATE time_entries'))return {rows:[]};throw new Error('unexpected query');}};
  const router=createQuickPunchRouter({requireUser:noop,requireAnyPermission:allow,pool,audit:async()=>{}});
  assert.deepStrictEqual(router.stack.filter(x=>x.route).map(x=>`${Object.keys(x.route.methods)[0]} ${x.route.path}`),['get /quick-status','post /clock-in','post /clock-out']);

  let res=makeRes();
  await handlerFor(router,'get','/quick-status')({user:{id:7}},res);
  assert.strictEqual(res.statusCode,200);
  assert.strictEqual(res.body.clocked_in,true);
  assert.strictEqual(res.body.next_action,'clock_out');

  res=makeRes();
  await handlerFor(router,'post','/clock-in')({user:{id:7,first_name:'Pat'}},res);
  assert.strictEqual(res.statusCode,400);
  assert.strictEqual(res.body.error,'You are already clocked in');

  res=makeRes();
  await handlerFor(router,'post','/clock-out')({user:{id:7,first_name:'Pat'}},res);
  assert.strictEqual(res.statusCode,400);
  assert.strictEqual(res.body.error,'You are not currently clocked in');
  console.log('quick-punch tests: PASS');
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
