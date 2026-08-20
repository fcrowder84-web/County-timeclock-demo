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
    if (text.startsWith('SELECT id,clock_in FROM time_entries')) {
      return { rows: [{ id: 1, clock_in: '2026-08-20T17:44:27Z' }] };
    }
    if (text.startsWith('SELECT clock_in,clock_out FROM time_entries')) {
      return { rows: [{ clock_in: '2026-08-20T17:42:00Z', clock_out: '2026-08-20T17:42:09Z' }] };
    }
    if (text.startsWith('SELECT * FROM time_entries') && text.includes('FOR UPDATE')) {
      return { rows: [{ id: 9, employee_id: 7, clock_in: '2026-08-20T17:44:27Z', clock_out: null, status: 'open' }] };
    }
    if (text.includes('FROM pay_period_approvals')) return { rows: [] };
    if (text.startsWith('UPDATE time_entries SET deleted_at=NOW()')) return { rows: [{ id: 9 }] };
    if (text.startsWith('SELECT id FROM time_entries')) return { rows: [{ id: 1 }] };
    if (text.startsWith('UPDATE time_entries SET clock_out=NOW()')) return { rows: [] };

    throw new Error(`unexpected query: ${text}`);
  }

  const client = { query, release() { released = true; } };
  const pool = { query, connect: async () => client };

  const router = createQuickPunchRouter({
    requireUser: noop,
    requireAnyPermission: allow,
    pool,
    audit: async (...args) => audits.push(args),
  });

  assert.deepStrictEqual(
    router.stack.filter((x) => x.route).map((x) => `${Object.keys(x.route.methods)[0]} ${x.route.path}`),
    ['get /quick-status', 'get /my-punches', 'post /delete-punch', 'post /clock-in', 'post /clock-out'],
  );

  let res = makeRes();
  await handlerFor(router, 'get', '/quick-status')({ user: { id: 7 } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.clocked_in, true);
  assert.strictEqual(res.body.next_action, 'clock_out');
  assert.strictEqual(res.body.current_clock_in, '2026-08-20T17:44:27Z');
  assert.strictEqual(res.body.last_punch_type, 'clock_out');
  assert.strictEqual(res.body.last_punch_at, '2026-08-20T17:42:09Z');

  res = makeRes();
  await handlerFor(router, 'post', '/delete-punch')(
    { user: { id: 7, permissions: [] }, body: { time_entry_id: 9, reason: 'Accidental punch' } },
    res,
  );
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.body.message, /audit trail/i);
  assert.strictEqual(audits.length, 1);
  assert.strictEqual(audits[0][1], 'delete_time_entry');
  assert.strictEqual(audits[0][3], 9);
  assert.strictEqual(audits[0][4].reason, 'Accidental punch');
  assert(released, 'delete transaction client should be released');
  assert(queries.some((item) => item.text === 'BEGIN'));
  assert(queries.some((item) => item.text === 'COMMIT'));
  assert(queries.some((item) => item.text.includes('FOR UPDATE')));

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

  // A simultaneous second clock-in should be handled as a normal user-state
  // conflict when the database unique index wins the race.
  const duplicateError = Object.assign(new Error('duplicate open punch'), { code: '23505' });
  const racePool = {
    query: async (sql) => {
      const text = compact(sql);
      if (text.startsWith('SELECT id FROM time_entries')) return { rows: [] };
      if (text.startsWith('INSERT INTO time_entries')) throw duplicateError;
      throw new Error(`unexpected race query: ${text}`);
    },
    connect: async () => { throw new Error('connect not expected'); },
  };
  const raceRouter = createQuickPunchRouter({
    requireUser: noop,
    requireAnyPermission: allow,
    pool: racePool,
    audit: async () => {},
  });
  res = makeRes();
  await handlerFor(raceRouter, 'post', '/clock-in')({ user: { id: 7, first_name: 'Pat' } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'You are already clocked in');

  console.log('quick-punch tests: PASS');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
