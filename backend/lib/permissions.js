'use strict';

const PERMISSION_GROUPS = Object.freeze({
  employee: [
    'access',
    'clock_in_out',
    'view_own_time',
    'request_punch_correction',
    'edit_own_pending_entry',
    'submit_timecard',
  ],
  supervisor: [
    'view_assigned_employees',
    'view_department_time',
    'view_live_status',
    'add_employee_entry',
    'edit_employee_time',
    'approve_punch_correction',
    'approve_timecard',
    'return_timecard',
    'view_timeclock_audit',
    'manage_employee_timeclock_settings',
    'manage_supervisor_assignments',
  ],
  payroll: [
    'view_payroll_records',
    'review_approved_timecards',
    'edit_payroll_time',
    'return_to_supervisor',
    'reopen_timecard',
    'finalize_timecard',
    'finalize_pay_period',
    'export_payroll',
    'view_payroll_reports',
    'manage_pay_periods',
    'view_timeclock_audit',
    'view_all_timeclock_records',
  ],
  admin: ['app_admin'],
});

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function legacyPermissionsForRole(role) {
  const normalized = String(role || 'employee').toLowerCase();
  const permissions = [...PERMISSION_GROUPS.employee];
  if (['supervisor', 'payroll', 'admin'].includes(normalized)) permissions.push(...PERMISSION_GROUPS.supervisor);
  if (['payroll', 'admin'].includes(normalized)) permissions.push(...PERMISSION_GROUPS.payroll);
  if (normalized === 'admin') permissions.push(...PERMISSION_GROUPS.admin);
  return unique(permissions);
}

function deriveLegacyRole(permissions) {
  const set = new Set(permissions || []);
  if (set.has('app_admin')) return 'admin';
  if (['view_payroll_records','review_approved_timecards','edit_payroll_time','return_to_supervisor','reopen_timecard','finalize_timecard','finalize_pay_period','export_payroll','view_payroll_reports'].some(key => set.has(key))) return 'payroll';
  if (['view_assigned_employees','view_department_time','view_live_status','add_employee_entry','edit_employee_time','approve_punch_correction','approve_timecard','return_timecard'].some(key => set.has(key))) return 'supervisor';
  return 'employee';
}

function userPermissionSet(user) {
  return new Set(Array.isArray(user?.permissions) ? user.permissions : []);
}

function userHasPermission(user, permissionKey) {
  const permissions = userPermissionSet(user);
  if (permissions.has('app_admin') || permissions.has(permissionKey)) return true;
  // Anyone granted TimeClock access must be able to view their own card.
  // This is self-service only; it does not grant supervisor/payroll authority.
  if (permissionKey === 'view_own_time' && permissions.has('access')) return true;
  return false;
}

function userHasAnyPermission(user, permissionKeys) {
  return permissionKeys.some(key => userHasPermission(user, key));
}

module.exports = {
  PERMISSION_GROUPS,
  unique,
  legacyPermissionsForRole,
  deriveLegacyRole,
  userPermissionSet,
  userHasPermission,
  userHasAnyPermission,
};
