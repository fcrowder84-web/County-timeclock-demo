'use strict';

const assert = require('assert');
const {
  canEditPunch,
  hasPayrollOverride,
  hasPunchPermission,
} = require('../lib/punch-edit-authority');

(async () => {
  const noScopeDb = {
    async query() {
      return { rows: [] };
    },
  };

  assert.strictEqual(
    await canEditPunch(
      noScopeDb,
      { id: 1, permissions: ['app_admin'], app_admin_scope: 'all', department_id: 10 },
      20,
      'edit',
    ),
    true,
  );

  assert.strictEqual(
    await canEditPunch(
      noScopeDb,
      { id: 1, permissions: ['app_admin'], app_admin_scope: 'all', department_id: 10 },
      20,
      'add',
    ),
    true,
  );

  assert.strictEqual(
    await canEditPunch(
      noScopeDb,
      { id: 1, permissions: ['edit_employee_time'], department_id: 10 },
      20,
      'edit',
    ),
    false,
  );

  const assignedDb = {
    async query(sql) {
      if (sql.includes('supervisor_employee_assignments')) return { rows: [{ one: 1 }] };
      return { rows: [] };
    },
  };

  assert.strictEqual(
    await canEditPunch(
      assignedDb,
      { id: 1, permissions: ['edit_employee_time'], department_id: 10 },
      20,
      'edit',
    ),
    true,
  );

  assert.strictEqual(hasPayrollOverride({ permissions: ['app_admin'] }), true);
  assert.strictEqual(hasPunchPermission({ permissions: ['app_admin'] }, 'reopen_timecard'), true);
  assert.strictEqual(hasPunchPermission({ permissions: ['edit_employee_time'] }, 'reopen_timecard'), false);

  console.log('punch edit authority tests: PASS');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
