'use strict';

const assert = require('assert');
const { createEmployeeRouter } = require('../routes/employee');

function noop(req, res, next) { if (next) next(); }
function allow() { return noop; }
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}
function handlerFor(router, method, path) {
  const layer = router.stack.find((x) => x.route && x.route.path === path && x.route.methods[method]);
  assert(layer, `${method.toUpperCase()} ${path} missing`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

(async () => {
  const period = { pay_period_start: '2026-08-03', pay_period_end: '2026-08-16' };
  const auditCalls = [];
  const router = createEmployeeRouter({
    requireUser: noop,
    requireAnyPermission: allow,
    getRequestedPayPeriod: async () => period,
    audit: async (...args) => auditCalls.push(args),
    pool: { query: async () => { throw new Error('unexpected query'); } },
  });

  assert.deepStrictEqual(
    router.stack.filter((x) => x.route).map((x) => `${Object.keys(x.route.methods)[0]} ${x.route.path}`),
    [
      'post /submit-timecard',
      'get /employee/my-timecard',
      'post /employee/edit-time-entry',
      'post /employee/request-time-change',
    ],
  );

  let res = makeRes();
  await handlerFor(router, 'post', '/employee/edit-time-entry')(
    { user: { id: 7 }, body: { time_entry_id: 1, new_clock_in: '', new_clock_out: '', reason: '' } },
    res,
  );
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'Time entry, clock in, and reason are required');

  res = makeRes();
  await handlerFor(router, 'post', '/employee/request-time-change')(
    { user: { id: 7 }, body: { time_entry_id: 1, employee_reason: 'fix' } },
    res,
  );
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'Select a clock in time, clock out time, or both');

  const otherEmployeeRouter = createEmployeeRouter({
    requireUser: noop,
    requireAnyPermission: allow,
    getRequestedPayPeriod: async () => period,
    audit: async () => {},
    pool: { query: async () => ({ rows: [{ id: 1, employee_id: 99, clock_in: '2026-08-12T08:00:00Z' }] }) },
  });
  res = makeRes();
  await handlerFor(otherEmployeeRouter, 'post', '/employee/request-time-change')(
    { user: { id: 7 }, body: { time_entry_id: 1, requested_clock_out: '2026-08-12T17:00:00Z', employee_reason: 'fix' } },
    res,
  );
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error, 'Cannot modify another employee');

  const signedRouter = createEmployeeRouter({
    requireUser: noop,
    requireAnyPermission: allow,
    getRequestedPayPeriod: async () => period,
    audit: async () => {},
    pool: {
      query: async (sql) => {
        if (sql.startsWith('SELECT id FROM time_entries')) return { rows: [] };
        if (sql.startsWith('SELECT * FROM pay_period_approvals')) {
          return { rows: [{ id: 4, employee_signed_at: '2026-08-12T18:00:00Z', status: 'employee_submitted' }] };
        }
        throw new Error('unexpected query');
      },
    },
  });
  res = makeRes();
  await handlerFor(signedRouter, 'post', '/submit-timecard')({ user: { id: 7 }, body: {}, query: {} }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.error, /already signed/i);

  const openPunchRouter = createEmployeeRouter({
    requireUser: noop,
    requireAnyPermission: allow,
    getRequestedPayPeriod: async () => period,
    audit: async () => {},
    pool: { query: async (sql) => sql.startsWith('SELECT id FROM time_entries') ? { rows: [{ id: 9 }] } : { rows: [] } },
  });
  res = makeRes();
  await handlerFor(openPunchRouter, 'post', '/submit-timecard')({ user: { id: 7 }, body: {}, query: {} }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'Clock out before submitting your timecard');

  console.log('employee route tests: PASS');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
