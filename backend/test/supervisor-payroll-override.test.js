'use strict';

const assert = require('assert');
const { createSupervisorRouter } = require('../routes/supervisor');

function noop(_req, _res, next) { if (next) next(); }

async function editCard(card, permissions = ['edit_payroll_time']) {
  const queries = [];
  const entry = {
    id: 3, employee_id: 7,
    clock_in: '2026-10-05T08:00:00-04:00',
    clock_out: '2026-10-05T16:00:00-04:00',
    source_date_iso: '2026-10-05',
  };
  const client = {
    async query(sql) {
      const q = String(sql).replace(/\s+/g, ' ');
      queries.push(q);
      if (['BEGIN', 'ROLLBACK', 'COMMIT'].includes(q)) return { rows: [] };
      if (q.includes('FROM time_entries WHERE id=$1 AND deleted_at IS NULL FOR UPDATE')) return { rows: [entry] };
      if (q.includes('FROM time_entries') && q.includes('LIMIT 1') && q.includes('FOR UPDATE')) return { rows: [] };
      if (q.includes('FROM pay_period_approvals') && q.includes('source_period')) return { rows: [{ ...card, source_period: true, destination_period: true }] };
      if (q.includes('INSERT INTO time_entry_audit')) return { rows: [] };
      if (q.includes('UPDATE time_entries')) return { rows: [entry] };
      if (q.includes('UPDATE pay_period_approvals')) return { rows: [{ id: card.id }] };
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {},
  };
  const router = createSupervisorRouter({
    requireUser: noop, requireAnyPermission: () => noop,
    pool: { connect: async () => client }, audit: async () => {},
    canAccessEmployee: async () => true, getRequestedPayPeriod: async () => ({}),
    userHasPermission: (user, permission) => user.permissions.includes(permission),
  });
  const handler = router.stack.find(layer => layer.route?.path === '/supervisor/edit-time-entry')
    .route.stack.at(-1).handle;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({
    user: { id: 5, role: 'payroll', permissions },
    body: { time_entry_id: 3, new_clock_in: '2026-10-05T09:00:00-04:00', new_clock_out: '2026-10-05T17:00:00-04:00', reason: 'Payroll correction' },
  }, res);
  return { res, queries };
}

(async () => {
  const approved = { id: 11, status: 'supervisor_approved', supervisor_approved_at: '2026-10-19T09:00:00', supervisor_employee_id: 12 };
  let result = await editCard({ ...approved, employee_signed_at: '2026-10-18T17:00:00' });
  assert.strictEqual(result.res.statusCode, 200);

  result = await editCard({ ...approved, employee_signed_at: null, supervisor_override_reason: 'Employee unavailable' });
  assert.strictEqual(result.res.statusCode, 200);
  assert(result.queries.some(sql => sql.includes('UPDATE time_entries')));

  result = await editCard({ ...approved, employee_signed_at: null, supervisor_override_reason: ' ' });
  assert.strictEqual(result.res.statusCode, 409);
  assert(!result.queries.some(sql => sql.includes('UPDATE time_entries')));

  result = await editCard({ ...approved, employee_signed_at: null, supervisor_override_reason: 'Employee unavailable', supervisor_employee_id: null });
  assert.strictEqual(result.res.statusCode, 409);

  result = await editCard({ ...approved, employee_signed_at: null, supervisor_override_reason: 'Employee unavailable', supervisor_approved_at: null });
  assert.strictEqual(result.res.statusCode, 409);

  result = await editCard({ ...approved, employee_signed_at: null, supervisor_override_reason: 'Employee unavailable', status: 'payroll_finalized', payroll_finalized_at: '2026-10-20T09:00:00' });
  assert.strictEqual(result.res.statusCode, 403);

  console.log('supervisor payroll override tests: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });

