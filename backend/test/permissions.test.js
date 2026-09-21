'use strict';

const assert=require('assert');
const {
  PERMISSION_GROUPS,
  ROLE_PRESETS,
  ALL_PERMISSIONS,
  unique,
  normalizePermissions,
  legacyPermissionsForRole,
  deriveLegacyRole,
  userHasPermission,
  userHasAnyPermission,
}=require('../lib/permissions');

assert(PERMISSION_GROUPS.employee.includes('clock_in_out'));
assert.deepStrictEqual(unique(['a','a','b',null]),['a','b']);

// Role presets are starting points. Individual checkbox permissions may still
// be adjusted by App Admin after a preset is applied.
assert(ROLE_PRESETS.employee.includes('access'));
assert(ROLE_PRESETS.employee.includes('request_leave'));
assert(ROLE_PRESETS.employee.includes('request_lunch_waiver'));
assert(ROLE_PRESETS.supervisor.includes('approve_timecard'));
assert(ROLE_PRESETS.supervisor.includes('submit_employee_timecard'));
assert(!ROLE_PRESETS.supervisor.includes('approve_own_timecard'));
assert(ROLE_PRESETS.department_head.includes('approve_own_timecard'));
assert(ROLE_PRESETS.department_head.includes('manage_supervisor_assignments'));
assert(ROLE_PRESETS.payroll.includes('view_payroll_records'));
assert(!ROLE_PRESETS.payroll.includes('approve_timecard'));
assert(ROLE_PRESETS.timeclock_manager.includes('approve_timecard'));
assert.deepStrictEqual(ROLE_PRESETS.admin,['app_admin']);

// Legacy permission names are accepted during the migration but normalize to
// the new canonical checkbox names.
assert.deepStrictEqual(
  normalizePermissions(['edit_own_pending_entry','review_approved_timecards','view_all_timeclock_records']),
  ['void_own_unapproved_punch','view_payroll_records'],
);

// A checkbox is an independent capability. Merely having TimeClock access does
// not silently grant other employee capabilities.
assert.strictEqual(userHasPermission({permissions:['access']},'access'),true);
assert.strictEqual(userHasPermission({permissions:['access']},'view_own_time'),false);
assert.strictEqual(userHasPermission({permissions:['view_own_time']},'request_punch_correction'),false);

// App Admin is the application master permission and receives every current
// and future application capability.
assert.strictEqual(userHasPermission({permissions:['app_admin']},'app_admin'),true);
assert.strictEqual(userHasPermission({permissions:['app_admin']},'clock_in_out'),true);
assert.strictEqual(userHasPermission({permissions:['app_admin']},'future_permission_not_yet_defined'),true);

assert.strictEqual(
  userHasAnyPermission({permissions:['clock_in_out']},['edit_payroll_time','clock_in_out']),
  true,
);

// Self-approval permissions remain separate from ordinary supervisor approval.
assert.strictEqual(userHasPermission({permissions:['approve_own_punch_corrections']},'approve_punch_correction'),false);
assert.strictEqual(userHasPermission({permissions:['approve_own_timecard']},'approve_timecard'),false);
assert.strictEqual(userHasPermission({permissions:['approve_own_leave']},'approve_leave'),false);

// Role derivation is compatibility behavior for the existing employees.role
// column. Structural scope checks still determine the actual employees affected.
assert.strictEqual(deriveLegacyRole(['view_payroll_records']),'payroll');
assert.strictEqual(deriveLegacyRole(['approve_timecard']),'supervisor');
assert.strictEqual(deriveLegacyRole(['approve_timecard','view_department_time','approve_own_timecard']),'department_head');
assert.strictEqual(deriveLegacyRole(['app_admin']),'admin');
assert.strictEqual(deriveLegacyRole(['view_own_time']),'employee');

assert(!legacyPermissionsForRole('employee').includes('app_admin'));
assert(legacyPermissionsForRole('admin').includes('app_admin'));

console.log('permissions tests: PASS');
