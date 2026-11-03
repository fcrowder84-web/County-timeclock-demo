'use strict';

const { summarizeTimecard } = require('./timecard-summary');
const { fetchWeeklyCapHistory } = require('./weekly-cap-history');
const { fetchWeeklyExtraHours } = require('./weekly-cap-extra-hours');

async function loadExtraHoursSummary(db, employeeId, period) {
  const args = [employeeId, period.pay_period_start, period.pay_period_end];
  const [employee, entries, leaves, settings, waivers, history, extras] = await Promise.all([
    db.query('SELECT weekly_hours_cap FROM employees WHERE id=$1', [employeeId]),
    db.query(`SELECT clock_in,clock_out FROM time_entries WHERE employee_id=$1 AND deleted_at IS NULL AND clock_in >= $2::date AND clock_in < ($3::date + INTERVAL '1 day')`, args),
    db.query(`SELECT leave_date,leave_type,ROUND(quarter_hours/4.0,2) AS hours,status FROM leave_entries WHERE employee_id=$1 AND leave_date BETWEEN $2::date AND $3::date`, args),
    db.query(`SELECT to_char(effective_date,'YYYY-MM-DD') AS effective_date_iso,enabled,minutes FROM forced_lunch_setting_history WHERE employee_id=$1 AND effective_date <= $2::date ORDER BY effective_date`, [employeeId,period.pay_period_end]),
    db.query(`SELECT to_char(work_date,'YYYY-MM-DD') AS work_date_iso,active FROM forced_lunch_waivers WHERE employee_id=$1 AND work_date BETWEEN $2::date AND $3::date AND active=TRUE`, args),
    fetchWeeklyCapHistory(db,[employeeId],period.pay_period_end),
    fetchWeeklyExtraHours(db,[employeeId],period.pay_period_start),
  ]);
  if (!employee.rows.length) throw new Error('Employee not found');
  const weeklyCapExtraHours = extras.get(employeeId) || [0,0];
  const summary = summarizeTimecard({
    entries: entries.rows,
    leaveEntries: leaves.rows,
    payPeriodStart: period.pay_period_start,
    forcedLunchSettings: settings.rows,
    lunchWaivers: waivers.rows,
    weeklyHoursCap: employee.rows[0].weekly_hours_cap,
    weeklyHoursCapHistory: history.get(employeeId) || [],
    weeklyCapExtraHours,
  });
  return {summary,weeklyCapExtraHours};
}

module.exports = {loadExtraHoursSummary};
