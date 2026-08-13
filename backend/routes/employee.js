'use strict';

const express = require('express');

function createEmployeeRouter({ requireUser, requireAnyPermission, pool, audit, getRequestedPayPeriod }) {
  const router = express.Router();

  router.post('/submit-timecard', requireUser, requireAnyPermission('submit_timecard'), async (req, res) => {
    try {
      const period = await getRequestedPayPeriod(req);
      const openPunches = await pool.query(
        `SELECT id FROM time_entries
          WHERE employee_id=$1
            AND clock_in >= $2::date
            AND clock_in < ($3::date + INTERVAL '1 day')
            AND clock_out IS NULL`,
        [req.user.id, period.pay_period_start, period.pay_period_end],
      );
      if (openPunches.rows.length) {
        return res.status(400).json({ error: 'Clock out before submitting your timecard' });
      }

      const existingApproval = await pool.query(
        `SELECT * FROM pay_period_approvals
          WHERE employee_id=$1 AND pay_period_start=$2::date AND pay_period_end=$3::date
          ORDER BY id DESC LIMIT 1`,
        [req.user.id, period.pay_period_start, period.pay_period_end],
      );

      if (
        existingApproval.rows.length &&
        existingApproval.rows[0].employee_signed_at &&
        existingApproval.rows[0].status !== 'returned_to_employee'
      ) {
        return res.status(409).json({
          error: 'This timecard is already signed. It must be returned to you before it can be submitted again.',
        });
      }

      if (existingApproval.rows.length) {
        await pool.query(
          `UPDATE pay_period_approvals
              SET employee_signed_at=NOW(),
                  supervisor_approved_at=NULL,
                  payroll_finalized_at=NULL,
                  status='employee_submitted'
            WHERE id=$1`,
          [existingApproval.rows[0].id],
        );
      } else {
        await pool.query(
          `INSERT INTO pay_period_approvals(
             employee_id,pay_period_start,pay_period_end,employee_signed_at,status
           ) VALUES($1,$2,$3,NOW(),'employee_submitted')`,
          [req.user.id, period.pay_period_start, period.pay_period_end],
        );
      }
      await audit(req.user.id, 'submit_timecard', 'employee', req.user.id, period);
      return res.json({ message: 'Timecard submitted successfully' });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Submit timecard error' });
    }
  });

  router.get('/employee/my-timecard', requireUser, requireAnyPermission('view_own_time'), async (req, res) => {
    try {
      const period = await getRequestedPayPeriod(req);

      const approvalResult = await pool.query(
        `SELECT *
           FROM pay_period_approvals
          WHERE employee_id = $1
            AND pay_period_start = $2::date
            AND pay_period_end = $3::date`,
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
            ROUND((EXTRACT(EPOCH FROM (COALESCE(clock_out, now()) - clock_in)) / 3600)::numeric, 2) AS hours_worked
           FROM time_entries
          WHERE employee_id = $1
            AND clock_in >= $2::date
            AND clock_in < ($3::date + interval '1 day')
          ORDER BY clock_in`,
        [req.user.id, period.pay_period_start, period.pay_period_end],
      );

      const requestsResult = await pool.query(
        `SELECT
            tcr.*,
            to_char(created_at, 'MM/DD/YYYY HH12:MI AM') AS created_at_display,
            to_char(reviewed_at, 'MM/DD/YYYY HH12:MI AM') AS reviewed_at_display
           FROM time_change_requests tcr
          WHERE employee_id = $1
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
        requests: requestsResult.rows,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).send('Employee timecard error');
    }
  });

  router.post(
    '/employee/edit-time-entry',
    requireUser,
    requireAnyPermission('request_punch_correction', 'submit_timecard'),
    async (req, res) => {
      const { time_entry_id, new_clock_in, new_clock_out, reason } = req.body;

      if (!time_entry_id || !new_clock_in || !reason?.trim()) {
        return res.status(400).json({ error: 'Time entry, clock in, and reason are required' });
      }

      try {
        const entryResult = await pool.query('SELECT * FROM time_entries WHERE id=$1', [time_entry_id]);
        if (!entryResult.rows.length) return res.status(404).json({ error: 'Time entry not found' });

        const existing = entryResult.rows[0];
        if (Number(existing.employee_id) !== Number(req.user.id)) {
          return res.status(403).json({ error: 'Cannot modify another employee' });
        }

        const approvalResult = await pool.query(
          `SELECT * FROM pay_period_approvals
            WHERE employee_id=$1
              AND $2::timestamp >= pay_period_start
              AND $2::timestamp < (pay_period_end + interval '1 day')
            ORDER BY id DESC LIMIT 1`,
          [req.user.id, existing.clock_in],
        );
        const approval = approvalResult.rows[0] || null;

        if (approval?.employee_signed_at && approval.status !== 'returned_to_employee') {
          return res.status(409).json({
            error: 'This timecard is signed. It must be returned to you before you can edit it.',
          });
        }

        const finalClockOut = new_clock_out && new_clock_out.trim() !== '' ? new_clock_out : null;
        if (finalClockOut && new Date(finalClockOut) <= new Date(new_clock_in)) {
          return res.status(400).json({ error: 'Clock out must be after clock in' });
        }

        await pool.query(
          `INSERT INTO time_entry_audit(
             time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,
             new_clock_in,new_clock_out,reason
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [existing.id, req.user.id, existing.clock_in, existing.clock_out, new_clock_in, finalClockOut, reason.trim()],
        );

        const updated = await pool.query(
          `UPDATE time_entries
              SET clock_in=$1,
                  clock_out=$2,
                  status=CASE WHEN $2::timestamp IS NULL THEN 'open' ELSE 'closed' END
            WHERE id=$3
            RETURNING *`,
          [new_clock_in, finalClockOut, existing.id],
        );

        if (approval) {
          await pool.query(
            `UPDATE pay_period_approvals
                SET employee_signed_at=NULL,
                    supervisor_approved_at=NULL,
                    supervisor_employee_id=NULL,
                    payroll_finalized_at=NULL,
                    payroll_finalized_by=NULL,
                    status='open'
              WHERE id=$1`,
            [approval.id],
          );
        }

        await audit(req.user.id, 'employee_edit_time_entry', 'time_entry', existing.id, { reason: reason.trim() });
        return res.json({ message: 'Time entry updated', entry: updated.rows[0] });
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Edit time entry error' });
      }
    },
  );

  router.post(
    '/employee/request-time-change',
    requireUser,
    requireAnyPermission('request_punch_correction'),
    async (req, res) => {
      const { time_entry_id, requested_clock_in, requested_clock_out, employee_reason } = req.body;

      try {
        if (!requested_clock_in && !requested_clock_out) {
          return res.status(400).json({ error: 'Select a clock in time, clock out time, or both' });
        }
        if (!employee_reason || !employee_reason.trim()) {
          return res.status(400).json({ error: 'Reason is required' });
        }

        const entryResult = await pool.query('SELECT * FROM time_entries WHERE id = $1', [time_entry_id]);
        if (entryResult.rows.length === 0) return res.status(404).json({ error: 'Time entry not found' });

        const entry = entryResult.rows[0];
        if (Number(entry.employee_id) !== Number(req.user.id)) {
          return res.status(403).json({ error: 'Cannot modify another employee' });
        }

        await pool.query(
          `INSERT INTO time_change_requests (
             employee_id,time_entry_id,requested_clock_in,requested_clock_out,employee_reason,status
           ) VALUES ($1,$2,$3,$4,$5,'pending')`,
          [req.user.id, time_entry_id, requested_clock_in, requested_clock_out, employee_reason],
        );

        return res.json({ message: 'Time change request submitted' });
      } catch (err) {
        console.error(err);
        return res.status(500).send('Time change request error');
      }
    },
  );

  return router;
}

module.exports = { createEmployeeRouter };
