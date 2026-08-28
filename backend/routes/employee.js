'use strict';

const express = require('express');
const { summarizeTimecard } = require('../lib/timecard-summary');

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

async function approvalForTimestamp(pool, employeeId, timestamp, lock = false) {
  return pool.query(
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

  // Employees do not directly rewrite punch history. They request a change
  // and a supervisor approves it. A request may reference an existing punch,
  // a complete missing interval, or one pending punch waiting to be paired
  // with a second punch for the same date.
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
      let hasEntryId = rawEntryId !== null && rawEntryId !== undefined && String(rawEntryId).trim() !== '';
      let entryId = hasEntryId ? Number(rawEntryId) : null;
      let requestedClockIn = req.body?.requested_clock_in || null;
      let requestedClockOut = req.body?.requested_clock_out || null;
      const requestedPunch = req.body?.requested_punch || null;
      const reason = String(req.body?.employee_reason || '').trim();

      if (hasEntryId && (!Number.isInteger(entryId) || entryId <= 0)) {
        return res.status(400).json({ error: 'Valid time entry is required' });
      }
      if (!requestedPunch && !requestedClockIn && !requestedClockOut) {
        return res.status(400).json({ error: 'Enter a punch date and time' });
      }
      if (!reason) {
        return res.status(400).json({ error: 'Reason is required' });
      }
      if (reason.length > 1000) {
        return res.status(400).json({ error: 'Reason must be 1000 characters or less' });
      }

      const parsedRequestedPunch = requestedPunch ? validDate(requestedPunch) : null;
      if (requestedPunch && !parsedRequestedPunch) {
        return res.status(400).json({ error: 'Requested punch is invalid' });
      }

      let parsedRequestedIn = requestedClockIn ? validDate(requestedClockIn) : null;
      let parsedRequestedOut = requestedClockOut ? validDate(requestedClockOut) : null;
      if (requestedClockIn && !parsedRequestedIn) {
        return res.status(400).json({ error: 'Requested clock in is invalid' });
      }
      if (requestedClockOut && !parsedRequestedOut) {
        return res.status(400).json({ error: 'Requested clock out is invalid' });
      }

      try {
        // A single-punch request is first matched to an existing open entry.
        // If no open entry exists, keep the first punch pending. A second
        // single punch on the same date completes that pending interval.
        if (parsedRequestedPunch) {
          const lockResult = await approvalForTimestamp(pool, req.user.id, requestedPunch);
          const punchApproval = lockResult.rows[0] || null;
          if (punchApproval?.employee_signed_at && punchApproval.status !== 'returned_to_employee') {
            return res.status(409).json({
              error: 'This timecard is signed and locked. Your supervisor must return it before you can request another change.',
            });
          }

          const openResult = await pool.query(
            `SELECT *
               FROM time_entries
              WHERE employee_id=$1
                AND deleted_at IS NULL
                AND clock_out IS NULL
              ORDER BY clock_in DESC
              LIMIT 1`,
            [req.user.id],
          );
          const openEntry = openResult.rows[0] || null;

          if (openEntry) {
            const openIn = validDate(openEntry.clock_in);
            if (parsedRequestedPunch.getTime() === openIn.getTime()) {
              return res.status(409).json({ error: 'That punch already exists' });
            }
            hasEntryId = true;
            entryId = Number(openEntry.id);
            if (parsedRequestedPunch > openIn) {
              requestedClockIn = null;
              requestedClockOut = requestedPunch;
            } else {
              requestedClockIn = requestedPunch;
              requestedClockOut = openEntry.clock_in;
            }
          } else {
            const pendingSingle = await pool.query(
              `SELECT *
                 FROM time_change_requests
                WHERE employee_id=$1
                  AND time_entry_id IS NULL
                  AND status='pending'
                  AND requested_clock_in IS NOT NULL
                  AND requested_clock_out IS NULL
                  AND requested_clock_in::date=$2::timestamp::date
                ORDER BY created_at DESC
                LIMIT 1`,
              [req.user.id, requestedPunch],
            );

            if (pendingSingle.rows.length) {
              const pending = pendingSingle.rows[0];
              const firstPunch = validDate(pending.requested_clock_in);
              if (firstPunch.getTime() === parsedRequestedPunch.getTime()) {
                return res.status(409).json({ error: 'That punch request is already pending' });
              }
              const earlier = firstPunch < parsedRequestedPunch ? pending.requested_clock_in : requestedPunch;
              const later = firstPunch < parsedRequestedPunch ? requestedPunch : pending.requested_clock_in;
              const completed = await pool.query(
                `UPDATE time_change_requests
                    SET requested_clock_in=$1,
                        requested_clock_out=$2,
                        employee_reason=CASE
                          WHEN employee_reason=$3 THEN employee_reason
                          ELSE employee_reason || E'\nAdditional punch: ' || $3
                        END
                  WHERE id=$4
                    AND status='pending'
                  RETURNING id`,
                [earlier, later, reason, pending.id],
              );
              if (!completed.rows.length) {
                return res.status(409).json({ error: 'The pending punch request changed; refresh and try again' });
              }
              await audit(req.user.id, 'complete_missing_time_request', 'time_change_request', pending.id, {
                requested_punch: requestedPunch,
                requested_clock_in: earlier,
                requested_clock_out: later,
              });
              return res.json({
                message: 'Punch request added. The missing-time pair is now waiting for supervisor approval.',
                request_id: pending.id,
                paired: true,
              });
            }

            hasEntryId = false;
            entryId = null;
            requestedClockIn = requestedPunch;
            requestedClockOut = null;
          }

          parsedRequestedIn = requestedClockIn ? validDate(requestedClockIn) : null;
          parsedRequestedOut = requestedClockOut ? validDate(requestedClockOut) : null;
        } else if (!hasEntryId && (!requestedClockIn || !requestedClockOut)) {
          return res.status(400).json({
            error: 'Clock in and clock out are both required for the older missing-workday form',
          });
        }

        let entry = null;
        if (hasEntryId) {
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

          entry = entryResult.rows[0];
          if (Number(entry.employee_id) !== Number(req.user.id)) {
            return res.status(403).json({ error: 'Cannot modify another employee' });
          }
        }

        const effectiveClockIn = parsedRequestedIn || validDate(entry?.clock_in);
        const effectiveClockOut = parsedRequestedOut || (entry?.clock_out ? validDate(entry.clock_out) : null);

        if (!effectiveClockIn) {
          return res.status(400).json({ error: 'Clock in is invalid' });
        }
        if (effectiveClockOut && effectiveClockOut <= effectiveClockIn) {
          return res.status(400).json({
            error: 'Clock out must be after clock in. Check AM/PM and the date.',
          });
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
        if (duplicate.rows.length) {
          return res.status(409).json({ error: 'That punch request is already pending' });
        }

        const inserted = await pool.query(
          `INSERT INTO time_change_requests(
             employee_id,time_entry_id,requested_clock_in,requested_clock_out,employee_reason,status
           ) VALUES($1,$2,$3,$4,$5,'pending')
           RETURNING id`,
          [req.user.id, entryId, requestedClockIn, requestedClockOut, reason],
        );

        await audit(
          req.user.id,
          requestedPunch ? 'request_single_punch' : (hasEntryId ? 'request_time_change' : 'request_missing_time'),
          'time_change_request',
          inserted.rows[0].id,
          {
            time_entry_id: entryId,
            requested_punch: requestedPunch,
            requested_clock_in: requestedClockIn,
            requested_clock_out: requestedClockOut,
          },
        );

        return res.json({
          message: requestedPunch
            ? (requestedClockOut ? 'Punch request submitted for supervisor approval' : 'Punch request saved. Add the matching punch for this date when needed.')
            : (hasEntryId ? 'Time change request submitted' : 'Missing time request submitted'),
          request_id: inserted.rows[0].id,
          paired: Boolean(requestedClockOut),
        });
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

  // Supervisor/payroll direct Add Punch action. The caller supplies one punch
  // timestamp; the server places it as an inferred clock-in or clock-out from
  // the employee's current open state. The legacy clock_in/clock_out pair is
  // also accepted for compatibility with older clients.
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

      if (!Number.isInteger(employeeId) || employeeId <= 0) {
        return res.status(400).json({ error: 'Valid employee is required' });
      }
      if (!reason) return res.status(400).json({ error: 'Reason is required' });
      if (reason.length > 500) return res.status(400).json({ error: 'Reason must be 500 characters or less' });
      if (!(await canDirectEditEmployee(pool, req.user, employeeId))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const payrollOverride =
        hasPermission(req.user, 'edit_payroll_time') ||
        ['payroll', 'admin'].includes(String(req.user.role || '').toLowerCase());

      const primaryTimestamp = punchAt || legacyClockIn;
      const parsedPrimary = validDate(primaryTimestamp);
      if (!parsedPrimary) return res.status(400).json({ error: 'Valid punch date and time are required' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const approvalResult = await approvalForTimestamp(client, employeeId, primaryTimestamp, true);
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
              error: 'This timecard is locked for supervisor editing. Return it to the correct stage before adding a punch.',
            });
          }
        }

        let result;
        let inferredPunchType;

        if (!punchAt) {
          const parsedOut = legacyClockOut ? validDate(legacyClockOut) : null;
          if (legacyClockOut && !parsedOut) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Valid clock out is required' });
          }
          if (parsedOut && parsedOut <= parsedPrimary) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Clock out must be after clock in' });
          }
          result = await client.query(
            `INSERT INTO time_entries(employee_id,clock_in,clock_out,notes,status)
             VALUES($1,$2,$3,$4,CASE WHEN $3::timestamp IS NULL THEN 'open' ELSE 'closed' END)
             RETURNING *`,
            [employeeId, legacyClockIn, legacyClockOut, reason],
          );
          inferredPunchType = legacyClockOut ? 'interval' : 'clock_in';
        } else {
          const duplicate = await client.query(
            `SELECT id
               FROM time_entries
              WHERE employee_id=$1
                AND deleted_at IS NULL
                AND (clock_in=$2::timestamp OR clock_out=$2::timestamp)
              LIMIT 1`,
            [employeeId, punchAt],
          );
          if (duplicate.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'That punch already exists' });
          }

          const openResult = await client.query(
            `SELECT *
               FROM time_entries
              WHERE employee_id=$1
                AND deleted_at IS NULL
                AND clock_out IS NULL
              ORDER BY clock_in DESC
              LIMIT 1
              FOR UPDATE`,
            [employeeId],
          );
          const openEntry = openResult.rows[0] || null;

          if (openEntry) {
            const openIn = validDate(openEntry.clock_in);
            const newIn = parsedPrimary < openIn ? punchAt : openEntry.clock_in;
            const newOut = parsedPrimary < openIn ? openEntry.clock_in : punchAt;

            const overlap = await client.query(
              `SELECT id
                 FROM time_entries
                WHERE employee_id=$1
                  AND id<>$2
                  AND deleted_at IS NULL
                  AND clock_in < $4::timestamp
                  AND COALESCE(clock_out,NOW()) > $3::timestamp
                LIMIT 1
                FOR UPDATE`,
              [employeeId, openEntry.id, newIn, newOut],
            );
            if (overlap.rows.length) {
              await client.query('ROLLBACK');
              return res.status(409).json({
                error: 'That punch would overlap an existing completed work interval. Edit the surrounding punches instead.',
              });
            }

            await client.query(
              `INSERT INTO time_entry_audit(
                 time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,new_clock_in,new_clock_out,reason
               ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [openEntry.id, req.user.id, openEntry.clock_in, openEntry.clock_out, newIn, newOut, reason],
            );
            result = await client.query(
              `UPDATE time_entries
                  SET clock_in=$1,clock_out=$2,status='closed',notes=COALESCE(notes,$3)
                WHERE id=$4
                  AND deleted_at IS NULL
                RETURNING *`,
              [newIn, newOut, reason, openEntry.id],
            );
            inferredPunchType = parsedPrimary < openIn ? 'clock_in' : 'clock_out';
          } else {
            const insideCompleted = await client.query(
              `SELECT id
                 FROM time_entries
                WHERE employee_id=$1
                  AND deleted_at IS NULL
                  AND clock_out IS NOT NULL
                  AND clock_in < $2::timestamp
                  AND clock_out > $2::timestamp
                LIMIT 1
                FOR UPDATE`,
              [employeeId, punchAt],
            );
            if (insideCompleted.rows.length) {
              await client.query('ROLLBACK');
              return res.status(409).json({
                error: 'That punch falls inside an existing completed work interval. Add or edit the matching surrounding punch first.',
              });
            }

            result = await client.query(
              `INSERT INTO time_entries(employee_id,clock_in,clock_out,notes,status)
               VALUES($1,$2,NULL,$3,'open')
               RETURNING *`,
              [employeeId, punchAt, reason],
            );
            inferredPunchType = 'clock_in';
          }
        }

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
          [employeeId, primaryTimestamp],
        );

        await client.query('COMMIT');
        const entry = result.rows[0];
        await audit(req.user.id, 'add_single_punch', 'time_entry', entry.id, {
          employee_id: employeeId,
          punch_at: punchAt,
          inferred_punch_type: inferredPunchType,
          reason,
          invalidated_approval_ids: invalidated.rows.map((row) => row.id),
        });
        return res.json({
          message: inferredPunchType === 'clock_out'
            ? 'Punch added as clock out'
            : inferredPunchType === 'clock_in'
              ? 'Punch added as clock in'
              : 'Time entry added',
          inferred_punch_type: inferredPunchType,
          entry,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') {
          return res.status(409).json({ error: 'This punch would create a second open punch for the employee' });
        }
        if (err.code === '23514') {
          return res.status(400).json({ error: 'Clock out must be after clock in' });
        }
        console.error(err);
        return res.status(500).json({ error: 'Add punch error' });
      } finally {
        client.release();
      }
    },
  );

  return router;
}

module.exports = { createEmployeeRouter, validDate, canDirectEditEmployee };
