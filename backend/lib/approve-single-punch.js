'use strict';

const { insertPunchIntoSequence } = require('./punch-sequence');

function permissionSet(user) {
  return new Set(Array.isArray(user?.permissions) ? user.permissions : []);
}

async function canReviewEmployee(pool, user, employeeId) {
  const role = String(user?.role || '').toLowerCase();
  const permissions = permissionSet(user);
  if (Number(user?.id) === Number(employeeId)) {
    return permissions.has('approve_own_punch_corrections');
  }
  if (permissions.has('app_admin') || permissions.has('view_all_timeclock_records') || role === 'payroll' || role === 'admin') {
    return true;
  }
  if (!permissions.has('approve_punch_correction')) return false;

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

function createApproveSinglePunchHandler({ pool, audit }) {
  return async (req, res) => {
    const requestId = Number(req.body?.request_id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: 'Valid punch request is required' });
    }
    const supervisorNote = String(req.body?.supervisor_note || '').trim();

    const preview = await pool.query(
      `SELECT employee_id,time_entry_id,requested_clock_in,requested_clock_out,status
         FROM time_change_requests
        WHERE id=$1`,
      [requestId],
    );
    if (!preview.rows.length) return res.status(404).json({ error: 'Request not found' });
    const target = preview.rows[0];
    const isSinglePunch = target.time_entry_id == null
      && Boolean(target.requested_clock_in) !== Boolean(target.requested_clock_out);
    if (!isSinglePunch) {
      return res.status(409).json({
        error: 'This is not a single-punch request',
        code: 'NOT_SINGLE_PUNCH',
      });
    }
    if (target.status !== 'pending') return res.status(409).json({ error: 'This punch request has already been reviewed' });
    if (!(await canReviewEmployee(pool, req.user, target.employee_id))) return res.status(403).json({ error: 'Access denied' });

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
        return res.status(409).json({ error: 'This is not a single-punch request', code: 'NOT_SINGLE_PUNCH' });
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
        self_approved: Number(req.user.id) === Number(request.employee_id),
        invalidated_approval_ids: invalidated.rows.map((row) => row.id),
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
  };
}

module.exports = { createApproveSinglePunchHandler, canReviewEmployee };
