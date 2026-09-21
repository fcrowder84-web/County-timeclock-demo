'use strict';

/*
 * TimeClock authorization model
 *
 * 1. A role/preset provides a sensible starting set of permissions.
 * 2. Individual permission checkboxes may be adjusted after a preset is applied.
 * 3. Scope answers WHO a capability applies to; permissions answer WHAT may be done.
 * 4. Workflow/data-integrity rules still apply even to App Admin.
 * 5. app_admin is the application-level master permission and receives every
 *    current/future TimeClock capability. It is not a database/God-mode bypass.
 */

const EMPLOYEE_PERMISSIONS = Object.freeze([
  'access',
  'clock_in_out',
  'view_own_time',
  'request_punch_correction',
  'request_leave',
  'request_lunch_waiver',
  'void_own_unapproved_punch',
  'withdraw_own_pending_request',
  'submit_timecard',
]);

const SUPERVISOR_PERMISSIONS = Object.freeze([
  'view_assigned_employees',
  'view_live_status',
  'add_employee_entry',
  'edit_employee_time',
  'approve_punch_correction',
  'approve_timecard',
  'return_timecard',
  'submit_employee_timecard',
  'view_employee_leave',
  'add_employee_leave',
  'approve_leave',
  'void_employee_leave',
  'approve_lunch_waiver',
]);

const DEPARTMENT_HEAD_ONLY_PERMISSIONS = Object.freeze([
  'view_department_time',
  'approve_own_punch_corrections',
  'approve_own_timecard',
  'approve_own_leave',
  'approve_own_lunch_waiver',
  'manage_supervisor_assignments',
  'manage_employee_lunch_settings',
]);

const DEPARTMENT_HEAD_PERMISSIONS = Object.freeze([
  ...SUPERVISOR_PERMISSIONS,
  ...DEPARTMENT_HEAD_ONLY_PERMISSIONS,
]);

const PAYROLL_PERMISSIONS = Object.freeze([
  'view_payroll_records',
  'edit_payroll_time',
  'return_to_supervisor',
  'reopen_timecard',
  'finalize_timecard',
  'finalize_pay_period',
  'export_payroll',
  'view_timeclock_audit',
]);

const MANAGEMENT_PERMISSIONS = Object.freeze([
  'manage_employee_timeclock_settings',
  'manage_supervisor_assignments',
  'manage_employee_lunch_settings',
]);

const TIMECLOCK_MANAGER_PERMISSIONS = Object.freeze([
  ...SUPERVISOR_PERMISSIONS,
  ...DEPARTMENT_HEAD_ONLY_PERMISSIONS,
  'manage_employee_timeclock_settings',
  'view_timeclock_audit',
]);

const LEGACY_PERMISSION_ALIASES = Object.freeze({
  // Old UI/backend names remain accepted during migration but are not part of
  // the canonical checkbox catalog.
  edit_own_pending_entry: 'void_own_unapproved_punch',
  review_approved_timecards: 'view_payroll_records',
  view_all_timeclock_records: 'view_payroll_records',
  view_payroll_reports: 'view_payroll_records',
});

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function canonicalPermissionKey(key) {
  const normalized=String(key || '').trim();
  return LEGACY_PERMISSION_ALIASES[normalized] || normalized;
}

function normalizePermissions(values) {
  return unique((values || []).map(canonicalPermissionKey));
}

const ROLE_PRESETS = Object.freeze({
  employee: Object.freeze([...EMPLOYEE_PERMISSIONS]),
  supervisor: Object.freeze(unique([...EMPLOYEE_PERMISSIONS, ...SUPERVISOR_PERMISSIONS])),
  department_head: Object.freeze(unique([...EMPLOYEE_PERMISSIONS, ...DEPARTMENT_HEAD_PERMISSIONS])),
  payroll: Object.freeze(unique([...EMPLOYEE_PERMISSIONS, ...PAYROLL_PERMISSIONS])),
  timeclock_manager: Object.freeze(unique([
    ...EMPLOYEE_PERMISSIONS,
    ...TIMECLOCK_MANAGER_PERMISSIONS,
  ])),
  // App Admin intentionally does not need every permission persisted. The
  // app_admin permission itself grants every application capability.
  admin: Object.freeze(['app_admin']),
});

