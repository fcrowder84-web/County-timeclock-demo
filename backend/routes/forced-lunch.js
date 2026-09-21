"use strict";

const express = require("express");
const {
  dateOnly,
  configuredMinutes,
  invalidateApprovalForWorkDate,
} = require("../lib/forced-lunch");

function positiveEmployeeId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error("Valid employee is required");
    error.statusCode = 400;
    throw error;
  }
  return id;
}

function validWorkDate(value) {
  const date = dateOnly(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const error = new Error("Valid work date is required");
    error.statusCode = 400;
    throw error;
  }
  return date;
}

function cleanReason(value, label = "Reason") {
  const reason = String(value || "").trim();
  if (!reason) {
    const error = new Error(`${label} is required`);
    error.statusCode = 400;
    throw error;
  }
  if (reason.length > 1000) {
    const error = new Error(`${label} must be 1000 characters or less`);
    error.statusCode = 400;
    throw error;
  }
  return reason;
}

async function employeeSettings(db, employeeId) {
  const result = await db.query(
    `SELECT id,department_id,forced_lunch_enabled,forced_lunch_minutes
       FROM employees
      WHERE id=$1 AND active=TRUE`,
    [employeeId],
  );
  return result.rows[0] || null;
}

async function hasWorkOnDate(db, employeeId, workDate) {
  const result = await db.query(
    `SELECT 1
       FROM time_entries
      WHERE employee_id=$1
        AND deleted_at IS NULL
        AND clock_in >= $2::date
        AND clock_in < ($2::date + INTERVAL '1 day')
      LIMIT 1`,
    [employeeId, workDate],
  );
  return result.rows.length > 0;
}

