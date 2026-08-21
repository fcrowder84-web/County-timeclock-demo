'use strict';

const express = require('express');
const { recordPunchMetadata } = require('../lib/punch-metadata');

function createQuickPunchRouter({ requireUser, requireAnyPermission, pool, audit }) {
  const router = express.Router();
  const canPunch = requireAnyPermission('clock_in_out');

  function permissionSet(user) {
    return new Set(Array.isArray(user?.permissions) ? user.permissions : []);
  }

  function hasPayrollOverride(user) {
    const permissions = permissionSet(user);
    return permissions.has('view_all_timeclock_records')
      || permissions.has('edit_payroll_time')
      || (permissions.has('app_admin') && user.app_admin_scope === 'all')
      || user.role === 'payroll'
      || user.role === 'admin';
  }

  async function currentTimecardLock(employeeId, db = pool) {
    const result = await db.query(
      `SELECT id,status,employee_signed_at,supervisor_approved_at,payroll_finalized_at
         FROM pay_period_approvals
        WHERE employee_id=$1
          AND CURRENT_DATE BETWEEN pay_period_start AND pay_period_end
        ORDER BY id DESC
        LIMIT 1`,
      [employeeId],
    );
    const approval = result.rows[0] || null;
    return {
      approval,
      locked: Boolean(
        approval?.employee_signed_at
        && approval.status !== 'returned_to_employee'
      ),
    };
  }

  async function canDeleteEntry(user, entry, db = pool) {
    if (Number(user.id) === Number(entry.employee_id)) return true;

    const permissions = permissionSet(user);
    if (permissions.has('view_all_timeclock_records') || permissions.has('edit_payroll_time')) return true;
    if (permissions.has('app_admin') && user.app_admin_scope === 'all') return true;
    if (!permissions.has('edit_employee_time') && !permissions.has('app_admin')) return false;

    const scope = await db.query(
      `SELECT 1
         FROM employees target
        WHERE target.id=$1
          AND (
            target.department_id=$2
            OR EXISTS(
              SELECT 1
                FROM supervisor_employee_assignments sea
               WHERE sea.employee_id=target.id
                 AND sea.supervisor_employee_id=$3
                 AND sea.active=TRUE
            )
            OR EXISTS(
              SELECT 1
                FROM department_heads dh
               WHERE dh.employee_id=$3
                 AND dh.department_id=target.department_id
                 AND dh.active=TRUE
            )
          )
        LIMIT 1`,
      [entry.employee_id, user.department_id, user.id],
    );
    return scope.rows.length > 0;
  }

  async function canAddEntryForEmployee(user, employeeId, db = pool) {
    if (hasPayrollOverride(user)) return true;

    const permissions = permissionSet(user);
    if (Number(user.id) === Number(employeeId)) return false;
    if (
      !permissions.has('add_employee_entry')
      && !permissions.has('edit_employee_time')
      && !permissions.has('app_admin')
    ) {
      return false;
    }

    const scope = await db.query(
      `SELECT 1
         FROM employees target
        WHERE target.id=$1
          AND (
            target.department_id=$2
            OR EXISTS(
              SELECT 1
                FROM supervisor_employee_assignments sea
               WHERE sea.employee_id=target.id
                 AND sea.supervisor_employee_id=$3
                 AND sea.active=TRUE
            )
            OR EXISTS(
              SELECT 1
                FROM department_heads dh
               WHERE dh.employee_id=$3
                 AND dh.department_id=target.department_id
                 AND dh.active=TRUE
            )
          )
        LIMIT 1`,
      [employeeId, user.department_id, user.id],
    );
    return scope.rows.length > 0;
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

  async function captureMetadata(req, timeEntryId, punchType) {
    try {
      return await recordPunchMetadata({
        pool,
        req,
        employeeId: req.user.id,
        timeEntryId,
        punchType,
      });
    } catch (err) {
      console.error('Punch metadata capture error', err);
      return null;
    }
  }

  router.get('/quick-status', requireUser, canPunch, async (req, res) => {
    try {
      const [openResult, lastResult, lock] = await Promise.all([
        pool.query(
          `SELECT id,clock_in,
                  (clock_in::date < CURRENT_DATE OR clock_in <= NOW() - INTERVAL '23 hours') AS requires_correction
             FROM time_entries
            WHERE employee_id=$1
              AND deleted_at IS NULL
              AND clock_out IS NULL
            ORDER BY clock_in DESC
            LIMIT 1`,
          [req.user.id],
        ),
        pool.query(
          `SELECT clock_in,clock_out
             FROM time_entries
            WHERE employee_id=$1
              AND deleted_at IS NULL
            ORDER BY GREATEST(clock_in,COALESCE(clock_out,clock_in)) DESC
            LIMIT 1`,
          [req.user.id],
        ),
        currentTimecardLock(req.user.id),
      ]);

      const openEntry = openResult.rows[0] || null;
      const latest = lastResult.rows[0] || null;
      const clockedIn = Boolean(openEntry);

      return res.json({
        clocked_in: clockedIn,
        next_action: clockedIn ? 'clock_out' : 'clock_in',
        current_entry_id: openEntry?.id || null,
        current_clock_in: openEntry?.clock_in || null,
        requires_correction: Boolean(openEntry?.requires_correction),
        timecard_locked: lock.locked,
        timecard_status: lock.approval?.status || null,
        employee_signed_at: lock.approval?.employee_signed_at || null,
        last_punch_type: latest ? (latest.clock_out ? 'clock_out' : 'clock_in') : null,
        last_punch_at: latest ? (latest.clock_out || latest.clock_in) : null,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Quick punch status error' });
    }
  });

  router.get('/my-punches', requireUser, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT
           id,
           clock_in,
           clock_out,
           status,
           to_char(clock_in,'MM/DD/YYYY HH12:MI AM') AS clock_in_display,
           CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out,'MM/DD/YYYY HH12:MI AM') END AS clock_out_display,
           ROUND((EXTRACT(EPOCH FROM (COALESCE(clock_out,NOW())-clock_in))/3600)::numeric,2) AS hours_worked
         FROM time_entries
        WHERE employee_id=$1
          AND deleted_at IS NULL
          AND clock_in>=NOW()-INTERVAL '90 days'
        ORDER BY clock_in DESC
        LIMIT 100`,
        [req.user.id],
      );
      return res.json({ entries: result.rows });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Unable to load punches' });
    }
  });

  router.post('/delete-punch', requireUser, async (req, res) => {
    const entryId = Number(req.body?.time_entry_id);
    const reason = String(req.body?.reason || '').trim();

    if (!Number.isInteger(entryId) || entryId <= 0) return res.status(400).json({ error: 'Valid time entry is required' });
    if (reason.length < 3) return res.status(400).json({ error: 'Deletion reason is required' });
    if (reason.length > 500) return res.status(400).json({ error: 'Deletion reason must be 500 characters or less' });

    let client = null;
    let auditDetails = null;

    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const entryResult = await client.query(
        `SELECT * FROM time_entries WHERE id=$1 AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
        [entryId],
      );
      if (!entryResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Time entry not found' });
      }

      const entry = entryResult.rows[0];
      if (!(await canDeleteEntry(req.user, entry, client))) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: "You cannot delete this employee's punch" });
      }

      const approvalResult = await client.query(
        `SELECT id,status,employee_signed_at,supervisor_approved_at,payroll_finalized_at
           FROM pay_period_approvals
          WHERE employee_id=$1
            AND $2::timestamp>=pay_period_start
            AND $2::timestamp<(pay_period_end+INTERVAL '1 day')
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [entry.employee_id, entry.clock_in],
      );
      const approval = approvalResult.rows[0] || null;

      if (Number(req.user.id) === Number(entry.employee_id) && approval?.employee_signed_at && approval.status !== 'returned_to_employee') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'This timecard is signed and locked. It must be returned to you before you can delete a punch.',
        });
      }

      const deleted = await client.query(
        `UPDATE time_entries
            SET deleted_at=NOW(),deleted_by_employee_id=$2,deletion_reason=$3
          WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
        [entry.id, req.user.id, reason],
      );
      if (!deleted.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Punch was already deleted or could not be deleted' });
      }

      const cancelledRequests = await client.query(
        `UPDATE time_change_requests
            SET status='denied',
                supervisor_note=CASE WHEN COALESCE(supervisor_note,'')='' THEN $2 ELSE supervisor_note || E'\n' || $2 END,
                reviewed_at=NOW()
          WHERE time_entry_id=$1 AND status='pending' RETURNING id`,
        [entry.id, `Punch deleted: ${reason}`],
      );

      if (approval) {
        await client.query(
          `UPDATE pay_period_approvals
              SET employee_signed_at=NULL,supervisor_approved_at=NULL,supervisor_employee_id=NULL,
                  payroll_finalized_at=NULL,payroll_finalized_by=NULL,status='open'
            WHERE id=$1`,
          [approval.id],
        );
      }

      auditDetails = {
        employee_id: entry.employee_id,
        original_clock_in: entry.clock_in,
        original_clock_out: entry.clock_out,
        original_status: entry.status,
        reason,
        approval_reopened: Boolean(approval),
        previous_approval_status: approval?.status || null,
        cancelled_change_request_ids: cancelledRequests.rows.map((row) => row.id),
        soft_delete: true,
      };

      await client.query('COMMIT');
      await audit(req.user.id, 'delete_time_entry', 'time_entry', entry.id, auditDetails);
      return res.json({ message: 'Punch deleted. The original record remains in the audit trail.' });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      return res.status(500).json({ error: 'Delete punch error' });
    } finally {
      if (client) client.release();
    }
  });

  router.post(
    '/supervisor/add-time-entry',
    requireUser,
    requireAnyPermission('add_employee_entry', 'edit_employee_time', 'edit_payroll_time'),
    async (req, res) => {
      const employeeId = Number(req.body?.employee_id);
      const reason = String(req.body?.reason || '').trim();
      let client = null;
      if (!Number.isInteger(employeeId) || employeeId <= 0) return res.status(400).json({ error: 'Valid employee is required' });
      if (reason.length < 3) return res.status(400).json({ error: 'Reason is required' });
      if (reason.length > 500) return res.status(400).json({ error: 'Reason must be 500 characters or less' });

      let parsedIn;
      let parsedOut = null;
      try {
        parsedIn = parseTimestamp(req.body?.clock_in, 'clock in');
        if (req.body?.clock_out && String(req.body.clock_out).trim() !== '') {
          parsedOut = parseTimestamp(req.body.clock_out, 'clock out');
          if (parsedOut <= parsedIn) return res.status(400).json({ error: 'Clock out must be after clock in' });
        }
      } catch (err) {
        return res.status(err.statusCode || 400).json({ error: err.message });
      }

      try {
        client = await pool.connect();
        await client.query('BEGIN');
        if (!(await canAddEntryForEmployee(req.user, employeeId, client))) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'You cannot add punches for this employee' });
        }

        const payrollOverride = hasPayrollOverride(req.user);
        const approvalResult = await client.query(
          `SELECT * FROM pay_period_approvals
            WHERE employee_id=$1
              AND $2::timestamp >= pay_period_start
              AND $2::timestamp < (pay_period_end + INTERVAL '1 day')
            ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [employeeId, req.body.clock_in],
        );
        const approval = approvalResult.rows[0] || null;
        if (!payrollOverride) {
          const supervisorUnlocked = approval?.employee_signed_at && !approval?.supervisor_approved_at
            && !approval?.payroll_finalized_at && approval?.status === 'employee_submitted';
          if (!supervisorUnlocked) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'This timecard is locked for supervisor entry. The employee must submit it before a supervisor can add punches.',
            });
          }
        }

        const inserted = await client.query(
          `INSERT INTO time_entries(employee_id,clock_in,clock_out,status)
           VALUES($1,$2,$3,CASE WHEN $3::timestamp IS NULL THEN 'open' ELSE 'closed' END) RETURNING *`,
          [employeeId, req.body.clock_in, parsedOut ? req.body.clock_out : null],
        );

        let invalidatedApprovalIds = [];
        if (approval) {
          const invalidated = await client.query(
            `UPDATE pay_period_approvals
                SET supervisor_approved_at=NULL,supervisor_employee_id=NULL,payroll_finalized_at=NULL,
                    payroll_finalized_by=NULL,status=CASE WHEN employee_signed_at IS NULL THEN 'open' ELSE 'employee_submitted' END
              WHERE id=$1 RETURNING id`,
            [approval.id],
          );
          invalidatedApprovalIds = invalidated.rows.map((row) => row.id);
        }

        await client.query('COMMIT');
        await audit(
          req.user.id,
          payrollOverride ? 'payroll_add_time_entry' : 'supervisor_add_time_entry',
          'time_entry',
          inserted.rows[0].id,
          { employee_id: employeeId, clock_in: req.body.clock_in, clock_out: parsedOut ? req.body.clock_out : null, reason, invalidated_approval_ids: invalidatedApprovalIds },
        );
        return res.status(201).json({ message: 'Time entry added', entry: inserted.rows[0] });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') return res.status(409).json({ error: 'This entry would create a second open punch for the employee' });
        if (err.code === '23514') return res.status(400).json({ error: 'Clock out must be after clock in' });
        console.error(err);
        return res.status(500).json({ error: 'Add time entry error' });
      } finally {
        if (client) client.release();
      }
    },
  );

  router.post('/clock-in', requireUser, canPunch, async (req, res) => {
    try {
      const lock = await currentTimecardLock(req.user.id);
      if (lock.locked) {
        return res.status(409).json({
          error: 'This timecard has been signed and is locked. Your supervisor must return it before you can punch again.',
          code: 'TIMECARD_LOCKED',
          timecard_status: lock.approval?.status || null,
          employee_signed_at: lock.approval?.employee_signed_at || null,
        });
      }

      const openEntry = await pool.query(
        `SELECT id,clock_in,
                (clock_in::date < CURRENT_DATE OR clock_in <= NOW() - INTERVAL '23 hours') AS requires_correction
           FROM time_entries
          WHERE employee_id=$1 AND deleted_at IS NULL AND clock_out IS NULL
          ORDER BY clock_in DESC LIMIT 1`,
        [req.user.id],
      );
      if (openEntry.rows.length) {
        if (openEntry.rows[0].requires_correction) {
          return res.status(409).json({
            error: 'Your previous open punch must be corrected and approved before you can punch again.',
            code: 'STALE_OPEN_PUNCH',time_entry_id: openEntry.rows[0].id,clock_in: openEntry.rows[0].clock_in,
          });
        }
        return res.status(400).json({ error: 'You are already clocked in' });
      }

      const result = await pool.query(
        `INSERT INTO time_entries(employee_id,clock_in,status) VALUES($1,NOW(),'open') RETURNING *`,
        [req.user.id],
      );
      const metadata = await captureMetadata(req, result.rows[0].id, 'clock_in');
      await audit(req.user.id, 'clock_in', 'time_entry', result.rows[0].id, metadata);
      return res.json({ message: `${req.user.first_name} clocked in successfully`, entry: result.rows[0], metadata_recorded: Boolean(metadata) });
    } catch (err) {
      if (err.code === '23505') return res.status(400).json({ error: 'You are already clocked in' });
      console.error(err);
      return res.status(500).json({ error: 'Clock-in error' });
    }
  });

  router.post('/clock-out', requireUser, canPunch, async (req, res) => {
    try {
      const lock = await currentTimecardLock(req.user.id);
      if (lock.locked) {
        return res.status(409).json({
          error: 'This timecard has been signed and is locked. Your supervisor must return it before you can punch again.',
          code: 'TIMECARD_LOCKED',
          timecard_status: lock.approval?.status || null,
          employee_signed_at: lock.approval?.employee_signed_at || null,
        });
      }

      const openResult = await pool.query(
        `SELECT id,clock_in,
                (clock_in::date < CURRENT_DATE OR clock_in <= NOW() - INTERVAL '23 hours') AS requires_correction
           FROM time_entries
          WHERE employee_id=$1 AND deleted_at IS NULL AND clock_out IS NULL
          ORDER BY clock_in DESC LIMIT 1`,
        [req.user.id],
      );
      if (!openResult.rows.length) return res.status(400).json({ error: 'You are not currently clocked in' });
      const openEntry = openResult.rows[0];
      if (openEntry.requires_correction) {
        return res.status(409).json({
          error: 'Your previous open punch must be corrected and approved before you can punch again.',
          code: 'STALE_OPEN_PUNCH',time_entry_id: openEntry.id,clock_in: openEntry.clock_in,
        });
      }

      const result = await pool.query(
        `UPDATE time_entries SET clock_out=NOW(),status='closed'
          WHERE id=$1 AND employee_id=$2 AND deleted_at IS NULL AND clock_out IS NULL RETURNING *`,
        [openEntry.id, req.user.id],
      );
      if (!result.rows.length) return res.status(400).json({ error: 'You are not currently clocked in' });
      const metadata = await captureMetadata(req, result.rows[0].id, 'clock_out');
      await audit(req.user.id, 'clock_out', 'time_entry', result.rows[0].id, metadata);
      return res.json({ message: `${req.user.first_name} clocked out successfully`, entry: result.rows[0], metadata_recorded: Boolean(metadata) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Clock-out error' });
    }
  });

  return router;
}

module.exports = { createQuickPunchRouter };
