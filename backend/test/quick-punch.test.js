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
    if (text.startsWith('SELECT id,clock_in,') && text.includes('requires_correction')) {
      return { rows: [{ id: 1, clock_in: '2026-08-20T17:44:27Z', requires_correction: false }] };
    }
    if (text.startsWith('SELECT clock_in,clock_out FROM time_entries')) return { rows: [{ clock_in: '2026-08-20T17:42:00Z', clock_out: '2026-08-20T17:42:09Z' }] };
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
    ['get /quick-status','get /my-punches','post /delete-punch','post /supervisor/add-time-entry','post /clock-in','post /clock-out'],
  );

  let res = makeRes();
  await handlerFor(router, 'get', '/quick-status')({ user: { id: 7 } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.clocked_in, true);
  assert.strictEqual(res.body.next_action, 'clock_out');
  assert.strictEqual(res.body.current_entry_id, 1);
  assert.strictEqual(res.body.current_clock_in, '2026-08-20T17:44:27Z');
  assert.strictEqual(res.body.requires_correction, false);
  assert.strictEqual(res.body.timecard_locked, false);
  assert.strictEqual(res.body.last_punch_type, 'clock_out');
  assert.strictEqual(res.body.last_punch_at, '2026-08-20T17:42:09Z');

  res = makeRes();
  await handlerFor(router, 'post', '/delete-punch')({ user: { id: 7, permissions: [] }, body: { time_entry_id: 9, reason: 'Accidental punch' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.body.message, /audit trail/i);
  assert.strictEqual(audits.length, 1);
  assert.strictEqual(audits[0][1], 'delete_time_entry');
  assert.strictEqual(audits[0][3], 9);
  assert.strictEqual(audits[0][4].reason, 'Accidental punch');
  assert.deepStrictEqual(audits[0][4].cancelled_change_request_ids, [44]);
  assert(released, 'delete transaction client should be released');
  assert(queries.some((item) => item.text === 'BEGIN'));
  assert(queries.some((item) => item.text === 'COMMIT'));
  assert(queries.some((item) => item.text.includes('FOR UPDATE')));

  res = makeRes();
  await handlerFor(router, 'post', '/supervisor/add-time-entry')({ user: { id: 99, role: 'payroll', permissions: ['edit_payroll_time'] }, body: { employee_id: 8, clock_in: '2026-08-20 08:00:00', clock_out: '2026-08-20 17:00:00', reason: 'Approved correction' } }, res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.entry.id, 55);
  assert.strictEqual(audits.length, 2);
  assert.strictEqual(audits[1][1], 'payroll_add_time_entry');

  res = makeRes();
  await handlerFor(router, 'post', '/clock-in')({ user: { id: 7, first_name: 'Pat' } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'You are already clocked in');

  res = makeRes();
  await handlerFor(router, 'post', '/clock-out')({ user: { id: 7, first_name: 'Pat' } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'You are not currently clocked in');
  const clockOutSql = queries.find((item) => item.text.startsWith('UPDATE time_entries SET clock_out=NOW()'))?.text || '';
  assert.match(clockOutSql, /AND deleted_at IS NULL AND clock_out IS NULL RETURNING \*/);

  const lockedQueries = [];
  const lockedPool = {
    query: async (sql) => {
      const text = compact(sql);
      lockedQueries.push(text);
      if (text.includes('FROM pay_period_approvals')) {
        return { rows: [{ id: 12, status: 'employee_submitted', employee_signed_at: '2026-08-21T09:00:00-04:00', supervisor_approved_at: null, payroll_finalized_at: null }] };
      }
      if (text.startsWith('SELECT id,clock_in,') && text.includes('requires_correction')) return { rows: [] };
      if (text.startsWith('SELECT clock_in,clock_out FROM time_entries')) return { rows: [{ clock_in: '2026-08-21T08:00:00-04:00', clock_out: '2026-08-21T08:30:00-04:00' }] };
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
      if (text.startsWith('SELECT id,clock_in,') && text.includes('requires_correction')) return { rows: [{ id: 77, clock_in: '2026-08-19T12:00:00Z', requires_correction: true }] };
      if (text.startsWith('SELECT clock_in,clock_out FROM time_entries')) return { rows: [] };
      throw new Error(`unexpected stale query: ${text}`);
    },
    connect: async () => { throw new Error('connect not expected'); },
  };
  const staleRouter = createQuickPunchRouter({ requireUser: noop, requireAnyPermission: allow, pool: stalePool, audit: async () => {} });
  res = makeRes();
  await handlerFor(staleRouter, 'post', '/clock-out')({ user: { id: 7, first_name: 'Pat' } }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, 'STALE_OPEN_PUNCH');
  assert.strictEqual(res.body.time_entry_id, 77);

  const duplicateError = Object.assign(new Error('duplicate open punch'), { code: '23505' });
  const racePool = {
    query: async (sql) => {
      const text = compact(sql);
      if (text.includes('FROM pay_period_approvals')) return { rows: [] };
      if (text.startsWith('SELECT id,clock_in,') && text.includes('requires_correction')) return { rows: [] };
      if (text.startsWith('INSERT INTO time_entries(employee_id,clock_in,status)')) throw duplicateError;
      throw new Error(`unexpected race query: ${text}`);
    },
    connect: async () => { throw new Error('connect not expected'); },
  };
  const raceRouter = createQuickPunchRouter({ requireUser: noop, requireAnyPermission: allow, pool: racePool, audit: async () => {} });
  res = makeRes();
  await handlerFor(raceRouter, 'post', '/clock-in')({ user: { id: 7, first_name: 'Pat' } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'You are already clocked in');

  console.log('quick-punch tests: PASS');
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
