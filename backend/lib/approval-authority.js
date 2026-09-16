'use strict';

function rawPermissions(user) {
  return new Set(Array.isArray(user?.permissions) ? user.permissions : []);
}

async function getApprovalAuthority(pool, user, employeeId) {
  const target = await pool.query(
    `SELECT id,department_id FROM employees WHERE id=$1 LIMIT 1`,
    [employeeId],
  );
  if (!target.rows.length) return { allowed: false, isSelf: false, isDepartmentHead: false, isAssignedSupervisor: false };

  const isSelf = Number(user?.id) === Number(employeeId);
  const departmentId = target.rows[0].department_id;
  const head = await pool.query(
    `SELECT 1 FROM department_heads
      WHERE employee_id=$1 AND department_id=$2 AND active=TRUE LIMIT 1`,
    [user.id, departmentId],
  );
  const isDepartmentHead = head.rows.length > 0;

  let isAssignedSupervisor = false;
  if (!isSelf) {
    const assigned = await pool.query(
      `SELECT 1 FROM supervisor_employee_assignments
        WHERE supervisor_employee_id=$1 AND employee_id=$2 AND active=TRUE LIMIT 1`,
      [user.id, employeeId],
    );
    isAssignedSupervisor = assigned.rows.length > 0;
  }

  return {
    allowed: isDepartmentHead || isAssignedSupervisor,
    isSelf,
    isDepartmentHead,
    isAssignedSupervisor,
    departmentId,
  };
}

async function canApprove(pool, user, employeeId, kind) {
  const permissions = rawPermissions(user);
  const authority = await getApprovalAuthority(pool, user, employeeId);
  if (!authority.allowed) return false;

  if (authority.isSelf) {
    if (!authority.isDepartmentHead) return false;
    if (kind === 'punch') return permissions.has('approve_own_punch_corrections');
    if (kind === 'timecard' || kind === 'leave') return permissions.has('approve_own_timecard');
    return false;
  }

  if (kind === 'punch') return permissions.has('approve_punch_correction');
  if (kind === 'timecard' || kind === 'leave') return permissions.has('approve_timecard');
  return false;
}

module.exports = { rawPermissions, getApprovalAuthority, canApprove };
