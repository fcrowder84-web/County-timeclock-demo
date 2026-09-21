'use strict';

const express = require('express');
const {
  FLOATING_HOLIDAY_POLICY,
  getHolidayCalendar,
  findFixedHoliday,
  holidayYear,
  isWorkday,
} = require('../lib/holiday-calendar');

const LEAVE_TYPES = [
  'vacation',
  'sick',
  'holiday',
  'floating_holiday',
  'bereavement',
  'jury_duty',
  'administrative',
  'other',
];

const LEAVE_MANAGEMENT_PERMISSIONS = [
  'view_employee_leave',
  'add_employee_leave',
  'approve_leave',
  'void_employee_leave',
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

function assessDailyPaidHours({
  workedQuarterHours = 0,
  existingLeaveQuarterHours = 0,
  proposedQuarterHours = 0,
  standardQuarterHours = 32,
}) {
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

function validateFloatingHolidayRequest(dates) {
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
}

function createLeaveRouter({ requireUser, pool, audit, canAccessEmployee, getRequestedPayPeriod, userHasAnyPermission }) {
  const router = express.Router();

  function canManageOthers(user) {
    return userHasAnyPermission(user, LEAVE_MANAGEMENT_PERMISSIONS);
  }

  function requireCapability(user, permissionKey, message='Permission denied') {
    if (!userHasAnyPermission(user, [permissionKey])) {
      const error = new Error(message);
      error.statusCode = 403;
      throw error;
    }
  }

  async function requireScopedCapability(user, employeeId, permissionKey, message='You cannot manage leave for this employee') {
    requireCapability(user, permissionKey, message);
    if (!(await canAccessEmployee(user, employeeId, [permissionKey]))) {
      const error = new Error(message);
      error.statusCode = 403;
      throw error;
    }
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
      if (Number(employeeId) === Number(req.user.id)) {
        requireCapability(req.user, 'view_own_time', 'View Own Time permission required');
      } else {
        await requireScopedCapability(req.user, employeeId, 'view_employee_leave');
      }
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
          WHERE le.employee_id=$1
            AND le.leave_date BETWEEN $2::date AND $3::date
          ORDER BY le.leave_date, le.id`,
        [employeeId, period.pay_period_start, period.pay_period_end],
      );
      res.json({
        employee_id: employeeId,
        ...period,
        leave_entries: result.rows,
        can_manage_others: canManageOthers(req.user),
      });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message || 'Leave lookup failed' });
    }
  });

  router.post('/leave', requireUser, async (req, res) => {
    const client = await pool.connect();
    try {
      const employeeId = Number(req.body.employee_id || req.user.id);
      const onBehalf = employeeId !== Number(req.user.id);
      if (onBehalf) {
        await requireScopedCapability(req.user, employeeId, 'add_employee_leave');
      } else {
        requireCapability(req.user, 'request_leave', 'Request Leave permission required');
      }

      const type = String(req.body.leave_type || '').toLowerCase();
      if (!LEAVE_TYPES.includes(type)) {
        const error = new Error('Select a valid leave type');
        error.statusCode = 400;
        throw error;
      }

      const quarterHours = parseQuarterHours(req.body.hours);
      const dates = datesBetween(req.body.start_date, req.body.end_date, req.body.weekdays_only === true);
      const status = onBehalf ? 'approved' : 'pending';
      let note = String(req.body.note || '').trim() || null;
      const overrideConfirmed = req.body.override_daily_hours === true;
      const overrideReason = String(req.body.override_reason || '').trim();
      const supervisorReviewedHours = type === 'holiday' || type === 'floating_holiday';

      if (type === 'holiday') {
        validateFixedHolidayDates(dates);
        if (!note && dates.length === 1) note = findFixedHoliday(dates[0])?.name || null;
      }

      if (type === 'floating_holiday') {
        validateFloatingHolidayRequest(dates);
      }

      await client.query('BEGIN');

      if (type === 'floating_holiday') {
        const year = holidayYear(dates[0]);
        const existingFloating = await client.query(
          `SELECT id,status,leave_date
             FROM leave_entries
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

      const dailyChecks = [];
      for (const date of dates) {
        const totals = await client.query(
          `SELECT
             COALESCE(
               FLOOR(SUM(EXTRACT(EPOCH FROM (COALESCE(clock_out,NOW()) - clock_in)) / 900))
               + CASE
                   WHEN MOD(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(clock_out,NOW()) - clock_in)) / 60))::int, 15) > 5
                   THEN 1 ELSE 0
                 END,
               0
             )::int AS worked_quarters,
             COALESCE((
               SELECT SUM(quarter_hours)
                 FROM leave_entries
                WHERE employee_id=$1
                  AND leave_date=$2::date
                  AND status IN ('pending','approved')
             ),0)::int AS leave_quarters
             FROM time_entries
            WHERE employee_id=$1
              AND deleted_at IS NULL
              AND clock_in >= $2::date
              AND clock_in < ($2::date + INTERVAL '1 day')`,
          [employeeId, date],
        );

        const check = assessDailyPaidHours({
          workedQuarterHours: Number(totals.rows[0].worked_quarters || 0),
          existingLeaveQuarterHours: Number(totals.rows[0].leave_quarters || 0),
          proposedQuarterHours: quarterHours,
        });
        if (check.exceeds_standard_day) dailyChecks.push({ date, ...check });
      }

      if (dailyChecks.length && !supervisorReviewedHours && !overrideConfirmed) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Worked time plus leave exceeds 8 hours on one or more days',
          code: 'DAILY_PAID_HOURS_WARNING',
          requires_confirmation: true,
          daily_checks: dailyChecks,
        });
      }

      if (dailyChecks.length && !supervisorReviewedHours && !overrideReason) {
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
          [
            employeeId,
            date,
            type,
            quarterHours,
            entryNote,
            status,
            req.user.id,
            onBehalf ? req.user.id : null,
          ],
        );
        inserted.push(result.rows[0]);
      }

      await client.query('COMMIT');
      await audit(
        req.user.id,
        onBehalf ? 'add_leave_on_behalf' : 'request_leave',
        'employee',
        employeeId,
        {
          leave_type: type,
          dates,
          hours: quarterHours / 4,
          status,
          note,
          daily_hours_override: dailyChecks.length > 0,
          override_reason: overrideReason || null,
          daily_checks: dailyChecks,
        },
      );

      res.status(201).json({
        message: onBehalf ? 'Leave added and approved' : 'Leave submitted for approval',
        leave_entries: inserted,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'This employee already has a pending or approved Floating Holiday for that year',
        });
      }
      return res.status(err.statusCode || 500).json({ error: err.message || 'Leave entry failed' });
    } finally {
      client.release();
    }
  });

  router.post('/leave/:id/review', requireUser, async (req, res) => {
    try {
      const existing = await pool.query('SELECT * FROM leave_entries WHERE id=$1', [req.params.id]);
      if (!existing.rows.length) return res.status(404).json({ error: 'Leave entry not found' });

      if (existing.rows[0].status !== 'pending') {
        return res.status(409).json({ error: 'Only pending leave requests can be reviewed' });
      }

      const reviewingOwnLeave = Number(existing.rows[0].employee_id) === Number(req.user.id);
      if (reviewingOwnLeave) {
        requireCapability(req.user, 'approve_own_leave', 'Approve Own Leave permission required');
      } else {
        await requireScopedCapability(req.user, existing.rows[0].employee_id, 'approve_leave');
      }

      const status = String(req.body.status || '').toLowerCase();
      if (!['approved', 'denied'].includes(status)) {
        return res.status(400).json({ error: 'Status must be approved or denied' });
      }

      const note = String(req.body.review_note || '').trim() || null;
      const result = await pool.query(
        `UPDATE leave_entries
            SET status=$1,
                review_note=$2,
                reviewed_by_employee_id=$3,
                reviewed_at=NOW(),
                updated_at=NOW()
          WHERE id=$4
          RETURNING *, ROUND(quarter_hours / 4.0, 2) AS hours`,
        [status, note, req.user.id, req.params.id],
      );

      await audit(req.user.id, `leave_${status}`, 'leave_entry', req.params.id, {
        employee_id: existing.rows[0].employee_id,
        review_note: note,
      });
      return res.json({ message: `Leave ${status}`, leave_entry: result.rows[0] });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message || 'Leave review failed' });
    }
  });

  router.delete('/leave/:id', requireUser, async (req, res) => {
    try {
      const existing = await pool.query('SELECT * FROM leave_entries WHERE id=$1', [req.params.id]);
      if (!existing.rows.length) return res.status(404).json({ error: 'Leave entry not found' });
      const entry=existing.rows[0];
      if (['withdrawn','voided'].includes(entry.status)) {
        return res.status(409).json({ error: 'Leave entry is already archived' });
      }

      const ownEntry=Number(entry.employee_id)===Number(req.user.id);
      let archivedStatus;
      let auditAction;
      if(ownEntry){
        requireCapability(req.user,'withdraw_own_pending_request','Withdraw Pending Request permission required');
        if(entry.status!=='pending'){
          return res.status(409).json({ error: 'Only a pending leave request can be withdrawn by the employee' });
        }
        archivedStatus='withdrawn';
        auditAction='withdraw_leave';
      }else{
        await requireScopedCapability(req.user,entry.employee_id,'void_employee_leave');
        archivedStatus='voided';
        auditAction='void_leave';
      }

      const reason=String(req.body?.reason||'').trim()||null;
      const result=await pool.query(
        `UPDATE leave_entries
            SET status=$1,archived_at=NOW(),archived_by_employee_id=$2,
                archive_reason=$3,updated_at=NOW()
          WHERE id=$4
          RETURNING *,ROUND(quarter_hours / 4.0,2) AS hours`,
        [archivedStatus,req.user.id,reason,req.params.id],
      );
      await audit(req.user.id,auditAction,'leave_entry',req.params.id,{
        employee_id:entry.employee_id,
        previous_status:entry.status,
        status:archivedStatus,
        reason,
      });
      return res.json({
        message: ownEntry ? 'Leave request withdrawn' : 'Leave entry voided',
        leave_entry:result.rows[0],
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message || 'Leave archive failed' });
    }
  });

  router.post('/leave/submit-timecard-on-behalf', requireUser, async (req, res) => {
    try {
      const employeeId = Number(req.body.employee_id);
      if (!employeeId || employeeId === Number(req.user.id)) {
        return res.status(403).json({ error: 'An employee other than yourself is required' });
      }

      await requireScopedCapability(req.user, employeeId, 'submit_employee_timecard');
      const period = await getRequestedPayPeriod(req);
      const open = await pool.query(
        `SELECT id
           FROM time_entries
          WHERE employee_id=$1
            AND deleted_at IS NULL
            AND clock_in >= $2::date
            AND clock_in < ($3::date + INTERVAL '1 day')
            AND clock_out IS NULL`,
        [employeeId, period.pay_period_start, period.pay_period_end],
      );
      if (open.rows.length) {
        return res.status(400).json({ error: 'Clock out the employee before completing the timecard' });
      }

      const result = await pool.query(
        `INSERT INTO pay_period_approvals(
           employee_id,pay_period_start,pay_period_end,employee_signed_at,status
         ) VALUES($1,$2,$3,NOW(),'employee_submitted')
         ON CONFLICT(employee_id,pay_period_start,pay_period_end)
         DO UPDATE SET employee_signed_at=NOW(),
                       supervisor_approved_at=NULL,
                       supervisor_employee_id=NULL,
                       payroll_finalized_at=NULL,
                       payroll_finalized_by=NULL,
                       status='employee_submitted'
         RETURNING *`,
        [employeeId, period.pay_period_start, period.pay_period_end],
      );

      await audit(req.user.id, 'submit_timecard_on_behalf', 'employee', employeeId, {
        ...period,
        reason: String(req.body.reason || '').trim() || null,
      });
      return res.json({
        message: 'Timecard completed on behalf of employee and sent for supervisor review',
        approval: result.rows[0],
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message || 'Timecard completion failed' });
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
