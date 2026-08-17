'use strict';

const express = require('express');
const {
  FLOATING_HOLIDAY_POLICY,
  getHolidayCalendar,
  findFixedHoliday,
  holidayYear,
  isWorkday,
} = require('../lib/holiday-calendar');

const LEAVE_TYPES = ['vacation', 'sick', 'holiday', 'floating_holiday', 'bereavement', 'jury_duty', 'administrative', 'other'];
const SUPERVISOR_PERMISSIONS = [
  'view_assigned_employees', 'view_department_time', 'edit_employee_time',
  'approve_timecard', 'manage_employee_timeclock_settings', 'edit_payroll_time',
  'view_all_timeclock_records', 'app_admin',
];

function parseQuarterHours(hours) {
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0 || value > 24 || Math.round(value * 4) !== value * 4) {
    const error = new Error('Leave hours must be between 0.25 and 24 in 15-minute increments');
    error.statusCode = 400;
    throw error;
  }
  return Math.round(value * 4);
}

function datesBetween(start, end, weekdaysOnly = false) {
  const first = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end || start}T12:00:00Z`);
  if (Number.isNaN(first.valueOf()) || Number.isNaN(last.valueOf()) || last < first) {
    const error = new Error('A valid start and end date are required');
    error.statusCode = 400;
    throw error;
  }
  const result = [];
  for (const day = new Date(first); day <= last; day.setUTCDate(day.getUTCDate() + 1)) {
    if (!weekdaysOnly || (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)) {
      result.push(day.toISOString().slice(0, 10));
    }
    if (result.length > 366) {
      const error = new Error('Leave range cannot exceed one year');
      error.statusCode = 400;
      throw error;
    }
  }
  if (!result.length) {
    const error = new Error('The selected range contains no applicable dates');
    error.statusCode = 400;
    throw error;
  }
  return result;
}

function assessDailyPaidHours({ workedQuarterHours = 0, existingLeaveQuarterHours = 0, proposedQuarterHours = 0, standardQuarterHours = 32 }) {
  const totalQuarterHours = workedQuarterHours + existingLeaveQuarterHours + proposedQuarterHours;
  return {
    worked_quarter_hours: workedQuarterHours,
    existing_leave_quarter_hours: existingLeaveQuarterHours,
    proposed_quarter_hours: proposedQuarterHours,
    total_quarter_hours: totalQuarterHours,
    worked_hours: workedQuarterHours / 4,
    existing_leave_hours: existingLeaveQuarterHours / 4,
    proposed_hours: proposedQuarterHours / 4,
    total_hours: totalQuarterHours / 4,
    exceeds_standard_day: totalQuarterHours > standardQuarterHours,
    recommended_leave_quarter_hours: Math.max(0, standardQuarterHours - workedQuarterHours - existingLeaveQuarterHours),
    recommended_leave_hours: Math.max(0, standardQuarterHours - workedQuarterHours - existingLeaveQuarterHours) / 4,
  };
}

function validateFixedHolidayDates(dates) {
  const invalid = dates.filter((date) => !findFixedHoliday(date));
  if (invalid.length) {
    const error = new Error(`Holiday leave is limited to the County holiday calendar. Invalid date(s): ${invalid.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
}

function validateFloatingHolidayRequest(dates, quarterHours) {
  if (dates.length !== 1) {
    const error = new Error('Floating Holiday must be requested for one workday');
    error.statusCode = 400;
    throw error;
  }
  if (!isWorkday(dates[0])) {
    const error = new Error('Floating Holiday must be used on a workday');
    error.statusCode = 400;
    throw error;
  }
  if (quarterHours !== FLOATING_HOLIDAY_POLICY.hours_per_day * 4) {
    const error = new Error(`Floating Holiday is one ${FLOATING_HOLIDAY_POLICY.hours_per_day}-hour personal leave day`);
    error.statusCode = 400;
    throw error;
  }
}

