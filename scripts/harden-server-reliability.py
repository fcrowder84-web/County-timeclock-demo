#!/usr/bin/env python3
"""One-time, fail-closed reliability cleanup for backend/server.js.

The script intentionally uses exact anchors and expected match counts.  If the
live server source has drifted, it aborts rather than making a partial edit.
Git remains the rollback mechanism; no backup files are written into the
checkout.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "backend" / "server.js"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly 1 match, found {count}")
    return text.replace(old, new, 1)


def replace_block(text: str, start: str, end: str, replacement: str, label: str) -> str:
    first = text.find(start)
    if first < 0:
        raise RuntimeError(f"{label}: start marker not found")
    if text.find(start, first + 1) >= 0:
        raise RuntimeError(f"{label}: start marker is ambiguous")
    last = text.find(end, first + len(start))
    if last < 0:
        raise RuntimeError(f"{label}: end marker not found")
    return text[:first] + replacement + text[last:]


def regex_replace(text: str, pattern: str, replacement: str, expected: int, label: str) -> str:
    result, count = re.subn(pattern, replacement, text, flags=re.MULTILINE)
    if count != expected:
        raise RuntimeError(f"{label}: expected {expected} replacements, found {count}")
    return result


def extract_employee_routes(text: str) -> str:
    employee_import = 'const { createEmployeeRouter } = require("./routes/employee");'
    if employee_import in text:
        return text

    import_anchor = 'const { createQuickPunchRouter } = require("./routes/quick-punch");'
    block_start = 'app.post(\n  "/submit-timecard",'
    block_end = 'app.get(\n  "/supervisor/pay-period-status",'
    if import_anchor not in text:
        raise RuntimeError("employee extraction: quick-punch import anchor not found")

    mounted = '''app.use(createEmployeeRouter({
  requireUser,
  requireAnyPermission,
  pool,
  audit,
  getRequestedPayPeriod,
}));

'''
    text = replace_once(
        text,
        import_anchor,
        import_anchor + "\n" + employee_import,
        "employee router import",
    )
    return replace_block(text, block_start, block_end, mounted, "employee route extraction")


APPROVE_CHANGE_ROUTE = '''app.post(
  "/supervisor/approve-change-request",
  requireUser,
  requireAnyPermission("approve_punch_correction"),
  async (req, res) => {
    const requestId = Number(req.body?.request_id);
    const supervisorNote = String(req.body?.supervisor_note || "").trim();

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: "Valid change request is required" });
    }

    try {
      const lookup = await pool.query(
        `SELECT employee_id,status FROM time_change_requests WHERE id=$1`,
        [requestId],
      );
      if (!lookup.rows.length) return res.status(404).json({ error: "Request not found" });
      if (lookup.rows[0].status !== "pending") {
        return res.status(409).json({ error: "This change request has already been reviewed" });
      }

      const access = await canAccessEmployee(
        req.user,
        lookup.rows[0].employee_id,
        ["approve_punch_correction"],
      );
      if (!access) return res.status(403).json({ error: "Access denied" });

      const client = await pool.connect();
      let auditDetails = null;
      try {
        await client.query("BEGIN");

        const requestResult = await client.query(
          `SELECT *
             FROM time_change_requests
            WHERE id=$1 AND status='pending'
            FOR UPDATE`,
          [requestId],
        );
        if (!requestResult.rows.length) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "This change request has already been reviewed" });
        }
        const request = requestResult.rows[0];

        const existingResult = await client.query(
          `SELECT *
             FROM time_entries
            WHERE id=$1 AND deleted_at IS NULL
            FOR UPDATE`,
          [request.time_entry_id],
        );
        if (!existingResult.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Original time entry not found or has been deleted" });
        }
        const existing = existingResult.rows[0];
        if (Number(existing.employee_id) !== Number(request.employee_id)) {
          throw new Error("Change request employee does not match the original time entry");
        }

        const newClockIn = request.requested_clock_in ?? existing.clock_in;
        const newClockOut = request.requested_clock_out ?? existing.clock_out;
        const newClockInDate = new Date(newClockIn);
        const newClockOutDate = newClockOut == null ? null : new Date(newClockOut);
        if (Number.isNaN(newClockInDate.getTime()) || (newClockOutDate && Number.isNaN(newClockOutDate.getTime()))) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Requested punch contains an invalid date or time" });
        }
        if (newClockOutDate && newClockOutDate <= newClockInDate) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Clock out must be after clock in. Check AM/PM and the date." });
        }

        const approvalResult = await client.query(
          `SELECT * FROM pay_period_approvals
            WHERE employee_id=$1
              AND $2::timestamp >= pay_period_start
              AND $2::timestamp < (pay_period_end + INTERVAL '1 day')
            ORDER BY id DESC LIMIT 1
            FOR UPDATE`,
          [existing.employee_id, existing.clock_in],
        );
        const approval = approvalResult.rows[0] || null;

        await client.query(
          `INSERT INTO time_entry_audit(
             time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,
             new_clock_in,new_clock_out,reason
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            existing.id,
            req.user.id,
            existing.clock_in,
            existing.clock_out,
            newClockIn,
            newClockOut,
            request.employee_reason,
          ],
        );

        const updatedEntry = await client.query(
          `UPDATE time_entries
              SET clock_in=$1,
                  clock_out=$2,
                  status=CASE WHEN $2::timestamp IS NULL THEN 'open' ELSE 'closed' END
            WHERE id=$3 AND deleted_at IS NULL
            RETURNING id`,
          [newClockIn, newClockOut, existing.id],
        );
        if (!updatedEntry.rows.length) throw new Error("Time entry changed while the request was being approved");

        if (approval) {
          await client.query(
            `UPDATE pay_period_approvals
                SET supervisor_approved_at=NULL,
                    supervisor_employee_id=NULL,
                    payroll_finalized_at=NULL,
                    payroll_finalized_by=NULL,
                    status=CASE WHEN employee_signed_at IS NULL THEN 'open' ELSE 'employee_submitted' END
              WHERE id=$1`,
            [approval.id],
          );
        }

        const reviewed = await client.query(
          `UPDATE time_change_requests
              SET status='approved',
                  supervisor_id=$1,
                  supervisor_note=$2,
                  reviewed_at=NOW()
            WHERE id=$3 AND status='pending'
            RETURNING id`,
          [req.user.id, supervisorNote, requestId],
        );
        if (!reviewed.rows.length) throw new Error("Change request changed while it was being approved");

        auditDetails = {
          employee_id: existing.employee_id,
          time_entry_id: existing.id,
          approval_reopened: Boolean(approval),
          previous_approval_status: approval?.status || null,
        };
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      await audit(req.user.id, "approve_time_change_request", "time_change_request", requestId, auditDetails);
      return res.json({ message: "Request approved" });
    } catch (err) {
      if (err.code === "23514") {
        return res.status(400).json({ error: "Clock out must be after clock in. Check AM/PM and the date." });
      }
      console.error(err);
      return res.status(500).json({ error: "Approve request error" });
    }
  },
);

'''

DENY_CHANGE_ROUTE = '''app.post(
  "/supervisor/deny-change-request",
  requireUser,
  requireAnyPermission("approve_punch_correction"),
  async (req, res) => {
    const requestId = Number(req.body?.request_id);
    const supervisorNote = String(req.body?.supervisor_note || "").trim();
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: "Valid change request is required" });
    }

    try {
      const requestResult = await pool.query(
        `SELECT employee_id,status FROM time_change_requests WHERE id=$1`,
        [requestId],
      );
      if (!requestResult.rows.length) return res.status(404).json({ error: "Request not found" });
      if (requestResult.rows[0].status !== "pending") {
        return res.status(409).json({ error: "This change request has already been reviewed" });
      }

      const access = await canAccessEmployee(
        req.user,
        requestResult.rows[0].employee_id,
        ["approve_punch_correction"],
      );
      if (!access) return res.status(403).json({ error: "Access denied" });

      const denied = await pool.query(
        `UPDATE time_change_requests
            SET status='denied',
                supervisor_id=$1,
                supervisor_note=$2,
                reviewed_at=NOW()
          WHERE id=$3 AND status='pending'
          RETURNING id`,
        [req.user.id, supervisorNote, requestId],
      );
      if (!denied.rows.length) {
        return res.status(409).json({ error: "This change request has already been reviewed" });
      }

      await audit(req.user.id, "deny_time_change_request", "time_change_request", requestId, {
        employee_id: requestResult.rows[0].employee_id,
        supervisor_note: supervisorNote,
      });
      return res.json({ message: "Request denied" });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Deny request error" });
    }
  },
);

'''

RETURN_TIMECARD_ROUTE = '''app.post(
  "/supervisor/return-timecard",
  requireUser,
  requireAnyPermission("return_timecard", "return_to_supervisor", "edit_payroll_time"),
  async (req, res) => {
    const employeeId = Number(req.body?.employee_id);
    const supervisorNote = String(req.body?.supervisor_note || "").trim();
    const targetStage = String(req.body?.target_stage || "employee");

    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return res.status(400).json({ error: "Valid employee is required" });
    }
    if (!["employee", "supervisor"].includes(targetStage)) {
      return res.status(400).json({ error: "Return target must be employee or supervisor" });
    }

    try {
      const access = await canAccessEmployee(req.user, employeeId);
      if (!access) return res.status(403).json({ error: "Access denied" });

      const canReturnToSupervisor =
        userHasPermission(req.user, "return_to_supervisor") ||
        userHasPermission(req.user, "edit_payroll_time") ||
        req.user.role === "payroll" ||
        req.user.role === "admin";
      if (targetStage === "supervisor" && !canReturnToSupervisor) {
        return res.status(403).json({ error: "Only payroll can return a timecard to supervisor review" });
      }

      const period = await getRequestedPayPeriod(req);
      const returningToEmployee = targetStage === "employee";
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const currentApproval = await client.query(
          `SELECT * FROM pay_period_approvals
            WHERE employee_id=$1
              AND pay_period_start=$2::date
              AND pay_period_end=$3::date
            ORDER BY id DESC LIMIT 1
            FOR UPDATE`,
          [employeeId, period.pay_period_start, period.pay_period_end],
        );
        if (!currentApproval.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "No timecard found for this pay period" });
        }
        if (currentApproval.rows[0].payroll_finalized_at && !canReturnToSupervisor) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "This timecard is payroll-finalized. Payroll must return it before changes can be made.",
          });
        }

        const updated = await client.query(
          `UPDATE pay_period_approvals
              SET status=$4,
                  employee_signed_at=CASE WHEN $5::boolean THEN NULL ELSE employee_signed_at END,
                  supervisor_approved_at=NULL,
                  supervisor_employee_id=NULL,
                  payroll_finalized_at=NULL,
                  payroll_finalized_by=NULL
            WHERE id=$1
            RETURNING id`,
          [
            currentApproval.rows[0].id,
            period.pay_period_start,
            period.pay_period_end,
            returningToEmployee ? "returned_to_employee" : "employee_submitted",
            returningToEmployee,
          ],
        );
        if (!updated.rows.length) throw new Error("Timecard changed while it was being returned");

        const returnText = returningToEmployee
          ? "Timecard returned to employee for correction"
          : "Timecard returned to supervisor review";
        await client.query(
          `INSERT INTO correction_requests(employee_id,request_text,status,supervisor_response)
           VALUES($1,$2,'returned',$3)`,
          [employeeId, returnText, supervisorNote],
        );
        await client.query("COMMIT");

        await audit(req.user.id, "return_timecard", "employee", employeeId, {
          target_stage: targetStage,
          note: supervisorNote,
          pay_period_start: period.pay_period_start,
          pay_period_end: period.pay_period_end,
        });
        return res.json({ message: returnText });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error(err);
      return res.status(err.statusCode || 500).json({ error: err.message || "Return timecard error" });
    }
  },
);

'''

EDIT_TIME_ENTRY_ROUTE = '''app.post(
  "/supervisor/edit-time-entry",
  requireUser,
  requireAnyPermission("edit_employee_time", "edit_payroll_time"),
  async (req, res) => {
    const timeEntryId = Number(req.body?.time_entry_id);
    const newClockIn = String(req.body?.new_clock_in || "").trim();
    const rawClockOut = req.body?.new_clock_out;
    const finalClockOut = rawClockOut == null || String(rawClockOut).trim() === ""
      ? null
      : String(rawClockOut).trim();
    const reason = String(req.body?.reason || "").trim();

    if (!Number.isInteger(timeEntryId) || timeEntryId <= 0 || !newClockIn || !reason) {
      return res.status(400).json({ error: "Time entry, clock in, and reason are required" });
    }
    if (reason.length > 1000) return res.status(400).json({ error: "Reason must be 1000 characters or less" });

    const inDate = new Date(newClockIn);
    const outDate = finalClockOut == null ? null : new Date(finalClockOut);
    if (Number.isNaN(inDate.getTime()) || (outDate && Number.isNaN(outDate.getTime()))) {
      return res.status(400).json({ error: "Enter a valid clock in and clock out date/time" });
    }
    if (outDate && outDate <= inDate) {
      return res.status(400).json({ error: "Clock out must be after clock in. Check AM/PM and the date." });
    }

    try {
      const lookup = await pool.query(
        `SELECT employee_id FROM time_entries WHERE id=$1 AND deleted_at IS NULL`,
        [timeEntryId],
      );
      if (!lookup.rows.length) return res.status(404).json({ error: "Time entry not found" });
      const access = await canAccessEmployee(req.user, lookup.rows[0].employee_id);
      if (!access) return res.status(403).json({ error: "Access denied" });

      const payrollOverride =
        userHasPermission(req.user, "edit_payroll_time") ||
        req.user.role === "payroll" ||
        req.user.role === "admin";

      const client = await pool.connect();
      let previousStatus = null;
      let updatedEntry = null;
      try {
        await client.query("BEGIN");
        const existingResult = await client.query(
          `SELECT * FROM time_entries WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
          [timeEntryId],
        );
        if (!existingResult.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Time entry not found" });
        }
        const existing = existingResult.rows[0];

        const approvalResult = await client.query(
          `SELECT * FROM pay_period_approvals
            WHERE employee_id=$1
              AND $2::timestamp >= pay_period_start
              AND $2::timestamp < (pay_period_end + INTERVAL '1 day')
            ORDER BY id DESC LIMIT 1
            FOR UPDATE`,
          [existing.employee_id, existing.clock_in],
        );
        const approval = approvalResult.rows[0] || null;
        previousStatus = approval?.status || null;

        if (!payrollOverride) {
          const supervisorUnlocked =
            approval?.employee_signed_at &&
            !approval?.supervisor_approved_at &&
            !approval?.payroll_finalized_at &&
            approval?.status === "employee_submitted";
          if (!supervisorUnlocked) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              error: "This timecard is locked for supervisor editing. Return it to the correct stage before making changes.",
            });
          }
        }

        await client.query(
          `INSERT INTO time_entry_audit(
             time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,
             new_clock_in,new_clock_out,reason
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [timeEntryId, req.user.id, existing.clock_in, existing.clock_out, newClockIn, finalClockOut, reason],
        );

        const changed = await client.query(
          `UPDATE time_entries
              SET clock_in=$1,
                  clock_out=$2,
                  status=CASE WHEN $2::timestamp IS NULL THEN 'open' ELSE 'closed' END
            WHERE id=$3 AND deleted_at IS NULL
            RETURNING *`,
          [newClockIn, finalClockOut, timeEntryId],
        );
        if (!changed.rows.length) throw new Error("Time entry changed while it was being edited");
        updatedEntry = changed.rows[0];

        if (approval) {
          if (payrollOverride) {
            await client.query(
              `UPDATE pay_period_approvals
                  SET payroll_finalized_at=NULL,
                      payroll_finalized_by=NULL,
                      status=CASE
                        WHEN supervisor_approved_at IS NOT NULL THEN 'supervisor_approved'
                        WHEN employee_signed_at IS NOT NULL THEN 'employee_submitted'
                        ELSE 'open'
                      END
                WHERE id=$1`,
              [approval.id],
            );
          } else {
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
          }
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      await audit(
        req.user.id,
        payrollOverride ? "payroll_edit_time_entry" : "supervisor_edit_time_entry",
        "time_entry",
        timeEntryId,
        { reason, previous_status: previousStatus },
      );
      return res.json({ message: "Time entry updated", entry: updatedEntry });
    } catch (err) {
      if (err.code === "23514") {
        return res.status(400).json({ error: "Clock out must be after clock in. Check AM/PM and the date." });
      }
      console.error(err);
      return res.status(500).json({ error: "Edit time entry error" });
    }
  },
);

'''

DEPARTMENT_HEAD_ROUTE = '''app.post(
  "/supervisor/team-structure/department-head",
  requireUser,
  requireAnyPermission("manage_supervisor_assignments"),
  async (req, res) => {
    const departmentId = Number(req.body?.department_id);
    const employeeId = req.body?.employee_id ? Number(req.body.employee_id) : null;
    let client = null;
    try {
      if (!Number.isInteger(departmentId) || departmentId <= 0) {
        return res.status(400).json({ error: "Valid department is required" });
      }
      if (!(await canManageTeamStructure(req.user, departmentId))) {
        return res.status(403).json({ error: "You cannot manage this department" });
      }

      client = await pool.connect();
      await client.query("BEGIN");
      await client.query(
        `UPDATE department_heads SET active=FALSE WHERE department_id=$1 AND active=TRUE`,
        [departmentId],
      );
      if (employeeId) {
        const employee = await client.query(
          `SELECT id FROM employees WHERE id=$1 AND department_id=$2 AND active=TRUE`,
          [employeeId, departmentId],
        );
        if (!employee.rows.length) throw new Error("Department head must be an active employee in the department");
        await client.query(
          `INSERT INTO department_heads(department_id,employee_id,active,assigned_by)
           VALUES($1,$2,TRUE,$3)
           ON CONFLICT(department_id,employee_id)
           DO UPDATE SET active=TRUE,assigned_by=EXCLUDED.assigned_by,assigned_at=NOW()`,
          [departmentId, employeeId, req.user.id],
        );
      }
      await client.query("COMMIT");
      await audit(req.user.id, "assign_department_head", "department", departmentId, {
        employee_id: employeeId,
      });
      return res.json({ message: "Department head updated" });
    } catch (err) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      console.error(err);
      return res.status(400).json({ error: err.message || "Department head update failed" });
    } finally {
      if (client) client.release();
    }
  },
);

'''

ASSIGN_SUPERVISOR_ROUTE = '''app.post(
  "/supervisor/team-structure/assign",
  requireUser,
  requireAnyPermission("manage_supervisor_assignments", "view_department_time"),
  async (req, res) => {
    const supervisorEmployeeId = Number(req.body?.supervisor_employee_id);
    const employeeId = Number(req.body?.employee_id);
    const departmentId = Number(req.body?.department_id);
    let client = null;
    try {
      if (![supervisorEmployeeId, employeeId, departmentId].every((value) => Number.isInteger(value) && value > 0)) {
        return res.status(400).json({ error: "Valid supervisor, employee, and department are required" });
      }
      if (supervisorEmployeeId === employeeId) {
        return res.status(400).json({ error: "An employee cannot supervise themselves" });
      }
      if (!(await canManageTeamStructure(req.user, departmentId))) {
        return res.status(403).json({ error: "You cannot manage this department" });
      }

      client = await pool.connect();
      await client.query("BEGIN");
      const valid = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM employees
          WHERE id IN ($1,$2) AND department_id=$3 AND active=TRUE`,
        [supervisorEmployeeId, employeeId, departmentId],
      );
      if (valid.rows[0].count !== 2) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Supervisor and employee must be active members of the department" });
      }

      await client.query(
        `UPDATE supervisor_employee_assignments
            SET active=FALSE,ended_at=NOW()
          WHERE employee_id=$1 AND active=TRUE AND is_primary=TRUE`,
        [employeeId],
      );
      await client.query(
        `INSERT INTO supervisor_employee_assignments(
           supervisor_employee_id,employee_id,department_id,is_primary,active,assigned_by
         ) VALUES($1,$2,$3,TRUE,TRUE,$4)
         ON CONFLICT(supervisor_employee_id,employee_id)
         DO UPDATE SET department_id=EXCLUDED.department_id,
                       is_primary=TRUE,
                       active=TRUE,
                       assigned_by=EXCLUDED.assigned_by,
                       assigned_at=NOW(),
                       ended_at=NULL`,
        [supervisorEmployeeId, employeeId, departmentId, req.user.id],
      );
      await client.query("COMMIT");

      await audit(req.user.id, "assign_supervisor", "employee", employeeId, {
        supervisor_employee_id: supervisorEmployeeId,
        department_id: departmentId,
      });
      return res.json({ message: "Employee assigned to supervisor" });
    } catch (err) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      console.error(err);
      return res.status(400).json({ error: err.message || "Assignment failed" });
    } finally {
      if (client) client.release();
    }
  },
);

'''

DISABLED_CREATE_STAFF = '''app.post(
  "/supervisor/create-staff",
  requireUser,
  requireAnyPermission("manage_employee_timeclock_settings"),
  (_req, res) => res.status(410).json({
    error: "Employee accounts are created, enabled, and disabled in the Employee Portal.",
  }),
);

'''

DISABLED_DEACTIVATE_STAFF = '''app.post(
  "/supervisor/deactivate-staff",
  requireUser,
  requireAnyPermission("manage_employee_timeclock_settings"),
  (_req, res) => res.status(410).json({
    error: "Employee accounts are created, enabled, and disabled in the Employee Portal.",
  }),
);

'''

DISABLED_REACTIVATE_STAFF = '''app.post(
  "/supervisor/reactivate-staff",
  requireUser,
  requireAnyPermission("manage_employee_timeclock_settings"),
  (_req, res) => res.status(410).json({
    error: "Employee accounts are created, enabled, and disabled in the Employee Portal.",
  }),
);

'''


def transform_server(source: str) -> str:
    text = extract_employee_routes(source)

    if "SERVER_RELIABILITY_HARDENING_V1" in text:
        raise RuntimeError("server reliability hardening is already present")

    text = replace_once(
        text,
        'const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 8) * 60 * 60 * 1000;',
        '''// SERVER_RELIABILITY_HARDENING_V1\nfunction positiveNumberEnv(name, fallback, minimum = 0) {\n  const value = Number(process.env[name] ?? fallback);\n  if (!Number.isFinite(value) || value < minimum) {\n    throw new Error(`${name} must be a finite number greater than or equal to ${minimum}`);\n  }\n  return value;\n}\n\nconst SESSION_TTL_HOURS = positiveNumberEnv("SESSION_TTL_HOURS", 8, 0.25);\nconst SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;''',
        "session TTL validation",
    )

    text = replace_once(
        text,
        'const PORTAL_SYNC_INTERVAL_MINUTES = Math.max(1, Number(process.env.PORTAL_SYNC_INTERVAL_MINUTES || 5));',
        'const PORTAL_SYNC_INTERVAL_MINUTES = positiveNumberEnv("PORTAL_SYNC_INTERVAL_MINUTES", 5, 1);',
        "portal sync interval validation",
    )

    text = replace_once(
        text,
        '''    const body = await response.json();\n    const employees = Array.isArray(body.employees) ? body.employees : [];\n    const client = await pool.connect();''',
        '''    const body = await response.json();\n    if (!Array.isArray(body.employees)) {\n      throw new Error("Portal directory response is missing the employees array");\n    }\n    const employees = body.employees;\n    const validEmployees = employees.filter((item) =>\n      item && item.portal_user_id && item.first_name && item.last_name\n    );\n    const activePortalResult = await pool.query(\n      `SELECT COUNT(*)::int AS count FROM employees WHERE auth_source='portal' AND active=TRUE`,\n    );\n    const activePortalCount = Number(activePortalResult.rows[0]?.count || 0);\n    if (activePortalCount > 0 && validEmployees.length === 0) {\n      throw new Error("Portal directory safety stop: response contained no valid employees");\n    }\n    if (activePortalCount >= 5 && validEmployees.length < Math.ceil(activePortalCount * 0.5)) {\n      throw new Error(\n        `Portal directory safety stop: valid employee count dropped from ${activePortalCount} to ${validEmployees.length}`,\n      );\n    }\n    const client = await pool.connect();''',
        "portal directory safety stop",
    )

    text = replace_once(
        text,
        '''      for (const item of employees) {\n        if (!item.portal_user_id || !item.first_name || !item.last_name) continue;\n        ids.push(String(item.portal_user_id));''',
        '''      for (const item of validEmployees) {\n        ids.push(String(item.portal_user_id));''',
        "portal directory valid employee loop",
    )

    text = replace_once(
        text,
        '''app.get("/", (req, res) => {\n  res.send("County Timeclock API Running");\n});''',
        '''app.get("/", (_req, res) => {\n  res.send("County Timeclock API Running");\n});\n\napp.get("/health", async (_req, res) => {\n  try {\n    await pool.query("SELECT 1");\n    return res.json({ ok: true, database: "up" });\n  } catch (err) {\n    console.error("Health check failed", err);\n    return res.status(503).json({ ok: false, database: "down" });\n  }\n});''',
        "health endpoint",
    )

    text = regex_replace(
        text,
        r'(WHERE day_entry\.employee_id = e\.id\n)(\s+)(AND day_entry\.clock_in)',
        r'\1\2AND day_entry.deleted_at IS NULL\n\2\3',
        1,
        "supervisor daily total soft-delete filter",
    )
    text = regex_replace(
        text,
        r'(WHERE period_te\.employee_id=e\.id\n)(\s+)(AND period_te\.clock_in)',
        r'\1\2AND period_te.deleted_at IS NULL\n\2\3',
        3,
        "period existence soft-delete filters",
    )
    text = regex_replace(
        text,
        r'(FROM time_entries\n\s+WHERE employee_id = \$1\n)(\s+)(AND clock_in >= \$2::date)',
        r'\1\2AND deleted_at IS NULL\n\2\3',
        2,
        "supervisor timecard/open-punch soft-delete filters",
    )
    text = regex_replace(
        text,
        r'(WHERE te\.clock_in >= \$1::date\n)(\s+)(AND te\.clock_in <)',
        r'WHERE te.deleted_at IS NULL\n\2AND te.clock_in >= $1::date\n\2AND te.clock_in <',
        1,
        "payroll export soft-delete filter",
    )
    text = regex_replace(
        text,
        r'(ON te\.employee_id = e\.id\n)(\s+)(AND te\.clock_in >=)',
        r'\1\2AND te.deleted_at IS NULL\n\2\3',
        1,
        "print timecard soft-delete filter",
    )

    text = replace_block(
        text,
        'app.post(\n  "/supervisor/approve-change-request",',
        'app.post(\n  "/supervisor/deny-change-request",',
        APPROVE_CHANGE_ROUTE,
        "approve change request route",
    )
    text = replace_block(
        text,
        'app.post(\n  "/supervisor/deny-change-request",',
        'app.get(\n  "/payroll/department-summary",',
        DENY_CHANGE_ROUTE,
        "deny change request route",
    )
    text = replace_block(
        text,
        'app.post(\n  "/supervisor/return-timecard",',
        'app.post(\n  "/supervisor/edit-time-entry",',
        RETURN_TIMECARD_ROUTE,
        "return timecard route",
    )
    text = replace_block(
        text,
        'app.post(\n  "/supervisor/edit-time-entry",',
        'app.get(\n  "/supervisor/time-entry-audit/:timeEntryId",',
        EDIT_TIME_ENTRY_ROUTE,
        "edit time entry route",
    )

    text = replace_once(
        text,
        '''              AND employee_signed_at IS NOT NULL\n              RETURNING *''',
        '''              AND employee_signed_at IS NOT NULL\n              AND status = 'employee_submitted'\n              AND supervisor_approved_at IS NULL\n              AND payroll_finalized_at IS NULL\n              RETURNING *''',
        "timecard approval stage guard",
    )

    approval_marker = '''      if (openPunches.rows.length > 0) {\n        return res.status(400).json({\n          error: "Cannot approve timecard with open punches",\n        });\n      }\n\n      const result = await pool.query('''
    approval_replacement = '''      if (openPunches.rows.length > 0) {\n        return res.status(400).json({\n          error: "Cannot approve timecard with open punches",\n        });\n      }\n\n      const [pendingChanges, pendingLeave] = await Promise.all([\n        pool.query(\n          `SELECT tcr.id\n             FROM time_change_requests tcr\n             JOIN time_entries te ON te.id=tcr.time_entry_id\n            WHERE tcr.employee_id=$1\n              AND tcr.status='pending'\n              AND te.deleted_at IS NULL\n              AND te.clock_in >= $2::date\n              AND te.clock_in < ($3::date + INTERVAL '1 day')\n            LIMIT 1`,\n          [employee_id, period.pay_period_start, period.pay_period_end],\n        ),\n        pool.query(\n          `SELECT id FROM leave_entries\n            WHERE employee_id=$1\n              AND leave_date BETWEEN $2::date AND $3::date\n              AND status='pending'\n            LIMIT 1`,\n          [employee_id, period.pay_period_start, period.pay_period_end],\n        ),\n      ]);\n      if (pendingChanges.rows.length) {\n        return res.status(409).json({ error: "Review pending punch change requests before approving this timecard" });\n      }\n      if (pendingLeave.rows.length) {\n        return res.status(409).json({ error: "Review pending leave before approving this timecard" });\n      }\n\n      const result = await pool.query('''
    text = replace_once(text, approval_marker, approval_replacement, "pending approval checks")

    text = replace_once(
        text,
        '''      res.json({\n        message: "Timecard approved",\n      });''',
        '''      await audit(req.user.id, "approve_timecard", "employee", employee_id, {\n        pay_period_start: period.pay_period_start,\n        pay_period_end: period.pay_period_end,\n      });\n      return res.json({ message: "Timecard approved" });''',
        "timecard approval audit",
    )

    text = replace_block(
        text,
        'app.post(\n  "/supervisor/create-staff",',
        'app.post(\n  "/supervisor/deactivate-staff",',
        DISABLED_CREATE_STAFF,
        "remove unreachable create staff code",
    )
    text = replace_block(
        text,
        'app.post(\n  "/supervisor/deactivate-staff",',
        'app.post(\n  "/supervisor/reactivate-staff",',
        DISABLED_DEACTIVATE_STAFF,
        "remove unreachable deactivate staff code",
    )
    text = replace_block(
        text,
        'app.post(\n  "/supervisor/reactivate-staff",',
        'app.get(\n  "/supervisor/departments",',
        DISABLED_REACTIVATE_STAFF,
        "remove unreachable reactivate staff code",
    )

    text = replace_block(
        text,
        'app.post(\n  "/supervisor/team-structure/department-head",',
        'app.post(\n  "/supervisor/team-structure/assign",',
        DEPARTMENT_HEAD_ROUTE,
        "department head transaction",
    )
    text = replace_block(
        text,
        'app.post(\n  "/supervisor/team-structure/assign",',
        'app.post(\n  "/supervisor/team-structure/unassign",',
        ASSIGN_SUPERVISOR_ROUTE,
        "supervisor assignment transaction",
    )

    if 'await pool.query("BEGIN")' in text or "await pool.query('BEGIN')" in text:
        raise RuntimeError("unsafe pool-level BEGIN remains after hardening")

    return text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="validate that the transform can be applied without writing")
    args = parser.parse_args()

    source = SERVER.read_text()
    transformed = transform_server(source)
    if transformed == source:
        raise RuntimeError("hardening produced no changes")

    if args.check:
        print("Server reliability hardening preflight: PASS")
        print(f"Would change {len(source.splitlines())} lines of source to {len(transformed.splitlines())} lines.")
        return 0

    SERVER.write_text(transformed)
    print("Server reliability hardening applied successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
