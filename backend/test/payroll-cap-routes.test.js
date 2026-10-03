'use strict';

const assert = require('assert');
const { createPayrollRouter } = require('../routes/payroll');

const period = { pay_period_start: '2026-09-28', pay_period_end: '2026-10-11' };
const rows = ['2026-09-28', '2026-10-05'].map((work_date_iso, index) => ({
  employee_id: 7, employee_number: '007', first_name: 'Cap', last_name: 'History',
  weekly_hours_cap: 32, // The current cache must never govern this older period.
  time_entry_id: index + 1, work_date_iso, clock_in_raw: null, clock_out_raw: null,
  hours_worked: 36,
}));

function noop(_req, _res, next) { if (next) next(); }
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}

async function run(history) {
  const queries = [];
  const pool = { async query(sql, args = []) {
    const q = String(sql).replace(/\s+/g, ' ');
    queries.push(q);
    if (q.includes('FROM employees e')) return { rows };
    if (q.includes('FROM leave_entries')) return { rows: [] };
    if (q.includes('FROM forced_lunch_setting_history')) return { rows: [] };
    if (q.includes('FROM forced_lunch_waivers')) return { rows: [] };
    if (q.includes('FROM weekly_hours_cap_history')) return { rows: history
      .filter(row => row.effective_date_iso <= args[1])
      .map(row => ({ employee_id: 7, ...row })) };
    throw new Error(`Unexpected payroll query: ${q}`);
  } };
  const router = createPayrollRouter({ requireUser: noop, requireAnyPermission: () => noop,
    pool, audit: async () => {}, canAccessEmployee: async () => true,
    getRequestedPayPeriod: async () => period });
  for (const path of ['/payroll/export-current-period', '/payroll/print-timecards']) {
    const handler = router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle;
    const res = response();
    await handler({ user: { id: 2 }, query: {} }, res);
    assert.strictEqual(res.statusCode, 200, `${path}: ${JSON.stringify(res.body)}`);
    assert(queries.some(q => q.includes('FROM weekly_hours_cap_history')));
    assertSummary(path, res.body.timecard_summaries[7]);
  }
}

let expectedCap;
function assertSummary(path, summary) {
  assert.deepStrictEqual(summary.weekly_hours_caps, [expectedCap, expectedCap], path);
  assert.strictEqual(summary.weeks[0].total_paid_hours, Math.min(36, expectedCap), path);
  assert.strictEqual(summary.weeks[1].total_paid_hours, Math.min(36, expectedCap), path);
}

(async () => {
  expectedCap = 32;
  await run([{ effective_date_iso: '2026-09-28', weekly_hours_cap: 32 }]);
  expectedCap = 40;
  await run([
    { effective_date_iso: '2026-09-28', weekly_hours_cap: 40 },
    { effective_date_iso: '2026-10-12', weekly_hours_cap: 32 },
  ]);
  console.log('payroll cap route tests: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
