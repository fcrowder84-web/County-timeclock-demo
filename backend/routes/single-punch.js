'use strict';

const express = require('express');
const { insertPunchIntoSequence } = require('../lib/punch-sequence');

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function createSinglePunchRouter({ requireUser, requireAnyPermission, pool, audit, canAccessEmployee }) {
  const router = express.Router();

  // This route is intentionally mounted before the general supervisor router.
  // It handles only a pending single-punch request. Complete interval/change
  // requests call next() and retain the established approval workflow.
  router.post(
    '/supervisor/approve-change-request',
    requireUser,
    requireAnyPermission('approve_punch_correction'),
    async (req, res, next) => {
      const requestId = positiveInt(req.body?.request_id);
      if (!requestId) return next();

      const preview = await pool.query(
        `SELECT employee_id,time_entry_id,requested_clock_in,requested_clock_out,status
           FROM time_change_requests
          WHERE id=$1`,
        [requestId],
      ).catch(next);
      if (!preview) return;
      if (!preview.rows.length) return next();

      const row = preview.rows[0];
      const singlePunch = row.time_entry_id == null
        && Boolean(row.requested_clock_in) !== Boolean(row.requested_clock_out);
      if (!singlePunch) return next();
      if (row.status !== 'pending') {
        return res.status(409).json({ error: 'This punch request has already been reviewed' });
      }
      if (!(await canAccessEmployee(req.user, row.employee_id, ['approve_punch_correction']))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const supervisorNote = String(req.body?.supervisor_note || '').trim();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const lockedResult = await client.query(
          `SELECT * FROM time_change_requests WHERE id=$1 FOR UPDATE`,
          [requestId],
        );
        const request = lockedResult.rows[0] || null;
        if (!request) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Request not found' });
        }
        if (request.status !== 'pending') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This punch request has already been reviewed' });
        }
        if (request.time_entry_id != null || Boolean(request.requested_clock_in) === Boolean(request.requested_clock_out)) {
          await client.query('ROLLBACK');
          return next();
        }

        const punchAt = request.requested_clock_in || request.requested_clock_out;
        const placed = await insertPunchIntoSequence({
          client,
          employeeId: request.employee_id,
          punchAt,
          actorEmployeeId: req.user.id,
          reason: request.employee_reason,
          ignoreRequestId: requestId,
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
          [request.employee_id, punchAt],
        );

        const reviewed = await client.query(
          `UPDATE time_change_requests
              SET status='approved',supervisor_id=$1,supervisor_note=$2,reviewed_at=NOW()
            WHERE id=$3 AND status='pending'
            RETURNING id`,
          [req.user.id, supervisorNote, requestId],
        );
        if (!reviewed.rows.length) throw new Error('Punch request changed while it was being approved');

        await client.query('COMMIT');
        await audit(req.user.id, 'approve_single_punch_request', 'time_change_request', requestId, {
          employee_id: request.employee_id,
          punch_at: punchAt,
          inferred_punch_type: placed.inferred_punch_type,
          invalidated_approval_ids: invalidated.rows.map((item) => item.id),
        });
        return res.json({
          message: `Punch approved and placed as ${placed.inferred_punch_type === 'clock_out' ? 'clock out' : 'clock in'}`,
          inferred_punch_type: placed.inferred_punch_type,
          entries: placed.entries,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        if (err.code === '23505') return res.status(409).json({ error: 'The approved punch would create a conflicting open punch' });
        if (err.code === '23514') return res.status(400).json({ error: 'The approved punch would create an invalid punch order' });
        console.error(err);
        return res.status(500).json({ error: 'Approve punch request error' });
      } finally {
        client.release();
      }
    },
  );

  return router;
}

module.exports = { createSinglePunchRouter };
