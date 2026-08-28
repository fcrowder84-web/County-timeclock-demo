'use strict';

const express = require('express');
const { summarizeTimecard } = require('../lib/timecard-summary');
const { insertPunchIntoSequence } = require('../lib/punch-sequence');
const { createApproveSinglePunchHandler } = require('../lib/approve-single-punch');

function validDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function permissionSet(user) {
  return new Set(Array.isArray(user?.permissions) ? user.permissions : []);
}

function hasPermission(user, key) {
  const permissions = permissionSet(user);
  return permissions.has('app_admin') || permissions.has(key);
}

async function canDirectEditEmployee(pool, user, employeeId) {
  if (Number(user?.id) === Number(employeeId)) return false;
  const role = String(user?.role || '').toLowerCase();
  const permissions = permissionSet(user);
  if (permissions.has('app_admin') || permissions.has('edit_payroll_time') || role === 'payroll' || role === 'admin') {
    return true;
  }
  if (!permissions.has('add_employee_entry') && !permissions.has('edit_employee_time')) return false;

  const result = await pool.query(
    `SELECT 1
       FROM employees target
      WHERE target.id=$1
        AND (
          target.department_id=$2
          OR EXISTS (
            SELECT 1
              FROM supervisor_employee_assignments sea
             WHERE sea.employee_id=target.id
               AND sea.supervisor_employee_id=$3
               AND sea.active=TRUE
          )
          OR EXISTS (
            SELECT 1
              FROM department_heads dh
             WHERE dh.department_id=target.department_id
               AND dh.employee_id=$3
               AND dh.active=TRUE
          )
        )
      LIMIT 1`,
    [employeeId, user.department_id, user.id],
  );
  return result.rows.length > 0;
}

