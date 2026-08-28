'use strict';

const { insertPunchIntoSequence } = require('./punch-sequence');

function explicitPermission(user, key) {
  return new Set(Array.isArray(user?.permissions) ? user.permissions : []).has(key);
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createApproveOwnPunchHandler({ pool, audit }) {
  return async (req, res) => {
    if (!explicitPermission(req.user, 'approve_own_punch_corrections')) {
      return res.status(403).json({ error: 'Approve Own Punch Corrections permission required' });
    }

    const requestId = positiveInt(req.body?.request_id);
    if (!requestId) return res.status(400).json({ error: 'Valid punch request is required' });
    const note = String(req.body?.supervisor_note || '').trim();

    const client = await pool.connect();
    try {
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
      if (Number(request.employee_id) !== Number(req.user.id)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'This permission only allows approval of your own punch requests' });
      }
      if (request.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This punch request has already been reviewed' });
      }

      const singlePunch = request.time_entry_id == null
        && Boolean(request.requested_clock_in) !== Boolean(request.requested_clock_out);
      let punchAt = null;
      let affectedEntryId = null;
      let action = 'self_approve_punch_correction';

      if (singlePunch) {
        punchAt = request.requested_clock_in || request.requested_clock_out;
        const placed = await insertPunchIntoSequence({
          client,
          employeeId: req.user.id,
          punchAt,
          actorEmployeeId: req.user.id,
          reason: request.employee_reason,
          ignoreRequestId: requestId,
        });
        affectedEntryId = placed.entries.find((entry) =>
          new Date(entry.clock_in).getTime() === new Date(punchAt).getTime()
          || (entry.clock_out && new Date(entry.clock_out).getTime() === new Date(punchAt).getTime()),
        )?.id || null;
        action = 'self_approve_single_punch';
      } else if (request.time_entry_id != null) {
        const existingResult = await client.query(
          `SELECT * FROM time_entries
            WHERE id=$1 AND employee_id=$2 AND deleted_at IS NULL
            FOR UPDATE`,
          [request.time_entry_id, req.user.id],
        );
        const existing = existingResult.rows[0] || null;
        if (!existing) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Original time entry not found' });
        }

        const newClockIn = request.requested_clock_in ?? existing.clock_in;
        const newClockOut = request.requested_clock_out ?? existing.clock_out;
        const parsedIn = validDate(newClockIn);
        const parsedOut = newClockOut ? validDate(newClockOut) : null;
        if (!parsedIn || (newClockOut && !parsedOut) || (parsedOut && parsedOut <= parsedIn)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Requested punch order is invalid' });
        }

        await client.query(
          `INSERT INTO time_entry_audit(
             time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,
             new_clock_in,new_clock_out,reason
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [existing.id, req.user.id, existing.clock_in, existing.clock_out, newClockIn, newClockOut, request.employee_reason],
        );
        await client.query(
          `UPDATE time_entries
              SET clock_in=$1,clock_out=$2,
                  status=CASE WHEN $2::timestamp IS NULL THEN 'open' ELSE 'closed' END
            WHERE id=$3 AND deleted_at IS NULL`,
          [newClockIn, newClockOut, existing.id],
        );
        punchAt = newClockIn;
        affectedEntryId = existing.id;
      } else {
        const newClockIn = request.requested_clock_in;
        const newClockOut = request.requested_clock_out;
        const parsedIn = validDate(newClockIn);
        const parsedOut = validDate(newClockOut);
        if (!parsedIn || !parsedOut || parsedOut <= parsedIn) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Requested punch order is invalid' });
        }
        const overlap = await client.query(
          `SELECT id FROM time_entries
            WHERE employee_id=$1 AND deleted_at IS NULL
              AND clock_in < $3::timestamp
              AND COALESCE(clock_out,NOW()) > $2::timestamp
            LIMIT 1 FOR UPDATE`,
          [req.user.id, newClockIn, newClockOut],
        );
        if (overlap.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'The requested time overlaps an existing punch' });
        }
        const inserted = await client.query(
          `INSERT INTO time_entries(employee_id,clock_in,clock_out,notes,status)
           VALUES($1,$2,$3,$4,'closed') RETURNING id`,
          [req.user.id, newClockIn, newClockOut, `Created from self-approved request #${request.id}`],
        );
        affectedEntryId = inserted.rows[0].id;
        punchAt = newClockIn;
      }

      await client.query(
        `UPDATE pay_period_approvals
            SET supervisor_approved_at=NULL,
                supervisor_employee_id=NULL,
                payroll_finalized_at=NULL,
                payroll_finalized_by=NULL,
                status=CASE WHEN employee_signed_at IS NULL THEN 'open' ELSE 'employee_submitted' END
          WHERE employee_id=$1
            AND $2::timestamp >= pay_period_start
            AND $2::timestamp < (pay_period_end + INTERVAL '1 day')`,
        [req.user.id, punchAt],
      );

      const reviewed = await client.query(
        `UPDATE time_change_requests
            SET status='approved',supervisor_id=$1,supervisor_note=$2,reviewed_at=NOW()
          WHERE id=$3 AND status='pending'
          RETURNING id`,
        [req.user.id, note, requestId],
      );
      if (!reviewed.rows.length) throw new Error('Punch request changed while it was being approved');

      await client.query('COMMIT');
      await audit(req.user.id, action, 'time_change_request', requestId, {
        employee_id: req.user.id,
        time_entry_id: affectedEntryId,
        self_approved: true,
      });
      return res.json({ message: 'Your punch request was approved' });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      if (err.code === '23505') return res.status(409).json({ error: 'This punch would create a conflicting open punch' });
      if (err.code === '23514') return res.status(400).json({ error: 'The approved punch would create an invalid punch order' });
      console.error(err);
      return res.status(500).json({ error: 'Approve own punch request error' });
    } finally {
      client.release();
    }
  };
}

