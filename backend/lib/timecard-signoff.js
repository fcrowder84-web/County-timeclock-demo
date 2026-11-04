'use strict';

function hasEmployeeSignoffOrOverride(approval) {
  if (!approval) return false;
  if (approval.employee_signed_at) return true;
  return Boolean(
    approval.supervisor_approved_at
    && Number.isSafeInteger(Number(approval.supervisor_employee_id))
    && Number(approval.supervisor_employee_id) > 0
    && typeof approval.supervisor_override_reason === 'string'
    && approval.supervisor_override_reason.trim(),
  );
}

module.exports = { hasEmployeeSignoffOrOverride };

