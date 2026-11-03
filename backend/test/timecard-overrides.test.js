'use strict';

const assert = require('assert');
const { installTimecardOverrides } = require('../routes/timecard-overrides');

const period = { pay_period_start: '2026-10-05', pay_period_end: '2026-10-18' };
const worked = Array.from({ length: 5 }, (_, day) => ({
  clock_in: `2026-10-${String(5 + day).padStart(2, '0')} 08:00:00`,
  clock_out: `2026-10-${String(5 + day).padStart(2, '0')} 16:00:00`,
}));

function setup({ cap = 35, approval = null, openPunch = false, allowed = true } = {}) {
  const routes = new Map();
  const writes = [];
  const client = {
    async query(sql, args) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (sql.includes('FROM employees WHERE id=$1 FOR UPDATE')) return { rows: [{ id: 2 }] };
      if (sql.includes('SELECT weekly_hours_cap FROM employees')) return { rows: [{ weekly_hours_cap: cap }] };
      if (sql.includes('FROM pay_period_approvals')) return { rows: approval ? [approval] : [] };
      if (sql.includes('FROM time_entries') && sql.includes('clock_out IS NULL')) return { rows: openPunch ? [{ id: 1 }] : [] };
      if (sql.includes('SELECT clock_in,clock_out FROM time_entries')) return { rows: worked };
      if (sql.includes('FROM leave_entries')) return { rows: [] };
      if (sql.includes('FROM time_change_requests')) return { rows: [] };
      if (sql.includes('FROM forced_lunch_waiver_requests')) return { rows: [] };
      if (sql.includes('FROM forced_lunch_setting_history')) return { rows: [] };
      if (sql.includes('FROM forced_lunch_waivers')) return { rows: [] };
      if (sql.includes('FROM weekly_hours_cap_history')) return { rows: [{employee_id:2,effective_date_iso:'2026-10-05',weekly_hours_cap:cap}] };
      if (sql.includes('FROM weekly_cap_extra_hours')) return { rows: [] };
      if (/^\s*(INSERT|UPDATE)/.test(sql)) { writes.push({ sql, args }); return { rows: [] }; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const router = { post(path, ...handlers) { routes.set(path, handlers.at(-1)); } };
  installTimecardOverrides(router, {
    requireUser: (_req, _res, next) => next(),
    requireAnyPermission: () => (_req, _res, next) => next(),
    pool: { connect: async () => client },
    audit: async () => {},
    canAccessEmployee: async () => allowed,
    getRequestedPayPeriod: async () => period,
  });
  async function call(path, body) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
    await routes.get(path)({ body, user: { id: 9 } }, res);
    return res;
  }
  return { call, writes };
}

(async () => {
  let app = setup();
  let result = await app.call('/supervisor/weekly-cap-extra', { employee_id: 2, week_number: 1, extra_hours: 6 });
  assert.strictEqual(result.statusCode, 409);
  assert.strictEqual(app.writes.length, 0);

  app = setup();
  result = await app.call('/supervisor/weekly-cap-extra', { employee_id: 2, week_number: 1, extra_hours: 5 });
  assert.strictEqual(result.statusCode, 200);
  assert(app.writes.some(write => write.sql.includes('weekly_cap_extra_hours_audit')));

  app = setup({ cap: 40 });
  result = await app.call('/supervisor/weekly-cap-extra', { employee_id: 2, week_number: 1, extra_hours: 1 });
  assert.strictEqual(result.statusCode, 409);

  app = setup({ allowed: false });
  result = await app.call('/supervisor/weekly-cap-extra', { employee_id: 2, week_number: 1, extra_hours: 5 });
  assert.strictEqual(result.statusCode, 403);
  result = await app.call('/supervisor/override-employee-signoff', { employee_id: 2, reason: 'Unavailable' });
  assert.strictEqual(result.statusCode, 403);

  app = setup();
  result = await app.call('/supervisor/override-employee-signoff', { employee_id: 2, reason: ' ' });
  assert.strictEqual(result.statusCode, 400);
  result = await app.call('/supervisor/override-employee-signoff', { employee_id: 2, reason: 'Employee unavailable' });
  assert.strictEqual(result.statusCode, 200);
  assert(app.writes.some(write => write.sql.includes('timeclock_audit_log') && write.args[2].includes('Employee unavailable')));

  app = setup({ openPunch: true });
  result = await app.call('/supervisor/override-employee-signoff', { employee_id: 2, reason: 'Employee unavailable' });
  assert.strictEqual(result.statusCode, 409);

  app = setup({ approval: { status: 'supervisor_approved', supervisor_approved_at: new Date() } });
  result = await app.call('/supervisor/weekly-cap-extra', { employee_id: 2, week_number: 1, extra_hours: 5 });
  assert.strictEqual(result.statusCode, 409);

  console.log('timecard override tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

