'use strict';

const assert = require('assert');
const { createQuickPunchRouter } = require('../routes/quick-punch');

function noop(req, res, next) { if (next) next(); }
function allow() { return noop; }
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
function handlerFor(router, method, path) {
  const layer = router.stack.find((x) => x.route && x.route.path === path && x.route.methods[method]);
  assert(layer, `${method.toUpperCase()} ${path} missing`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function compact(sql) { return String(sql).replace(/\s+/g, ' ').trim(); }

(async () => {
  const queries = [];
  const audits = [];
  let released = false;

  async function query(sql, args) {
    const text = compact(sql);
    queries.push({ text, args });
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    if (text.startsWith('SELECT id FROM employees WHERE id=$1 FOR UPDATE')) return { rows: [{id:7}] };
    if (text === 'SELECT clock_timestamp() AS punch_at') return { rows: [{punch_at:new Date('2026-08-20T12:00:00-04:00')}] };
    if (text === 'SELECT clock_timestamp() AS status_at') return { rows: [{status_at:new Date('2026-08-20T12:00:00-04:00')}] };
    if (text.includes('AS total_incomplete')) return { rows: [] };
    if (text.startsWith('SELECT id,clock_in,pending_clock_out')) {
      return { rows: [{ id: 1, clock_in: '2026-08-20T17:44:27Z', pending_clock_out: null }] };
    }
    if (text.includes('AS remaining_seconds') && text.includes('AS cooldown_until')) {
      return { rows: [{
        clock_in: '2026-08-20T17:42:00Z',
        clock_out: '2026-08-20T17:42:09Z',
        last_punch_at: '2026-08-20T17:42:09Z',
        remaining_seconds: 0,
        cooldown_until: '2026-08-20T17:47:09Z',
      }] };
    }
    if (text.startsWith('SELECT * FROM time_entries') && text.includes('FOR UPDATE')) return { rows: [{ id: 9, employee_id: 7, clock_in: '2026-08-20T17:44:27Z', clock_out: null, status: 'open' }] };
    if (text.includes('FROM pay_period_approvals')) return { rows: [] };
    if (text.startsWith('UPDATE time_entries SET deleted_at=NOW()')) return { rows: [{ id: 9 }] };
    if (text.startsWith('UPDATE time_change_requests SET status=')) return { rows: [{ id: 44 }] };
    if (text.startsWith('INSERT INTO time_entries(employee_id,clock_in,clock_out,status)')) return { rows: [{ id: 55, employee_id: 8, clock_in: args[1], clock_out: args[2], status: args[2] ? 'closed' : 'open' }] };
    if (text.startsWith('UPDATE time_entries SET clock_out=NOW()')) return { rows: [] };
    throw new Error(`unexpected query: ${text}`);
  }

  const client = { query, release() { released = true; } };
  const pool = { query, connect: async () => client };
  const router = createQuickPunchRouter({ requireUser: noop, requireAnyPermission: allow, pool, audit: async (...args) => audits.push(args) });

  assert.deepStrictEqual(
    router.stack.filter((x) => x.route).map((x) => `${Object.keys(x.route.methods)[0]} ${x.route.path}`),
    ['get /quick-status','get /my-punches','post /delete-punch','post /clock-in','post /clock-out'],
  );

  let res = makeRes();
  await handlerFor(router, 'get', '/quick-status')({ user: { id: 7 } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.clocked_in, true);
  assert.strictEqual(res.body.next_action, 'clock_out');
  assert.strictEqual(res.body.current_entry_id, 1);
  assert.strictEqual(res.body.current_clock_in, '2026-08-20T17:44:27Z');
  assert.strictEqual(res.body.requires_correction, false);
  assert.deepStrictEqual(res.body.historical_incomplete_entries, []);
  assert.strictEqual(res.body.timecard_locked, false);
  assert.strictEqual(res.body.last_punch_type, 'clock_out');
  assert.strictEqual(res.body.last_punch_at, '2026-08-20T17:42:09Z');
  assert.strictEqual(res.body.punch_cooldown_active, false);
  assert.strictEqual(res.body.punch_cooldown_seconds, 300);
  assert.strictEqual(res.body.punch_cooldown_seconds_remaining, 0);

  res = makeRes();
  await handlerFor(router, 'post', '/delete-punch')({ user: { id: 7, permissions: ['void_own_unapproved_punch'] }, body: { time_entry_id: 9, reason: 'Accidental punch' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.body.message, /audit trail/i);
  assert.strictEqual(audits.length, 1);
  assert.strictEqual(audits[0][1], 'void_time_entry');
  assert.strictEqual(audits[0][3], 9);
  assert.strictEqual(audits[0][4].reason, 'Accidental punch');
  assert.deepStrictEqual(audits[0][4].cancelled_change_request_ids, [44]);
  assert(released, 'delete transaction client should be released');
  assert(queries.some((item) => item.text === 'BEGIN'));
  assert(queries.some((item) => item.text === 'COMMIT'));
  assert(queries.some((item) => item.text.includes('FOR UPDATE')));

  // Clicking a visible clock-out punch must clear only clock_out, not soft-delete the paired clock-in.
  {
    const outQueries = [];
    const outAudits = [];
    async function outQuery(sql, args) {
      const text = compact(sql);
      outQueries.push({ text, args });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.startsWith('SELECT * FROM time_entries') && text.includes('FOR UPDATE')) {
        return { rows: [{ id: 19, employee_id: 7, clock_in: '2026-09-23T08:44:00-04:00', clock_out: '2026-09-23T11:45:00-04:00', status: 'closed' }] };
      }
      if (text.includes('FROM pay_period_approvals')) return { rows: [] };
      if (text.startsWith('UPDATE time_entries SET clock_out=NULL')) return { rows: [{ id: 19 }] };
      if (text.startsWith('UPDATE time_change_requests SET status=')) return { rows: [] };
      throw new Error(`unexpected clock-out void query: ${text}`);
    }
    const outClient = { query: outQuery, release() {} };
    const outPool = { query: outQuery, connect: async () => outClient };
    const outRouter = createQuickPunchRouter({ requireUser: noop, requireAnyPermission: allow, pool: outPool, audit: async (...args) => outAudits.push(args) });
    const outRes = makeRes();
    await handlerFor(outRouter, 'post', '/delete-punch')({
      user: { id: 7, permissions: ['void_own_unapproved_punch'] },
      body: { time_entry_id: 19, punch_kind: 'out', reason: 'Wrong clock out' },
    }, outRes);
    assert.strictEqual(outRes.statusCode, 200);
    assert.match(outRes.body.message, /clock-in remains open/i);
    assert(outQueries.some((item) => item.text.startsWith('UPDATE time_entries SET clock_out=NULL')));
    assert(!outQueries.some((item) => item.text.includes('SET deleted_at=NOW()')));
    assert.strictEqual(outAudits[0][4].punch_kind, 'out');
    assert.strictEqual(outAudits[0][4].soft_delete, false);
  }

  res = makeRes();
  await handlerFor(router, 'post', '/clock-in')({ user: { id: 7, first_name: 'Pat' } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'You are already clocked in');

  res = makeRes();
  await handlerFor(router, 'post', '/clock-out')({ user: { id: 7, first_name: 'Pat' }, headers: { 'cf-connecting-ip': '64.139.245.9' }, body: { location_status: 'denied' } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'You are not currently clocked in');
  const clockOutSql = queries.find((item) => item.text.startsWith('UPDATE time_entries SET clock_out=NOW()'))?.text || '';
  assert.match(clockOutSql, /AND clock_out IS NULL AND pending_clock_out IS NULL/);
  assert.match(clockOutSql, /clock_in::date=\(NOW\(\) AT TIME ZONE 'America\/New_York'\)::date RETURNING \*/);

  const lockedQueries = [];
  const lockedPool = {
    query: async (sql) => {
      const text = compact(sql);
      lockedQueries.push(text);
      if (text === 'SELECT clock_timestamp() AS status_at') return { rows: [{status_at:new Date('2026-08-21T09:00:00-04:00')}] };
      if (text.includes('FROM pay_period_approvals')) {
        return { rows: [{ id: 12, status: 'employee_submitted', employee_signed_at: '2026-08-21T09:00:00-04:00', supervisor_approved_at: null, payroll_finalized_at: null }] };
      }
      if (text.includes('AS total_incomplete')) return { rows: [] };
      if (text.startsWith('SELECT id,clock_in,pending_clock_out')) return { rows: [] };
      if (text.includes('AS remaining_seconds') && text.includes('AS cooldown_until')) return { rows: [{
        clock_in: '2026-08-21T08:00:00-04:00',
        clock_out: '2026-08-21T08:30:00-04:00',
        last_punch_at: '2026-08-21T08:30:00-04:00',
        remaining_seconds: 0,
        cooldown_until: '2026-08-21T08:35:00-04:00',
      }] };
      throw new Error(`unexpected locked query: ${text}`);
    },
    connect: async () => { throw new Error('connect not expected'); },
  };
  const lockedRouter = createQuickPunchRouter({ requireUser: noop, requireAnyPermission: allow, pool: lockedPool, audit: async () => {} });

  res = makeRes();
  await handlerFor(lockedRouter, 'get', '/quick-status')({ user: { id: 7 } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.timecard_locked, true);
  assert.strictEqual(res.body.timecard_status, 'employee_submitted');
  assert.strictEqual(res.body.employee_signed_at, '2026-08-21T09:00:00-04:00');

  res = makeRes();
  await handlerFor(lockedRouter, 'post', '/clock-in')({ user: { id: 7, first_name: 'Pat' } }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, 'TIMECARD_LOCKED');

  res = makeRes();
  await handlerFor(lockedRouter, 'post', '/clock-out')({ user: { id: 7, first_name: 'Pat' } }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, 'TIMECARD_LOCKED');
  assert(!lockedQueries.some((text) => text.startsWith('INSERT INTO time_entries')), 'locked card must not create a punch');
  assert(!lockedQueries.some((text) => text.startsWith('UPDATE time_entries SET clock_out=NOW()')), 'locked card must not close a punch');

  const stalePool = {
    query: async (sql) => {
      const text = compact(sql);
      if (text.includes('FROM pay_period_approvals')) return { rows: [] };
      if (text.startsWith('SELECT id,clock_in,pending_clock_out')) return { rows: [{ id: 77, clock_in: '2026-08-19T12:00:00Z', pending_clock_out: '2026-08-19T17:00:00Z' }] };
      if (text.startsWith('SELECT clock_in,clock_out FROM time_entries')) return { rows: [] };
      throw new Error(`unexpected stale query: ${text}`);
    },
    connect: async () => { throw new Error('connect not expected'); },
  };
  const staleRouter = createQuickPunchRouter({ requireUser: noop, requireAnyPermission: allow, pool: stalePool, audit: async () => {} });
  res = makeRes();
  await handlerFor(staleRouter, 'post', '/clock-out')({ user: { id: 7, first_name: 'Pat' } }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, 'PENDING_CORRECTION');
  assert.strictEqual(res.body.time_entry_id, 77);

  const cooldownQueries = [];
  const cooldownPool = {
    query: async (sql) => {
      const text = compact(sql);
      cooldownQueries.push(text);
      if (text === 'SELECT clock_timestamp() AS status_at') return { rows: [{status_at:new Date('2026-09-22T09:00:00-04:00')}] };
      if (text.includes('FROM pay_period_approvals')) return { rows: [] };
      if (text.includes('AS total_incomplete')) return { rows: [] };
      if (text.startsWith('SELECT id,clock_in,pending_clock_out')) {
        return { rows: [{ id: 88, clock_in: '2026-09-22T12:00:00Z', pending_clock_out: null }] };
      }
      if (text.includes('AS remaining_seconds') && text.includes('AS cooldown_until')) {
        return { rows: [{
          clock_in: '2026-09-22T12:00:00Z',
          clock_out: null,
          last_punch_at: '2026-09-22T12:00:00Z',
          remaining_seconds: 287,
          cooldown_until: '2026-09-22T12:05:00Z',
        }] };
      }
      if (text.startsWith('UPDATE time_entries SET clock_out=NOW()')) {
        throw new Error('cooldown must block clock-out update');
      }
      throw new Error(`unexpected cooldown query: ${text}`);
    },
    connect: async () => { throw new Error('connect not expected'); },
  };
  const cooldownRouter = createQuickPunchRouter({ requireUser: noop, requireAnyPermission: allow, pool: cooldownPool, audit: async () => {} });

  res = makeRes();
  await handlerFor(cooldownRouter, 'get', '/quick-status')({ user: { id: 7 } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.punch_cooldown_active, true);
  assert.strictEqual(res.body.punch_cooldown_seconds_remaining, 287);
  assert.strictEqual(res.body.punch_cooldown_seconds, 300);

  res = makeRes();
  await handlerFor(cooldownRouter, 'post', '/clock-out')({ user: { id: 7, first_name: 'Pat' } }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, 'PUNCH_COOLDOWN');
  assert.strictEqual(res.body.cooldown_seconds_remaining, 287);
  assert.match(res.body.error, /wait/i);
  assert(!cooldownQueries.some((text) => text.startsWith('UPDATE time_entries SET clock_out=NOW()')));

  // The same cooldown applies in the other direction: a recent clock-out
  // prevents an immediate new clock-in.
  const clockInCooldownPool = {
    query: async (sql) => {
      const text = compact(sql);
      if (text.includes('FROM pay_period_approvals')) return { rows: [] };
      if (text.startsWith('SELECT id,clock_in,pending_clock_out')) return { rows: [] };
      if (text.includes('AS remaining_seconds') && text.includes('AS cooldown_until')) {
        return { rows: [{
          clock_in: '2026-09-22T12:00:00Z',
          clock_out: '2026-09-22T13:00:00Z',
          last_punch_at: '2026-09-22T13:00:00Z',
          remaining_seconds: 121,
          cooldown_until: '2026-09-22T13:05:00Z',
        }] };
      }
      if (text.startsWith('INSERT INTO time_entries')) throw new Error('cooldown must block clock-in insert');
      throw new Error(`unexpected clock-in cooldown query: ${text}`);
    },
    connect: async () => { throw new Error('connect not expected'); },
  };
  const clockInCooldownRouter = createQuickPunchRouter({ requireUser: noop, requireAnyPermission: allow, pool: clockInCooldownPool, audit: async () => {} });
  res = makeRes();
  await handlerFor(clockInCooldownRouter, 'post', '/clock-in')({ user: { id: 7, first_name: 'Pat' } }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, 'PUNCH_COOLDOWN');
  assert.strictEqual(res.body.cooldown_seconds_remaining, 121);

  // Off-network punches must provide a valid captured GPS location before mutation.
  {
    const gpsQueries = [];
    const gpsAudits = [];
    const gpsPool = {
      query: async (sql) => {
        const text = compact(sql);
        gpsQueries.push(text);
        if (text.includes('FROM pay_period_approvals')) return { rows: [] };
        if (text.startsWith('SELECT id,clock_in,pending_clock_out')) return { rows: [] };
        if (text.includes('AS remaining_seconds') && text.includes('AS cooldown_until')) return { rows: [] };
        if (text.startsWith('INSERT INTO time_entries')) throw new Error('GPS gate must block insert');
        throw new Error(`unexpected GPS gate query: ${text}`);
      },
      connect: async () => { throw new Error('connect not expected'); },
    };
    const gpsRouter = createQuickPunchRouter({ requireUser: noop, requireAnyPermission: allow, pool: gpsPool, audit: async (...args) => gpsAudits.push(args) });
    const gpsRes = makeRes();
    await handlerFor(gpsRouter, 'post', '/clock-in')({
      user: { id: 7, first_name: 'Pat' },
      headers: { 'cf-connecting-ip': '192.0.2.25' },
      body: { location_status: 'denied', client_source: 'mobile_pwa' },
    }, gpsRes);
    assert.strictEqual(gpsRes.statusCode, 403);
    assert.strictEqual(gpsRes.body.code, 'GPS_REQUIRED');
    assert(!gpsQueries.some((text) => text.startsWith('INSERT INTO time_entries')));
    assert.strictEqual(gpsAudits[0][1], 'punch_rejected_gps_required');
  }

  const duplicateError = Object.assign(new Error('duplicate open punch'), { code: '23505' });
  const racePool = {
    query: async (sql) => {
      const text = compact(sql);
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
      if (text.startsWith('SELECT id FROM employees WHERE id=$1 FOR UPDATE')) return { rows: [{id:7}] };
      if (text === 'SELECT clock_timestamp() AS punch_at') return { rows: [{punch_at:new Date('2026-09-22T09:00:00-04:00')}] };
      if (text.includes('FROM pay_period_approvals')) return { rows: [] };
      if (text.startsWith('SELECT id,clock_in,pending_clock_out')) return { rows: [] };
      if (text.includes('AS remaining_seconds') && text.includes('AS cooldown_until')) return { rows: [] };
      if (text.startsWith('INSERT INTO time_entries(employee_id,clock_in,status)')) throw duplicateError;
      throw new Error(`unexpected race query: ${text}`);
    },
    connect: async () => ({query:racePool.query,release(){}}),
  };
  const raceRouter = createQuickPunchRouter({ requireUser: noop, requireAnyPermission: allow, pool: racePool, audit: async () => {} });
  res = makeRes();
  await handlerFor(raceRouter, 'post', '/clock-in')({ user: { id: 7, first_name: 'Pat' }, headers: { 'cf-connecting-ip': '64.139.245.9' }, body: { location_status: 'denied' } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'You are already clocked in');

  // Signing can finish while GPS is being collected. The employee lock and
  // second approval check must reject that clock-in before any insert.
  {
    const order=[];
    let approvalReads=0;
    const signingPool={
      async query(sql){
        const text=compact(sql);order.push(text);
        if(['BEGIN','ROLLBACK'].includes(text))return {rows:[]};
        if(text.startsWith('SELECT id FROM employees WHERE id=$1 FOR UPDATE'))return {rows:[{id:7}]};
        if(text==='SELECT clock_timestamp() AS punch_at')return {rows:[{punch_at:new Date('2026-10-18T09:00:00-04:00')}]};
        if(text.includes('FROM pay_period_approvals')){
          approvalReads++;
          return {rows:approvalReads===1?[]:[{id:12,status:'employee_submitted',employee_signed_at:'2026-10-18T09:00:00-04:00'}]};
        }
        if(text.startsWith('SELECT id,clock_in,pending_clock_out'))return {rows:[]};
        if(text.includes('AS remaining_seconds'))return {rows:[]};
        if(text.startsWith('SELECT value FROM settings'))return {rows:[]};
        if(text.startsWith('INSERT INTO time_entries'))throw new Error('signed timecard must block insert');
        throw new Error('unexpected signed-race query: '+text);
      },
      async connect(){return {query:signingPool.query,release(){}};},
    };
    const signingRouter=createQuickPunchRouter({requireUser:noop,requireAnyPermission:allow,
      pool:signingPool,audit:async()=>{}});
    res=makeRes();
    await handlerFor(signingRouter,'post','/clock-in')({
      user:{id:7,first_name:'Pat'},headers:{'cf-connecting-ip':'64.139.245.9'},
      body:{location_status:'denied'},
    },res);
    assert.strictEqual(res.statusCode,409);
    assert.strictEqual(res.body.code,'TIMECARD_LOCKED');
    assert.strictEqual(approvalReads,2);
    assert(order.some(text=>text.startsWith('SELECT id FROM employees WHERE id=$1 FOR UPDATE')));
    assert(!order.some(text=>text.startsWith('INSERT INTO time_entries')));
  }

  const conflictClient={
    async query(sql){
      const text=compact(sql);
      if(text==='BEGIN'||text==='ROLLBACK')return {rows:[]};
      if(text.startsWith('SELECT * FROM time_entries'))return {rows:[{
        id:35,employee_id:7,clock_in:'2026-10-18T08:00:00-04:00',
        clock_out:'2026-10-18T12:00:00-04:00',status:'closed',
      }]};
      if(text.includes('FROM pay_period_approvals'))return {rows:[]};
      if(text.startsWith('UPDATE time_entries SET clock_out=NULL')){
        throw Object.assign(new Error('duplicate open day'),{code:'23505'});
      }
      throw new Error('unexpected void query: '+text);
    },release(){},
  };
  const conflictRouter=createQuickPunchRouter({requireUser:noop,requireAnyPermission:allow,
    pool:{connect:async()=>conflictClient},audit:async()=>{}});
  res=makeRes();
  await handlerFor(conflictRouter,'post','/delete-punch')({
    user:{id:7,permissions:['void_own_unapproved_punch']},
    body:{time_entry_id:35,punch_kind:'out',reason:'Accidental punch'},
  },res);
  assert.strictEqual(res.statusCode,409);
  assert.match(res.body.error,/second open entry/);

  // Two older missing days remain visible, while today's state alone permits
  // a new in/out pair. The database query itself enforces the Eastern date.
  {
    const dayQueries=[];
    let todayOpen=null;
    const historical=[
      {id:71,clock_in:'2026-10-17T08:00:00-04:00',pending_clock_out:null,total_incomplete:2},
      {id:70,clock_in:'2026-10-16T08:00:00-04:00',pending_clock_out:'2026-10-16T16:00:00-04:00',total_incomplete:2},
    ];
    const dayPool={
      async query(sql,args=[]){
        const text=compact(sql);dayQueries.push({text,args});
        if(['BEGIN','COMMIT','ROLLBACK'].includes(text))return {rows:[]};
        if(text.startsWith('SELECT id FROM employees WHERE id=$1 FOR UPDATE'))return {rows:[{id:7}]};
        if(text==='SELECT clock_timestamp() AS punch_at')return {rows:[{punch_at:new Date('2026-10-18T00:01:00-04:00')}]};
        if(text==='SELECT clock_timestamp() AS status_at')return {rows:[{status_at:new Date('2026-10-18T00:01:00-04:00')}]};
        if(text.includes('FROM pay_period_approvals'))return {rows:[]};
        if(text.includes('AS total_incomplete')){
          assert.match(text,/clock_in::date<\(\$2::timestamptz AT TIME ZONE 'America\/New_York'\)::date/);
          return {rows:historical};
        }
        if(text.startsWith('SELECT id,clock_in,pending_clock_out')){
          assert.match(text,/clock_in::date=(?:\(NOW\(\)|\(\$2::timestamptz) AT TIME ZONE 'America\/New_York'\)::date/);
          return {rows:todayOpen?[todayOpen]:[]};
        }
        if(text.includes('AS remaining_seconds')){
          assert.match(text,/CASE WHEN clock_in::date=\(COALESCE\(\$3::timestamptz,statement_timestamp\(\)\) AT TIME ZONE 'America\/New_York'\)::date/);
          return {rows:[{
            clock_in:'2026-10-17T23:59:00-04:00',clock_out:null,
            last_punch_at:'2026-10-17T23:59:00-04:00',remaining_seconds:0,
          }]};
        }
        if(text.startsWith('SELECT value FROM settings'))return {rows:[]};
        if(text.startsWith('INSERT INTO time_entries(employee_id,clock_in,status)')){
          todayOpen={id:90,clock_in:'2026-10-18T00:01:00-04:00',pending_clock_out:null};
          return {rows:[{...todayOpen,employee_id:7,clock_out:null}]};
        }
        if(text.startsWith('UPDATE time_entries SET clock_out=NOW()')){
          assert.strictEqual(args[0],90,'clock-out must select today, not a historical open row');
          assert.match(text,/clock_in::date=\(NOW\(\) AT TIME ZONE 'America\/New_York'\)::date/);
          todayOpen=null;
          return {rows:[{id:90,employee_id:7,clock_in:'2026-10-18T00:01:00-04:00',clock_out:'2026-10-18T00:10:00-04:00'}]};
        }
        if(text.startsWith('INSERT INTO time_punch_metadata'))return {rows:[]};
        throw new Error('unexpected calendar-day query: '+text);
      },
      async connect(){return {query:dayPool.query,release(){}};},
    };
    const dayRouter=createQuickPunchRouter({requireUser:noop,requireAnyPermission:allow,pool:dayPool,audit:async()=>{}});
    const request={user:{id:7,first_name:'Pat'},headers:{'cf-connecting-ip':'192.0.2.25'},
      body:{location_status:'captured',latitude:33.92,longitude:-80.94,client_source:'mobile_pwa'}};
    res=makeRes();
    await handlerFor(dayRouter,'get','/quick-status')(request,res);
    assert.strictEqual(res.statusCode,200);
    assert.strictEqual(res.body.clocked_in,false);
    assert.strictEqual(res.body.next_action,'clock_in');
    assert.strictEqual(res.body.historical_incomplete_count,2);
    assert.deepStrictEqual(res.body.historical_incomplete_entries.map(row=>row.id),[71,70]);
    const statusReads=dayQueries.filter(({text})=>text.includes('AS total_incomplete')
      ||text.startsWith('SELECT id,clock_in,pending_clock_out'));
    assert(statusReads.every(({args})=>args[1] instanceof Date
      &&args[1].toISOString()==='2026-10-18T04:01:00.000Z'),
    'today and historical reads must share one captured Eastern date');
    assert.strictEqual(res.body.punch_cooldown_seconds_remaining,0,
      "a prior-day punch must not impose today's cooldown");
    res=makeRes();
    await handlerFor(dayRouter,'post','/clock-in')(request,res);
    assert.strictEqual(res.statusCode,200);
    const inserted=dayQueries.find(({text})=>text.startsWith('INSERT INTO time_entries(employee_id,clock_in,status)'));
    assert.match(inserted.text,/VALUES\(\$1,\$2::timestamptz,'open'\)/);
    assert.strictEqual(inserted.args[1].toISOString(),'2026-10-18T04:01:00.000Z');
    assert(dayQueries.some(({text,args})=>text.includes('FROM pay_period_approvals')
      &&args[1] instanceof Date&&args[1].toISOString()===inserted.args[1].toISOString()),
    'the final lock check must use the captured post-lock punch instant');
    res=makeRes();
    await handlerFor(dayRouter,'get','/quick-status')(request,res);
    assert.strictEqual(res.body.clocked_in,true);
    assert.strictEqual(res.body.current_entry_id,90);
    res=makeRes();
    await handlerFor(dayRouter,'post','/clock-out')(request,res);
    assert.strictEqual(res.statusCode,200);
    assert.strictEqual(historical.length,2,'older incomplete punches remain untouched');
    assert(dayQueries.some(({text})=>text.startsWith('INSERT INTO time_punch_metadata')),
      'GPS/IP metadata capture remains active for the new punch');
    todayOpen={id:91,clock_in:'2026-10-18T00:20:00-04:00',
      pending_clock_out:'2026-10-18T00:30:00-04:00'};
    res=makeRes();
    await handlerFor(dayRouter,'get','/quick-status')(request,res);
    assert.strictEqual(res.body.clocked_in,true);
    assert.strictEqual(res.body.next_action,null);
    assert.strictEqual(res.body.today_pending_correction,true);
    res=makeRes();
    await handlerFor(dayRouter,'post','/clock-in')(request,res);
    assert.strictEqual(res.statusCode,409);
    assert.strictEqual(res.body.code,'PENDING_CORRECTION');
  }

  console.log('quick-punch tests: PASS');
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
