'use strict';
const assert=require('assert');
const {
  PERMISSION_GROUPS,
  unique,
  legacyPermissionsForRole,
  deriveLegacyRole,
  userHasPermission,
  userHasAnyPermission,
}=require('../lib/permissions');

assert(PERMISSION_GROUPS.employee.includes('clock_in_out'));
assert.deepStrictEqual(unique(['a','a','b',null]),['a','b']);
assert(!legacyPermissionsForRole('employee').includes('app_admin'));
assert(legacyPermissionsForRole('admin').includes('app_admin'));
assert(legacyPermissionsForRole('payroll').includes('approve_timecard'));
assert.strictEqual(deriveLegacyRole(['view_payroll_records']),'payroll');
assert.strictEqual(deriveLegacyRole(['approve_timecard']),'supervisor');
assert.strictEqual(deriveLegacyRole(['view_own_time']),'employee');
assert.strictEqual(userHasPermission({permissions:['view_own_time']},'view_own_time'),true);
assert.strictEqual(userHasPermission({permissions:['access']},'view_own_time'),true);
assert.strictEqual(userHasPermission({permissions:['app_admin']},'anything'),true);
assert.strictEqual(userHasAnyPermission({permissions:['clock_in_out']},['edit_payroll_time','clock_in_out']),true);

// Self-approval flags stay distinct from normal supervisor authority. Route
// middleware handles them only on the matching self-approval POST action.
assert.strictEqual(userHasPermission({permissions:['approve_own_punch_corrections']},'approve_punch_correction'),false);
assert.strictEqual(userHasPermission({permissions:['approve_own_punch_corrections']},'approve_timecard'),false);
assert.strictEqual(userHasPermission({permissions:['approve_own_timecard']},'approve_timecard'),false);
assert.strictEqual(userHasPermission({permissions:['approve_own_timecard']},'approve_punch_correction'),false);
assert.strictEqual(deriveLegacyRole(['approve_own_punch_corrections']),'employee');
assert.strictEqual(deriveLegacyRole(['approve_own_timecard']),'employee');
console.log('permissions tests: PASS');
