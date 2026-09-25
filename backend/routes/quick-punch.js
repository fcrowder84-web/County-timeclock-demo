'use strict';

const express = require('express');
const { canEditPunch, hasPayrollOverride } = require('../lib/punch-edit-authority');
const { recordPunchMetadata, punchLocationGate } = require('../lib/punch-metadata');
const { userHasPermission } = require('../lib/permissions');
const { removePunchFromSequence } = require('../lib/punch-sequence');

const PUNCH_COOLDOWN_SECONDS = 5 * 60;

function createQuickPunchRouter({ requireUser, requireAnyPermission, pool, audit }) {
  const router = express.Router();
  const canPunch = requireAnyPermission('clock_in_out');

  async function punchCooldown(employeeId, db = pool) {
    const result = await db.query(
      `SELECT clock_in,clock_out,
              GREATEST(clock_in,COALESCE(clock_out,clock_in)) AS last_punch_at,
              GREATEST(
                0,
                CEIL(EXTRACT(EPOCH FROM (
                  GREATEST(clock_in,COALESCE(clock_out,clock_in))
                  + ($2::int * INTERVAL '1 second')
                  - NOW()
                )))
              )::int AS remaining_seconds,
              GREATEST(clock_in,COALESCE(clock_out,clock_in))
                + ($2::int * INTERVAL '1 second') AS cooldown_until
         FROM time_entries
        WHERE employee_id=$1
          AND deleted_at IS NULL
        ORDER BY GREATEST(clock_in,COALESCE(clock_out,clock_in)) DESC
        LIMIT 1`,
      [employeeId,PUNCH_COOLDOWN_SECONDS],
    );
    const latest=result.rows[0]||null;
    const remaining=Number(latest?.remaining_seconds||0);
    return {
      active:remaining>0,
      remaining_seconds:remaining,
      cooldown_until:latest?.cooldown_until||null,
      last_punch_at:latest?.last_punch_at||null,
      last_punch_type:latest ? (latest.clock_out ? 'clock_out' : 'clock_in') : null,
    };
  }

  function cooldownResponse(res,cooldown) {
    const seconds=Math.max(1,Number(cooldown?.remaining_seconds||0));
    const minutes=Math.floor(seconds/60);
    const remainder=seconds%60;
    const waitText=minutes>0
      ? minutes+' minute'+(minutes===1?'':'s')+(remainder?' '+remainder+' seconds':'')
      : remainder+' seconds';
    return res.status(409).json({
      error:'Please wait '+waitText+' before punching again.',
      code:'PUNCH_COOLDOWN',
      cooldown_seconds_remaining:seconds,
      cooldown_until:cooldown?.cooldown_until||null,
    });
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
    if (Number(user.id) === Number(entry.employee_id)) {
      return userHasPermission(user,'void_own_unapproved_punch');
    }
    return canEditPunch(db, user, entry.employee_id, 'edit');
  }

  async function canAddEntryForEmployee(user, employeeId, db = pool) {
    return canEditPunch(db, user, employeeId, 'add');
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

  async function requirePunchLocation(req, res, punchType) {
    const gate = await punchLocationGate(req, pool);
    if (gate.allowed) return gate;
    const details = {
      punch_type: punchType,
      source_ip: gate.source_ip,
      location_status: gate.location_status,
      latitude: gate.latitude,
      longitude: gate.longitude,
      accuracy_meters: gate.accuracy_meters,
      client_source: req.body?.client_source || 'web',
      reason: 'GPS required outside trusted County network',
    };
    try {
      await audit(req.user.id, 'punch_rejected_gps_required', 'employee', req.user.id, details);
    } catch (err) {
      console.error('Rejected punch GPS audit error', err);
    }
    res.status(403).json({
      error: 'Location access is required to clock in or out when you are not connected to a County network. Enable location services and allow location access, then try again.',
      code: 'GPS_REQUIRED',
      location_status: gate.location_status,
    });
    return null;
  }

  router.get('/quick-status', requireUser, canPunch, async (req, res) => {
    try {
      const [openResult, cooldown, lock] = await Promise.all([
        pool.query(
          `SELECT id,clock_in,
                  (clock_in::date < CURRENT_DATE OR clock_in <= NOW() - INTERVAL '23 hours') AS requires_correction
             FROM time_entries
            WHERE employee_id=$1
              AND deleted_at IS NULL
              AND clock_out IS NULL
              AND pending_clock_out IS NULL
            ORDER BY clock_in DESC
            LIMIT 1`,
          [req.user.id],
        ),
        punchCooldown(req.user.id),
        currentTimecardLock(req.user.id),
      ]);

      const openEntry = openResult.rows[0] || null;
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
        last_punch_type: cooldown.last_punch_type,
        last_punch_at: cooldown.last_punch_at,
        punch_cooldown_active: cooldown.active,
        punch_cooldown_seconds: PUNCH_COOLDOWN_SECONDS,
        punch_cooldown_seconds_remaining: cooldown.remaining_seconds,
        punch_cooldown_until: cooldown.cooldown_until,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Quick punch status error' });
    }
  });

  router.get('/my-punches', requireUser, requireAnyPermission('view_own_time'), async (req, res) => {
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
    const punchKind = String(req.body?.punch_kind || 'entry').trim().toLowerCase();

    if (!Number.isInteger(entryId) || entryId <= 0) return res.status(400).json({ error: 'Valid time entry is required' });
    if (!['in', 'out', 'entry'].includes(punchKind)) return res.status(400).json({ error: 'Valid punch kind is required' });
    if (reason.length < 3) return res.status(400).json({ error: 'Void reason is required' });
    if (reason.length > 500) return res.status(400).json({ error: 'Void reason must be 500 characters or less' });

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
        return res.status(403).json({ error: "You cannot void this employee's punch" });
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

      if (Number(req.user.id) !== Number(entry.employee_id)) {
        const payroll = hasPayrollOverride(req.user);
        const supervisorStage = !approval?.supervisor_approved_at
          && !approval?.payroll_finalized_at
          && (!approval || ['open', 'returned_to_employee', 'employee_submitted'].includes(approval.status));
        if ((!payroll && !supervisorStage)
            || (payroll && approval?.payroll_finalized_at && !userHasPermission(req.user,'reopen_timecard'))) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Return the timecard to the authorized editing stage before voiding a punch.' });
        }
      }

      let punchMutation;
      let softDelete = false;
      const managementSequenceEdit = Number(req.user.id) !== Number(entry.employee_id) && ['in','out'].includes(punchKind);

      if (managementSequenceEdit) {
        const rebuilt = await removePunchFromSequence({
          client, employeeId: entry.employee_id, timeEntryId: entry.id, punchKind,
          actorEmployeeId: req.user.id, reason,
        });
        punchMutation = { rows: [{ id: entry.id }] };
        auditDetails = { sequence_rebuilt: true, rebuilt_entries: rebuilt.entries.map((row) => row.id) };
      } else if (punchKind === 'out') {
        if (!entry.clock_out) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This entry does not have a clock-out punch to void.' });
        }
        punchMutation = await client.query(
          `UPDATE time_entries
              SET clock_out=NULL,status='open'
            WHERE id=$1 AND deleted_at IS NULL AND clock_out IS NOT NULL RETURNING id`,
          [entry.id],
        );
      } else {
        if (punchKind === 'in' && entry.clock_out) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'Void the clock-out punch first. A clock-in cannot be removed while its clock-out remains.',
          });
        }
        softDelete = true;
        punchMutation = await client.query(
          `UPDATE time_entries
              SET deleted_at=NOW(),deleted_by_employee_id=$2,deletion_reason=$3
            WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
          [entry.id, req.user.id, reason],
        );
      }

      if (!punchMutation.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Punch was already voided or could not be voided' });
      }

      const cancelledRequests = await client.query(
        `UPDATE time_change_requests
            SET status='voided',
                supervisor_note=CASE WHEN COALESCE(supervisor_note,'')='' THEN $2 ELSE supervisor_note || E'\n' || $2 END,
                reviewed_at=NOW(),
                archived_at=NOW(),
                archived_by_employee_id=$3,
                archive_reason=$2
          WHERE time_entry_id=$1 AND status='pending' RETURNING id`,
        [entry.id, `Punch voided: ${reason}`, req.user.id],
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
        ...(auditDetails || {}),
        employee_id: entry.employee_id,
        original_clock_in: entry.clock_in,
        original_clock_out: entry.clock_out,
        original_status: entry.status,
        reason,
        punch_kind: punchKind,
        approval_reopened: Boolean(approval),
        previous_approval_status: approval?.status || null,
        cancelled_change_request_ids: cancelledRequests.rows.map((row) => row.id),
        soft_delete: softDelete,
      };

      await client.query('COMMIT');
      await audit(req.user.id, 'void_time_entry', 'time_entry', entry.id, auditDetails);
      return res.json({
        message: managementSequenceEdit
          ? 'Punch voided and the remaining punches were safely re-paired. Original values remain in the audit trail.'
          : (punchKind === 'out'
            ? 'Clock-out punch voided. The clock-in remains open and the original clock-out remains in the audit trail.'
            : 'Punch voided. The original record remains in the audit trail.'),
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      return res.status(500).json({ error: 'Delete punch error' });
    } finally {
      if (client) client.release();
    }
  });

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
          WHERE employee_id=$1
            AND deleted_at IS NULL
            AND clock_out IS NULL
            AND pending_clock_out IS NULL
          ORDER BY clock_in DESC LIMIT 1`,
        [req.user.id],
      );
      if (openEntry.rows.length) {
        if (openEntry.rows[0].requires_correction) {
          return res.status(409).json({
            error: 'Your previous open punch must have a correction request submitted before you can punch again.',
            code: 'STALE_OPEN_PUNCH',time_entry_id: openEntry.rows[0].id,clock_in: openEntry.rows[0].clock_in,
          });
        }
        return res.status(400).json({ error: 'You are already clocked in' });
      }

      const cooldown=await punchCooldown(req.user.id);
      if(cooldown.active) return cooldownResponse(res,cooldown);

      const locationGate = await requirePunchLocation(req, res, 'clock_in');
      if (!locationGate) return;

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
          WHERE employee_id=$1
            AND deleted_at IS NULL
            AND clock_out IS NULL
            AND pending_clock_out IS NULL
          ORDER BY clock_in DESC LIMIT 1`,
        [req.user.id],
      );
      if (!openResult.rows.length) return res.status(400).json({ error: 'You are not currently clocked in' });
      const openEntry = openResult.rows[0];
      if (openEntry.requires_correction) {
        return res.status(409).json({
          error: 'Your previous open punch must have a correction request submitted before you can punch again.',
          code: 'STALE_OPEN_PUNCH',time_entry_id: openEntry.id,clock_in: openEntry.clock_in,
        });
      }

      const cooldown=await punchCooldown(req.user.id);
      if(cooldown.active) return cooldownResponse(res,cooldown);

      const locationGate = await requirePunchLocation(req, res, 'clock_out');
      if (!locationGate) return;

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

module.exports = { createQuickPunchRouter, PUNCH_COOLDOWN_SECONDS };
