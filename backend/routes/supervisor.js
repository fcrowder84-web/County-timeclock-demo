'use strict';

const express = require('express');
const { summarizeTimecard } = require('../lib/timecard-summary');

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`Valid ${label} is required`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function parseTimestamp(value, label) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    const error = new Error(`Valid ${label} is required`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function createSupervisorRouter({
  requireUser,
  requireAnyPermission,
  pool,
  audit,
  canAccessEmployee,
  getRequestedPayPeriod,
  userHasPermission,
}) {
  const router = express.Router();

  router.get(
    '/supervisor/pay-period-status',
    requireUser,
    requireAnyPermission(
      'view_assigned_employees',
      'view_department_time',
      'view_live_status',
      'view_payroll_records',
      'view_all_timeclock_records',
    ),
    async (req, res) => {
      try {
        const period = await getRequestedPayPeriod(req);
        const result = await pool.query(
          `SELECT
             e.id,
             e.first_name,
             e.last_name,
             d.name AS department,
             e.role,
             ppa.status,
             ppa.employee_signed_at,
             ppa.supervisor_approved_at,
             ROUND(
               COALESCE((
                 SELECT SUM(
                   FLOOR(daily.day_minutes / 15.0) * 15
                   + CASE WHEN MOD(daily.day_minutes, 15) > 5 THEN 15 ELSE 0 END
                 ) / 60.0
                 FROM (
                   SELECT ROUND(SUM(
                     EXTRACT(EPOCH FROM (COALESCE(day_entry.clock_out,NOW()) - day_entry.clock_in)) / 60
                   ))::int AS day_minutes
                   FROM time_entries day_entry
                   WHERE day_entry.employee_id=e.id
                     AND day_entry.deleted_at IS NULL
                     AND day_entry.clock_in >= $1::date
                     AND day_entry.clock_in < ($2::date + INTERVAL '1 day')
                   GROUP BY day_entry.clock_in::date
                 ) daily
               ),0)::numeric,
               2
             ) AS total_hours,
             COALESCE((
               SELECT COUNT(*)
               FROM leave_entries pending_leave
               WHERE pending_leave.employee_id=e.id
                 AND pending_leave.leave_date BETWEEN $1::date AND $2::date
                 AND pending_leave.status='pending'
             ),0)::int AS pending_leave_count,
             COALESCE((
               SELECT COUNT(*)
               FROM time_change_requests pending_change
               LEFT JOIN time_entries change_entry ON change_entry.id=pending_change.time_entry_id
               WHERE pending_change.employee_id=e.id
                 AND pending_change.status='pending'
                 AND (pending_change.time_entry_id IS NULL OR change_entry.deleted_at IS NULL)
                 AND (
                   (change_entry.clock_in >= $1::date AND change_entry.clock_in < ($2::date + INTERVAL '1 day'))
                   OR
                   (pending_change.requested_clock_in >= $1::date AND pending_change.requested_clock_in < ($2::date + INTERVAL '1 day'))
                 )
             ),0)::int AS pending_change_count
           FROM employees e
           LEFT JOIN departments d ON d.id=e.department_id
           LEFT JOIN pay_period_approvals ppa
             ON ppa.employee_id=e.id
            AND ppa.pay_period_start=$1::date
            AND ppa.pay_period_end=$2::date
           WHERE (
             e.active=TRUE
             OR ppa.id IS NOT NULL
             OR EXISTS (
               SELECT 1
               FROM time_entries period_te
               WHERE period_te.employee_id=e.id
                 AND period_te.deleted_at IS NULL
                 AND period_te.clock_in >= $1::date
                 AND period_te.clock_in < ($2::date + INTERVAL '1 day')
             )
           )
           AND (
             $3::text IN ('admin','payroll')
             OR e.id IN (
               SELECT employee_id
               FROM supervisor_employee_assignments
               WHERE supervisor_employee_id=$4 AND active=TRUE
             )
             OR e.department_id IN (
               SELECT department_id
               FROM department_heads
               WHERE employee_id=$4 AND active=TRUE
             )
           )
           GROUP BY e.id,e.first_name,e.last_name,d.name,e.role,
                    ppa.status,ppa.employee_signed_at,ppa.supervisor_approved_at
           ORDER BY d.name,e.last_name`,
          [period.pay_period_start, period.pay_period_end, req.user.role, req.user.id],
        );

        return res.json({
          pay_period_start: period.pay_period_start,
          pay_period_end: period.pay_period_end,
          employees: result.rows,
        });
      } catch (err) {
        console.error(err);
        return res.status(err.statusCode || 500).json({ error: err.message || 'Supervisor status error' });
      }
    },
  );

  router.get(
    '/supervisor/change-requests',
    requireUser,
    requireAnyPermission('approve_punch_correction'),
    async (req, res) => {
      try {
        const result = await pool.query(
          `SELECT
             tcr.*,
             e.first_name,
             e.last_name,
             d.name AS department,
             to_char(tcr.requested_clock_in,'MM/DD/YYYY HH12:MI AM') AS requested_clock_in_display,
             to_char(tcr.requested_clock_out,'MM/DD/YYYY HH12:MI AM') AS requested_clock_out_display,
             to_char(tcr.created_at,'MM/DD/YYYY HH12:MI AM') AS created_at_display
           FROM time_change_requests tcr
           LEFT JOIN time_entries te ON te.id=tcr.time_entry_id
           JOIN employees e ON e.id=tcr.employee_id
           LEFT JOIN departments d ON d.id=e.department_id
           WHERE tcr.status='pending'
             AND (tcr.time_entry_id IS NULL OR te.deleted_at IS NULL)
             AND (
               $1::text IN ('admin','payroll')
               OR e.id IN (
                 SELECT employee_id FROM supervisor_employee_assignments
                 WHERE supervisor_employee_id=$2 AND active=TRUE
               )
               OR e.department_id IN (
                 SELECT department_id FROM department_heads
                 WHERE employee_id=$2 AND active=TRUE
               )
             )
           ORDER BY tcr.created_at`,
          [req.user.role, req.user.id],
        );
        return res.json(result.rows);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Change request lookup failed' });
      }
    },
  );

  router.post(
    '/supervisor/approve-change-request',
    requireUser,
    requireAnyPermission('approve_punch_correction'),
    async (req, res) => {
      let client = null;
      try {
        const requestId = parsePositiveInt(req.body?.request_id, 'change request');
        const supervisorNote = String(req.body?.supervisor_note || '').trim();

        const target = await pool.query(
          `SELECT employee_id,status FROM time_change_requests WHERE id=$1`,
          [requestId],
        );
        if (!target.rows.length) return res.status(404).json({ error: 'Request not found' });
        if (target.rows[0].status !== 'pending') {
          return res.status(409).json({ error: 'This change request has already been reviewed' });
        }
        if (!(await canAccessEmployee(req.user, target.rows[0].employee_id, ['approve_punch_correction']))) {
          return res.status(403).json({ error: 'Access denied' });
        }

        client = await pool.connect();
        await client.query('BEGIN');

        const requestResult = await client.query(
          `SELECT * FROM time_change_requests WHERE id=$1 FOR UPDATE`,
          [requestId],
        );
        const request = requestResult.rows[0] || null;
        if (!request) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Request not found' });
        }
        if (request.status !== 'pending') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This change request has already been reviewed' });
        }

        let existing = null;
        if (request.time_entry_id != null) {
          const existingResult = await client.query(
            `SELECT *
               FROM time_entries
              WHERE id=$1
                AND employee_id=$2
                AND deleted_at IS NULL
              FOR UPDATE`,
            [request.time_entry_id, request.employee_id],
          );
          existing = existingResult.rows[0] || null;
          if (!existing) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Original time entry not found' });
          }
        }

        const newClockIn = request.requested_clock_in ?? existing?.clock_in ?? null;
        const newClockOut = request.requested_clock_out ?? existing?.clock_out ?? null;
        if (!newClockIn) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Clock in is required' });
        }
        if (!existing && !newClockOut) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Clock out is required for a missing workday request' });
        }

        const parsedIn = parseTimestamp(newClockIn, 'clock in');
        if (newClockOut != null) {
          const parsedOut = parseTimestamp(newClockOut, 'clock out');
          if (parsedOut <= parsedIn) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Clock out must be after clock in' });
          }
        }

        let updatedEntry;
        if (existing) {
          await client.query(
            `INSERT INTO time_entry_audit(
               time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,
               new_clock_in,new_clock_out,reason
             ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              existing.id,
              req.user.id,
              existing.clock_in,
              existing.clock_out,
              newClockIn,
              newClockOut,
              request.employee_reason,
            ],
          );

          updatedEntry = await client.query(
            `UPDATE time_entries
                SET clock_in=$1,
                    clock_out=$2,
                    status=CASE WHEN $2::timestamp IS NULL THEN 'open' ELSE 'closed' END
              WHERE id=$3
                AND deleted_at IS NULL
              RETURNING *`,
            [newClockIn, newClockOut, existing.id],
          );
          if (!updatedEntry.rows.length) throw new Error('Time entry changed while request was being approved');
        } else {
          const overlap = await client.query(
            `SELECT id
               FROM time_entries
              WHERE employee_id=$1
                AND deleted_at IS NULL
                AND clock_in < $3::timestamp
                AND COALESCE(clock_out,NOW()) > $2::timestamp
              LIMIT 1
              FOR UPDATE`,
            [request.employee_id, newClockIn, newClockOut],
          );
          if (overlap.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'The requested missing time overlaps an existing punch. Edit the existing punch instead.',
            });
          }

          updatedEntry = await client.query(
            `INSERT INTO time_entries(employee_id,clock_in,clock_out,notes,status)
             VALUES($1,$2,$3,$4,'closed')
             RETURNING *`,
            [
              request.employee_id,
              newClockIn,
              newClockOut,
              `Created from approved missing time request #${request.id}`,
            ],
          );

          await client.query(
            `INSERT INTO time_entry_audit(
               time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,
               new_clock_in,new_clock_out,reason
             ) VALUES($1,$2,NULL,NULL,$3,$4,$5)`,
            [
              updatedEntry.rows[0].id,
              req.user.id,
              newClockIn,
              newClockOut,
              request.employee_reason,
            ],
          );
        }

        const oldClockInForPeriod = existing?.clock_in ?? newClockIn;
        const invalidated = await client.query(
          `UPDATE pay_period_approvals
              SET supervisor_approved_at=NULL,
                  supervisor_employee_id=NULL,
                  payroll_finalized_at=NULL,
                  payroll_finalized_by=NULL,
                  status=CASE WHEN employee_signed_at IS NULL THEN 'open' ELSE 'employee_submitted' END
            WHERE employee_id=$1
              AND (
                ($2::timestamp >= pay_period_start AND $2::timestamp < (pay_period_end + INTERVAL '1 day'))
                OR
                ($3::timestamp >= pay_period_start AND $3::timestamp < (pay_period_end + INTERVAL '1 day'))
              )
            RETURNING id`,
          [request.employee_id, oldClockInForPeriod, newClockIn],
        );

        const reviewed = await client.query(
          `UPDATE time_change_requests
              SET status='approved',supervisor_id=$1,supervisor_note=$2,reviewed_at=NOW()
            WHERE id=$3 AND status='pending'
            RETURNING id`,
          [req.user.id, supervisorNote, requestId],
        );
        if (!reviewed.rows.length) throw new Error('Change request was reviewed by another request');

        await client.query('COMMIT');
        await audit(req.user.id, existing ? 'approve_time_change_request' : 'approve_missing_time_request', 'time_change_request', requestId, {
          employee_id: request.employee_id,
          time_entry_id: updatedEntry.rows[0].id,
          created_new_entry: !existing,
          invalidated_approval_ids: invalidated.rows.map((row) => row.id),
        });
        return res.json({
          message: existing ? 'Request approved' : 'Missing time request approved and punch created',
          entry: updatedEntry.rows[0],
        });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        if (err.code === '23505') {
          return res.status(409).json({ error: 'This change would create a second open punch for the employee' });
        }
        if (err.code === '23514') {
          return res.status(400).json({ error: 'Clock out must be after clock in' });
        }
        console.error(err);
        return res.status(500).json({ error: 'Approve request error' });
      } finally {
        if (client) client.release();
      }
    },
  );

  router.post(
    '/supervisor/deny-change-request',
    requireUser,
    requireAnyPermission('approve_punch_correction'),
    async (req, res) => {
      try {
        const requestId = parsePositiveInt(req.body?.request_id, 'change request');
        const supervisorNote = String(req.body?.supervisor_note || '').trim();
        const requestResult = await pool.query(
          `SELECT employee_id,status FROM time_change_requests WHERE id=$1`,
          [requestId],
        );
        if (!requestResult.rows.length) return res.status(404).json({ error: 'Request not found' });
        if (requestResult.rows[0].status !== 'pending') {
          return res.status(409).json({ error: 'This change request has already been reviewed' });
        }
        if (!(await canAccessEmployee(req.user, requestResult.rows[0].employee_id, ['approve_punch_correction']))) {
          return res.status(403).json({ error: 'Access denied' });
        }

        const denied = await pool.query(
          `UPDATE time_change_requests
              SET status='denied',supervisor_id=$1,supervisor_note=$2,reviewed_at=NOW()
            WHERE id=$3 AND status='pending'
            RETURNING id`,
          [req.user.id, supervisorNote, requestId],
        );
        if (!denied.rows.length) {
          return res.status(409).json({ error: 'This change request has already been reviewed' });
        }
        await audit(req.user.id, 'deny_time_change_request', 'time_change_request', requestId, {
          employee_id: requestResult.rows[0].employee_id,
          supervisor_note: supervisorNote,
        });
        return res.json({ message: 'Request denied' });
      } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: 'Deny request error' });
      }
    },
  );

  router.get(
    '/supervisor/employee-timecard/:employeeId',
    requireUser,
    requireAnyPermission(
      'view_assigned_employees',
      'view_department_time',
      'view_payroll_records',
      'review_approved_timecards',
      'view_all_timeclock_records',
    ),
    async (req, res) => {
      try {
        const employeeId = parsePositiveInt(req.params.employeeId, 'employee');
        if (!(await canAccessEmployee(req.user, employeeId))) {
          return res.status(403).json({ error: 'Access denied' });
        }
        const period = await getRequestedPayPeriod(req);

        const employeeResult = await pool.query(
          `SELECT e.id,e.employee_number,e.first_name,e.last_name,d.name AS department,e.role
             FROM employees e
             LEFT JOIN departments d ON d.id=e.department_id
            WHERE e.id=$1`,
          [employeeId],
        );
        if (!employeeResult.rows.length) return res.status(404).json({ error: 'Employee not found' });

        const [approvalResult, correctionResult, entriesResult, leaveResult, requestsResult] = await Promise.all([
          pool.query(
            `SELECT * FROM pay_period_approvals
              WHERE employee_id=$1 AND pay_period_start=$2::date AND pay_period_end=$3::date
              ORDER BY id DESC LIMIT 1`,
            [employeeId, period.pay_period_start, period.pay_period_end],
          ),
          pool.query(
            `SELECT cr.*,to_char(cr.created_at,'MM/DD/YYYY HH12:MI AM') AS created_at_display
               FROM correction_requests cr
              WHERE cr.employee_id=$1
              ORDER BY cr.created_at DESC LIMIT 10`,
            [employeeId],
          ),
          pool.query(
            `SELECT
               id,clock_in,clock_out,
               to_char(clock_in,'YYYY-MM-DD') AS entry_date_iso,
               to_char(clock_in,'MM/DD/YYYY') AS entry_date,
               to_char(clock_in,'HH12:MI AM') AS clock_in_time,
               to_char(clock_in,'HH24:MI') AS clock_in_time_24,
               CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out,'HH12:MI AM') END AS clock_out_time,
               CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out,'HH24:MI') END AS clock_out_time_24,
               CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out,'YYYY-MM-DD') END AS clock_out_date_iso,
               ROUND((EXTRACT(EPOCH FROM (COALESCE(clock_out,NOW())-clock_in))/3600)::numeric,2) AS hours_worked
             FROM time_entries
             WHERE employee_id=$1
               AND deleted_at IS NULL
               AND clock_in >= $2::date
               AND clock_in < ($3::date + INTERVAL '1 day')
             ORDER BY clock_in`,
            [employeeId, period.pay_period_start, period.pay_period_end],
          ),
          pool.query(
            `SELECT id,to_char(leave_date,'YYYY-MM-DD') AS leave_date_iso,
                    to_char(leave_date,'MM/DD/YYYY') AS leave_date_display,
                    leave_type,ROUND(quarter_hours/4.0,2) AS hours,status,note,review_note
               FROM leave_entries
              WHERE employee_id=$1 AND leave_date BETWEEN $2::date AND $3::date
              ORDER BY leave_date,id`,
            [employeeId, period.pay_period_start, period.pay_period_end],
          ),
          pool.query(
            `SELECT tcr.*,
                    to_char(tcr.requested_clock_in,'MM/DD/YYYY HH12:MI AM') AS requested_clock_in_display,
                    to_char(tcr.requested_clock_out,'MM/DD/YYYY HH12:MI AM') AS requested_clock_out_display,
                    to_char(tcr.created_at,'MM/DD/YYYY HH12:MI AM') AS created_at_display,
                    to_char(tcr.reviewed_at,'MM/DD/YYYY HH12:MI AM') AS reviewed_at_display
               FROM time_change_requests tcr
              WHERE tcr.employee_id=$1
              ORDER BY tcr.created_at DESC`,
            [employeeId],
          ),
        ]);

        const approval = approvalResult.rows[0] || null;
        const payrollCanEdit =
          userHasPermission(req.user, 'edit_payroll_time') ||
          req.user.role === 'payroll' || req.user.role === 'admin';
        const supervisorCanEdit =
          userHasPermission(req.user, 'edit_employee_time') &&
          Boolean(approval?.employee_signed_at) &&
          !approval?.supervisor_approved_at &&
          !approval?.payroll_finalized_at &&
          approval?.status === 'employee_submitted';

        return res.json({
          employee: employeeResult.rows[0],
          approval,
          can_edit_entries: payrollCanEdit || supervisorCanEdit,
          edit_mode: payrollCanEdit ? 'payroll' : (supervisorCanEdit ? 'supervisor' : 'locked'),
          correction_requests: correctionResult.rows,
          change_requests: requestsResult.rows,
          leave_entries: leaveResult.rows,
          pay_period_start: period.pay_period_start,
          pay_period_end: period.pay_period_end,
          entries: entriesResult.rows,
          timecard_summary: summarizeTimecard({
            entries: entriesResult.rows,
            leaveEntries: leaveResult.rows,
            payPeriodStart: period.pay_period_start,
          }),
        });
      } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: 'Employee timecard error' });
      }
    },
  );

  router.post(
    '/supervisor/approve-timecard',
    requireUser,
    requireAnyPermission('approve_timecard'),
    async (req, res) => {
      let client = null;
      try {
        const employeeId = parsePositiveInt(req.body?.employee_id, 'employee');
        if (!(await canAccessEmployee(req.user, employeeId, ['approve_timecard']))) {
          return res.status(403).json({ error: 'Access denied' });
        }
        const period = await getRequestedPayPeriod(req);
        client = await pool.connect();
        await client.query('BEGIN');

        const approvalResult = await client.query(
          `SELECT * FROM pay_period_approvals
            WHERE employee_id=$1 AND pay_period_start=$2::date AND pay_period_end=$3::date
            ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [employeeId, period.pay_period_start, period.pay_period_end],
        );
        const approval = approvalResult.rows[0] || null;
        if (!approval) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'No submitted timecard found' });
        }
        if (!approval.employee_signed_at || approval.status !== 'employee_submitted') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Timecard is not currently awaiting supervisor approval' });
        }
        if (approval.payroll_finalized_at) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Timecard is already payroll-finalized' });
        }

        const [openPunches, pendingLeave, pendingChanges] = await Promise.all([
          client.query(
            `SELECT id FROM time_entries
              WHERE employee_id=$1 AND deleted_at IS NULL
                AND clock_in >= $2::date AND clock_in < ($3::date + INTERVAL '1 day')
                AND clock_out IS NULL`,
            [employeeId, period.pay_period_start, period.pay_period_end],
          ),
          client.query(
            `SELECT id FROM leave_entries
              WHERE employee_id=$1 AND leave_date BETWEEN $2::date AND $3::date AND status='pending'`,
            [employeeId, period.pay_period_start, period.pay_period_end],
          ),
          client.query(
            `SELECT tcr.id
               FROM time_change_requests tcr
               LEFT JOIN time_entries te ON te.id=tcr.time_entry_id
              WHERE tcr.employee_id=$1 AND tcr.status='pending'
                AND (tcr.time_entry_id IS NULL OR te.deleted_at IS NULL)
                AND (
                  (te.clock_in >= $2::date AND te.clock_in < ($3::date + INTERVAL '1 day'))
                  OR
                  (tcr.requested_clock_in >= $2::date AND tcr.requested_clock_in < ($3::date + INTERVAL '1 day'))
                )`,
            [employeeId, period.pay_period_start, period.pay_period_end],
          ),
        ]);

        if (openPunches.rows.length || pendingLeave.rows.length || pendingChanges.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'Resolve open punches and pending leave/change requests before approving the timecard',
            open_punch_count: openPunches.rows.length,
            pending_leave_count: pendingLeave.rows.length,
            pending_change_count: pendingChanges.rows.length,
          });
        }

        const updated = await client.query(
          `UPDATE pay_period_approvals
              SET supervisor_approved_at=NOW(),supervisor_employee_id=$2,status='supervisor_approved'
            WHERE id=$1 AND status='employee_submitted' AND employee_signed_at IS NOT NULL
            RETURNING *`,
          [approval.id, req.user.id],
        );
        if (!updated.rows.length) throw new Error('Timecard changed while it was being approved');
        await client.query('COMMIT');

        await audit(req.user.id, 'approve_timecard', 'employee', employeeId, period);
        return res.json({ message: 'Timecard approved' });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: 'Approve timecard error' });
      } finally {
        if (client) client.release();
      }
    },
  );

  router.post(
    '/supervisor/return-timecard',
    requireUser,
    requireAnyPermission('return_timecard', 'return_to_supervisor', 'edit_payroll_time'),
    async (req, res) => {
      let client = null;
      try {
        const employeeId = parsePositiveInt(req.body?.employee_id, 'employee');
        const supervisorNote = String(req.body?.supervisor_note || '').trim();
        const targetStage = String(req.body?.target_stage || 'employee');
        if (!['employee','supervisor'].includes(targetStage)) {
          return res.status(400).json({ error: 'Return target must be employee or supervisor' });
        }
        if (!(await canAccessEmployee(req.user, employeeId))) {
          return res.status(403).json({ error: 'Access denied' });
        }

        const canReturnFromPayroll =
          userHasPermission(req.user, 'return_to_supervisor') ||
          userHasPermission(req.user, 'edit_payroll_time') ||
          req.user.role === 'payroll' || req.user.role === 'admin';
        if (targetStage === 'supervisor' && !canReturnFromPayroll) {
          return res.status(403).json({ error: 'Only payroll can return a timecard to supervisor review' });
        }

        const period = await getRequestedPayPeriod(req);
        client = await pool.connect();
        await client.query('BEGIN');
        const approvalResult = await client.query(
          `SELECT * FROM pay_period_approvals
            WHERE employee_id=$1 AND pay_period_start=$2::date AND pay_period_end=$3::date
            ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [employeeId, period.pay_period_start, period.pay_period_end],
        );
        const approval = approvalResult.rows[0] || null;
        if (!approval) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'No timecard found for this pay period' });
        }
        if (approval.payroll_finalized_at && !canReturnFromPayroll) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This timecard is payroll-finalized. Payroll must return it before changes can be made.' });
        }

        const returningToEmployee = targetStage === 'employee';
        const updated = await client.query(
          `UPDATE pay_period_approvals
              SET status=$2,
                  employee_signed_at=CASE WHEN $3::boolean THEN NULL ELSE employee_signed_at END,
                  supervisor_approved_at=NULL,
                  supervisor_employee_id=NULL,
                  payroll_finalized_at=NULL,
                  payroll_finalized_by=NULL
            WHERE id=$1
            RETURNING *`,
          [approval.id, returningToEmployee ? 'returned_to_employee' : 'employee_submitted', returningToEmployee],
        );
        if (!updated.rows.length) throw new Error('Timecard changed while it was being returned');

        const returnText = returningToEmployee
          ? 'Timecard returned to employee for correction'
          : 'Timecard returned to supervisor review';
        await client.query(
          `INSERT INTO correction_requests(employee_id,request_text,status,supervisor_response)
           VALUES($1,$2,'returned',$3)`,
          [employeeId, returnText, supervisorNote],
        );
        await client.query('COMMIT');

        await audit(req.user.id, 'return_timecard', 'employee', employeeId, {
          target_stage: targetStage,
          note: supervisorNote,
          pay_period_start: period.pay_period_start,
          pay_period_end: period.pay_period_end,
        });
        return res.json({ message: returnText });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: 'Return timecard error' });
      } finally {
        if (client) client.release();
      }
    },
  );

  router.post(
    '/supervisor/edit-time-entry',
    requireUser,
    requireAnyPermission('edit_employee_time', 'edit_payroll_time'),
    async (req, res) => {
      let client = null;
      try {
        const timeEntryId = parsePositiveInt(req.body?.time_entry_id, 'time entry');
        const reason = String(req.body?.reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Reason is required' });
        if (reason.length > 500) return res.status(400).json({ error: 'Reason must be 500 characters or less' });

        const newClockIn = req.body?.new_clock_in;
        const parsedIn = parseTimestamp(newClockIn, 'clock in');
        const finalClockOut = req.body?.new_clock_out && String(req.body.new_clock_out).trim() !== ''
          ? req.body.new_clock_out
          : null;
        if (finalClockOut != null) {
          const parsedOut = parseTimestamp(finalClockOut, 'clock out');
          if (parsedOut <= parsedIn) return res.status(400).json({ error: 'Clock out must be after clock in' });
        }

        const target = await pool.query(
          `SELECT employee_id FROM time_entries WHERE id=$1 AND deleted_at IS NULL`,
          [timeEntryId],
        );
        if (!target.rows.length) return res.status(404).json({ error: 'Time entry not found' });
        if (!(await canAccessEmployee(req.user, target.rows[0].employee_id))) {
          return res.status(403).json({ error: 'Access denied' });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        const existingResult = await client.query(
          `SELECT * FROM time_entries WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
          [timeEntryId],
        );
        const existing = existingResult.rows[0] || null;
        if (!existing) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Time entry not found' });
        }

        const payrollOverride =
          userHasPermission(req.user, 'edit_payroll_time') ||
          req.user.role === 'payroll' || req.user.role === 'admin';
        const approvalResult = await client.query(
          `SELECT * FROM pay_period_approvals
            WHERE employee_id=$1
              AND $2::timestamp >= pay_period_start
              AND $2::timestamp < (pay_period_end + INTERVAL '1 day')
            ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [existing.employee_id, existing.clock_in],
        );
        const approval = approvalResult.rows[0] || null;

        if (!payrollOverride) {
          const supervisorUnlocked =
            approval?.employee_signed_at &&
            !approval?.supervisor_approved_at &&
            !approval?.payroll_finalized_at &&
            approval?.status === 'employee_submitted';
          if (!supervisorUnlocked) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'This timecard is locked for supervisor editing. Return it to the correct stage before making changes.',
            });
          }
          const periodStart = new Date(`${String(approval.pay_period_start).slice(0,10)}T00:00:00`);
          const periodEnd = new Date(`${String(approval.pay_period_end).slice(0,10)}T23:59:59.999`);
          if (parsedIn < periodStart || parsedIn > periodEnd) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Supervisor edits cannot move an entry to a different pay period; payroll must make that correction.' });
          }
        }

        await client.query(
          `INSERT INTO time_entry_audit(
             time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,new_clock_in,new_clock_out,reason
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [timeEntryId, req.user.id, existing.clock_in, existing.clock_out, newClockIn, finalClockOut, reason],
        );

        const result = await client.query(
          `UPDATE time_entries
              SET clock_in=$1,
                  clock_out=$2,
                  status=CASE WHEN $2::timestamp IS NULL THEN 'open' ELSE 'closed' END
            WHERE id=$3 AND deleted_at IS NULL
            RETURNING *`,
          [newClockIn, finalClockOut, timeEntryId],
        );
        if (!result.rows.length) throw new Error('Time entry changed while it was being edited');

        const invalidated = await client.query(
          `UPDATE pay_period_approvals
              SET supervisor_approved_at=NULL,
                  supervisor_employee_id=NULL,
                  payroll_finalized_at=NULL,
                  payroll_finalized_by=NULL,
                  status=CASE WHEN employee_signed_at IS NULL THEN 'open' ELSE 'employee_submitted' END
            WHERE employee_id=$1
              AND (
                ($2::timestamp >= pay_period_start AND $2::timestamp < (pay_period_end + INTERVAL '1 day'))
                OR
                ($3::timestamp >= pay_period_start AND $3::timestamp < (pay_period_end + INTERVAL '1 day'))
              )
            RETURNING id`,
          [existing.employee_id, existing.clock_in, newClockIn],
        );
        await client.query('COMMIT');

        await audit(
          req.user.id,
          payrollOverride ? 'payroll_edit_time_entry' : 'supervisor_edit_time_entry',
          'time_entry',
          timeEntryId,
          { reason, invalidated_approval_ids: invalidated.rows.map((row) => row.id) },
        );
        return res.json({ message: 'Time entry updated', entry: result.rows[0] });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        if (err.code === '23505') {
          return res.status(409).json({ error: 'This edit would create a second open punch for the employee' });
        }
        if (err.code === '23514') {
          return res.status(400).json({ error: 'Clock out must be after clock in' });
        }
        console.error(err);
        return res.status(500).json({ error: 'Edit time entry error' });
      } finally {
        if (client) client.release();
      }
    },
  );

  router.get(
    '/supervisor/time-entry-audit/:timeEntryId',
    requireUser,
    requireAnyPermission('view_timeclock_audit', 'edit_employee_time', 'edit_payroll_time'),
    async (req, res) => {
      try {
        const timeEntryId = parsePositiveInt(req.params.timeEntryId, 'time entry');
        const entryResult = await pool.query(`SELECT employee_id FROM time_entries WHERE id=$1`, [timeEntryId]);
        if (!entryResult.rows.length) return res.status(404).json({ error: 'Time entry not found' });
        if (!(await canAccessEmployee(req.user, entryResult.rows[0].employee_id))) {
          return res.status(403).json({ error: 'Access denied' });
        }

        const result = await pool.query(
          `SELECT tea.*,
                  changer.first_name AS changed_by_first_name,
                  changer.last_name AS changed_by_last_name,
                  to_char(tea.old_clock_in,'MM/DD/YYYY HH12:MI AM') AS old_clock_in_display,
                  CASE WHEN tea.old_clock_out IS NULL THEN NULL ELSE to_char(tea.old_clock_out,'MM/DD/YYYY HH12:MI AM') END AS old_clock_out_display,
                  to_char(tea.new_clock_in,'MM/DD/YYYY HH12:MI AM') AS new_clock_in_display,
                  CASE WHEN tea.new_clock_out IS NULL THEN NULL ELSE to_char(tea.new_clock_out,'MM/DD/YYYY HH12:MI AM') END AS new_clock_out_display,
                  to_char(tea.created_at,'MM/DD/YYYY HH12:MI AM') AS changed_at_display
             FROM time_entry_audit tea
             LEFT JOIN employees changer ON changer.id=tea.changed_by_employee_id
            WHERE tea.time_entry_id=$1
            ORDER BY tea.created_at DESC`,
          [timeEntryId],
        );
        return res.json({ time_entry_id: timeEntryId, audit: result.rows });
      } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: 'Audit history error' });
      }
    },
  );

  return router;
}

module.exports = { createSupervisorRouter, parsePositiveInt, parseTimestamp };
