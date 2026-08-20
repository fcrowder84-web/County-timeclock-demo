'use strict';

const express = require('express');
const { summarizeTimecard } = require('../lib/timecard-summary');

function validDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createEmployeeRouter({ requireUser, requireAnyPermission, pool, audit, getRequestedPayPeriod }) {
  const router = express.Router();

  router.post('/submit-timecard', requireUser, requireAnyPermission('submit_timecard'), async (req, res) => {
    const client = await pool.connect();
    try {
      const period = await getRequestedPayPeriod(req);
      await client.query('BEGIN');

      const openPunches = await client.query(
        `SELECT id
           FROM time_entries
          WHERE employee_id=$1
            AND deleted_at IS NULL
            AND clock_in >= $2::date
            AND clock_in < ($3::date + INTERVAL '1 day')
            AND clock_out IS NULL`,
        [req.user.id, period.pay_period_start, period.pay_period_end],
      );
      if (openPunches.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Clock out before submitting your timecard' });
      }

      const existingApproval = await client.query(
        `SELECT *
           FROM pay_period_approvals
          WHERE employee_id=$1
            AND pay_period_start=$2::date
            AND pay_period_end=$3::date
          ORDER BY id DESC
          LIMIT 1
          FOR UPDATE`,
        [req.user.id, period.pay_period_start, period.pay_period_end],
      );

      const existing = existingApproval.rows[0] || null;
      if (existing?.employee_signed_at && existing.status !== 'returned_to_employee') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'This timecard is already signed. It must be returned to you before it can be submitted again.',
        });
      }

      if (existing) {
        await client.query(
          `UPDATE pay_period_approvals
              SET employee_signed_at=NOW(),
                  supervisor_approved_at=NULL,
                  supervisor_employee_id=NULL,
                  payroll_finalized_at=NULL,
                  payroll_finalized_by=NULL,
                  status='employee_submitted'
            WHERE id=$1`,
          [existing.id],
        );
      } else {
        await client.query(
          `INSERT INTO pay_period_approvals(
             employee_id,pay_period_start,pay_period_end,employee_signed_at,status
           ) VALUES($1,$2,$3,NOW(),'employee_submitted')`,
          [req.user.id, period.pay_period_start, period.pay_period_end],
        );
      }

      await client.query('COMMIT');
      await audit(req.user.id, 'submit_timecard', 'employee', req.user.id, period);
      return res.json({ message: 'Timecard submitted successfully' });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      return res.status(500).json({ error: 'Submit timecard error' });
    } finally {
      client.release();
    }
  });

  router.get('/employee/my-timecard', requireUser, requireAnyPermission('view_own_time'), async (req, res) => {
    try {
      const period = await getRequestedPayPeriod(req);

      const approvalResult = await pool.query(
        `SELECT *
           FROM pay_period_approvals
          WHERE employee_id=$1
            AND pay_period_start=$2::date
            AND pay_period_end=$3::date`,
        [req.user.id, period.pay_period_start, period.pay_period_end],
      );

      const entriesResult = await pool.query(
        `SELECT
           id,
           clock_in,
           clock_out,
           to_char(clock_in, 'YYYY-MM-DD') AS entry_date_iso,
           to_char(clock_in, 'MM/DD/YYYY') AS entry_date,
           to_char(clock_in, 'HH12:MI AM') AS clock_in_display,
           to_char(clock_in, 'HH24:MI') AS clock_in_24,
           CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out, 'HH12:MI AM') END AS clock_out_display,
           CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out, 'HH24:MI') END AS clock_out_24,
           ROUND((EXTRACT(EPOCH FROM (COALESCE(clock_out, NOW()) - clock_in)) / 3600)::numeric, 2) AS hours_worked
         FROM time_entries
        WHERE employee_id=$1
          AND deleted_at IS NULL
          AND clock_in >= $2::date
          AND clock_in < ($3::date + INTERVAL '1 day')
        ORDER BY clock_in`,
        [req.user.id, period.pay_period_start, period.pay_period_end],
      );

      const leaveResult = await pool.query(
        `SELECT
           id,
           to_char(leave_date, 'YYYY-MM-DD') AS leave_date_iso,
           to_char(leave_date, 'MM/DD/YYYY') AS leave_date_display,
           leave_type,
           ROUND(quarter_hours / 4.0, 2) AS hours,
           status,
           note,
           review_note
         FROM leave_entries
        WHERE employee_id=$1
          AND leave_date BETWEEN $2::date AND $3::date
        ORDER BY leave_date,id`,
        [req.user.id, period.pay_period_start, period.pay_period_end],
      );

      const requestsResult = await pool.query(
        `SELECT
           tcr.*,
           to_char(created_at, 'MM/DD/YYYY HH12:MI AM') AS created_at_display,
           to_char(reviewed_at, 'MM/DD/YYYY HH12:MI AM') AS reviewed_at_display
         FROM time_change_requests tcr
        WHERE employee_id=$1
        ORDER BY created_at DESC`,
        [req.user.id],
      );

      const approval = approvalResult.rows[0] || null;
      const canEditEntries = !approval?.employee_signed_at || approval?.status === 'returned_to_employee';

      return res.json({
        employee: req.user,
        pay_period_start: period.pay_period_start,
        pay_period_end: period.pay_period_end,
        approval,
        can_edit_entries: canEditEntries,
        entries: entriesResult.rows,
        leave_entries: leaveResult.rows,
        timecard_summary: summarizeTimecard({
          entries: entriesResult.rows,
          leaveEntries: leaveResult.rows,
          payPeriodStart: period.pay_period_start,
        }),
        requests: requestsResult.rows,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Employee timecard error' });
    }
  });

  // Employees do not directly rewrite punch history.  They request a change
  // and a supervisor approves it; deletion is handled separately through the
  // auditable soft-delete route.
  router.post(
    '/employee/edit-time-entry',
    requireUser,
    requireAnyPermission('request_punch_correction'),
    (_req, res) => res.status(403).json({
      error: 'Employee time changes must be submitted for supervisor approval',
    }),
  );

  router.post(
    '/employee/request-time-change',
    requireUser,
    requireAnyPermission('request_punch_correction'),
    async (req, res) => {
      const entryId = Number(req.body?.time_entry_id);
      const requestedClockIn = req.body?.requested_clock_in || null;
      const requestedClockOut = req.body?.requested_clock_out || null;
      const reason = String(req.body?.employee_reason || '').trim();

      if (!Number.isInteger(entryId) || entryId <= 0) {
        return res.status(400).json({ error: 'Valid time entry is required' });
      }
      if (!requestedClockIn && !requestedClockOut) {
        return res.status(400).json({ error: 'Select a clock in time, clock out time, or both' });
      }
      if (!reason) {
        return res.status(400).json({ error: 'Reason is required' });
      }
      if (reason.length > 1000) {
        return res.status(400).json({ error: 'Reason must be 1000 characters or less' });
      }
      if (requestedClockIn && !validDate(requestedClockIn)) {
        return res.status(400).json({ error: 'Requested clock in is invalid' });
      }
      if (requestedClockOut && !validDate(requestedClockOut)) {
        return res.status(400).json({ error: 'Requested clock out is invalid' });
      }

      try {
        const entryResult = await pool.query(
          `SELECT *
             FROM time_entries
            WHERE id=$1
              AND deleted_at IS NULL`,
          [entryId],
        );
        if (!entryResult.rows.length) {
          return res.status(404).json({ error: 'Time entry not found' });
        }

        const entry = entryResult.rows[0];
        if (Number(entry.employee_id) !== Number(req.user.id)) {
          return res.status(403).json({ error: 'Cannot modify another employee' });
        }

        const effectiveClockIn = validDate(requestedClockIn || entry.clock_in);
        const effectiveClockOut = requestedClockOut
          ? validDate(requestedClockOut)
          : (entry.clock_out ? validDate(entry.clock_out) : null);

        if (!effectiveClockIn) {
          return res.status(400).json({ error: 'Clock in is invalid' });
        }
        if (effectiveClockOut && effectiveClockOut <= effectiveClockIn) {
          return res.status(400).json({
            error: 'Clock out must be after clock in. Check AM/PM and the date.',
          });
        }

        await pool.query(
          `INSERT INTO time_change_requests(
             employee_id,time_entry_id,requested_clock_in,requested_clock_out,employee_reason,status
           ) VALUES($1,$2,$3,$4,$5,'pending')`,
          [req.user.id, entryId, requestedClockIn, requestedClockOut, reason],
        );

        return res.json({ message: 'Time change request submitted' });
      } catch (err) {
        if (err.code === '23514') {
          return res.status(400).json({
            error: 'Clock out must be after clock in. Check AM/PM and the date.',
          });
        }
        console.error(err);
        return res.status(500).json({ error: 'Time change request error' });
      }
    },
  );

  return router;
}

module.exports = { createEmployeeRouter, validDate };
