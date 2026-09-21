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

function createLunchRouter({
  requireUser,
  requireAnyPermission,
  pool,
  audit,
  canAccessEmployee,
}) {
  const router = express.Router();

  router.post(
    '/supervisor/lunch-settings',
    requireUser,
    requireAnyPermission('manage_employee_timeclock_settings', 'manage_supervisor_assignments'),
    async (req, res) => {
      try {
        const employeeId = positiveInt(req.body?.employee_id, 'employee');
        const enabled = req.body?.enabled === true;
        const minutes = positiveInt(req.body?.minutes, 'lunch duration');
        if (minutes > 240) return res.status(400).json({ error: 'Lunch duration cannot exceed 240 minutes' });
        if (!(await canAccessEmployee(req.user, employeeId))) return res.status(403).json({ error: 'Access denied' });

        const updated = await pool.query(
          `UPDATE employees
              SET forced_lunch_enabled=$1, forced_lunch_minutes=$2
            WHERE id=$3
            RETURNING id,forced_lunch_enabled,forced_lunch_minutes`,
          [enabled, minutes, employeeId],
        );
        if (!updated.rows.length) return res.status(404).json({ error: 'Employee not found' });

        await audit(req.user.id, 'update_forced_lunch_settings', 'employee', employeeId, {
          forced_lunch_enabled: enabled,
          forced_lunch_minutes: minutes,
        });
        return res.json({ message: 'Forced lunch settings updated', employee: updated.rows[0] });
      } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: 'Forced lunch settings update failed' });
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
        const employee = await pool.query(
          `SELECT forced_lunch_enabled FROM employees WHERE id=$1`,
          [req.user.id],
        );
        if (!employee.rows[0]?.forced_lunch_enabled) {
          return res.status(409).json({ error: 'Forced lunch is not enabled for your account' });
        }

        const existingWaiver = await pool.query(
          `SELECT id FROM forced_lunch_waivers
            WHERE employee_id=$1 AND work_date=$2::date AND active=TRUE LIMIT 1`,
          [req.user.id, workDate],
        );
        if (existingWaiver.rows.length) return res.status(409).json({ error: 'Forced lunch has already been removed for this date' });

        const inserted = await pool.query(
          `INSERT INTO forced_lunch_waiver_requests(
             employee_id,work_date,reason,requested_by_employee_id
           ) VALUES($1,$2::date,$3,$1)
           RETURNING id`,
          [req.user.id, workDate, reason],
        );
        await audit(req.user.id, 'request_forced_lunch_waiver', 'forced_lunch_waiver_request', inserted.rows[0].id, {
          employee_id: req.user.id,
          work_date: workDate,
          reason,
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

        const target = await pool.query(
          `SELECT employee_id,status FROM forced_lunch_waiver_requests WHERE id=$1`,
          [requestId],
        );
        if (!target.rows.length) return res.status(404).json({ error: 'Request not found' });
        if (target.rows[0].status !== 'pending') return res.status(409).json({ error: 'This request has already been reviewed' });
        if (!(await canAccessEmployee(req.user, target.rows[0].employee_id))) return res.status(403).json({ error: 'Access denied' });

        client = await pool.connect();
        await client.query('BEGIN');
        const locked = await client.query(
          `SELECT * FROM forced_lunch_waiver_requests WHERE id=$1 FOR UPDATE`,
          [requestId],
        );
        const request = locked.rows[0];
        if (!request || request.status !== 'pending') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This request has already been reviewed' });
        }

        if (status === 'approved') {
          await client.query(
            `INSERT INTO forced_lunch_waivers(
               employee_id,work_date,reason,source,request_id,waived_by_employee_id
             ) VALUES($1,$2,$3,'approved_request',$4,$5)
             ON CONFLICT (employee_id,work_date) WHERE active=TRUE
             DO UPDATE SET reason=EXCLUDED.reason,source='approved_request',
                           request_id=EXCLUDED.request_id,waived_by_employee_id=EXCLUDED.waived_by_employee_id,
                           created_at=NOW()`,
            [request.employee_id, request.work_date, request.reason, request.id, req.user.id],
          );
        }

        await client.query(
          `UPDATE forced_lunch_waiver_requests
              SET status=$1,reviewed_by_employee_id=$2,review_note=$3,reviewed_at=NOW()
            WHERE id=$4`,
          [status, req.user.id, reviewNote || null, requestId],
        );
        await client.query('COMMIT');

        await audit(req.user.id, `${status}_forced_lunch_waiver_request`, 'forced_lunch_waiver_request', requestId, {
          employee_id: request.employee_id,
          work_date: request.work_date,
          review_note: reviewNote || null,
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
      try {
        const employeeId = positiveInt(req.body?.employee_id, 'employee');
        const workDate = validWorkDate(req.body?.work_date);
        const reason = String(req.body?.reason || '').trim();
        if (!workDate) return res.status(400).json({ error: 'Valid work date is required' });
        if (!reason) return res.status(400).json({ error: 'Reason is required' });
        if (reason.length > 1000) return res.status(400).json({ error: 'Reason must be 1000 characters or less' });
        if (!(await canAccessEmployee(req.user, employeeId))) return res.status(403).json({ error: 'Access denied' });

        const employee = await pool.query(
          `SELECT forced_lunch_enabled FROM employees WHERE id=$1`,
          [employeeId],
        );
        if (!employee.rows.length) return res.status(404).json({ error: 'Employee not found' });
        if (!employee.rows[0].forced_lunch_enabled) return res.status(409).json({ error: 'Forced lunch is not enabled for this employee' });

        await pool.query(
          `INSERT INTO forced_lunch_waivers(
             employee_id,work_date,reason,source,waived_by_employee_id
           ) VALUES($1,$2::date,$3,'supervisor',$4)
           ON CONFLICT (employee_id,work_date) WHERE active=TRUE
           DO UPDATE SET reason=EXCLUDED.reason,source='supervisor',
                         request_id=NULL,waived_by_employee_id=EXCLUDED.waived_by_employee_id,
                         created_at=NOW()`,
          [employeeId, workDate, reason, req.user.id],
        );

        await audit(req.user.id, 'remove_forced_lunch', 'employee', employeeId, {
          work_date: workDate,
          reason,
        });
        return res.json({ message: 'Forced lunch removed for this date' });
      } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: 'Forced lunch removal failed' });
      }
    },
  );

  return router;
}

module.exports = { createLunchRouter };