async function approvalForDate(db, employeeId, workDate, lock = false) {
  const result = await db.query(
    `SELECT *
       FROM pay_period_approvals
      WHERE employee_id=$1
        AND $2::date BETWEEN pay_period_start AND pay_period_end
      ORDER BY id DESC
      LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [employeeId, workDate],
  );
  return result.rows[0] || null;
}

async function upsertWaiver(client, {
  employeeId,
  workDate,
  minutes,
  reason,
  source,
  requestedBy,
  approvedBy,
}) {
  return client.query(
    `INSERT INTO forced_lunch_waivers(
       employee_id,work_date,configured_lunch_minutes,reason,source,
       requested_by_employee_id,approved_by_employee_id,approved_at
     ) VALUES($1,$2::date,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT(employee_id,work_date) DO UPDATE
       SET configured_lunch_minutes=EXCLUDED.configured_lunch_minutes,
           reason=EXCLUDED.reason,
           source=EXCLUDED.source,
           requested_by_employee_id=EXCLUDED.requested_by_employee_id,
           approved_by_employee_id=EXCLUDED.approved_by_employee_id,
           approved_at=NOW()
     RETURNING *`,
    [employeeId, workDate, minutes, reason, source, requestedBy || null, approvedBy],
  );
}

function createForcedLunchRouter({
  requireUser,
  requireAnyPermission,
  pool,
  audit,
  canAccessEmployee,
  userHasPermission,
}) {
  const router = express.Router();

  router.post(
    "/employee/request-lunch-waiver",
    requireUser,
    requireAnyPermission("view_own_time", "request_punch_correction"),
    async (req, res) => {
      try {
        const workDate = validWorkDate(req.body?.work_date);
        const reason = cleanReason(req.body?.reason);
        const settings = await employeeSettings(pool, req.user.id);
        if (!settings) return res.status(404).json({ error: "Employee not found" });

        const minutes = configuredMinutes(settings);
        if (!minutes) return res.status(409).json({ error: "Forced lunch is not enabled for your account" });
        if (!(await hasWorkOnDate(pool, req.user.id, workDate))) {
          return res.status(409).json({ error: "A lunch waiver can only be requested for a day with recorded work" });
        }

        const approval = await approvalForDate(pool, req.user.id, workDate);
        if (approval?.payroll_finalized_at) {
          return res.status(409).json({ error: "This pay period is payroll-finalized" });
        }
        if (approval?.employee_signed_at && approval.status !== "returned_to_employee") {
          return res.status(409).json({
            error: "This timecard is signed and locked. Your supervisor must return it before you can request lunch removal.",
          });
        }

        const existingWaiver = await pool.query(
          `SELECT id FROM forced_lunch_waivers WHERE employee_id=$1 AND work_date=$2::date LIMIT 1`,
          [req.user.id, workDate],
        );
        if (existingWaiver.rows.length) {
          return res.status(409).json({ error: "Forced lunch has already been removed for this date" });
        }

        const inserted = await pool.query(
          `INSERT INTO forced_lunch_waiver_requests(
             employee_id,work_date,configured_lunch_minutes,reason,status,requested_by_employee_id
           ) VALUES($1,$2::date,$3,$4,'pending',$1)
           ON CONFLICT (employee_id,work_date) WHERE status='pending'
           DO NOTHING
           RETURNING id`,
          [req.user.id, workDate, minutes, reason],
        );
        if (!inserted.rows.length) {
          return res.status(409).json({ error: "A lunch removal request is already pending for this date" });
        }

        await audit(req.user.id, "request_forced_lunch_waiver", "forced_lunch_waiver_request", inserted.rows[0].id, {
          work_date: workDate,
          configured_lunch_minutes: minutes,
          reason,
        });

        return res.json({
          message: "Lunch removal request submitted to your supervisor",
          request_id: inserted.rows[0].id,
        });
      } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: "Lunch removal request failed" });
      }
    },
  );

  router.post(
    "/supervisor/employee-lunch-settings",
    requireUser,
    requireAnyPermission("manage_employee_timeclock_settings"),
    async (req, res) => {
      try {
        const employeeId = positiveEmployeeId(req.body?.employee_id);
        if (!(await canAccessEmployee(req.user, employeeId, ["manage_employee_timeclock_settings"]))) {
          return res.status(403).json({ error: "Access denied" });
        }

        const enabled = req.body?.forced_lunch_enabled === true;
        const minutes = Number(req.body?.forced_lunch_minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
          return res.status(400).json({ error: "Lunch duration must be between 1 and 240 minutes" });
        }

        const updated = await pool.query(
          `UPDATE employees
              SET forced_lunch_enabled=$2,
                  forced_lunch_minutes=$3
            WHERE id=$1
            RETURNING id,forced_lunch_enabled,forced_lunch_minutes`,
          [employeeId, enabled, minutes],
        );
        if (!updated.rows.length) return res.status(404).json({ error: "Employee not found" });

        await audit(req.user.id, "update_forced_lunch_settings", "employee", employeeId, {
          forced_lunch_enabled: enabled,
          forced_lunch_minutes: minutes,
        });

        return res.json({
          message: enabled
            ? `Forced lunch set to ${minutes} minutes`
            : "Forced lunch disabled",
          employee: updated.rows[0],
        });
      } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: "Lunch settings update failed" });
      }
    },
  );

  router.post(
    "/supervisor/waive-forced-lunch",
    requireUser,
    requireAnyPermission("edit_employee_time", "edit_payroll_time"),
    async (req, res) => {
      let client = null;
      try {
        const employeeId = positiveEmployeeId(req.body?.employee_id);
        const workDate = validWorkDate(req.body?.work_date);
        const reason = cleanReason(req.body?.reason);
        if (!(await canAccessEmployee(req.user, employeeId))) {
          return res.status(403).json({ error: "Access denied" });
        }

        client = await pool.connect();
        await client.query("BEGIN");
        const settings = await employeeSettings(client, employeeId);
        if (!settings) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Employee not found" });
        }
        const minutes = configuredMinutes(settings);
        if (!minutes) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Forced lunch is not enabled for this employee" });
        }
        if (!(await hasWorkOnDate(client, employeeId, workDate))) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "There is no recorded work for this date" });
        }

        const approval = await approvalForDate(client, employeeId, workDate, true);
        const payrollOverride = userHasPermission(req.user, "edit_payroll_time");
        if (approval?.payroll_finalized_at && !payrollOverride) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "This timecard is payroll-finalized" });
        }
        if (!payrollOverride && approval && (
          !approval.employee_signed_at ||
          approval.supervisor_approved_at ||
          approval.status !== "employee_submitted"
        )) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Supervisor lunch removal is available while the submitted timecard is awaiting supervisor review",
          });
        }

        const waiver = await upsertWaiver(client, {
          employeeId,
          workDate,
          minutes,
          reason,
          source: "supervisor",
          requestedBy: null,
          approvedBy: req.user.id,
        });
        await client.query(
          `UPDATE forced_lunch_waiver_requests
              SET status='approved',reviewed_by_employee_id=$3,reviewed_at=NOW(),
                  review_note=COALESCE(NULLIF(review_note,''),$4)
            WHERE employee_id=$1 AND work_date=$2::date AND status='pending'`,
          [employeeId, workDate, req.user.id, reason],
        );
        await invalidateApprovalForWorkDate(client, employeeId, workDate);
        await client.query("COMMIT");

        await audit(req.user.id, "waive_forced_lunch", "forced_lunch_waiver", waiver.rows[0].id, {
          employee_id: employeeId,
          work_date: workDate,
          configured_lunch_minutes: minutes,
          reason,
          source: "supervisor",
        });

        return res.json({ message: "Forced lunch removed for this date" });
      } catch (err) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: "Lunch removal failed" });
      } finally {
        if (client) client.release();
      }
    },
  );

  router.post(
    "/supervisor/review-lunch-waiver",
    requireUser,
    requireAnyPermission("approve_timecard", "edit_employee_time", "edit_payroll_time"),
    async (req, res) => {
      let client = null;
      try {
        const requestId = Number(req.body?.request_id);
        if (!Number.isInteger(requestId) || requestId <= 0) {
          return res.status(400).json({ error: "Valid lunch request is required" });
        }
        const status = String(req.body?.status || "");
        if (!["approved", "denied"].includes(status)) {
          return res.status(400).json({ error: "Status must be approved or denied" });
        }
        const reviewNote = String(req.body?.review_note || "").trim();
        if (reviewNote.length > 1000) {
          return res.status(400).json({ error: "Review note must be 1000 characters or less" });
        }

        client = await pool.connect();
        await client.query("BEGIN");
        const requestResult = await client.query(
          `SELECT * FROM forced_lunch_waiver_requests WHERE id=$1 FOR UPDATE`,
          [requestId],
        );
        const request = requestResult.rows[0] || null;
        if (!request) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Lunch request not found" });
        }
        if (request.status !== "pending") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "This lunch request has already been reviewed" });
        }
        if (!(await canAccessEmployee(req.user, request.employee_id))) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "Access denied" });
        }
        if (Number(request.employee_id) === Number(req.user.id) &&
            !userHasPermission(req.user, "approve_own_timecard") &&
            !userHasPermission(req.user, "edit_payroll_time") &&
            !userHasPermission(req.user, "app_admin")) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "You cannot approve your own lunch removal request" });
        }

        let waiverId = null;
        if (status === "approved") {
          const settings = await employeeSettings(client, request.employee_id);
          const minutes = configuredMinutes(settings);
          if (!minutes) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "Forced lunch is no longer enabled for this employee" });
          }
          const waiver = await upsertWaiver(client, {
            employeeId: request.employee_id,
            workDate: request.work_date,
            minutes: request.configured_lunch_minutes || minutes,
            reason: request.reason,
            source: "employee_request",
            requestedBy: request.requested_by_employee_id,
            approvedBy: req.user.id,
          });
          waiverId = waiver.rows[0].id;
          await invalidateApprovalForWorkDate(client, request.employee_id, request.work_date);
        }

        const updated = await client.query(
          `UPDATE forced_lunch_waiver_requests
              SET status=$2,reviewed_by_employee_id=$3,review_note=$4,reviewed_at=NOW()
            WHERE id=$1
            RETURNING *`,
          [requestId, status, req.user.id, reviewNote || null],
        );
        await client.query("COMMIT");

        await audit(req.user.id, `${status}_forced_lunch_waiver_request`, "forced_lunch_waiver_request", requestId, {
          employee_id: request.employee_id,
          work_date: dateOnly(request.work_date),
          review_note: reviewNote || null,
          waiver_id: waiverId,
        });

        return res.json({ message: `Lunch removal request ${status}`, request: updated.rows[0] });
      } catch (err) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: "Lunch request review failed" });
      } finally {
        if (client) client.release();
      }
    },
  );

  return router;
}

module.exports = { createForcedLunchRouter };
