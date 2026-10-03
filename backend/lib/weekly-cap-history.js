"use strict";

const { resolvePayPeriod, shiftDate } = require('./pay-period');

function normalizeCap(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function capsEqual(left, right) {
  return normalizeCap(left) === normalizeCap(right);
}

async function recordWeeklyCapChange(client, {
  employeeId,
  previousCap,
  weeklyHoursCap,
  source = 'portal-sync',
  targetPeriod = 'auto',
  force = false,
}) {
  if (!force && capsEqual(previousCap, weeklyHoursCap)) return false;
  if (!['auto', 'current', 'next'].includes(targetPeriod)) {
    const error = new Error('Select the current or next payroll period for a cap change');
    error.statusCode = 400;
    throw error;
  }
  const config = await client.query(
    `SELECT to_char(MAX(CASE WHEN key='pay_period_start_date' THEN value END)::date,'YYYY-MM-DD') AS anchor_date_iso,
            MAX(CASE WHEN key='pay_period_length_days' THEN value END)::int AS period_days,
            to_char((NOW() AT TIME ZONE 'America/New_York')::date,'YYYY-MM-DD') AS current_date_iso
       FROM settings`,
  );
  const setting = config.rows[0] || {};
  const period = resolvePayPeriod({
    anchorDate: setting.anchor_date_iso,
    periodDays: setting.period_days,
    targetDate: setting.current_date_iso,
  });
  if (period.period_days !== 14) throw new Error('Weekly cap history requires a two-week payroll period');
  let effectiveDate = targetPeriod === 'next'
    ? shiftDate(period.pay_period_start, period.period_days)
    : period.pay_period_start;

  // The employee row is locked by each caller. Lock the affected approval rows
  // as well so finalization and cap changes cannot cross in flight.
  for (let attempt = 0; attempt < 52; attempt += 1) {
    const next = await client.query(
      `SELECT to_char(effective_date,'YYYY-MM-DD') AS effective_date_iso
         FROM weekly_hours_cap_history
        WHERE employee_id=$1 AND effective_date > $2::date
        ORDER BY effective_date LIMIT 1`,
      [employeeId, effectiveDate],
    );
    const nextDate = next.rows[0]?.effective_date_iso || null;
    const approvals = await client.query(
      `SELECT id,status,employee_signed_at,supervisor_approved_at,payroll_finalized_at,
              to_char(pay_period_end,'YYYY-MM-DD') AS pay_period_end_iso
         FROM pay_period_approvals
        WHERE employee_id=$1
          AND pay_period_end >= $2::date
          AND ($3::date IS NULL OR pay_period_start < $3::date)
        ORDER BY pay_period_start,id FOR UPDATE`,
      [employeeId, effectiveDate, nextDate],
    );
    const locked = approvals.rows.filter(row =>
      row.payroll_finalized_at || row.supervisor_approved_at ||
      ['employee_submitted', 'supervisor_approved', 'payroll_finalized'].includes(row.status) ||
      (row.employee_signed_at && row.status !== 'returned_to_employee'));
    if (!locked.length) break;
    if (targetPeriod !== 'auto') {
      const error = new Error('The selected payroll period affects a signed, approved, or finalized timecard');
      error.statusCode = 409;
      throw error;
    }
    const lastLockedEnd = locked.map(row => row.pay_period_end_iso).sort().at(-1);
    effectiveDate = resolvePayPeriod({
      anchorDate: setting.anchor_date_iso,
      periodDays: period.period_days,
      targetDate: shiftDate(lastLockedEnd, 1),
    }).pay_period_start;
    if (attempt === 51) throw new Error('No open payroll period is available for the cap change');
  }
  await client.query(
    `INSERT INTO weekly_hours_cap_history(
       employee_id,effective_date,weekly_hours_cap,source
     )
     VALUES($1,$2::date,$3::numeric,$4)
     ON CONFLICT (employee_id,effective_date)
     DO UPDATE SET weekly_hours_cap=EXCLUDED.weekly_hours_cap,
                   source=EXCLUDED.source
     WHERE weekly_hours_cap_history.weekly_hours_cap IS DISTINCT FROM EXCLUDED.weekly_hours_cap`,
    [employeeId, effectiveDate, normalizeCap(weeklyHoursCap), source],
  );
  return true;
}

async function fetchWeeklyCapHistory(client, employeeIds, throughDate) {
  const ids = [...new Set((Array.isArray(employeeIds) ? employeeIds : [employeeIds])
    .map(Number).filter(Number.isInteger))];
  if (!ids.length) return new Map();
  const result = await client.query(
    `SELECT employee_id,
            to_char(effective_date,'YYYY-MM-DD') AS effective_date_iso,
            weekly_hours_cap
       FROM weekly_hours_cap_history
      WHERE employee_id=ANY($1::int[])
        AND effective_date <= $2::date
      ORDER BY employee_id,effective_date,id`,
    [ids, throughDate],
  );
  const grouped = new Map();
  for (const row of result.rows) {
    const id = Number(row.employee_id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  return grouped;
}

module.exports = {
  capsEqual,
  fetchWeeklyCapHistory,
  normalizeCap,
  recordWeeklyCapChange,
};