const PERMISSION_GROUPS = Object.freeze({
  employee: EMPLOYEE_PERMISSIONS,
  supervisor: SUPERVISOR_PERMISSIONS,
  department_head: DEPARTMENT_HEAD_PERMISSIONS,
  payroll: PAYROLL_PERMISSIONS,
  management: MANAGEMENT_PERMISSIONS,
  timeclock_manager: TIMECLOCK_MANAGER_PERMISSIONS,
  admin: Object.freeze(['app_admin']),
});

const ALL_PERMISSIONS = Object.freeze(unique([
  ...EMPLOYEE_PERMISSIONS,
  ...SUPERVISOR_PERMISSIONS,
  ...DEPARTMENT_HEAD_ONLY_PERMISSIONS,
  ...PAYROLL_PERMISSIONS,
  ...MANAGEMENT_PERMISSIONS,
  'app_admin',
]));

function legacyPermissionsForRole(role) {
  const normalized=String(role || 'employee').toLowerCase();
  return [...(ROLE_PRESETS[normalized] || ROLE_PRESETS.employee)];
}

function deriveLegacyRole(permissions) {
  const set=new Set(normalizePermissions(permissions));
  if (set.has('app_admin')) return 'admin';

  if (
    set.has('manage_employee_timeclock_settings')
    && set.has('view_department_time')
    && set.has('approve_own_timecard')
  ) return 'timeclock_manager';

  if (PAYROLL_PERMISSIONS.some(key => set.has(key))) return 'payroll';

  const hasSupervisorAuthority=SUPERVISOR_PERMISSIONS.some(key => set.has(key));
  const hasDepartmentHeadAuthority=
    set.has('view_department_time')
    || set.has('approve_own_punch_corrections')
    || set.has('approve_own_timecard')
    || set.has('approve_own_leave')
    || set.has('manage_supervisor_assignments');

  if (hasSupervisorAuthority && hasDepartmentHeadAuthority) return 'department_head';
  if (hasSupervisorAuthority) return 'supervisor';
  return 'employee';
}

function currentAuthorizationForUser(user, fallbackPermissions = [], fallbackScope = 'own') {
  const source=String(user?.auth_source||'').toLowerCase();
  let permissions;
  if(source==='portal'){
    if(Array.isArray(user?.portal_permissions)){
      permissions=normalizePermissions(user.portal_permissions);
    }else if(user?.portal_permissions&&typeof user.portal_permissions==='object'){
      permissions=normalizePermissions(
        Object.keys(user.portal_permissions).filter(key=>user.portal_permissions[key]),
      );
    }else{
      permissions=[];
    }
  }else{
    permissions=normalizePermissions(fallbackPermissions||[]);
  }

  const scopeSource=source==='portal' ? user?.app_admin_scope : fallbackScope;
  const appAdminScope=
    permissions.includes('app_admin')&&scopeSource==='all' ? 'all' : 'own';

  return {permissions,appAdminScope};
}

function roleCanSelfApprove(user) {
  const role=String(user?.role||'employee').toLowerCase();
  return ['department_head','payroll','timeclock_manager','admin'].includes(role);
}

function userPermissionSet(user) {
  return new Set(normalizePermissions(Array.isArray(user?.permissions) ? user.permissions : []));
}

function userHasPermission(user, permissionKey) {
  const permissions=userPermissionSet(user);

  // App Admin is the master application permission. It grants every action
  // exposed by TimeClock, but callers must still enforce workflow and
  // data-integrity rules.
  if (permissions.has('app_admin')) return true;
  return permissions.has(canonicalPermissionKey(permissionKey));
}

function userHasAnyPermission(user, permissionKeys) {
  return (permissionKeys || []).some(key => userHasPermission(user,key));
}

module.exports={
  EMPLOYEE_PERMISSIONS,
  SUPERVISOR_PERMISSIONS,
  DEPARTMENT_HEAD_PERMISSIONS,
  PAYROLL_PERMISSIONS,
  MANAGEMENT_PERMISSIONS,
  TIMECLOCK_MANAGER_PERMISSIONS,
  LEGACY_PERMISSION_ALIASES,
  ROLE_PRESETS,
  PERMISSION_GROUPS,
  ALL_PERMISSIONS,
  unique,
  canonicalPermissionKey,
  normalizePermissions,
  legacyPermissionsForRole,
  deriveLegacyRole,
  currentAuthorizationForUser,
  roleCanSelfApprove,
  userPermissionSet,
  userHasPermission,
  userHasAnyPermission,
};
