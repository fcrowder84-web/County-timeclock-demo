'use strict';

function uniqueTimestamps(values) {
  return [...new Set((values || []).filter(Boolean).map(value => {
    if (value instanceof Date) {
      const pad=n=>String(n).padStart(2,'0');
      return `${value.getFullYear()}-${pad(value.getMonth()+1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    }
    return String(value);
  }))];
}

async function lockApprovalsForTimestamps(db, employeeId, timestamps) {
  const affected=uniqueTimestamps(timestamps);
  if (!affected.length) return [];
  const result=await db.query(
    `SELECT *
       FROM pay_period_approvals ppa
      WHERE ppa.employee_id=$1
        AND EXISTS (
          SELECT 1
            FROM unnest($2::timestamp[]) AS affected(ts)
           WHERE affected.ts >= ppa.pay_period_start
             AND affected.ts < (ppa.pay_period_end + INTERVAL '1 day')
        )
      ORDER BY ppa.id
      FOR UPDATE`,
    [employeeId,affected],
  );
  return result.rows;
}

async function requireReopenForFinalized({
  db,
  user,
  employeeId,
  timestamps,
  canAccessEmployee,
}) {
  const approvals=await lockApprovalsForTimestamps(db,employeeId,timestamps);
  const finalized=approvals.filter(row=>row.payroll_finalized_at||row.status==='payroll_finalized');
  if(finalized.length){
    const canReopen=await canAccessEmployee(user,employeeId,['reopen_timecard']);
    if(!canReopen){
      const error=new Error('Reopen permission is required before changing a payroll-finalized timecard.');
      error.statusCode=403;
      throw error;
    }
  }
  return approvals;
}

async function invalidateApprovals(db, approvals) {
  const ids=[...new Set((approvals||[]).map(row=>Number(row.id)).filter(Number.isInteger))];
  if(!ids.length) return [];
  const result=await db.query(
    `UPDATE pay_period_approvals
        SET supervisor_approved_at=NULL,
            supervisor_employee_id=NULL,
            payroll_finalized_at=NULL,
            payroll_finalized_by=NULL,
            status=CASE WHEN employee_signed_at IS NULL THEN 'open' ELSE 'employee_submitted' END
      WHERE id=ANY($1::int[])
      RETURNING id`,
    [ids],
  );
  return result.rows;
}

module.exports={
  uniqueTimestamps,
  lockApprovalsForTimestamps,
  requireReopenForFinalized,
  invalidateApprovals,
};