function createLeaveRouter({ requireUser, pool, audit, canAccessEmployee, getRequestedPayPeriod, userHasAnyPermission }) {
  const router = express.Router();

  function isSupervisor(user) {
    return userHasAnyPermission(user, SUPERVISOR_PERMISSIONS) || ['supervisor', 'payroll', 'admin'].includes(user.role);
  }

  async function assertAccess(user, employeeId) {
    if (Number(user.id) === Number(employeeId)) return true;
    if (!isSupervisor(user) || !(await canAccessEmployee(user, employeeId, SUPERVISOR_PERMISSIONS))) {
      const error = new Error('You cannot manage leave for this employee');
      error.statusCode = 403;
      throw error;
    }
    return true;
  }

  router.get('/leave/types', requireUser, (_req, res) => res.json({ leave_types: LEAVE_TYPES }));

  router.get('/leave/holiday-calendar', requireUser, (req, res) => {
    const requestedYear = Number(req.query.year || new Date().getFullYear());
    res.json({
      year: requestedYear,
      fixed_holidays: getHolidayCalendar(requestedYear),
      floating_holiday: FLOATING_HOLIDAY_POLICY,
    });
  });

  router.get('/leave', requireUser, async (req, res) => {
    try {
      const employeeId = Number(req.query.employee_id || req.user.id);
      await assertAccess(req.user, employeeId);
      const period = await getRequestedPayPeriod(req);
      const result = await pool.query(
        `SELECT le.*, ROUND(le.quarter_hours / 4.0, 2) AS hours,
                e.first_name, e.last_name,
                creator.first_name AS created_by_first_name, creator.last_name AS created_by_last_name,
                reviewer.first_name AS reviewed_by_first_name, reviewer.last_name AS reviewed_by_last_name
           FROM leave_entries le
           JOIN employees e ON e.id=le.employee_id
           JOIN employees creator ON creator.id=le.created_by_employee_id
           LEFT JOIN employees reviewer ON reviewer.id=le.reviewed_by_employee_id
          WHERE le.employee_id=$1 AND le.leave_date BETWEEN $2::date AND $3::date
          ORDER BY le.leave_date, le.id`,
        [employeeId, period.pay_period_start, period.pay_period_end],
      );
      res.json({ employee_id: employeeId, ...period, leave_entries: result.rows, can_manage_others: isSupervisor(req.user) });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message || 'Leave lookup failed' });
    }
  });

  router.post('/leave', requireUser, async (req, res) => {
    const client = await pool.connect();
    try {
      const employeeId = Number(req.body.employee_id || req.user.id);
      await assertAccess(req.user, employeeId);
      const type = String(req.body.leave_type || '').toLowerCase();
      if (!LEAVE_TYPES.includes(type)) {
        const error = new Error('Select a valid leave type');
        error.statusCode = 400;
        throw error;
      }
      const quarterHours = parseQuarterHours(req.body.hours);
      const dates = datesBetween(req.body.start_date, req.body.end_date, req.body.weekdays_only === true);
      const onBehalf = employeeId !== Number(req.user.id);
      const status = onBehalf ? 'approved' : 'pending';
      let note = String(req.body.note || '').trim() || null;
      const overrideConfirmed = req.body.override_daily_hours === true;
      const overrideReason = String(req.body.override_reason || '').trim();

      if (type === 'holiday') {
        validateFixedHolidayDates(dates);
        if (!note && dates.length === 1) note = findFixedHoliday(dates[0])?.name || null;
      }

      if (type === 'floating_holiday') {
        validateFloatingHolidayRequest(dates, quarterHours);
        const year = holidayYear(dates[0]);
        const existingFloating = await client.query(
          `SELECT id,status,leave_date FROM leave_entries
            WHERE employee_id=$1
              AND leave_type='floating_holiday'
              AND EXTRACT(YEAR FROM leave_date)=$2
              AND status IN ('pending','approved')
            LIMIT 1`,
          [employeeId, year],
        );
        if (existingFloating.rows.length) {
          const error = new Error(`This employee already has a pending or approved Floating Holiday for ${year}`);
          error.statusCode = 409;
          throw error;
        }
        if (!note) note = 'Annual Floating Holiday';
      }

      await client.query('BEGIN');

      const dailyChecks = [];
      for (const date of dates) {
        const totals = await client.query(
          `SELECT
             COALESCE(
               FLOOR(SUM(EXTRACT(EPOCH FROM (COALESCE(clock_out,NOW()) - clock_in)) / 900)
               + CASE
                   WHEN MOD(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(clock_out,NOW()) - clock_in)) / 60)::int, 15) > 5
                   THEN 1 ELSE 0
                 END,
               0
             )::int AS worked_quarters,
             COALESCE((SELECT SUM(quarter_hours) FROM leave_entries
                        WHERE employee_id=$1 AND leave_date=$2::date AND status <> 'denied'),0)::int AS leave_quarters
             FROM time_entries
            WHERE employee_id=$1 AND clock_in >= $2::date AND clock_in < ($2::date + INTERVAL '1 day')`,
          [employeeId, date],
        );
        const check = assessDailyPaidHours({
          workedQuarterHours: Number(totals.rows[0].worked_quarters || 0),
          existingLeaveQuarterHours: Number(totals.rows[0].leave_quarters || 0),
          proposedQuarterHours: quarterHours,
        });
        if (check.exceeds_standard_day) dailyChecks.push({ date, ...check });
      }

      if (dailyChecks.length && !overrideConfirmed) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Worked time plus leave exceeds 8 hours on one or more days',
          code: 'DAILY_PAID_HOURS_WARNING',
          requires_confirmation: true,
          daily_checks: dailyChecks,
        });
      }
      if (dailyChecks.length && !overrideReason) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'An override reason is required when total paid time exceeds 8 hours',
          code: 'OVERRIDE_REASON_REQUIRED',
          daily_checks: dailyChecks,
        });
      }
      const inserted = [];
      for (const date of dates) {
        const entryNote = type === 'holiday' && !String(req.body.note || '').trim()
          ? (findFixedHoliday(date)?.name || note)
          : note;
        const result = await client.query(
          `INSERT INTO leave_entries(
             employee_id,leave_date,leave_type,quarter_hours,note,status,
             created_by_employee_id,reviewed_by_employee_id,reviewed_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8::int IS NULL THEN NULL ELSE NOW() END)
           RETURNING *, ROUND(quarter_hours / 4.0, 2) AS hours`,
          [employeeId, date, type, quarterHours, entryNote, status, req.user.id, onBehalf ? req.user.id : null],
        );
        inserted.push(result.rows[0]);
      }
      await client.query('COMMIT');
      await audit(req.user.id, onBehalf ? 'add_leave_on_behalf' : 'request_leave', 'employee', employeeId, {
        leave_type: type, dates, hours: quarterHours / 4, status, note, daily_hours_override: dailyChecks.length > 0, override_reason: overrideReason || null, daily_checks: dailyChecks,
      });
      res.status(201).json({ message: onBehalf ? 'Leave added and approved' : 'Leave submitted for approval', leave_entries: inserted });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(err.statusCode || 500).json({ error: err.message || 'Leave entry failed' });
    } finally {
      client.release();
    }
  });

  router.post('/leave/:id/review', requireUser, async (req, res) => {
    try {
      if (!isSupervisor(req.user)) return res.status(403).json({ error: 'Supervisor access required' });
      const existing = await pool.query('SELECT * FROM leave_entries WHERE id=$1', [req.params.id]);
      if (!existing.rows.length) return res.status(404).json({ error: 'Leave entry not found' });
      await assertAccess(req.user, existing.rows[0].employee_id);
      const status = String(req.body.status || '').toLowerCase();
      if (!['approved', 'denied'].includes(status)) return res.status(400).json({ error: 'Status must be approved or denied' });
      const note = String(req.body.review_note || '').trim() || null;
      const result = await pool.query(
        `UPDATE leave_entries SET status=$1,review_note=$2,reviewed_by_employee_id=$3,reviewed_at=NOW(),updated_at=NOW()
          WHERE id=$4 RETURNING *, ROUND(quarter_hours / 4.0, 2) AS hours`,
        [status, note, req.user.id, req.params.id],
      );
      await audit(req.user.id, `leave_${status}`, 'leave_entry', req.params.id, { employee_id: existing.rows[0].employee_id, review_note: note });
      res.json({ message: `Leave ${status}`, leave_entry: result.rows[0] });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message || 'Leave review failed' });
    }
  });

  router.delete('/leave/:id', requireUser, async (req, res) => {
    try {
      const existing = await pool.query('SELECT * FROM leave_entries WHERE id=$1', [req.params.id]);
      if (!existing.rows.length) return res.status(404).json({ error: 'Leave entry not found' });
      await assertAccess(req.user, existing.rows[0].employee_id);
      await pool.query('DELETE FROM leave_entries WHERE id=$1', [req.params.id]);
      await audit(req.user.id, 'delete_leave', 'leave_entry', req.params.id, existing.rows[0]);
      res.json({ message: 'Leave entry removed' });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message || 'Leave removal failed' });
    }
  });

  router.post('/leave/submit-timecard-on-behalf', requireUser, async (req, res) => {
    try {
      const employeeId = Number(req.body.employee_id);
      if (!employeeId || employeeId === Number(req.user.id) || !isSupervisor(req.user)) {
        return res.status(403).json({ error: 'Supervisor entry on behalf of an employee is required' });
      }
      await assertAccess(req.user, employeeId);
      const period = await getRequestedPayPeriod(req);
      const open = await pool.query(
        `SELECT id FROM time_entries WHERE employee_id=$1 AND clock_in >= $2::date
          AND clock_in < ($3::date + INTERVAL '1 day') AND clock_out IS NULL`,
        [employeeId, period.pay_period_start, period.pay_period_end],
      );
      if (open.rows.length) return res.status(400).json({ error: 'Clock out the employee before completing the timecard' });
      const result = await pool.query(
        `INSERT INTO pay_period_approvals(employee_id,pay_period_start,pay_period_end,employee_signed_at,status)
         VALUES($1,$2,$3,NOW(),'employee_submitted')
         ON CONFLICT(employee_id,pay_period_start,pay_period_end)
         DO UPDATE SET employee_signed_at=NOW(),supervisor_approved_at=NULL,payroll_finalized_at=NULL,status='employee_submitted'
         RETURNING *`,
        [employeeId, period.pay_period_start, period.pay_period_end],
      );
      await audit(req.user.id, 'submit_timecard_on_behalf', 'employee', employeeId, { ...period, reason: String(req.body.reason || '').trim() || null });
      res.json({ message: 'Timecard completed on behalf of employee and sent for supervisor review', approval: result.rows[0] });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message || 'Timecard completion failed' });
    }
  });

  return router;
}

module.exports = {
  LEAVE_TYPES,
  parseQuarterHours,
  datesBetween,
  assessDailyPaidHours,
  validateFixedHolidayDates,
  validateFloatingHolidayRequest,
  createLeaveRouter,
};
