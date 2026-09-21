"use strict";

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function configuredMinutes(settings) {
  if (!settings?.forced_lunch_enabled) return 0;
  const minutes = Number(settings.forced_lunch_minutes || 0);
  return Number.isInteger(minutes) && minutes > 0 ? minutes : 0;
}

async function getForcedLunchContext(pool, employeeId, payPeriodStart, payPeriodEnd) {
  const [settingsResult, waiversResult, requestsResult] = await Promise.all([
    pool.query(
      `SELECT forced_lunch_enabled,forced_lunch_minutes
         FROM employees
        WHERE id=$1`,
      [employeeId],
    ),
    pool.query(
      `SELECT id,to_char(work_date,'YYYY-MM-DD') AS work_date_iso,
              configured_lunch_minutes,reason,source,requested_by_employee_id,
              approved_by_employee_id,approved_at,created_at
         FROM forced_lunch_waivers
        WHERE employee_id=$1
          AND work_date BETWEEN $2::date AND $3::date
        ORDER BY work_date,id`,
      [employeeId, payPeriodStart, payPeriodEnd],
    ),
    pool.query(
      `SELECT id,to_char(work_date,'YYYY-MM-DD') AS work_date_iso,
              configured_lunch_minutes,reason,status,review_note,
              requested_by_employee_id,reviewed_by_employee_id,
              created_at,reviewed_at,
              to_char(created_at,'MM/DD/YYYY HH12:MI AM') AS created_at_display,
              to_char(reviewed_at,'MM/DD/YYYY HH12:MI AM') AS reviewed_at_display
         FROM forced_lunch_waiver_requests
        WHERE employee_id=$1
          AND work_date BETWEEN $2::date AND $3::date
        ORDER BY work_date,id`,
      [employeeId, payPeriodStart, payPeriodEnd],
    ),
  ]);

  const settings = settingsResult.rows[0] || {
    forced_lunch_enabled: false,
    forced_lunch_minutes: 30,
  };

  return {
    settings,
    forcedLunchMinutes: configuredMinutes(settings),
    waivers: waiversResult.rows,
    requests: requestsResult.rows,
  };
}

async function invalidateApprovalForWorkDate(client, employeeId, workDate) {
  return client.query(
    `UPDATE pay_period_approvals
        SET supervisor_approved_at=NULL,
            supervisor_employee_id=NULL,
            payroll_finalized_at=NULL,
            payroll_finalized_by=NULL,
            status=CASE
              WHEN employee_signed_at IS NULL THEN 'open'
              ELSE 'employee_submitted'
            END
      WHERE employee_id=$1
        AND $2::date BETWEEN pay_period_start AND pay_period_end
      RETURNING id,status`,
    [employeeId, dateOnly(workDate)],
  );
}

module.exports = {
  dateOnly,
  configuredMinutes,
  getForcedLunchContext,
  invalidateApprovalForWorkDate,
};
