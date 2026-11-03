'use strict';

const assert = require('assert');
const { createPayrollRouter } = require('../routes/payroll');

const period = { pay_period_start: '2026-10-05', pay_period_end: '2026-10-18' };
const entries = Array.from({ length: 5 }, (_, day) => ({
  clock_in: `2026-10-${String(day + 5).padStart(2, '0')} 08:00:00`,
  clock_out: `2026-10-${String(day + 5).padStart(2, '0')} 16:00:00`,
}));
function noop(_req, _res, next) { if (next) next(); }

async function finalize({ extra = 5, pendingPunch = 0, allowed = true, reason = 'Employee unavailable', supervisorId = 9 } = {}) {
  const queries = [];
  let locked = false;
  const client = {
    async query(sql, args) {
      const q = String(sql).replace(/\s+/g, ' ');
      queries.push({ q, args });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [] };
      if (q.includes('FROM employees e')) return { rows: [{ id: 2, first_name: 'Case', last_name: 'Worker' }] };
      if (q.includes('FROM employees WHERE id=ANY($1::int[])')) {
        assert.deepStrictEqual(args[0], [2]);
        assert(q.includes('ORDER BY id FOR UPDATE'));
        locked = true;
        return { rows: [{ id: 2 }] };
      }
      if (q.includes('FROM pay_period_approvals')) {
        assert(locked, 'employee lock must precede approval validation');
        assert(q.includes('FOR UPDATE'));
        return { rows: [{ id: 10, employee_signed_at: null, supervisor_override_reason: reason,
          supervisor_employee_id: supervisorId, supervisor_approved_at: '2026-10-19T09:00:00', status: 'supervisor_approved' }] };
      }
      if (q.includes('FROM time_entries') && q.includes('clock_out IS NULL')) return { rows: [{ count: pendingPunch }] };
      if (q.includes('FROM time_change_requests') || q.includes('FROM forced_lunch_waiver_requests')) return { rows: [{ count: 0 }] };
      if (q.includes('FROM leave_entries') && q.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
      if (q.includes('SELECT weekly_hours_cap FROM employees')) return { rows: [{ weekly_hours_cap: 35 }] };
      if (q.includes('SELECT clock_in,clock_out FROM time_entries')) { assert(locked); return { rows: entries }; }
      if (q.includes('FROM leave_entries')) return { rows: [] };
      if (q.includes('FROM forced_lunch_setting_history') || q.includes('FROM forced_lunch_waivers')) return { rows: [] };
      if (q.includes('FROM weekly_hours_cap_history')) return { rows: [{ employee_id: 2, effective_date_iso: '2026-10-05', weekly_hours_cap: 35 }] };
      if (q.includes('FROM weekly_cap_extra_hours')) { assert(locked); return { rows: [{ employee_id: 2, week_number: 1, extra_hours: extra }] }; }
      if (q.includes('UPDATE pay_period_approvals')) return { rows: [] };
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {},
  };
  const router = createPayrollRouter({
    requireUser: noop, requireAnyPermission: () => noop,
    pool: { connect: async () => client }, audit: async () => {},
    canAccessEmployee: async () => allowed, getRequestedPayPeriod: async () => period,
  });
  const handler = router.stack.find(layer => layer.route?.path === '/payroll/finalize-pay-period')
    .route.stack.at(-1).handle;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ user: { id: 5 }, body: {} }, res);
  return { res, queries };
}

(async () => {
  let outcome = await finalize();
  assert.strictEqual(outcome.res.statusCode, 200);
  assert.strictEqual(outcome.res.body.finalized_count, 1);
  assert(outcome.queries.some(({ q }) => q.includes('UPDATE pay_period_approvals')));

  outcome = await finalize({ extra: 6 });
  assert.strictEqual(outcome.res.statusCode, 409);
  assert(outcome.res.body.blockers[0].blockers.some(message => message.includes('extra hours')));
  assert(!outcome.queries.some(({ q }) => q.includes('UPDATE pay_period_approvals')));

  outcome = await finalize({ pendingPunch: 1 });
  assert.strictEqual(outcome.res.statusCode, 409);
  assert(outcome.res.body.blockers[0].blockers.some(message => message.includes('Open punch')));

  outcome = await finalize({ reason: ' ' });
  assert.strictEqual(outcome.res.statusCode, 409);
  assert(outcome.res.body.blockers[0].blockers.some(message => message.includes('documented supervisor override')));

  outcome = await finalize({ allowed: false });
  assert.strictEqual(outcome.res.statusCode, 403);
  assert(!outcome.queries.some(({ q }) => q.includes('FOR UPDATE')));

  console.log('payroll bulk finalization tests: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });

