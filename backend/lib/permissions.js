'use strict';

const EMPLOYEE_PERMISSIONS = [
  'access',
  'clock_in_out',
  'view_own_time',
  'request_punch_correction',
  'edit_own_pending_entry',
  'submit_timecard',
];

const SUPERVISOR_PERMISSIONS = [
  'view_assigned_employees',
  'view_live_status',
  'add_employee_entry',
  'edit_employee_time',
  'approve_punch_correction',
  'approve_timecard',
  'return_timecard',
];

const DEPARTMENT_HEAD_PERMISSIONS = [
  ...SUPERVISOR_PERMISSIONS,
  'view_department_time',
  'approve_own_punch_corrections',
  'approve_own_timecard',
];

const PAYROLL_PERMISSIONS = [
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
];

const PERMISSION_GROUPS = Object.freeze({
  employee: Object.freeze([...EMPLOYEE_PERMISSIONS]),
  supervisor: Object.freeze([...SUPERVISOR_PERMISSIONS]),
  department_head: Object.freeze([...DEPARTMENT_HEAD_PERMISSIONS]),
  payroll: Object.freeze([...PAYROLL_PERMISSIONS]),
  admin: Object.freeze(['app_admin']),
});

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function legacyPermissionsForRole(role) {
  const normalized = String(role || 'employee').toLowerCase();
  const permissions = [...EMPLOYEE_PERMISSIONS];
  if (normalized === 'supervisor') permissions.push(...SUPERVISOR_PERMISSIONS);
  if (normalized === 'department_head') permissions.push(...DEPARTMENT_HEAD_PERMISSIONS);
  if (normalized === 'payroll') permissions.push(...PAYROLL_PERMISSIONS);
  if (normalized === 'admin') permissions.push('app_admin');
  return unique(permissions);
}

function deriveLegacyRole(permissions) {
  const set = new Set(permissions || []);
  if (['view_payroll_records','review_approved_timecards','edit_payroll_time','return_to_supervisor','reopen_timecard','finalize_timecard','finalize_pay_period','export_payroll','view_payroll_reports'].some(key => set.has(key))) return 'payroll';
  const hasSupervisorAuthority = SUPERVISOR_PERMISSIONS.some(key => set.has(key));
  const hasDepartmentHeadAuthority = set.has('view_department_time') || set.has('approve_own_punch_corrections') || set.has('approve_own_timecard');
  if (hasSupervisorAuthority && hasDepartmentHeadAuthority) return 'supervisor'; // DB role remains legacy; department_heads supplies structural role.
  if (hasSupervisorAuthority) return 'supervisor';
  if (set.has('app_admin')) return 'admin';
  return 'employee';
}

function userPermissionSet(user) {
  return new Set(Array.isArray(user?.permissions) ? user.permissions : []);
}

function userHasPermission(user, permissionKey) {
  const permissions = userPermissionSet(user);
  if (permissions.has(permissionKey)) return true;
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
