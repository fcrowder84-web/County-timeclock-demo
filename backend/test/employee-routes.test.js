'use strict';

const assert = require('assert');
const { createEmployeeRouter, validDate } = require('../routes/employee');

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
function compact(sql) { return String(sql).replace(/\s+/g, ' ').trim(); }

(async () => {
  const period = { pay_period_start: '2026-08-03', pay_period_end: '2026-08-16' };
  const auditCalls = [];

  assert(validDate('2026-08-12T08:00:00Z'));
  assert.strictEqual(validDate('not-a-date'), null);

  const basePool = {
    query: async () => { throw new Error('unexpected query'); },
    connect: async () => { throw new Error('unexpected connect'); },
  };
  const router = createEmployeeRouter({
    requireUser: noop,
    requireAnyPermission: allow,
    getRequestedPayPeriod: async () => period,
    audit: async (...args) => auditCalls.push(args),
    pool: basePool,
  });

  assert.deepStrictEqual(
    router.stack.filter((x) => x.route).map((x) => `${Object.keys(x.route.methods)[0]} ${x.route.path}`),
    [
      'post /submit-timecard',
      'get /employee/my-timecard',
      'post /employee/edit-time-entry',
      'post /employee/request-time-change',
      'post /supervisor/add-time-entry',
    ],
  );

  let res = makeRes();
  await handlerFor(router, 'post', '/employee/edit-time-entry')(
    { user: { id: 7 }, body: {} },
    res,
  );
  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.error, /supervisor approval/i);

  res = makeRes();
  await handlerFor(router, 'post', '/employee/request-time-change')(
    { user: { id: 7 }, body: { time_entry_id: 1, employee_reason: 'fix' } },
    res,
  );
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /punch date and time|clock in time/i);

  const otherEmployeeRouter = createEmployeeRouter({
    requireUser: noop,
    requireAnyPermission: allow,
    getRequestedPayPeriod: async () => period,
    audit: async () => {},
    pool: {
      connect: async () => { throw new Error('unexpected connect'); },
      query: async () => ({ rows: [{ id: 1, employee_id: 99, clock_in: '2026-08-12T08:00:00Z' }] }),
    },
  });
  res = makeRes();
  await handlerFor(otherEmployeeRouter, 'post', '/employee/request-time-change')(
    {
      user: { id: 7 },
      body: {
        time_entry_id: 1,
        requested_clock_out: '2026-08-12T17:00:00Z',
        employee_reason: 'fix',
      },
    },
    res,
  );
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error, 'Cannot modify another employee');

  const invalidPairRouter = createEmployeeRouter({
    requireUser: noop,
    requireAnyPermission: allow,
    getRequestedPayPeriod: async () => period,
    audit: async () => {},
    pool: {
      connect: async () => { throw new Error('unexpected connect'); },
      query: async () => ({
        rows: [{
          id: 1,
          employee_id: 7,
          clock_in: '2026-08-12T08:00:00Z',
          clock_out: '2026-08-12T17:00:00Z',
        }],
      }),
    },
  });
  res = makeRes();
  await handlerFor(invalidPairRouter, 'post', '/employee/request-time-change')(
    {
      user: { id: 7 },
      body: {
        time_entry_id: 1,
        requested_clock_in: '2026-08-12T19:45:00Z',
        employee_reason: 'wrong AM/PM',
      },
    },
    res,
  );
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /Clock out must be after clock in/);

  // A first single punch on an otherwise empty date is stored immediately as
  // a pending, incomplete request so the employee can see that it was received.
  const singleQueries = [];
  const singleAudit = [];
  const singlePunchRouter = createEmployeeRouter({
    requireUser: noop,
    requireAnyPermission: allow,
    getRequestedPayPeriod: async () => period,
    audit: async (...args) => singleAudit.push(args),
    pool: {
      connect: async () => { throw new Error('unexpected connect'); },
      query: async (sql) => {
        const text = compact(sql);
        singleQueries.push(text);
        if (text.includes('FROM pay_period_approvals')) return { rows: [] };
        if (text.includes('FROM time_entries') && text.includes('clock_out IS NULL')) return { rows: [] };
        if (text.includes('FROM time_change_requests') && text.includes('requested_clock_out IS NULL')) return { rows: [] };
        if (text.includes('FROM time_change_requests') && text.includes('IS NOT DISTINCT FROM')) return { rows: [] };
        if (text.startsWith('INSERT INTO time_change_requests')) return { rows: [{ id: 42 }] };
        throw new Error(`unexpected single punch query: ${text}`);
      },
    },
  });
  res = makeRes();
  await handlerFor(singlePunchRouter, 'post', '/employee/request-time-change')(
    {
      user: { id: 7 },
      body: {
        requested_punch: '2026-08-12T08:00:00Z',
        employee_reason: 'Forgot to clock in',
      },
    },
    res,
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.request_id, 42);
  assert.strictEqual(res.body.paired, false);
  assert.match(res.body.message, /saved|matching punch/i);
  assert(singleQueries.some((sql) => sql.startsWith('INSERT INTO time_change_requests')));
  assert(singleAudit.some((call) => call[1] === 'request_single_punch'));

  // A second single punch on the same date completes the existing pending
  // request instead of creating a second unrelated approval item.
  const pairAudit = [];
  const pairPunchRouter = createEmployeeRouter({
    requireUser: noop,
    requireAnyPermission: allow,
    getRequestedPayPeriod: async () => period,
    audit: async (...args) => pairAudit.push(args),
    pool: {
      connect: async () => { throw new Error('unexpected connect'); },
      query: async (sql) => {
        const text = compact(sql);
        if (text.includes('FROM pay_period_approvals')) return { rows: [] };
        if (text.includes('FROM time_entries') && text.includes('clock_out IS NULL')) return { rows: [] };
        if (text.includes('FROM time_change_requests') && text.includes('requested_clock_out IS NULL')) {
          return { rows: [{ id: 9, requested_clock_in: '2026-08-12T08:00:00Z', employee_reason: 'Forgot first punch' }] };
        }
        if (text.startsWith('UPDATE time_change_requests')) return { rows: [{ id: 9 }] };
        throw new Error(`unexpected paired punch query: ${text}`);
      },
    },
  });
  res = makeRes();
  await handlerFor(pairPunchRouter, 'post', '/employee/request-time-change')(
    {
      user: { id: 7 },
      body: {
        requested_punch: '2026-08-12T17:00:00Z',
        employee_reason: 'Forgot second punch',
      },
    },
    res,
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.request_id, 9);
  assert.strictEqual(res.body.paired, true);
  assert.match(res.body.message, /supervisor approval/i);
  assert(pairAudit.some((call) => call[1] === 'complete_missing_time_request'));

  async function makeSubmitRouter({ openRows = [], approvalRows = [] }) {
    const txQueries = [];
    const client = {
      async query(sql) {
        const text = compact(sql);
        txQueries.push(text);
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
        if (text.startsWith('SELECT id FROM time_entries')) return { rows: openRows };
        if (text.startsWith('SELECT * FROM pay_period_approvals')) return { rows: approvalRows };
        if (text.startsWith('UPDATE pay_period_approvals')) return { rows: [] };
        if (text.startsWith('INSERT INTO pay_period_approvals')) return { rows: [] };
        throw new Error(`unexpected submit query: ${text}`);
      },
      release() {},
    };
    const submitRouter = createEmployeeRouter({
      requireUser: noop,
      requireAnyPermission: allow,
      getRequestedPayPeriod: async () => period,
      audit: async () => {},
      pool: {
        query: async () => { throw new Error('pool query not expected'); },
        connect: async () => client,
      },
    });
    return { submitRouter, txQueries };
  }

  const signed = await makeSubmitRouter({
    approvalRows: [{ id: 4, employee_signed_at: '2026-08-12T18:00:00Z', status: 'employee_submitted' }],
  });
  res = makeRes();
  await handlerFor(signed.submitRouter, 'post', '/submit-timecard')(
    { user: { id: 7 }, body: {}, query: {} },
    res,
  );
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.error, /already signed/i);
  assert(signed.txQueries.some((sql) => sql.includes('deleted_at IS NULL')));
  assert(signed.txQueries.includes('ROLLBACK'));

  const openPunch = await makeSubmitRouter({ openRows: [{ id: 9 }] });
  res = makeRes();
  await handlerFor(openPunch.submitRouter, 'post', '/submit-timecard')(
    { user: { id: 7 }, body: {}, query: {} },
    res,
  );
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'Clock out before submitting your timecard');

  // The employee timecard query must always hide soft-deleted work intervals.
  const timecardQueries = [];
  const timecardRouter = createEmployeeRouter({
    requireUser: noop,
    requireAnyPermission: allow,
    getRequestedPayPeriod: async () => period,
    audit: async () => {},
    pool: {
      connect: async () => { throw new Error('unexpected connect'); },
      query: async (sql) => {
        const text = compact(sql);
        timecardQueries.push(text);
        if (text.includes('FROM pay_period_approvals')) return { rows: [] };
        if (text.includes('FROM time_entries')) return { rows: [] };
        if (text.includes('FROM leave_entries')) return { rows: [] };
        if (text.includes('FROM time_change_requests')) return { rows: [] };
        throw new Error(`unexpected timecard query: ${text}`);
      },
    },
  });
  res = makeRes();
  await handlerFor(timecardRouter, 'get', '/employee/my-timecard')(
    { user: { id: 7 }, body: {}, query: {} },
    res,
  );
  assert.strictEqual(res.statusCode, 200);
  const timeEntryRead = timecardQueries.find((sql) => sql.includes('FROM time_entries')) || '';
  assert.match(timeEntryRead, /deleted_at IS NULL/);

  console.log('employee route tests: PASS');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