function createApproveOwnTimecardHandler({ pool, audit, getRequestedPayPeriod }) {
  return async (req, res) => {
    if (!explicitPermission(req.user, 'approve_own_timecard')) {
      return res.status(403).json({ error: 'Approve Own Timecard permission required' });
    }

    const client = await pool.connect();
    try {
      const period = await getRequestedPayPeriod(req);
      await client.query('BEGIN');
      const approvalResult = await client.query(
        `SELECT * FROM pay_period_approvals
          WHERE employee_id=$1 AND pay_period_start=$2::date AND pay_period_end=$3::date
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [req.user.id, period.pay_period_start, period.pay_period_end],
      );
      const approval = approvalResult.rows[0] || null;
      if (!approval) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'No submitted timecard found' });
      }
      if (!approval.employee_signed_at || approval.status !== 'employee_submitted') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Your timecard is not awaiting supervisor approval' });
      }

      const [openPunches, pendingLeave, pendingChanges] = await Promise.all([
        client.query(
          `SELECT id FROM time_entries
            WHERE employee_id=$1 AND deleted_at IS NULL
              AND clock_in >= $2::date AND clock_in < ($3::date + INTERVAL '1 day')
              AND clock_out IS NULL`,
          [req.user.id, period.pay_period_start, period.pay_period_end],
        ),
        client.query(
          `SELECT id FROM leave_entries
            WHERE employee_id=$1 AND leave_date BETWEEN $2::date AND $3::date AND status='pending'`,
          [req.user.id, period.pay_period_start, period.pay_period_end],
        ),
        client.query(
          `SELECT tcr.id FROM time_change_requests tcr
             LEFT JOIN time_entries te ON te.id=tcr.time_entry_id
            WHERE tcr.employee_id=$1 AND tcr.status='pending'
              AND (tcr.time_entry_id IS NULL OR te.deleted_at IS NULL)
              AND (
                (te.clock_in >= $2::date AND te.clock_in < ($3::date + INTERVAL '1 day'))
                OR
                (tcr.requested_clock_in >= $2::date AND tcr.requested_clock_in < ($3::date + INTERVAL '1 day'))
              )`,
          [req.user.id, period.pay_period_start, period.pay_period_end],
        ),
      ]);

      if (openPunches.rows.length || pendingLeave.rows.length || pendingChanges.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Resolve open punches and pending leave/change requests before approving your timecard',
        });
      }

      const updated = await client.query(
        `UPDATE pay_period_approvals
            SET supervisor_approved_at=NOW(),supervisor_employee_id=$2,status='supervisor_approved'
          WHERE id=$1 AND status='employee_submitted' AND employee_signed_at IS NOT NULL
          RETURNING id`,
        [approval.id, req.user.id],
      );
      if (!updated.rows.length) throw new Error('Timecard changed while it was being approved');

      await client.query('COMMIT');
      await audit(req.user.id, 'self_approve_timecard', 'employee', req.user.id, {
        ...period,
        self_approved: true,
      });
      return res.json({ message: 'Your timecard was approved' });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      return res.status(err.statusCode || 500).json({ error: err.message || 'Approve own timecard error' });
    } finally {
      client.release();
    }
  };
}

module.exports = {
  explicitPermission,
  createApproveOwnPunchHandler,
  createApproveOwnTimecardHandler,
};
