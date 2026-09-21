'use strict';

const express = require('express');

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`Valid ${label} is required`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function validWorkDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
}

async function effectiveLunchSetting(db, employeeId, workDate) {
  const result = await db.query(
    `SELECT enabled,minutes
       FROM forced_lunch_setting_history
      WHERE employee_id=$1 AND effective_date <= $2::date
      ORDER BY effective_date DESC
      LIMIT 1`,
    [employeeId, workDate],
  );
  return result.rows[0] || null;
}

async function approvalAffectedByDate(client, employeeId, workDate) {
  const result = await client.query(
    `SELECT id,status,employee_signed_at,supervisor_approved_at,payroll_finalized_at
       FROM pay_period_approvals
      WHERE employee_id=$1
        AND $2::date BETWEEN pay_period_start AND pay_period_end
      ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [employeeId, workDate],
  );
  return result.rows[0] || null;
}

async function approvalsAffectedByRange(client, employeeId, effectiveDate) {
  const nextSetting = await client.query(
    `SELECT to_char(effective_date,'YYYY-MM-DD') AS effective_date_iso
       FROM forced_lunch_setting_history
      WHERE employee_id=$1 AND effective_date > $2::date
      ORDER BY effective_date LIMIT 1`,
    [employeeId, effectiveDate],
  );
  const nextEffectiveDate = nextSetting.rows[0]?.effective_date_iso || null;
  const approvals = await client.query(
    `SELECT id,status,pay_period_start,pay_period_end,
            employee_signed_at,supervisor_approved_at,payroll_finalized_at
       FROM pay_period_approvals
      WHERE employee_id=$1
        AND pay_period_end >= $2::date
        AND ($3::date IS NULL OR pay_period_start < $3::date)
      ORDER BY pay_period_start
      FOR UPDATE`,
    [employeeId, effectiveDate, nextEffectiveDate],
  );
  return { approvals: approvals.rows, nextEffectiveDate };
}

function finalized(approval) {
  return Boolean(approval?.payroll_finalized_at || approval?.status === 'payroll_finalized');
}

async function reopenSignedApproval(client, approval) {
  if (!approval?.employee_signed_at) return false;
  await client.query(
    `UPDATE pay_period_approvals
        SET supervisor_approved_at=NULL,
            supervisor_employee_id=NULL,
            payroll_finalized_at=NULL,
            payroll_finalized_by=NULL,
            status='employee_submitted'
      WHERE id=$1`,
    [approval.id],
  );
  return true;
}

function createLunchRouter({ requireUser, requireAnyPermission, pool, audit, canAccessEmployee }) {
  const router = express.Router();

  router.post(
    '/supervisor/lunch-settings',
    requireUser,
    requireAnyPermission('manage_employee_timeclock_settings', 'manage_supervisor_assignments'),
    async (req, res) => {
      let client = null;
      try {
        const employeeId = positiveInt(req.body?.employee_id, 'employee');
        const enabled = req.body?.enabled === true;
        const minutes = positiveInt(req.body?.minutes, 'lunch duration');
        if (minutes > 240) return res.status(400).json({ error: 'Lunch duration cannot exceed 240 minutes' });
        if (!(await canAccessEmployee(req.user, employeeId))) return res.status(403).json({ error: 'Access denied' });

        client = await pool.connect();
        await client.query('BEGIN');
        let effectiveDate = validWorkDate(req.body?.effective_date);
        if (!effectiveDate) {
          const today = await client.query(`SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS work_date`);
          effectiveDate = today.rows[0].work_date;
        }

        const employee = await client.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE', [employeeId]);
        if (!employee.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Employee not found' });
        }

        const affected = await approvalsAffectedByRange(client, employeeId, effectiveDate);
        if (affected.approvals.some(finalized)) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'Forced lunch settings cannot be changed because the effective range overlaps a payroll-finalized pay period',
          });
        }

        await client.query(
          `INSERT INTO forced_lunch_setting_history(
             employee_id,effective_date,enabled,minutes,changed_by_employee_id
           ) VALUES($1,$2::date,$3,$4,$5)
           ON CONFLICT(employee_id,effective_date)
           DO UPDATE SET enabled=EXCLUDED.enabled,minutes=EXCLUDED.minutes,
                         changed_by_employee_id=EXCLUDED.changed_by_employee_id,created_at=NOW()`,
          [employeeId, effectiveDate, enabled, minutes, req.user.id],
        );

        const current = await client.query(
          `SELECT enabled,minutes FROM forced_lunch_setting_history
            WHERE employee_id=$1 AND effective_date <= CURRENT_DATE
            ORDER BY effective_date DESC LIMIT 1`,
          [employeeId],
        );
        const currentEnabled = current.rows[0]?.enabled === true;
        const currentMinutes = Number(current.rows[0]?.minutes || minutes);
        const updated = await client.query(
          `UPDATE employees SET forced_lunch_enabled=$1,forced_lunch_minutes=$2
            WHERE id=$3 RETURNING id,forced_lunch_enabled,forced_lunch_minutes`,
          [currentEnabled, currentMinutes, employeeId],
        );

        const approvalsToReopen = affected.approvals.filter(item => item.employee_signed_at);
        if (approvalsToReopen.length) {
          await client.query(
            `UPDATE pay_period_approvals
                SET supervisor_approved_at=NULL,supervisor_employee_id=NULL,
                    payroll_finalized_at=NULL,payroll_finalized_by=NULL,status='employee_submitted'
              WHERE id = ANY($1::int[])`,
            [approvalsToReopen.map(item => item.id)],
          );
        }
        await client.query('COMMIT');

        await audit(req.user.id, 'update_forced_lunch_settings', 'employee', employeeId, {
          forced_lunch_enabled: enabled,
          forced_lunch_minutes: minutes,
          effective_date: effectiveDate,
          next_effective_date: affected.nextEffectiveDate,
          affected_approval_ids: affected.approvals.map(item => item.id),
          reopened_approval_ids: approvalsToReopen.map(item => item.id),
        });
        return res.json({ message: 'Forced lunch settings updated', effective_date: effectiveDate, employee: updated.rows[0] });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: 'Forced lunch settings update failed' });
      } finally {
        if (client) client.release();
      }
    },
  );

  router.post(
    '/employee/request-lunch-waiver',
    requireUser,
    requireAnyPermission('view_own_time', 'request_punch_correction'),
    async (req, res) => {
      const workDate = validWorkDate(req.body?.work_date);
      const reason = String(req.body?.reason || '').trim();
      if (!workDate) return res.status(400).json({ error: 'Valid work date is required' });
      if (!reason) return res.status(400).json({ error: 'Reason is required' });
      if (reason.length > 1000) return res.status(400).json({ error: 'Reason must be 1000 characters or less' });
      try {
        const setting = await effectiveLunchSetting(pool, req.user.id, workDate);
        if (!setting?.enabled) return res.status(409).json({ error: 'Forced lunch is not enabled for this date' });
        const existingWaiver = await pool.query(
          `SELECT id FROM forced_lunch_waivers
            WHERE employee_id=$1 AND work_date=$2::date AND active=TRUE LIMIT 1`,
          [req.user.id, workDate],
        );
        if (existingWaiver.rows.length) return res.status(409).json({ error: 'Forced lunch has already been removed for this date' });
        const inserted = await pool.query(
          `INSERT INTO forced_lunch_waiver_requests(employee_id,work_date,reason,requested_by_employee_id)
           VALUES($1,$2::date,$3,$1) RETURNING id`,
          [req.user.id, workDate, reason],
        );
        await audit(req.user.id, 'request_forced_lunch_waiver', 'forced_lunch_waiver_request', inserted.rows[0].id, {
          employee_id: req.user.id, work_date: workDate, reason,
        });
        return res.json({ message: 'Lunch removal request submitted', request_id: inserted.rows[0].id });
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'A lunch removal request is already pending for this date' });
        console.error(err);
        return res.status(500).json({ error: 'Lunch removal request failed' });
      }
    },
  );

  router.get(
    '/supervisor/lunch-waiver-requests',
    requireUser,
    requireAnyPermission('approve_timecard', 'edit_employee_time', 'edit_payroll_time'),
    async (req, res) => {
      try {
        const result = await pool.query(
          `SELECT r.*,e.first_name,e.last_name,d.name AS department
             FROM forced_lunch_waiver_requests r
             JOIN employees e ON e.id=r.employee_id
             LEFT JOIN departments d ON d.id=e.department_id
            WHERE r.status='pending'
              AND ($1::text IN ('admin','payroll')
                OR e.id IN (SELECT employee_id FROM supervisor_employee_assignments WHERE supervisor_employee_id=$2 AND active=TRUE)
                OR e.department_id IN (SELECT department_id FROM department_heads WHERE employee_id=$2 AND active=TRUE))
            ORDER BY r.work_date,r.created_at`,
          [req.user.role, req.user.id],
        );
        return res.json(result.rows);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Lunch removal request lookup failed' });
      }
    },
  );

  router.post(
    '/supervisor/review-lunch-waiver-request',
    requireUser,
    requireAnyPermission('approve_timecard', 'edit_employee_time', 'edit_payroll_time'),
    async (req, res) => {
      let client = null;
      try {
        const requestId = positiveInt(req.body?.request_id, 'request');
        const status = String(req.body?.status || '');
        const reviewNote = String(req.body?.review_note || '').trim();
        if (!['approved', 'denied'].includes(status)) return res.status(400).json({ error: 'Status must be approved or denied' });

        const target = await pool.query('SELECT employee_id,status FROM forced_lunch_waiver_requests WHERE id=$1', [requestId]);
        if (!target.rows.length) return res.status(404).json({ error: 'Request not found' });
        if (target.rows[0].status !== 'pending') return res.status(409).json({ error: 'This request has already been reviewed' });
        if (!(await canAccessEmployee(req.user, target.rows[0].employee_id))) return res.status(403).json({ error: 'Access denied' });

        client = await pool.connect();
        await client.query('BEGIN');
        const locked = await client.query('SELECT * FROM forced_lunch_waiver_requests WHERE id=$1 FOR UPDATE', [requestId]);
        const request = locked.rows[0];
        if (!request || request.status !== 'pending') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This request has already been reviewed' });
        }

        let approval = null;
        let reopened = false;
        if (status === 'approved') {
          approval = await approvalAffectedByDate(client, request.employee_id, request.work_date);
          if (finalized(approval)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Forced lunch cannot be removed from a payroll-finalized pay period' });
          }
          const setting = await effectiveLunchSetting(client, request.employee_id, request.work_date);
          if (!setting?.enabled) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Forced lunch is not enabled for this date' });
          }
          await client.query(
            `INSERT INTO forced_lunch_waivers(employee_id,work_date,reason,source,request_id,waived_by_employee_id)
             VALUES($1,$2,$3,'approved_request',$4,$5)
             ON CONFLICT (employee_id,work_date) WHERE active=TRUE
             DO UPDATE SET reason=EXCLUDED.reason,source='approved_request',request_id=EXCLUDED.request_id,
                           waived_by_employee_id=EXCLUDED.waived_by_employee_id,created_at=NOW()`,
            [request.employee_id, request.work_date, request.reason, request.id, req.user.id],
          );
          reopened = await reopenSignedApproval(client, approval);
        }

        await client.query(
          `UPDATE forced_lunch_waiver_requests
              SET status=$1,reviewed_by_employee_id=$2,review_note=$3,reviewed_at=NOW()
            WHERE id=$4`,
          [status, req.user.id, reviewNote || null, requestId],
        );
        await client.query('COMMIT');
        await audit(req.user.id, `${status}_forced_lunch_waiver_request`, 'forced_lunch_waiver_request', requestId, {
          employee_id: request.employee_id, work_date: request.work_date, review_note: reviewNote || null,
          affected_approval_id: approval?.id || null, approval_reopened: reopened,
        });
        return res.json({ message: status === 'approved' ? 'Forced lunch removed for this date' : 'Lunch removal request denied' });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: 'Lunch removal request review failed' });
      } finally {
        if (client) client.release();
      }
    },
  );

  router.post(
    '/supervisor/lunch-waiver',
    requireUser,
    requireAnyPermission('approve_timecard', 'edit_employee_time', 'edit_payroll_time'),
    async (req, res) => {
      let client = null;
      try {
        const employeeId = positiveInt(req.body?.employee_id, 'employee');
        const workDate = validWorkDate(req.body?.work_date);
        const reason = String(req.body?.reason || '').trim();
        if (!workDate) return res.status(400).json({ error: 'Valid work date is required' });
        if (!reason) return res.status(400).json({ error: 'Reason is required' });
        if (reason.length > 1000) return res.status(400).json({ error: 'Reason must be 1000 characters or less' });
        if (!(await canAccessEmployee(req.user, employeeId))) return res.status(403).json({ error: 'Access denied' });

        client = await pool.connect();
        await client.query('BEGIN');
        const employee = await client.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE', [employeeId]);
        if (!employee.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Employee not found' });
        }
        const setting = await effectiveLunchSetting(client, employeeId, workDate);
        if (!setting?.enabled) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Forced lunch is not enabled for this date' });
        }
        const approval = await approvalAffectedByDate(client, employeeId, workDate);
        if (finalized(approval)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Forced lunch cannot be removed from a payroll-finalized pay period' });
        }

        await client.query(
          `INSERT INTO forced_lunch_waivers(employee_id,work_date,reason,source,waived_by_employee_id)
           VALUES($1,$2::date,$3,'supervisor',$4)
           ON CONFLICT (employee_id,work_date) WHERE active=TRUE
           DO UPDATE SET reason=EXCLUDED.reason,source='supervisor',request_id=NULL,
                         waived_by_employee_id=EXCLUDED.waived_by_employee_id,created_at=NOW()`,
          [employeeId, workDate, reason, req.user.id],
        );
        const reopened = await reopenSignedApproval(client, approval);
        await client.query('COMMIT');

        await audit(req.user.id, 'remove_forced_lunch', 'employee', employeeId, {
          work_date: workDate, reason, affected_approval_id: approval?.id || null, approval_reopened: reopened,
        });
        return res.json({ message: 'Forced lunch removed for this date' });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: 'Forced lunch removal failed' });
      } finally {
        if (client) client.release();
      }
    },
  );

  return router;
}

module.exports = { createLunchRouter };