async function approvalForTimestamp(db, employeeId, timestamp, lock = false) {
  return db.query(
    `SELECT *
       FROM pay_period_approvals
      WHERE employee_id=$1
        AND $2::timestamp >= pay_period_start
        AND $2::timestamp < (pay_period_end + INTERVAL '1 day')
      ORDER BY id DESC
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [employeeId, timestamp],
  );
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
           to_char(requested_clock_in, 'MM/DD/YYYY HH12:MI AM') AS requested_clock_in_display,
           to_char(requested_clock_out, 'MM/DD/YYYY HH12:MI AM') AS requested_clock_out_display,
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
    requireAnyPermission('request_punch_correction', 'view_own_time'),
    async (req, res) => {
      const rawEntryId = req.body?.time_entry_id;
      const hasEntryId = rawEntryId !== null && rawEntryId !== undefined && String(rawEntryId).trim() !== '';
      const entryId = hasEntryId ? Number(rawEntryId) : null;
      const requestedPunch = req.body?.requested_punch || null;
      const requestedClockIn = req.body?.requested_clock_in || null;
      const requestedClockOut = req.body?.requested_clock_out || null;
      const reason = String(req.body?.employee_reason || '').trim();

      if (hasEntryId && (!Number.isInteger(entryId) || entryId <= 0)) {
        return res.status(400).json({ error: 'Valid time entry is required' });
      }
      if (!requestedPunch && !requestedClockIn && !requestedClockOut) {
        return res.status(400).json({ error: 'Enter a punch date and time' });
      }
      if (!reason) return res.status(400).json({ error: 'Reason is required' });
      if (reason.length > 1000) return res.status(400).json({ error: 'Reason must be 1000 characters or less' });

      const parsedRequestedPunch = requestedPunch ? validDate(requestedPunch) : null;
      const parsedRequestedIn = requestedClockIn ? validDate(requestedClockIn) : null;
      const parsedRequestedOut = requestedClockOut ? validDate(requestedClockOut) : null;
      if (requestedPunch && !parsedRequestedPunch) return res.status(400).json({ error: 'Requested punch is invalid' });
      if (requestedClockIn && !parsedRequestedIn) return res.status(400).json({ error: 'Requested clock in is invalid' });
      if (requestedClockOut && !parsedRequestedOut) return res.status(400).json({ error: 'Requested clock out is invalid' });

      try {
        // Add Punch requests are stored as one independent punch event.
        // Approval inserts that timestamp into the day's chronological event
        // stream and rebuilds the in/out pairing.
        if (parsedRequestedPunch) {
          const approvalResult = await approvalForTimestamp(pool, req.user.id, requestedPunch);
          const approval = approvalResult.rows[0] || null;
          if (approval?.employee_signed_at && approval.status !== 'returned_to_employee') {
            return res.status(409).json({
              error: 'This timecard is signed and locked. Your supervisor must return it before you can request another change.',
            });
          }

          const actualDuplicate = await pool.query(
            `SELECT id
               FROM time_entries
              WHERE employee_id=$1
                AND deleted_at IS NULL
                AND (clock_in=$2::timestamp OR clock_out=$2::timestamp)
              LIMIT 1`,
            [req.user.id, requestedPunch],
          );
          if (actualDuplicate.rows.length) return res.status(409).json({ error: 'That punch already exists' });

          const pendingDuplicate = await pool.query(
            `SELECT id
               FROM time_change_requests
              WHERE employee_id=$1
                AND time_entry_id IS NULL
                AND status='pending'
                AND requested_clock_in=$2::timestamp
                AND requested_clock_out IS NULL
              LIMIT 1`,
            [req.user.id, requestedPunch],
          );
          if (pendingDuplicate.rows.length) return res.status(409).json({ error: 'That punch request is already pending' });

          const inserted = await pool.query(
            `INSERT INTO time_change_requests(
               employee_id,time_entry_id,requested_clock_in,requested_clock_out,employee_reason,status
             ) VALUES($1,NULL,$2,NULL,$3,'pending')
             RETURNING id`,
            [req.user.id, requestedPunch, reason],
          );
          await audit(req.user.id, 'request_single_punch', 'time_change_request', inserted.rows[0].id, {
            requested_punch: requestedPunch,
          });
          return res.json({
            message: 'Punch request received and waiting for supervisor approval',
            request_id: inserted.rows[0].id,
          });
        }

        let entry = null;
        if (hasEntryId) {
          const entryResult = await pool.query(
            `SELECT * FROM time_entries WHERE id=$1 AND deleted_at IS NULL`,
            [entryId],
          );
          if (!entryResult.rows.length) return res.status(404).json({ error: 'Time entry not found' });
          entry = entryResult.rows[0];
          if (Number(entry.employee_id) !== Number(req.user.id)) return res.status(403).json({ error: 'Cannot modify another employee' });
        } else if (!requestedClockIn || !requestedClockOut) {
          return res.status(400).json({ error: 'Clock in and clock out are both required for the older missing-workday form' });
        }

        const effectiveClockIn = parsedRequestedIn || validDate(entry?.clock_in);
        const effectiveClockOut = parsedRequestedOut || (entry?.clock_out ? validDate(entry.clock_out) : null);
        if (!effectiveClockIn) return res.status(400).json({ error: 'Clock in is invalid' });
        if (effectiveClockOut && effectiveClockOut <= effectiveClockIn) {
          return res.status(400).json({ error: 'Clock out must be after clock in. Check AM/PM and the date.' });
        }

        const approvalResult = await approvalForTimestamp(pool, req.user.id, effectiveClockIn);
        const approval = approvalResult.rows[0] || null;
        if (approval?.employee_signed_at && approval.status !== 'returned_to_employee') {
          return res.status(409).json({
            error: 'This timecard is signed and locked. Your supervisor must return it before you can request another change.',
          });
        }

        const duplicate = await pool.query(
          `SELECT id
             FROM time_change_requests
            WHERE employee_id=$1
              AND status='pending'
              AND time_entry_id IS NOT DISTINCT FROM $2::int
              AND requested_clock_in IS NOT DISTINCT FROM $3::timestamp
              AND requested_clock_out IS NOT DISTINCT FROM $4::timestamp
            LIMIT 1`,
          [req.user.id, entryId, requestedClockIn, requestedClockOut],
        );
        if (duplicate.rows.length) return res.status(409).json({ error: 'That punch request is already pending' });

        const inserted = await pool.query(
          `INSERT INTO time_change_requests(
             employee_id,time_entry_id,requested_clock_in,requested_clock_out,employee_reason,status
           ) VALUES($1,$2,$3,$4,$5,'pending')
           RETURNING id`,
          [req.user.id, entryId, requestedClockIn, requestedClockOut, reason],
        );
        await audit(req.user.id, hasEntryId ? 'request_time_change' : 'request_missing_time', 'time_change_request', inserted.rows[0].id, {
          time_entry_id: entryId,
          requested_clock_in: requestedClockIn,
          requested_clock_out: requestedClockOut,
        });
        return res.json({
          message: hasEntryId ? 'Time change request submitted' : 'Missing time request submitted',
          request_id: inserted.rows[0].id,
        });
      } catch (err) {
        if (err.code === '23514') {
          return res.status(400).json({ error: 'Clock out must be after clock in. Check AM/PM and the date.' });
        }
        console.error(err);
        return res.status(500).json({ error: 'Time change request error' });
      }
    },
  );

  router.post(
    '/supervisor/add-time-entry',
    requireUser,
    requireAnyPermission('add_employee_entry', 'edit_employee_time', 'edit_payroll_time', 'app_admin'),
    async (req, res) => {
      const employeeId = Number(req.body?.employee_id);
      const punchAt = req.body?.punch_at || null;
      const legacyClockIn = req.body?.clock_in || null;
      const legacyClockOut = req.body?.clock_out || null;
      const reason = String(req.body?.reason || '').trim();

      if (!Number.isInteger(employeeId) || employeeId <= 0) return res.status(400).json({ error: 'Valid employee is required' });
      if (!reason) return res.status(400).json({ error: 'Reason is required' });
      if (reason.length > 500) return res.status(400).json({ error: 'Reason must be 500 characters or less' });
      if (!(await canDirectEditEmployee(pool, req.user, employeeId))) return res.status(403).json({ error: 'Access denied' });

      const payrollOverride = hasPermission(req.user, 'edit_payroll_time') || ['payroll','admin'].includes(String(req.user.role || '').toLowerCase());
      const primaryTimestamp = punchAt || legacyClockIn;
      if (!validDate(primaryTimestamp)) return res.status(400).json({ error: 'Valid punch date and time are required' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const approvalResult = await approvalForTimestamp(client, employeeId, primaryTimestamp, true);
        const approval = approvalResult.rows[0] || null;
        if (!payrollOverride) {
          const supervisorUnlocked = approval?.employee_signed_at && !approval?.supervisor_approved_at && !approval?.payroll_finalized_at && approval?.status === 'employee_submitted';
          if (!supervisorUnlocked) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'This timecard is locked for supervisor editing. Return it to the correct stage before adding a punch.' });
          }
        }

        if (!punchAt) {
          const parsedIn = validDate(legacyClockIn);
          const parsedOut = legacyClockOut ? validDate(legacyClockOut) : null;
          if (!parsedIn || (legacyClockOut && !parsedOut)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Valid clock in/out values are required' });
          }
          if (parsedOut && parsedOut <= parsedIn) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Clock out must be after clock in' });
          }
          const result = await client.query(
            `INSERT INTO time_entries(employee_id,clock_in,clock_out,notes,status)
             VALUES($1,$2,$3,$4,CASE WHEN $3::timestamp IS NULL THEN 'open' ELSE 'closed' END)
             RETURNING *`,
            [employeeId, legacyClockIn, legacyClockOut, reason],
          );
          await client.query('COMMIT');
          await audit(req.user.id, 'add_time_entry_legacy', 'time_entry', result.rows[0].id, { employee_id: employeeId, reason });
          return res.json({ message: 'Time entry added', entry: result.rows[0] });
        }

        const placed = await insertPunchIntoSequence({
          client,
          employeeId,
          punchAt,
          actorEmployeeId: req.user.id,
          reason,
        });
        const invalidated = await client.query(
          `UPDATE pay_period_approvals
              SET supervisor_approved_at=NULL,
                  supervisor_employee_id=NULL,
                  payroll_finalized_at=NULL,
                  payroll_finalized_by=NULL,
                  status=CASE WHEN employee_signed_at IS NULL THEN 'open' ELSE 'employee_submitted' END
            WHERE employee_id=$1
              AND $2::timestamp >= pay_period_start
              AND $2::timestamp < (pay_period_end + INTERVAL '1 day')
            RETURNING id`,
          [employeeId, punchAt],
        );
        await client.query('COMMIT');
        await audit(req.user.id, 'add_single_punch', 'employee', employeeId, {
          punch_at: punchAt,
          inferred_punch_type: placed.inferred_punch_type,
          reason,
          invalidated_approval_ids: invalidated.rows.map((row) => row.id),
        });
        return res.json({
          message: `Punch added as ${placed.inferred_punch_type === 'clock_out' ? 'clock out' : 'clock in'}`,
          inferred_punch_type: placed.inferred_punch_type,
          entries: placed.entries,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        if (err.code === '23505') return res.status(409).json({ error: 'This punch would create a conflicting open punch' });
        if (err.code === '23514') return res.status(400).json({ error: 'Clock out must be after clock in' });
        console.error(err);
        return res.status(500).json({ error: 'Add punch error' });
      } finally {
        client.release();
      }
    },
  );

  router.post(
    '/supervisor/approve-single-punch',
    requireUser,
    requireAnyPermission('approve_punch_correction'),
    createApproveSinglePunchHandler({ pool, audit }),
  );

  return router;
}

module.exports = { createEmployeeRouter, validDate, canDirectEditEmployee };
