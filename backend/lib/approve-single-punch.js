'use strict';

const { insertPunchIntoSequence } = require('./punch-sequence');
const {
  requireReopenForFinalized,
  invalidateApprovals,
} = require('./payroll-approval-lock');

function punchTimestamp(request) {
  return request.requested_clock_in || request.requested_clock_out || null;
}

function createApproveSinglePunchHandler({ pool, audit, canAccessEmployee }) {
  return async (req, res) => {
    const requestId = Number(req.body?.request_id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: 'Valid punch request is required' });
    }
    const supervisorNote = String(req.body?.supervisor_note || '').trim();

    const preview = await pool.query(
      `SELECT employee_id,time_entry_id,requested_clock_in,requested_clock_out,status
         FROM time_change_requests WHERE id=$1`,
      [requestId],
    );
    if (!preview.rows.length) return res.status(404).json({ error: 'Request not found' });
    const target = preview.rows[0];
    const isSinglePunch = target.time_entry_id == null
      && Boolean(target.requested_clock_in) !== Boolean(target.requested_clock_out);
    if (!isSinglePunch) return res.status(409).json({ error: 'This is not a single-punch request', code: 'NOT_SINGLE_PUNCH' });
    if (target.status !== 'pending') return res.status(409).json({ error: 'This punch request has already been reviewed' });
    if (!(await canAccessEmployee(req.user, target.employee_id, ['approve_punch_correction']))) return res.status(403).json({ error: 'Access denied' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockedResult = await client.query(`SELECT * FROM time_change_requests WHERE id=$1 FOR UPDATE`, [requestId]);
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

      const punchAt = punchTimestamp(request);
      const existingDay = await client.query(
        `SELECT id FROM time_entries
          WHERE employee_id=$1 AND deleted_at IS NULL
            AND clock_in::date=$2::timestamp::date
          LIMIT 1 FOR UPDATE`,
        [request.employee_id, punchAt],
      );

      if (!existingDay.rows.length) {
        const companionResult = await client.query(
          `SELECT *
             FROM time_change_requests
            WHERE employee_id=$1
              AND id<>$2
              AND status='pending'
              AND time_entry_id IS NULL
              AND (requested_clock_in IS NULL) <> (requested_clock_out IS NULL)
              AND COALESCE(requested_clock_in,requested_clock_out)::date=$3::timestamp::date
            ORDER BY ABS(EXTRACT(EPOCH FROM (COALESCE(requested_clock_in,requested_clock_out)-$3::timestamp)))
            LIMIT 1
            FOR UPDATE`,
          [request.employee_id, requestId, punchAt],
        );
        const companion = companionResult.rows[0] || null;
        if (companion) {
          const companionAt = punchTimestamp(companion);
          const firstAt = new Date(punchAt) <= new Date(companionAt) ? punchAt : companionAt;
          const secondAt = new Date(punchAt) <= new Date(companionAt) ? companionAt : punchAt;
          if (new Date(secondAt) <= new Date(firstAt)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'The requested punches are not in a valid order' });
          }

          const affectedApprovals=await requireReopenForFinalized({
            db:client,
            user:req.user,
            employeeId:request.employee_id,
            timestamps:[firstAt,secondAt],
            canAccessEmployee,
          });

          const inserted = await client.query(
            `INSERT INTO time_entries(employee_id,clock_in,clock_out,notes,status)
             VALUES($1,$2,$3,$4,'closed') RETURNING *`,
            [request.employee_id, firstAt, secondAt, `Created from approved punch requests #${request.id} and #${companion.id}`],
          );
          await client.query(
            `INSERT INTO time_entry_audit(
               time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,new_clock_in,new_clock_out,reason
             ) VALUES($1,$2,NULL,NULL,$3,$4,$5)`,
            [inserted.rows[0].id, req.user.id, firstAt, secondAt, `${request.employee_reason || ''}${companion.employee_reason ? ` | ${companion.employee_reason}` : ''}`],
          );

          const invalidated=await invalidateApprovals(client,affectedApprovals);

          const reviewed = await client.query(
            `UPDATE time_change_requests
                SET status='approved',supervisor_id=$1,supervisor_note=$2,reviewed_at=NOW()
              WHERE id=ANY($3::int[]) AND status='pending'
              RETURNING id`,
            [req.user.id, supervisorNote, [request.id, companion.id]],
          );
          if (reviewed.rows.length !== 2) throw new Error('Punch requests changed while they were being approved');

          await client.query('COMMIT');
          await audit(req.user.id, 'approve_paired_single_punch_requests', 'time_entry', inserted.rows[0].id, {
            employee_id: request.employee_id,
            request_ids: [request.id, companion.id],
            clock_in: firstAt,
            clock_out: secondAt,
            self_approved: Number(req.user.id) === Number(request.employee_id),
            invalidated_approval_ids: invalidated.map((row) => row.id),
          });
          return res.json({
            message: 'Both pending punches for this work period were approved',
            paired_request_ids: [request.id, companion.id],
            entry: inserted.rows[0],
          });
        }
      }

      const affectedApprovals=await requireReopenForFinalized({
        db:client,
        user:req.user,
        employeeId:request.employee_id,
        timestamps:[punchAt],
        canAccessEmployee,
      });

      const placed = await insertPunchIntoSequence({
        client,
        employeeId: request.employee_id,
        punchAt,
        actorEmployeeId: req.user.id,
        reason: request.employee_reason,
        ignoreRequestId: requestId,
      });

      const invalidated=await invalidateApprovals(client,affectedApprovals);

      const reviewed = await client.query(
        `UPDATE time_change_requests
            SET status='approved',supervisor_id=$1,supervisor_note=$2,reviewed_at=NOW()
          WHERE id=$3 AND status='pending' RETURNING id`,
        [req.user.id, supervisorNote, requestId],
      );
      if (!reviewed.rows.length) throw new Error('Punch request changed while it was being approved');

      await client.query('COMMIT');
      await audit(req.user.id, 'approve_single_punch_request', 'time_change_request', requestId, {
        employee_id: request.employee_id,
        punch_at: punchAt,
        inferred_punch_type: placed.inferred_punch_type,
        self_approved: Number(req.user.id) === Number(request.employee_id),
        invalidated_approval_ids: invalidated.map((row) => row.id),
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

module.exports = { createApproveSinglePunchHandler };
