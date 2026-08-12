const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const {
  PERMISSION_GROUPS,
  unique,
  legacyPermissionsForRole,
  deriveLegacyRole,
  userHasPermission,
  userHasAnyPermission,
} = require("./lib/permissions");

const app = express();

app.use(express.json({ limit: "1mb" }));


if (!process.env.PGPASSWORD) {
  throw new Error("PGPASSWORD is required");
}

const pool = new Pool({
  user: process.env.PGUSER || "timeclock_user",
  host: process.env.PGHOST || "postgres",
  database: process.env.PGDATABASE || "county_timeclock",
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT || 5432),
});

pool.on("connect", async (client) => {
  await client.query("SET TIME ZONE 'America/New_York'");
});


const sessions = new Map();
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 8) * 60 * 60 * 1000;
const PORTAL_ISSUER = process.env.TIMECLOCK_SSO_ISSUER || "edgefield-employee-portal";
const PORTAL_AUDIENCE = process.env.TIMECLOCK_SSO_AUDIENCE || "edgefield-timeclock";

function decodeBase64UrlJson(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function verifyPortalToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid portal token");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeBase64UrlJson(encodedHeader);
  if (header.alg !== "HS256") throw new Error("Unsupported portal token algorithm");

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = crypto.createHmac("sha256", secret).update(signingInput).digest();
  const actual = Buffer.from(encodedSignature, "base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error("Invalid portal token signature");
  }

  const payload = decodeBase64UrlJson(encodedPayload);
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== PORTAL_ISSUER) throw new Error("Invalid portal token issuer");
  if (payload.aud !== PORTAL_AUDIENCE) throw new Error("Invalid portal token audience");
  if (!payload.exp || payload.exp < now - 5) {
    const err = new Error("Portal token expired");
    err.name = "TokenExpiredError";
    throw err;
  }
  if (payload.nbf && payload.nbf > now + 5) throw new Error("Portal token is not active");
  return payload;
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  return authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;
}

function createSession(employeeId, permissions, options = {}) {
  const token = generateToken();
  sessions.set(token, {
    employee_id: employeeId,
    permissions: unique(permissions),
    app_admin_scope: options.app_admin_scope === "all" ? "all" : "own",
    auth_source: options.auth_source || "legacy",
    expires_at: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

async function audit(actorEmployeeId, action, targetType = null, targetId = null, details = null) {
  try {
    await pool.query(
      `INSERT INTO timeclock_audit_log(actor_employee_id,action,target_type,target_id,details)
       VALUES($1,$2,$3,$4,$5)`,
      [actorEmployeeId || null, action, targetType, targetId == null ? null : String(targetId), details || null],
    );
  } catch (err) {
    // Audit logging should not break the timekeeping action.
    console.error("Audit log error", err);
  }
}

async function getPayPeriodConfig() {
  const result = await pool.query(`
    SELECT
      MAX(CASE WHEN key = 'pay_period_start_date' THEN value END)::date AS anchor_date,
      MAX(CASE WHEN key = 'pay_period_length_days' THEN value END)::int AS period_days,
      CURRENT_DATE AS current_date
    FROM settings
  `);

  const config = result.rows[0];
  if (!config?.anchor_date || !config?.period_days) {
    throw new Error("Pay period settings are incomplete");
  }

  return config;
}

function formatDateOnly(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

async function getPayPeriod(requestedStart = null) {
  const config = await getPayPeriodConfig();
  const anchor = new Date(`${formatDateOnly(config.anchor_date)}T12:00:00Z`);
  const periodDays = Number(config.period_days);
  const targetDate = requestedStart
    ? String(requestedStart).slice(0, 10)
    : formatDateOnly(config.current_date);
  const target = new Date(`${targetDate}T12:00:00Z`);

  if (Number.isNaN(target.getTime())) {
    const error = new Error("Invalid pay period start date");
    error.statusCode = 400;
    throw error;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const daysFromAnchor = Math.floor((target.getTime() - anchor.getTime()) / dayMs);
  const periodIndex = Math.floor(daysFromAnchor / periodDays);
  const start = new Date(anchor.getTime() + periodIndex * periodDays * dayMs);
  const end = new Date(start.getTime() + (periodDays - 1) * dayMs);

  if (requestedStart && formatDateOnly(start) !== String(requestedStart).slice(0, 10)) {
    const error = new Error("Pay period start does not match the configured schedule");
    error.statusCode = 400;
    throw error;
  }

  return {
    pay_period_start: formatDateOnly(start),
    pay_period_end: formatDateOnly(end),
    period_days: periodDays,
  };
}

async function getCurrentPayPeriod() {
  return getPayPeriod();
}

async function getRequestedPayPeriod(req) {
  const requestedStart = req.query?.period_start || req.body?.period_start || null;
  return getPayPeriod(requestedStart);
}

function shiftDate(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

async function getUserById(id) {
  const result = await pool.query(
    `
        SELECT
            e.*,
            d.name AS department_name
        FROM employees e
        LEFT JOIN departments d
            ON d.id = e.department_id
        WHERE e.id = $1
    `,
    [id],
  );

  return result.rows[0] || null;
}

async function requireUser(req, res, next) {
  try {
    const token = getBearerToken(req);
    const session = token ? sessions.get(token) : null;

    if (!session || session.expires_at <= Date.now()) {
      if (token) sessions.delete(token);
      return res.status(401).json({ error: "Login required" });
    }

    const user = await getUserById(session.employee_id);
    if (!user || !user.active || user.is_active === false) {
      sessions.delete(token);
      return res.status(401).json({ error: "Invalid session" });
    }

    user.permissions = session.permissions;
    user.app_admin_scope = session.app_admin_scope;
    user.auth_source = session.auth_source;
    req.user = user;
    req.sessionToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAnyPermission(...permissionKeys) {
  const keys = permissionKeys.flat();
  return (req, res, next) => {
    if (userHasAnyPermission(req.user, keys)) return next();
    return res.status(403).json({
      error: `Permission required: ${keys.join(" or ")}`,
      required_permissions: keys,
    });
  };
}

function requireSupervisor(req, res, next) {
  if (userHasAnyPermission(req.user, PERMISSION_GROUPS.supervisor)) return next();
  return res.status(403).json({ error: "Supervisor permission required" });
}

function requirePayroll(req, res, next) {
  if (userHasAnyPermission(req.user, PERMISSION_GROUPS.payroll)) return next();
  return res.status(403).json({ error: "Payroll permission required" });
}

async function isSameDepartment(user, employeeId) {
  const result = await pool.query(
    `SELECT 1
       FROM employees target
      WHERE target.id=$1
        AND target.department_id=$2
      LIMIT 1`,
    [employeeId, user.department_id],
  );
  return result.rows.length > 0;
}

async function isDepartmentHead(user, departmentId = null) {
  const result = await pool.query(
    `SELECT 1
       FROM department_heads dh
      WHERE dh.employee_id=$1
        AND dh.active=TRUE
        AND ($2::int IS NULL OR dh.department_id=$2)
      LIMIT 1`,
    [user.id, departmentId],
  );
  return result.rows.length > 0;
}

async function isAssignedEmployee(user, employeeId) {
  const result = await pool.query(
    `SELECT 1
       FROM supervisor_employee_assignments sea
      WHERE sea.employee_id=$1
        AND sea.supervisor_employee_id=$2
        AND sea.active=TRUE
      LIMIT 1`,
    [employeeId, user.id],
  );
  return result.rows.length > 0;
}

async function canManageTeamStructure(user, departmentId = null) {
  const permissions = userPermissionSet(user);
  if (permissions.has("app_admin") && user.app_admin_scope === "all") return true;
  if (permissions.has("manage_supervisor_assignments")) {
    if (user.app_admin_scope === "all") return true;
    if (departmentId == null || Number(departmentId) === Number(user.department_id)) return true;
  }
  return isDepartmentHead(user, departmentId);
}

async function ensureOwnDepartmentAssignment(employeeId, departmentId, permissions) {
  if (!employeeId || !departmentId) return;
  const set = new Set(permissions || []);
  const shouldAssign = set.has("app_admin") || PERMISSION_GROUPS.supervisor.some((key) => set.has(key));
  if (!shouldAssign) return;
  await pool.query(
    `INSERT INTO supervisor_departments(supervisor_employee_id,department_id)
     VALUES($1,$2)
     ON CONFLICT(supervisor_employee_id,department_id) DO NOTHING`,
    [employeeId, departmentId],
  );
}

async function canAccessEmployee(user, employeeId, actionPermissions = []) {
  if (Number(user.id) === Number(employeeId)) return true;

  const permissions = userPermissionSet(user);
  if (permissions.has("view_all_timeclock_records")) return true;
  if (permissions.has("app_admin")) {
    if (user.app_admin_scope === "all") return true;
    return isSameDepartment(user, employeeId);
  }

  const requested = actionPermissions.length ? actionPermissions : [
    "view_assigned_employees",
    "view_department_time",
    "view_payroll_records",
    "review_approved_timecards",
    "edit_employee_time",
    "edit_payroll_time",
    "approve_punch_correction",
    "approve_timecard",
    "return_timecard",
    "return_to_supervisor",
  ];

  const targetDepartment = await pool.query(
    `SELECT department_id FROM employees WHERE id=$1 LIMIT 1`,
    [employeeId],
  );
  if (targetDepartment.rows.length && await isDepartmentHead(user, targetDepartment.rows[0].department_id)) {
    return true;
  }

  if (!requested.some((key) => permissions.has(key))) return false;

  const payrollKeys = new Set([
    "view_payroll_records",
    "review_approved_timecards",
    "edit_payroll_time",
    "return_to_supervisor",
    "reopen_timecard",
    "finalize_timecard",
    "export_payroll",
    "view_payroll_reports",
  ]);
  if (requested.some((key) => permissions.has(key) && payrollKeys.has(key))) return true;

  if (permissions.has("view_assigned_employees") && (await isAssignedEmployee(user, employeeId))) return true;
  if (
    requested.some((key) => permissions.has(key)) &&
    (await isSameDepartment(user, employeeId))
  ) {
    return true;
  }

  return isAssignedEmployee(user, employeeId);
}

async function syncPortalUser(payload) {
  if (!payload.sub || !payload.first_name || !payload.last_name) {
    throw new Error("Employee Portal token is missing required employee identity details");
  }

  const permissions = unique(payload.permissions || []);
  const departmentName = payload.department_name || "Unassigned";
  let departmentId = null;

  if (payload.department_id) {
    const byPortalId = await pool.query(
      `SELECT id FROM departments WHERE portal_department_id=$1 LIMIT 1`,
      [payload.department_id],
    );
    departmentId = byPortalId.rows[0]?.id || null;
  }

  if (!departmentId) {
    const departmentResult = await pool.query(
      `INSERT INTO departments(name,active,portal_department_id)
       VALUES($1,TRUE,$2)
       ON CONFLICT (name)
       DO UPDATE SET active=TRUE,
                     portal_department_id=COALESCE(departments.portal_department_id,EXCLUDED.portal_department_id)
       RETURNING id`,
      [departmentName, payload.department_id || null],
    );
    departmentId = departmentResult.rows[0].id;
  }

  let existing = await pool.query(
    `SELECT id
       FROM employees
      WHERE portal_user_id=$1
      LIMIT 1`,
    [payload.sub],
  );

  // One-time migration path for an existing legacy TimeClock employee.
  // Employee number may establish the first link only when that employee
  // has not already been connected to an Employee Portal account.
  if (!existing.rows.length && payload.employee_number) {
    existing = await pool.query(
      `SELECT id
         FROM employees
        WHERE portal_user_id IS NULL
          AND employee_number=$1
        LIMIT 1`,
      [String(payload.employee_number)],
    );
  }

  const appAdminScope = payload.app_admin_scope === "all" ? "all" : "own";
  let role = deriveLegacyRole(permissions);
  if (permissions.includes("app_admin") && appAdminScope === "own") role = "supervisor";

  if (existing.rows.length) {
    const result = await pool.query(
      `UPDATE employees
          SET portal_user_id=$1,
              employee_number=$2,
              first_name=$3,
              last_name=$4,
              email=$5,
              department=$6,
              department_id=$7,
              portal_department_id=$8,
              role=$9,
              active=TRUE,
              is_active=TRUE,
              must_change_pin=FALSE,
              portal_permissions=$10::jsonb,
              app_admin_scope=$11,
              auth_source='portal',
              last_portal_sync_at=NOW()
        WHERE id=$12
        RETURNING *`,
      [
        payload.sub,
        payload.employee_number ? String(payload.employee_number) : null,
        payload.first_name,
        payload.last_name,
        payload.email || null,
        departmentName,
        departmentId,
        payload.department_id || null,
        role,
        JSON.stringify(permissions),
        appAdminScope,
        existing.rows[0].id,
      ],
    );
    await ensureOwnDepartmentAssignment(result.rows[0].id, departmentId, permissions);
    return { user: result.rows[0], permissions, appAdminScope };
  }

  const result = await pool.query(
    `INSERT INTO employees(
       portal_user_id,employee_number,first_name,last_name,email,role,is_active,pin,
       department,active,department_id,must_change_pin,portal_department_id,
       portal_permissions,app_admin_scope,auth_source,last_portal_sync_at
     )
     VALUES($1,$2,$3,$4,$5,$6,TRUE,NULL,$7,TRUE,$8,FALSE,$9,$10::jsonb,$11,'portal',NOW())
     RETURNING *`,
    [
      payload.sub,
      payload.employee_number ? String(payload.employee_number) : null,
      payload.first_name,
      payload.last_name,
      payload.email || null,
      role,
      departmentName,
      departmentId,
      payload.department_id || null,
      JSON.stringify(permissions),
      appAdminScope,
    ],
  );
  await ensureOwnDepartmentAssignment(result.rows[0].id, departmentId, permissions);
  return { user: result.rows[0], permissions, appAdminScope };
}


const PORTAL_DIRECTORY_URL = process.env.PORTAL_DIRECTORY_URL || "";
const PORTAL_DIRECTORY_API_KEY = process.env.PORTAL_DIRECTORY_API_KEY || "";
const PORTAL_SYNC_INTERVAL_MINUTES = Math.max(1, Number(process.env.PORTAL_SYNC_INTERVAL_MINUTES || 5));
let portalSyncRunning = false;
let lastPortalSync = null;

async function upsertDirectoryEmployee(client, item) {
  const departmentName = item.department_name || "Unassigned";
  let departmentId = null;
  if (item.portal_department_id) {
    const found = await client.query(`SELECT id FROM departments WHERE portal_department_id=$1 LIMIT 1`, [item.portal_department_id]);
    departmentId = found.rows[0]?.id || null;
  }
  if (!departmentId) {
    const department = await client.query(
      `INSERT INTO departments(name,active,portal_department_id)
       VALUES($1,TRUE,$2)
       ON CONFLICT(name) DO UPDATE SET active=TRUE,
         portal_department_id=COALESCE(departments.portal_department_id,EXCLUDED.portal_department_id)
       RETURNING id`,
      [departmentName, item.portal_department_id || null],
    );
    departmentId = department.rows[0].id;
  }

  const permissions = unique(item.permissions || []);
  const appAdminScope = item.app_admin_scope === "all" ? "all" : "own";
  let role = deriveLegacyRole(permissions);
  if (permissions.includes("app_admin") && appAdminScope === "own") role = "supervisor";

  let existing = await client.query(`SELECT id,active FROM employees WHERE portal_user_id=$1 LIMIT 1`, [item.portal_user_id]);
  if (!existing.rows.length && item.employee_number) {
    existing = await client.query(
      `SELECT id,active FROM employees WHERE portal_user_id IS NULL AND employee_number=$1 LIMIT 1`,
      [String(item.employee_number)],
    );
  }

  if (existing.rows.length) {
    const wasActive = existing.rows[0].active === true;
    const updated = await client.query(
      `UPDATE employees SET portal_user_id=$1,employee_number=$2,first_name=$3,last_name=$4,email=$5,
        department=$6,department_id=$7,portal_department_id=$8,role=$9,active=TRUE,is_active=TRUE,
        must_change_pin=FALSE,portal_permissions=$10::jsonb,app_admin_scope=$11,auth_source='portal',
        last_portal_sync_at=NOW(),access_removed_at=NULL,directory_sync_state='active'
       WHERE id=$12 RETURNING id`,
      [item.portal_user_id,item.employee_number?String(item.employee_number):null,item.first_name,item.last_name,
       item.email||null,departmentName,departmentId,item.portal_department_id||null,role,JSON.stringify(permissions),
       appAdminScope,existing.rows[0].id],
    );
    return { id: updated.rows[0].id, activated: !wasActive };
  }

  const inserted = await client.query(
    `INSERT INTO employees(portal_user_id,employee_number,first_name,last_name,email,role,is_active,pin,
      department,active,department_id,must_change_pin,portal_department_id,portal_permissions,app_admin_scope,
      auth_source,last_portal_sync_at,access_removed_at,directory_sync_state)
     VALUES($1,$2,$3,$4,$5,$6,TRUE,NULL,$7,TRUE,$8,FALSE,$9,$10::jsonb,$11,'portal',NOW(),NULL,'active')
     RETURNING id`,
    [item.portal_user_id,item.employee_number?String(item.employee_number):null,item.first_name,item.last_name,
     item.email||null,role,departmentName,departmentId,item.portal_department_id||null,JSON.stringify(permissions),appAdminScope],
  );
  return { id: inserted.rows[0].id, activated: true };
}

async function syncPortalDirectory(trigger = "scheduled") {
  if (portalSyncRunning) return { skipped: true, reason: "sync already running", lastPortalSync };
  if (!PORTAL_DIRECTORY_URL || !PORTAL_DIRECTORY_API_KEY) throw new Error("Portal directory sync is not configured");
  portalSyncRunning = true;
  const log = await pool.query(`INSERT INTO portal_directory_sync_log(status) VALUES('running') RETURNING id`);
  const logId = log.rows[0].id;
  try {
    const response = await fetch(PORTAL_DIRECTORY_URL, {
      headers: { "x-internal-api-key": PORTAL_DIRECTORY_API_KEY, "accept": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Portal directory returned HTTP ${response.status}`);
    const body = await response.json();
    const employees = Array.isArray(body.employees) ? body.employees : [];
    const client = await pool.connect();
    let activated = 0;
    let deactivated = 0;
    try {
      await client.query('BEGIN');
      const ids = [];
      for (const item of employees) {
        if (!item.portal_user_id || !item.first_name || !item.last_name) continue;
        ids.push(String(item.portal_user_id));
        const result = await upsertDirectoryEmployee(client, item);
        if (result.activated) activated += 1;
      }
      const removed = await client.query(
        `UPDATE employees SET active=FALSE,is_active=FALSE,portal_permissions='[]'::jsonb,
            access_removed_at=COALESCE(access_removed_at,NOW()),directory_sync_state='removed',last_portal_sync_at=NOW()
          WHERE auth_source='portal' AND active=TRUE
            AND NOT (portal_user_id::text = ANY($1::text[]))
          RETURNING id`,
        [ids],
      );
      deactivated = removed.rowCount;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    lastPortalSync = { at: new Date().toISOString(), trigger, received: employees.length, activated, deactivated, ok: true };
    await pool.query(
      `UPDATE portal_directory_sync_log SET completed_at=NOW(),status='success',received_count=$1,activated_count=$2,deactivated_count=$3 WHERE id=$4`,
      [employees.length,activated,deactivated,logId],
    );
    return lastPortalSync;
  } catch (err) {
    lastPortalSync = { at: new Date().toISOString(), trigger, ok: false, error: err.message };
    await pool.query(`UPDATE portal_directory_sync_log SET completed_at=NOW(),status='failed',error_message=$1 WHERE id=$2`, [err.message,logId]);
    throw err;
  } finally {
    portalSyncRunning = false;
  }
}

app.post('/admin/sync-portal-directory', requireUser, requireAnyPermission('app_admin','manage_employee_timeclock_settings'), async (req,res) => {
  try { res.json(await syncPortalDirectory('manual')); }
  catch (err) { res.status(502).json({ error: err.message, last_sync: lastPortalSync }); }
});

app.get('/admin/portal-sync-status', requireUser, requireAnyPermission('app_admin','manage_employee_timeclock_settings'), async (req,res) => {
  const recent = await pool.query(`SELECT * FROM portal_directory_sync_log ORDER BY id DESC LIMIT 10`);
  res.json({ configured: !!PORTAL_DIRECTORY_URL && !!PORTAL_DIRECTORY_API_KEY, running: portalSyncRunning, last_sync: lastPortalSync, recent: recent.rows });
});

setTimeout(() => syncPortalDirectory('startup').catch(err => console.error('Portal directory startup sync failed:', err.message)), 10000);
setInterval(() => syncPortalDirectory('scheduled').catch(err => console.error('Portal directory scheduled sync failed:', err.message)), PORTAL_SYNC_INTERVAL_MINUTES * 60 * 1000);

app.get("/", (req, res) => {
  res.send("County Timeclock API Running");
});

app.post("/logout", requireUser, async (req, res) => {
  const token = getBearerToken(req);

  if (token) {
    sessions.delete(token);
  }

  res.json({
    message: "Logged out",
  });
});

app.get("/me", requireUser, async (req, res) => {
  const safeUser = { ...req.user };
  delete safeUser.pin;

  res.json({
    user: safeUser,
    permissions: req.user.permissions || [],
    app_admin_scope: req.user.app_admin_scope || "own",
    auth_source: req.user.auth_source || "legacy",
  });
});

app.get("/pay-periods", requireUser, async (req, res) => {
  try {
    const current = await getCurrentPayPeriod();
    const config = await getPayPeriodConfig();
    const periodDays = Number(config.period_days);
    const periods = [];

    for (let offset = -52; offset <= 1; offset += 1) {
      const start = shiftDate(current.pay_period_start, offset * periodDays);
      periods.push({
        pay_period_start: start,
        pay_period_end: shiftDate(start, periodDays - 1),
        is_current: offset === 0,
        is_future: offset > 0,
      });
    }

    res.json({
      current,
      periods: periods.reverse(),
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Pay period lookup failed" });
  }
});

app.post("/auth/portal", async (req, res) => {
  try {
    const secret = process.env.TIMECLOCK_SSO_SECRET;
    if (!secret || secret.length < 32) {
      return res.status(503).json({ error: "Employee Portal SSO is not configured" });
    }

    const portalToken = req.body?.token;
    if (!portalToken) {
      return res.status(400).json({ error: "Portal token is required" });
    }

    const payload = verifyPortalToken(portalToken, secret);

    const synced = await syncPortalUser(payload);
    if (!synced.permissions.includes("access") && !synced.permissions.includes("app_admin")) {
      return res.status(403).json({ error: "TimeClock access has not been granted" });
    }

    const token = createSession(synced.user.id, synced.permissions, {
      app_admin_scope: synced.appAdminScope,
      auth_source: "portal",
    });
    const user = await getUserById(synced.user.id);
    delete user.pin;

    await audit(user.id, "portal_sso_login", "employee", user.id, {
      portal_user_id: payload.sub,
      permission_count: synced.permissions.length,
    });

    return res.json({
      message: "Employee Portal login successful",
      token,
      user,
      permissions: synced.permissions,
      app_admin_scope: synced.appAdminScope,
      auth_source: "portal",
    });
  } catch (err) {
    console.error("Portal login error", err);
    const status = err.name === "TokenExpiredError" || /token|signature|issuer|audience|algorithm/i.test(err.message) ? 401 : 500;
    return res.status(status).json({
      error: status === 401 ? "Employee Portal login link is invalid or expired" : "Employee Portal login failed",
    });
  }
});

app.get(
  "/quick-status",
  requireUser,
  requireAnyPermission("clock_in_out"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, clock_in, clock_out
           FROM time_entries
          WHERE employee_id=$1
          ORDER BY clock_in DESC
          LIMIT 1`,
        [req.user.id],
      );

      const latest = result.rows[0] || null;
      const clockedIn = Boolean(latest && !latest.clock_out);
      const lastPunchType = latest ? (latest.clock_out ? "clock_out" : "clock_in") : null;
      const lastPunchAt = latest ? (latest.clock_out || latest.clock_in) : null;

      return res.json({
        clocked_in: clockedIn,
        next_action: clockedIn ? "clock_out" : "clock_in",
        last_punch_type: lastPunchType,
        last_punch_at: lastPunchAt,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Quick punch status error" });
    }
  },
);

app.post(
  "/clock-in",
  requireUser,
  requireAnyPermission("clock_in_out"),
  async (req, res) => {
    try {
      const openEntry = await pool.query(
        `SELECT id FROM time_entries WHERE employee_id=$1 AND clock_out IS NULL LIMIT 1`,
        [req.user.id],
      );
      if (openEntry.rows.length) {
        return res.status(400).json({ error: "You are already clocked in" });
      }

      const result = await pool.query(
        `INSERT INTO time_entries(employee_id,clock_in,status)
         VALUES($1,NOW(),'open') RETURNING *`,
        [req.user.id],
      );
      await audit(req.user.id, "clock_in", "time_entry", result.rows[0].id);
      return res.json({ message: `${req.user.first_name} clocked in successfully`, entry: result.rows[0] });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Clock-in error" });
    }
  },
);

app.post(
  "/clock-out",
  requireUser,
  requireAnyPermission("clock_in_out"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE time_entries
            SET clock_out=NOW(),status='closed'
          WHERE id=(
            SELECT id FROM time_entries
             WHERE employee_id=$1 AND clock_out IS NULL
             ORDER BY clock_in DESC LIMIT 1
          )
          RETURNING *`,
        [req.user.id],
      );
      if (!result.rows.length) {
        return res.status(400).json({ error: "You are not currently clocked in" });
      }
      await audit(req.user.id, "clock_out", "time_entry", result.rows[0].id);
      return res.json({ message: `${req.user.first_name} clocked out successfully`, entry: result.rows[0] });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Clock-out error" });
    }
  },
);

app.post(
  "/submit-timecard",
  requireUser,
  requireAnyPermission("submit_timecard"),
  async (req, res) => {
    try {
      const period = await getRequestedPayPeriod(req);
      const openPunches = await pool.query(
        `SELECT id FROM time_entries
          WHERE employee_id=$1
            AND clock_in >= $2::date
            AND clock_in < ($3::date + INTERVAL '1 day')
            AND clock_out IS NULL`,
        [req.user.id, period.pay_period_start, period.pay_period_end],
      );
      if (openPunches.rows.length) {
        return res.status(400).json({ error: "Clock out before submitting your timecard" });
      }

      const existingApproval = await pool.query(
        `SELECT * FROM pay_period_approvals
          WHERE employee_id=$1 AND pay_period_start=$2::date AND pay_period_end=$3::date
          ORDER BY id DESC LIMIT 1`,
        [req.user.id, period.pay_period_start, period.pay_period_end],
      );

      if (
        existingApproval.rows.length &&
        existingApproval.rows[0].employee_signed_at &&
        existingApproval.rows[0].status !== "returned_to_employee"
      ) {
        return res.status(409).json({
          error: "This timecard is already signed. It must be returned to you before it can be submitted again.",
        });
      }

      if (existingApproval.rows.length) {
        await pool.query(
          `UPDATE pay_period_approvals
              SET employee_signed_at=NOW(),
                  supervisor_approved_at=NULL,
                  payroll_finalized_at=NULL,
                  status='employee_submitted'
            WHERE id=$1`,
          [existingApproval.rows[0].id],
        );
      } else {
        await pool.query(
          `INSERT INTO pay_period_approvals(
             employee_id,pay_period_start,pay_period_end,employee_signed_at,status
           ) VALUES($1,$2,$3,NOW(),'employee_submitted')`,
          [req.user.id, period.pay_period_start, period.pay_period_end],
        );
      }
      await audit(req.user.id, "submit_timecard", "employee", req.user.id, period);
      return res.json({ message: "Timecard submitted successfully" });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Submit timecard error" });
    }
  },
);

app.get("/employee/my-timecard", requireUser, requireAnyPermission("view_own_time"), async (req, res) => {
  try {
    const period = await getRequestedPayPeriod(req);

    const approvalResult = await pool.query(
      `
            SELECT *
            FROM pay_period_approvals
            WHERE employee_id = $1
            AND pay_period_start = $2::date
            AND pay_period_end = $3::date
        `,
      [req.user.id, period.pay_period_start, period.pay_period_end],
    );

    const entriesResult = await pool.query(
      `
            SELECT
                id,
                clock_in,
                clock_out,
                to_char(clock_in, 'YYYY-MM-DD') AS entry_date_iso,
                to_char(clock_in, 'MM/DD/YYYY') AS entry_date,
                to_char(clock_in, 'HH12:MI AM') AS clock_in_display,
                to_char(clock_in, 'HH24:MI') AS clock_in_24,
                CASE
                    WHEN clock_out IS NULL THEN NULL
                    ELSE to_char(clock_out, 'HH12:MI AM')
                END AS clock_out_display,
                CASE
                    WHEN clock_out IS NULL THEN NULL
                    ELSE to_char(clock_out, 'HH24:MI')
                END AS clock_out_24,
                ROUND(
                    (
                        EXTRACT(EPOCH FROM (
                            COALESCE(clock_out, now()) - clock_in
                        )) / 3600
                    )::numeric,
                    2
                ) AS hours_worked
            FROM time_entries
            WHERE employee_id = $1
            AND clock_in >= $2::date
            AND clock_in < ($3::date + interval '1 day')
            ORDER BY clock_in
        `,
      [req.user.id, period.pay_period_start, period.pay_period_end],
    );

    const requestsResult = await pool.query(
      `
            SELECT
                tcr.*,
                to_char(created_at, 'MM/DD/YYYY HH12:MI AM')
                    AS created_at_display,
                to_char(reviewed_at, 'MM/DD/YYYY HH12:MI AM')
                    AS reviewed_at_display
            FROM time_change_requests tcr
            WHERE employee_id = $1
            ORDER BY created_at DESC
        `,
      [req.user.id],
    );

    const approval = approvalResult.rows[0] || null;
    const canEditEntries = !approval?.employee_signed_at || approval?.status === "returned_to_employee";

    res.json({
      employee: req.user,
      pay_period_start: period.pay_period_start,
      pay_period_end: period.pay_period_end,
      approval,
      can_edit_entries: canEditEntries,
      entries: entriesResult.rows,
      requests: requestsResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Employee timecard error");
  }
});

app.post(
  "/employee/edit-time-entry",
  requireUser,
  requireAnyPermission("request_punch_correction", "submit_timecard"),
  async (req, res) => {
    const { time_entry_id, new_clock_in, new_clock_out, reason } = req.body;

    if (!time_entry_id || !new_clock_in || !reason?.trim()) {
      return res.status(400).json({ error: "Time entry, clock in, and reason are required" });
    }

    try {
      const entryResult = await pool.query(`SELECT * FROM time_entries WHERE id=$1`, [time_entry_id]);
      if (!entryResult.rows.length) {
        return res.status(404).json({ error: "Time entry not found" });
      }

      const existing = entryResult.rows[0];
      if (Number(existing.employee_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: "Cannot modify another employee" });
      }

      const approvalResult = await pool.query(
        `SELECT * FROM pay_period_approvals
          WHERE employee_id=$1
            AND $2::timestamp >= pay_period_start
            AND $2::timestamp < (pay_period_end + interval '1 day')
          ORDER BY id DESC LIMIT 1`,
        [req.user.id, existing.clock_in],
      );
      const approval = approvalResult.rows[0] || null;

      if (approval?.employee_signed_at && approval.status !== "returned_to_employee") {
        return res.status(409).json({
          error: "This timecard is signed. It must be returned to you before you can edit it.",
        });
      }

      const finalClockOut = new_clock_out && new_clock_out.trim() !== "" ? new_clock_out : null;
      if (finalClockOut && new Date(finalClockOut) <= new Date(new_clock_in)) {
        return res.status(400).json({ error: "Clock out must be after clock in" });
      }

      await pool.query(
        `INSERT INTO time_entry_audit(
           time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,
           new_clock_in,new_clock_out,reason
         ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [existing.id, req.user.id, existing.clock_in, existing.clock_out, new_clock_in, finalClockOut, reason.trim()],
      );

      const updated = await pool.query(
        `UPDATE time_entries
            SET clock_in=$1,
                clock_out=$2,
                status=CASE WHEN $2::timestamp IS NULL THEN 'open' ELSE 'closed' END
          WHERE id=$3
          RETURNING *`,
        [new_clock_in, finalClockOut, existing.id],
      );

      if (approval) {
        await pool.query(
          `UPDATE pay_period_approvals
              SET employee_signed_at=NULL,
                  supervisor_approved_at=NULL,
                  supervisor_employee_id=NULL,
                  payroll_finalized_at=NULL,
                  payroll_finalized_by=NULL,
                  status='open'
            WHERE id=$1`,
          [approval.id],
        );
      }

      await audit(req.user.id, "employee_edit_time_entry", "time_entry", existing.id, {
        reason: reason.trim(),
      });

      return res.json({ message: "Time entry updated", entry: updated.rows[0] });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Edit time entry error" });
    }
  },
);

app.post("/employee/request-time-change", requireUser, requireAnyPermission("request_punch_correction"), async (req, res) => {
  const {
    time_entry_id,
    requested_clock_in,
    requested_clock_out,
    employee_reason,
  } = req.body;

  try {
    if (!requested_clock_in && !requested_clock_out) {
      return res.status(400).json({
        error: "Select a clock in time, clock out time, or both",
      });
    }

    if (!employee_reason || !employee_reason.trim()) {
      return res.status(400).json({
        error: "Reason is required",
      });
    }

    const entryResult = await pool.query(
      `
                SELECT *
                FROM time_entries
                WHERE id = $1
            `,
      [time_entry_id],
    );

    if (entryResult.rows.length === 0) {
      return res.status(404).json({
        error: "Time entry not found",
      });
    }

    const entry = entryResult.rows[0];

    if (Number(entry.employee_id) !== Number(req.user.id)) {
      return res.status(403).json({
        error: "Cannot modify another employee",
      });
    }

    await pool.query(
      `
                INSERT INTO time_change_requests (
                    employee_id,
                    time_entry_id,
                    requested_clock_in,
                    requested_clock_out,
                    employee_reason,
                    status
                )
                VALUES ($1,$2,$3,$4,$5,'pending')
            `,
      [
        req.user.id,
        time_entry_id,
        requested_clock_in,
        requested_clock_out,
        employee_reason,
      ],
    );

    res.json({
      message: "Time change request submitted",
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Time change request error");
  }
});

app.get(
  "/supervisor/pay-period-status",
  requireUser,
  requireAnyPermission("view_assigned_employees", "view_department_time", "view_live_status", "view_payroll_records", "view_all_timeclock_records"),
  async (req, res) => {
    try {
      const period = await getRequestedPayPeriod(req);

      const result = await pool.query(
        `
                SELECT
                    e.id,
                    e.first_name,
                    e.last_name,
                    d.name AS department,
                    e.role,
                    ppa.status,
                    ppa.employee_signed_at,
                    ppa.supervisor_approved_at,
                    ROUND(
                        COALESCE(
                            SUM(
                                EXTRACT(EPOCH FROM (
                                    COALESCE(te.clock_out, now())
                                    - te.clock_in
                                )) / 3600
                            ),
                            0
                        )::numeric,
                        2
                    ) AS total_hours
                FROM employees e

                LEFT JOIN departments d
                    ON d.id = e.department_id

                LEFT JOIN pay_period_approvals ppa
                    ON ppa.employee_id = e.id
                    AND ppa.pay_period_start = $1::date
                    AND ppa.pay_period_end = $2::date

                LEFT JOIN time_entries te
                    ON te.employee_id = e.id
                    AND te.clock_in >= $1::date
                    AND te.clock_in < ($2::date + interval '1 day')

                WHERE (
                    e.active = true
                    OR ppa.id IS NOT NULL
                    OR EXISTS (
                        SELECT 1 FROM time_entries period_te
                         WHERE period_te.employee_id=e.id
                           AND period_te.clock_in >= $1::date
                           AND period_te.clock_in < ($2::date + interval '1 day')
                    )
                )

                AND (
                    $3::text IN ('admin','payroll')

                    OR e.id IN (
                        SELECT employee_id
                        FROM supervisor_employee_assignments
                        WHERE supervisor_employee_id = $4 AND active = TRUE
                    )
                    OR e.department_id IN (
                        SELECT department_id
                        FROM department_heads
                        WHERE employee_id = $4 AND active = TRUE
                    )
                )

                GROUP BY
                    e.id,
                    e.first_name,
                    e.last_name,
                    d.name,
                    e.role,
                    ppa.status,
                    ppa.employee_signed_at,
                    ppa.supervisor_approved_at

                ORDER BY
                    d.name,
                    e.last_name
            `,
        [
          period.pay_period_start,
          period.pay_period_end,
          req.user.role,
          req.user.id,
        ],
      );

      res.json({
        pay_period_start: period.pay_period_start,
        pay_period_end: period.pay_period_end,
        employees: result.rows,
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Supervisor status error");
    }
  },
);

app.get(
  "/supervisor/change-requests",
  requireUser,
  requireAnyPermission("approve_punch_correction"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `
                SELECT
                    tcr.*,
                    e.first_name,
                    e.last_name,
                    d.name AS department,
                    to_char(tcr.requested_clock_in,
                        'MM/DD/YYYY HH12:MI AM')
                        AS requested_clock_in_display,
                    to_char(tcr.requested_clock_out,
                        'MM/DD/YYYY HH12:MI AM')
                        AS requested_clock_out_display,
                    to_char(tcr.created_at,
                        'MM/DD/YYYY HH12:MI AM')
                        AS created_at_display
                FROM time_change_requests tcr

                JOIN employees e
                    ON e.id = tcr.employee_id

                LEFT JOIN departments d
                    ON d.id = e.department_id

                WHERE tcr.status = 'pending'

                AND (
                    $1::text IN ('admin','payroll')

                    OR e.id IN (
                        SELECT employee_id
                        FROM supervisor_employee_assignments
                        WHERE supervisor_employee_id = $2 AND active = TRUE
                    )
                    OR e.department_id IN (
                        SELECT department_id
                        FROM department_heads
                        WHERE employee_id = $2 AND active = TRUE
                    )
                )

                ORDER BY tcr.created_at
            `,
        [req.user.role, req.user.id],
      );

      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).send("Change request error");
    }
  },
);

app.post(
  "/supervisor/approve-change-request",
  requireUser,
  requireAnyPermission("approve_punch_correction"),
  async (req, res) => {
    const { request_id, supervisor_note } = req.body;

    try {
      const requestResult = await pool.query(
        `
                SELECT *
                FROM time_change_requests
                WHERE id = $1
            `,
        [request_id],
      );

      if (requestResult.rows.length === 0) {
        return res.status(404).json({
          error: "Request not found",
        });
      }

      const request = requestResult.rows[0];

      const access = await canAccessEmployee(req.user, request.employee_id);

      if (!access) {
        return res.status(403).json({
          error: "Access denied",
        });
      }

      const existingResult = await pool.query(
        `
                SELECT *
                FROM time_entries
                WHERE id = $1
            `,
        [request.time_entry_id],
      );

      const existing = existingResult.rows[0];

      if (!existing) {
        return res.status(404).json({
          error: "Original time entry not found",
        });
      }

      const newClockIn =
        request.requested_clock_in ?? existing.clock_in;

      const newClockOut =
        request.requested_clock_out ?? existing.clock_out;

      await pool.query(
        `
                INSERT INTO time_entry_audit (
                    time_entry_id,
                    changed_by_employee_id,
                    old_clock_in,
                    old_clock_out,
                    new_clock_in,
                    new_clock_out,
                    reason
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7)
            `,
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

      await pool.query(
        `
                UPDATE time_entries
                SET
                    clock_in = $1,
                    clock_out = $2,
                    status = 'closed'
                WHERE id = $3
            `,
        [newClockIn, newClockOut, existing.id],
      );

      await pool.query(
        `
                UPDATE time_change_requests
                SET
                    status = 'approved',
                    supervisor_id = $1,
                    supervisor_note = $2,
                    reviewed_at = now()
                WHERE id = $3
            `,
        [req.user.id, supervisor_note || "", request_id],
      );

      res.json({
        message: "Request approved",
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Approve request error");
    }
  },
);

app.post(
  "/supervisor/deny-change-request",
  requireUser,
  requireAnyPermission("approve_punch_correction"),
  async (req, res) => {
    const { request_id, supervisor_note } = req.body;

    try {
      const requestResult = await pool.query(
        `SELECT employee_id FROM time_change_requests WHERE id=$1`,
        [request_id],
      );
      if (!requestResult.rows.length) {
        return res.status(404).json({ error: "Request not found" });
      }
      const access = await canAccessEmployee(req.user, requestResult.rows[0].employee_id, ["approve_punch_correction"]);
      if (!access) {
        return res.status(403).json({ error: "Access denied" });
      }

      await pool.query(
        `
                UPDATE time_change_requests
                SET
                    status = 'denied',
                    supervisor_id = $1,
                    supervisor_note = $2,
                    reviewed_at = now()
                WHERE id = $3
            `,
        [req.user.id, supervisor_note || "", request_id],
      );

      res.json({
        message: "Request denied",
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Deny request error");
    }
  },
);

app.get(
  "/payroll/department-summary",
  requireUser,
  requireAnyPermission("view_payroll_records", "view_payroll_reports"),
  async (req, res) => {
    try {
      const period = await getRequestedPayPeriod(req);

      const result = await pool.query(
        `
                SELECT
                    d.name AS department,
                    e.id,
                    e.first_name,
                    e.last_name,
                    e.role,
                    ppa.status,
                    ppa.employee_signed_at,
                    ppa.supervisor_approved_at
                FROM employees e

                LEFT JOIN departments d
                    ON d.id = e.department_id

                LEFT JOIN pay_period_approvals ppa
                    ON ppa.employee_id = e.id
                    AND ppa.pay_period_start = $1::date
                    AND ppa.pay_period_end = $2::date

                WHERE (
                    e.active = true
                    OR ppa.id IS NOT NULL
                    OR EXISTS (
                        SELECT 1 FROM time_entries period_te
                         WHERE period_te.employee_id=e.id
                           AND period_te.clock_in >= $1::date
                           AND period_te.clock_in < ($2::date + interval '1 day')
                    )
                )

                ORDER BY
                    d.name,
                    e.last_name
            `,
        [period.pay_period_start, period.pay_period_end],
      );

      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).send("Payroll summary error");
    }
  },
);

app.get(
  "/payroll/export-current-period",
  requireUser,
  requireAnyPermission("export_payroll"),
  async (req, res) => {
    try {
      const period = await getRequestedPayPeriod(req);

      const result = await pool.query(
        `
                SELECT
                    e.employee_number,
                    e.first_name,
                    e.last_name,
                    d.name AS department,

                    to_char(te.clock_in, 'MM/DD/YYYY')
                        AS work_date,

                    to_char(te.clock_in, 'HH12:MI AM')
                        AS clock_in,

                    CASE
                        WHEN te.clock_out IS NULL THEN ''
                        ELSE to_char(te.clock_out, 'HH12:MI AM')
                    END AS clock_out,

                    ROUND(
                        (
                            EXTRACT(EPOCH FROM (
                                COALESCE(te.clock_out, now())
                                - te.clock_in
                            )) / 3600
                        )::numeric,
                        2
                    ) AS hours_worked,

                    COALESCE(
                        ppa.status,
                        'pending'
                    ) AS timecard_status

                FROM time_entries te

                JOIN employees e
                    ON e.id = te.employee_id

                LEFT JOIN departments d
                    ON d.id = e.department_id

                LEFT JOIN pay_period_approvals ppa
                    ON ppa.employee_id = e.id
                    AND ppa.pay_period_start = $1::date
                    AND ppa.pay_period_end = $2::date

                WHERE te.clock_in >= $1::date
                AND te.clock_in < ($2::date + interval '1 day')

                ORDER BY
                    d.name,
                    e.last_name,
                    te.clock_in
            `,
        [period.pay_period_start, period.pay_period_end],
      );

      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).send("Payroll export error");
    }
  },
);

app.get(
  "/supervisor/employee-timecard/:employeeId",
  requireUser,
  requireAnyPermission("view_assigned_employees", "view_department_time", "view_payroll_records", "review_approved_timecards", "view_all_timeclock_records"),
  async (req, res) => {
    const employeeId = req.params.employeeId;

    try {
      const access = await canAccessEmployee(req.user, employeeId);

      if (!access) {
        return res.status(403).json({
          error: "Access denied",
        });
      }

      const period = await getRequestedPayPeriod(req);

      const employeeResult = await pool.query(
        `
              SELECT
                  e.id,
                  e.employee_number,
                  e.first_name,
                  e.last_name,
                  d.name AS department,
                  e.role
              FROM employees e
              LEFT JOIN departments d
                  ON d.id = e.department_id
              WHERE e.id = $1
          `,
        [employeeId],
      );

      if (employeeResult.rows.length === 0) {
        return res.status(404).json({
          error: "Employee not found",
        });
      }

      const approvalResult = await pool.query(
        `
              SELECT *
              FROM pay_period_approvals
              WHERE employee_id = $1
              AND pay_period_start = $2::date
              AND pay_period_end = $3::date
          `,
        [employeeId, period.pay_period_start, period.pay_period_end],
      );

      const correctionResult = await pool.query(
        `
              SELECT
                  cr.*,
                  to_char(cr.created_at, 'MM/DD/YYYY HH12:MI AM')
                      AS created_at_display
              FROM correction_requests cr
              WHERE cr.employee_id = $1
              ORDER BY cr.created_at DESC
              LIMIT 10
          `,
        [employeeId],
      );

      const entriesResult = await pool.query(
        `
              SELECT
                  id,
                  clock_in,
                  clock_out,
                  to_char(clock_in, 'YYYY-MM-DD') AS entry_date_iso,
                  to_char(clock_in, 'MM/DD/YYYY') AS entry_date,
                  to_char(clock_in, 'HH12:MI AM') AS clock_in_time,
                  to_char(clock_in, 'HH24:MI') AS clock_in_time_24,
                  CASE
                      WHEN clock_out IS NULL THEN NULL
                      ELSE to_char(clock_out, 'HH12:MI AM')
                  END AS clock_out_time,
                  CASE
                      WHEN clock_out IS NULL THEN NULL
                      ELSE to_char(clock_out, 'HH24:MI')
                  END AS clock_out_time_24,
                  CASE
                      WHEN clock_out IS NULL THEN NULL
                      ELSE to_char(clock_out, 'YYYY-MM-DD')
                  END AS clock_out_date_iso,
                  ROUND(
                      (
                          EXTRACT(EPOCH FROM (
                              COALESCE(clock_out, now()) - clock_in
                          )) / 3600
                      )::numeric,
                      2
                  ) AS hours_worked
              FROM time_entries
              WHERE employee_id = $1
              AND clock_in >= $2::date
              AND clock_in < ($3::date + interval '1 day')
              ORDER BY clock_in
          `,
        [employeeId, period.pay_period_start, period.pay_period_end],
      );

      const requestsResult = await pool.query(
        `
              SELECT
                  tcr.*,
                  to_char(tcr.requested_clock_in,
                      'MM/DD/YYYY HH12:MI AM')
                      AS requested_clock_in_display,
                  to_char(tcr.requested_clock_out,
                      'MM/DD/YYYY HH12:MI AM')
                      AS requested_clock_out_display,
                  to_char(tcr.created_at,
                      'MM/DD/YYYY HH12:MI AM')
                      AS created_at_display,
                  to_char(tcr.reviewed_at,
                      'MM/DD/YYYY HH12:MI AM')
                      AS reviewed_at_display
              FROM time_change_requests tcr
              WHERE tcr.employee_id = $1
              ORDER BY tcr.created_at DESC
          `,
        [employeeId],
      );

      const approval = approvalResult.rows[0] || null;
      const payrollCanEdit =
        userHasPermission(req.user, "edit_payroll_time") ||
        req.user.role === "payroll" ||
        req.user.role === "admin";
      const supervisorCanEdit =
        userHasPermission(req.user, "edit_employee_time") &&
        Boolean(approval?.employee_signed_at) &&
        !approval?.supervisor_approved_at &&
        !approval?.payroll_finalized_at &&
        approval?.status === "employee_submitted";

      res.json({
        employee: employeeResult.rows[0],
        approval,
        can_edit_entries: payrollCanEdit || supervisorCanEdit,
        edit_mode: payrollCanEdit ? "payroll" : (supervisorCanEdit ? "supervisor" : "locked"),
        correction_requests: correctionResult.rows,
        change_requests: requestsResult.rows,
        pay_period_start: period.pay_period_start,
        pay_period_end: period.pay_period_end,
        entries: entriesResult.rows,
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Employee timecard error");
    }
  },
);

app.post(
  "/supervisor/approve-timecard",
  requireUser,
  requireAnyPermission("approve_timecard"),
  async (req, res) => {
    const { employee_id } = req.body;

    try {
      const access = await canAccessEmployee(req.user, employee_id);

      if (!access) {
        return res.status(403).json({
          error: "Access denied",
        });
      }

      const period = await getRequestedPayPeriod(req);

      const openPunches = await pool.query(
        `
              SELECT id
              FROM time_entries
              WHERE employee_id = $1
              AND clock_in >= $2::date
              AND clock_in < ($3::date + interval '1 day')
              AND clock_out IS NULL
          `,
        [employee_id, period.pay_period_start, period.pay_period_end],
      );

      if (openPunches.rows.length > 0) {
        return res.status(400).json({
          error: "Cannot approve timecard with open punches",
        });
      }

      const result = await pool.query(
        `
              UPDATE pay_period_approvals
              SET
                  supervisor_approved_at = now(),
                  supervisor_employee_id = $4,
                  status = 'supervisor_approved'
              WHERE employee_id = $1
              AND pay_period_start = $2::date
              AND pay_period_end = $3::date
              AND employee_signed_at IS NOT NULL
              RETURNING *
          `,
        [
          employee_id,
          period.pay_period_start,
          period.pay_period_end,
          req.user.id,
        ],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "No submitted timecard found",
        });
      }

      res.json({
        message: "Timecard approved",
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Approve timecard error");
    }
  },
);

app.post(
  "/supervisor/return-timecard",
  requireUser,
  requireAnyPermission("return_timecard", "return_to_supervisor", "edit_payroll_time"),
  async (req, res) => {
    const { employee_id, supervisor_note, target_stage = "employee" } = req.body;

    try {
      const access = await canAccessEmployee(req.user, employee_id);
      if (!access) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (!["employee", "supervisor"].includes(target_stage)) {
        return res.status(400).json({ error: "Return target must be employee or supervisor" });
      }

      const canReturnToSupervisor =
        userHasPermission(req.user, "return_to_supervisor") ||
        userHasPermission(req.user, "edit_payroll_time") ||
        req.user.role === "payroll" ||
        req.user.role === "admin";

      if (target_stage === "supervisor" && !canReturnToSupervisor) {
        return res.status(403).json({ error: "Only payroll can return a timecard to supervisor review" });
      }

      const period = await getRequestedPayPeriod(req);
      const returningToEmployee = target_stage === "employee";

      const currentApproval = await pool.query(
        `SELECT * FROM pay_period_approvals
          WHERE employee_id=$1
            AND pay_period_start=$2::date
            AND pay_period_end=$3::date
          ORDER BY id DESC LIMIT 1`,
        [employee_id, period.pay_period_start, period.pay_period_end],
      );

      if (!currentApproval.rows.length) {
        return res.status(404).json({ error: "No timecard found for this pay period" });
      }

      if (currentApproval.rows[0].payroll_finalized_at && !canReturnToSupervisor) {
        return res.status(409).json({
          error: "This timecard is payroll-finalized. Payroll must return it before changes can be made.",
        });
      }

      const result = await pool.query(
        `UPDATE pay_period_approvals
            SET status = $4,
                employee_signed_at = CASE WHEN $5::boolean THEN NULL ELSE employee_signed_at END,
                supervisor_approved_at = NULL,
                supervisor_employee_id = CASE WHEN $5::boolean THEN NULL ELSE $6 END,
                payroll_finalized_at = NULL,
                payroll_finalized_by = NULL
          WHERE employee_id = $1
            AND pay_period_start = $2::date
            AND pay_period_end = $3::date
          RETURNING *`,
        [
          employee_id,
          period.pay_period_start,
          period.pay_period_end,
          returningToEmployee ? "returned_to_employee" : "employee_submitted",
          returningToEmployee,
          null,
        ],
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "No timecard found for this pay period" });
      }

      const returnText = returningToEmployee
        ? "Timecard returned to employee for correction"
        : "Timecard returned to supervisor review";

      await pool.query(
        `INSERT INTO correction_requests(
           employee_id,request_text,status,supervisor_response
         ) VALUES($1,$2,'returned',$3)`,
        [employee_id, returnText, supervisor_note || ""],
      );

      await audit(req.user.id, "return_timecard", "employee", employee_id, {
        target_stage,
        note: supervisor_note || "",
        pay_period_start: period.pay_period_start,
        pay_period_end: period.pay_period_end,
      });

      return res.json({ message: returnText });
    } catch (err) {
      console.error(err);
      return res.status(err.statusCode || 500).json({ error: err.message || "Return timecard error" });
    }
  },
);

app.post(
  "/supervisor/edit-time-entry",
  requireUser,
  requireAnyPermission("edit_employee_time", "edit_payroll_time"),
  async (req, res) => {
    const { time_entry_id, new_clock_in, new_clock_out, reason } = req.body;

    if (!time_entry_id || !new_clock_in || !reason) {
      return res.status(400).json({
        error: "Time entry, clock in, and reason are required",
      });
    }

    try {
      const existingResult = await pool.query(
        `
              SELECT *
              FROM time_entries
              WHERE id = $1
          `,
        [time_entry_id],
      );

      if (existingResult.rows.length === 0) {
        return res.status(404).json({
          error: "Time entry not found",
        });
      }

      const existing = existingResult.rows[0];

      const access = await canAccessEmployee(req.user, existing.employee_id);

      if (!access) {
        return res.status(403).json({
          error: "Access denied",
        });
      }

      const payrollOverride =
        userHasPermission(req.user, "edit_payroll_time") ||
        req.user.role === "payroll" ||
        req.user.role === "admin";

      const approvalResult = await pool.query(
        `SELECT * FROM pay_period_approvals
          WHERE employee_id=$1
            AND $2::timestamp >= pay_period_start
            AND $2::timestamp < (pay_period_end + interval '1 day')
          ORDER BY id DESC LIMIT 1`,
        [existing.employee_id, existing.clock_in],
      );
      const approval = approvalResult.rows[0] || null;

      if (!payrollOverride) {
        const supervisorUnlocked =
          approval?.employee_signed_at &&
          !approval?.supervisor_approved_at &&
          !approval?.payroll_finalized_at &&
          approval?.status === "employee_submitted";

        if (!supervisorUnlocked) {
          return res.status(409).json({
            error: "This timecard is locked for supervisor editing. Return it to the correct stage before making changes.",
          });
        }
      }

      const finalClockOut =
        new_clock_out && new_clock_out.trim() !== "" ? new_clock_out : null;

      if (finalClockOut && new Date(finalClockOut) <= new Date(new_clock_in)) {
        return res.status(400).json({
          error: "Clock out must be after clock in",
        });
      }

      await pool.query(
        `
              INSERT INTO time_entry_audit (
                  time_entry_id,
                  changed_by_employee_id,
                  old_clock_in,
                  old_clock_out,
                  new_clock_in,
                  new_clock_out,
                  reason
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7)
          `,
        [
          time_entry_id,
          req.user.id,
          existing.clock_in,
          existing.clock_out,
          new_clock_in,
          finalClockOut,
          reason,
        ],
      );

      const result = await pool.query(
        `
              UPDATE time_entries
              SET
                  clock_in = $1,
                  clock_out = $2,
                  status = CASE
                      WHEN $2::timestamp IS NULL THEN 'open'
                      ELSE 'closed'
                  END
              WHERE id = $3
              RETURNING *
          `,
        [new_clock_in, finalClockOut, time_entry_id],
      );

      if (approval && !payrollOverride) {
        await pool.query(
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

      await audit(req.user.id, payrollOverride ? "payroll_edit_time_entry" : "supervisor_edit_time_entry", "time_entry", time_entry_id, {
        reason,
        previous_status: approval?.status || null,
      });

      res.json({
        message: "Time entry updated",
        entry: result.rows[0],
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Edit time entry error");
    }
  },
);

app.get(
  "/supervisor/time-entry-audit/:timeEntryId",
  requireUser,
  requireAnyPermission("view_timeclock_audit", "edit_employee_time", "edit_payroll_time"),
  async (req, res) => {
    const timeEntryId = req.params.timeEntryId;

    try {
      const entryResult = await pool.query(
        `
              SELECT employee_id
              FROM time_entries
              WHERE id = $1
          `,
        [timeEntryId],
      );

      if (entryResult.rows.length === 0) {
        return res.status(404).json({
          error: "Time entry not found",
        });
      }

      const access = await canAccessEmployee(
        req.user,
        entryResult.rows[0].employee_id,
      );

      if (!access) {
        return res.status(403).json({
          error: "Access denied",
        });
      }

      const result = await pool.query(
        `
              SELECT
                  tea.*,
                  changer.first_name AS changed_by_first_name,
                  changer.last_name AS changed_by_last_name,
                  to_char(tea.old_clock_in,
                      'MM/DD/YYYY HH12:MI AM')
                      AS old_clock_in_display,
                  CASE
                      WHEN tea.old_clock_out IS NULL THEN NULL
                      ELSE to_char(tea.old_clock_out,
                          'MM/DD/YYYY HH12:MI AM')
                  END AS old_clock_out_display,
                  to_char(tea.new_clock_in,
                      'MM/DD/YYYY HH12:MI AM')
                      AS new_clock_in_display,
                  CASE
                      WHEN tea.new_clock_out IS NULL THEN NULL
                      ELSE to_char(tea.new_clock_out,
                          'MM/DD/YYYY HH12:MI AM')
                  END AS new_clock_out_display,
                  to_char(tea.created_at,
                      'MM/DD/YYYY HH12:MI AM')
                      AS changed_at_display
              FROM time_entry_audit tea
              LEFT JOIN employees changer
                  ON changer.id = tea.changed_by_employee_id
              WHERE tea.time_entry_id = $1
              ORDER BY tea.created_at DESC
          `,
        [timeEntryId],
      );

      res.json({
        time_entry_id: Number(timeEntryId),
        audit: result.rows,
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Audit history error");
    }
  },
);

app.post("/employee/change-pin", requireUser, async (req, res) => {
  if (req.user.auth_source === "portal") {
    return res.status(400).json({ error: "Employee Portal users manage their password in Employee Portal" });
  }

  const { new_pin } = req.body;

  if (!new_pin || new_pin.length < 4) {
    return res.status(400).json({
      error: "New PIN must be at least 4 digits",
    });
  }

  try {
    await pool.query(
      `
              UPDATE employees
              SET
                  pin = $1,
                  must_change_pin = false
              WHERE id = $2
          `,
      [new_pin, req.user.id],
    );

    res.json({
      message: "PIN changed successfully",
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Change PIN error");
  }
});

app.post(
  "/supervisor/reset-pin",
  requireUser,
  requireAnyPermission("manage_employee_timeclock_settings"),
  async (req, res) => {
    const { employee_id } = req.body;

    try {
      const targetResult = await pool.query(`SELECT auth_source FROM employees WHERE id=$1`, [employee_id]);
      if (!targetResult.rows.length) return res.status(404).json({ error: "Employee not found" });
      if (targetResult.rows[0].auth_source === "portal") {
        return res.status(400).json({ error: "Employee Portal users do not use a TimeClock PIN" });
      }

      const access = await canAccessEmployee(req.user, employee_id, ["manage_employee_timeclock_settings"]);

      if (!access) {
        return res.status(403).json({
          error: "Access denied",
        });
      }

      await pool.query(
        `
              UPDATE employees
              SET
                  pin = '1111',
                  must_change_pin = true
              WHERE id = $1
          `,
        [employee_id],
      );

      res.json({
        message: "PIN reset to 1111. Employee must change PIN at next login.",
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Reset PIN error");
    }
  },
);

app.get(
  "/payroll/print-timecards",
  requireUser,
  requireAnyPermission("view_payroll_records", "view_payroll_reports", "export_payroll"),
  async (req, res) => {
    try {
      const period = await getRequestedPayPeriod(req);

      const result = await pool.query(
        `
              SELECT
                  e.id AS employee_id,
                  e.employee_number,
                  e.first_name,
                  e.last_name,
                  d.name AS department,

                  ppa.status AS approval_status,
                  ppa.employee_signed_at,
                  ppa.supervisor_approved_at,

                  te.id AS time_entry_id,
                  to_char(te.clock_in, 'MM/DD/YYYY') AS work_date,
                  to_char(te.clock_in, 'HH12:MI AM') AS clock_in,
                  CASE
                      WHEN te.clock_out IS NULL THEN ''
                      ELSE to_char(te.clock_out, 'HH12:MI AM')
                  END AS clock_out,

                  ROUND(
                      (
                          EXTRACT(EPOCH FROM (
                              COALESCE(te.clock_out, now()) - te.clock_in
                          )) / 3600
                      )::numeric,
                      2
                  ) AS hours_worked

              FROM employees e

              LEFT JOIN departments d
                  ON d.id = e.department_id

              LEFT JOIN pay_period_approvals ppa
                  ON ppa.employee_id = e.id
                  AND ppa.pay_period_start = $1::date
                  AND ppa.pay_period_end = $2::date

              LEFT JOIN time_entries te
                  ON te.employee_id = e.id
                  AND te.clock_in >= $1::date
                  AND te.clock_in < ($2::date + interval '1 day')

              WHERE (
              e.active = true
              OR ppa.id IS NOT NULL
              OR EXISTS (
                  SELECT 1 FROM time_entries period_te
                   WHERE period_te.employee_id=e.id
                     AND period_te.clock_in >= $1::date
                     AND period_te.clock_in < ($2::date + interval '1 day')
              )
                )

              ORDER BY
                  d.name,
                  e.last_name,
                  e.first_name,
                  te.clock_in
          `,
        [period.pay_period_start, period.pay_period_end],
      );

      res.json({
        pay_period_start: period.pay_period_start,
        pay_period_end: period.pay_period_end,
        rows: result.rows,
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Print timecards error");
    }
  },
);

app.get(
  "/supervisor/staff",
  requireUser,
  requireAnyPermission("view_assigned_employees", "view_department_time", "manage_employee_timeclock_settings", "manage_supervisor_assignments"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          e.id,
          e.employee_number,
          e.first_name,
          e.last_name,
          e.department,
          e.department_id,
          d.name AS department_name,
          e.role,
          e.active,
          e.must_change_pin
        FROM employees e
        LEFT JOIN departments d
          ON d.id = e.department_id
        WHERE (
          $1::text IN ('admin','payroll')
          OR e.id IN (
            SELECT employee_id
            FROM supervisor_employee_assignments
            WHERE supervisor_employee_id = $2 AND active = TRUE
          )
          OR e.department_id IN (
            SELECT department_id
            FROM department_heads
            WHERE employee_id = $2 AND active = TRUE
          )
        )
        ORDER BY d.name, e.active DESC, e.last_name, e.first_name
      `,
        [req.user.role, req.user.id],
      );

      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).send("Staff list error");
    }
  },
);

app.post(
  "/supervisor/create-staff",
  requireUser,
  requireAnyPermission("manage_employee_timeclock_settings"),
  async (req, res) => {
    return res.status(410).json({ error: "Employee accounts are created, enabled, and disabled in the Employee Portal." });

    const { employee_number, first_name, last_name, department_id, role } =
      req.body;

    if (!employee_number || !first_name || !last_name || !department_id) {
      return res.status(400).json({
        error:
          "Employee number, first name, last name, and department are required",
      });
    }

    try {
      if (!["admin", "payroll"].includes(req.user.role)) {
        const access = await pool.query(
          `
          SELECT 1
          FROM supervisor_departments
          WHERE supervisor_employee_id = $1
          AND department_id = $2
        `,
          [req.user.id, department_id],
        );

        if (access.rows.length === 0) {
          return res.status(403).json({
            error: "You cannot create staff in this department",
          });
        }
      }

      const dept = await pool.query(
        `
        SELECT name
        FROM departments
        WHERE id = $1
      `,
        [department_id],
      );

      if (dept.rows.length === 0) {
        return res.status(404).json({
          error: "Department not found",
        });
      }

      const result = await pool.query(
        `
        INSERT INTO employees (
          employee_number,
          pin,
          first_name,
          last_name,
          department,
          department_id,
          role,
          active,
          must_change_pin
        )
        VALUES ($1, '1111', $2, $3, $4, $5, $6, true, true)
        RETURNING *
      `,
        [
          employee_number,
          first_name,
          last_name,
          dept.rows[0].name,
          department_id,
          role || "employee",
        ],
      );

      res.json({
        message:
          "Employee created. Temporary PIN is 1111 and must be changed at next login.",
        employee: result.rows[0],
      });
    } catch (err) {
      console.error(err);

      if (err.code === "23505") {
        return res.status(400).json({
          error: "Employee number already exists",
        });
      }

      res.status(500).send("Create staff error");
    }
  },
);

app.post(
  "/supervisor/deactivate-staff",
  requireUser,
  requireAnyPermission("manage_employee_timeclock_settings"),
  async (req, res) => {
    return res.status(410).json({ error: "Employee accounts are created, enabled, and disabled in the Employee Portal." });

    const { employee_id, confirmation } = req.body;

    if (confirmation !== "DEACTIVATE") {
      return res.status(400).json({
        error: "You must type DEACTIVATE to confirm",
      });
    }

    try {
      const access = await canAccessEmployee(req.user, employee_id);

      if (!access) {
        return res.status(403).json({
          error: "Access denied",
        });
      }

      if (Number(employee_id) === Number(req.user.id)) {
        return res.status(400).json({
          error: "You cannot deactivate yourself",
        });
      }

      await pool.query(
        `
        UPDATE employees
        SET active = false
        WHERE id = $1
      `,
        [employee_id],
      );

      res.json({
        message: "Employee deactivated. Historical timecard data was retained.",
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Deactivate staff error");
    }
  },
);

app.post(
  "/supervisor/reactivate-staff",
  requireUser,
  requireAnyPermission("manage_employee_timeclock_settings"),
  async (req, res) => {
    return res.status(410).json({ error: "Employee accounts are created, enabled, and disabled in the Employee Portal." });

    const { employee_id } = req.body;

    try {
      const access = await canAccessEmployee(req.user, employee_id);

      if (!access) {
        return res.status(403).json({
          error: "Access denied",
        });
      }

      await pool.query(
        `
        UPDATE employees
        SET active = true
        WHERE id = $1
      `,
        [employee_id],
      );

      res.json({
        message: "Employee reactivated",
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Reactivate staff error");
    }
  },
);

app.get(
  "/supervisor/departments",
  requireUser,
  requireAnyPermission("view_department_time", "manage_employee_timeclock_settings", "manage_supervisor_assignments"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT d.id, d.name
        FROM departments d
        WHERE (
          $1::text IN ('admin','payroll')
          OR d.id IN (
            SELECT department_id
            FROM department_heads
            WHERE employee_id = $2 AND active = TRUE
          )
          OR d.id IN (
            SELECT department_id
            FROM supervisor_employee_assignments
            WHERE supervisor_employee_id = $2 AND active = TRUE
          )
        )
        ORDER BY d.name
      `,
        [req.user.role, req.user.id],
      );

      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).send("Departments error");
    }
  },
);

app.get(
  "/supervisor/team-structure",
  requireUser,
  requireAnyPermission("view_assigned_employees", "view_department_time", "manage_supervisor_assignments"),
  async (req, res) => {
    try {
      const structurePermissions = userPermissionSet(req.user);
      const canManageAll = req.user.app_admin_scope === "all" &&
        (structurePermissions.has("app_admin") || structurePermissions.has("manage_supervisor_assignments"));
      const departments = await pool.query(
        `SELECT d.id, d.name,
                dh.employee_id AS department_head_id,
                he.first_name AS department_head_first_name,
                he.last_name AS department_head_last_name
           FROM departments d
           LEFT JOIN department_heads dh ON dh.department_id=d.id AND dh.active=TRUE
           LEFT JOIN employees he ON he.id=dh.employee_id
          WHERE $1::boolean = TRUE
             OR d.id=$2
             OR EXISTS (SELECT 1 FROM department_heads x WHERE x.department_id=d.id AND x.employee_id=$3 AND x.active=TRUE)
             OR EXISTS (SELECT 1 FROM supervisor_employee_assignments x WHERE x.department_id=d.id AND x.supervisor_employee_id=$3 AND x.active=TRUE)
          ORDER BY d.name`,
        [canManageAll, req.user.department_id, req.user.id],
      );

      const employees = await pool.query(
        `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.department_id,
                d.name AS department_name, e.active,
                EXISTS(SELECT 1 FROM department_heads dh WHERE dh.employee_id=e.id AND dh.active=TRUE) AS is_department_head,
                EXISTS(SELECT 1 FROM supervisor_employee_assignments sea WHERE sea.supervisor_employee_id=e.id AND sea.active=TRUE) AS is_supervisor
           FROM employees e
           LEFT JOIN departments d ON d.id=e.department_id
          WHERE e.active=TRUE
            AND ($1::boolean = TRUE OR e.department_id IN (
              SELECT id FROM departments d2
               WHERE d2.id=$2
                  OR EXISTS (SELECT 1 FROM department_heads x WHERE x.department_id=d2.id AND x.employee_id=$3 AND x.active=TRUE)
                  OR EXISTS (SELECT 1 FROM supervisor_employee_assignments x WHERE x.department_id=d2.id AND x.supervisor_employee_id=$3 AND x.active=TRUE)
            ))
          ORDER BY d.name, e.last_name, e.first_name`,
        [canManageAll, req.user.department_id, req.user.id],
      );

      const visibleDepartmentIds = departments.rows.map((department) => department.id);
      const assignments = visibleDepartmentIds.length
        ? await pool.query(
            `SELECT sea.id, sea.department_id, sea.supervisor_employee_id, sea.employee_id, sea.is_primary,
                    s.first_name AS supervisor_first_name, s.last_name AS supervisor_last_name,
                    e.first_name AS employee_first_name, e.last_name AS employee_last_name
               FROM supervisor_employee_assignments sea
               JOIN employees s ON s.id=sea.supervisor_employee_id
               JOIN employees e ON e.id=sea.employee_id
              WHERE sea.active=TRUE AND sea.department_id = ANY($1::int[])
              ORDER BY sea.department_id, s.last_name, e.last_name`,
            [visibleDepartmentIds],
          )
        : { rows: [] };

      res.json({ departments: departments.rows, employees: employees.rows, assignments: assignments.rows, can_manage_all: canManageAll });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Team structure error" });
    }
  },
);

app.post(
  "/supervisor/team-structure/department-head",
  requireUser,
  requireAnyPermission("manage_supervisor_assignments"),
  async (req, res) => {
    const { department_id, employee_id } = req.body;
    try {
      if (!(await canManageTeamStructure(req.user, Number(department_id)))) {
        return res.status(403).json({ error: "You cannot manage this department" });
      }
      await pool.query("BEGIN");
      await pool.query(`UPDATE department_heads SET active=FALSE WHERE department_id=$1 AND active=TRUE`, [department_id]);
      if (employee_id) {
        const employee = await pool.query(`SELECT id FROM employees WHERE id=$1 AND department_id=$2 AND active=TRUE`, [employee_id, department_id]);
        if (!employee.rows.length) throw new Error("Department head must be an active employee in the department");
        await pool.query(
          `INSERT INTO department_heads(department_id,employee_id,active,assigned_by)
           VALUES($1,$2,TRUE,$3)
           ON CONFLICT(department_id,employee_id)
           DO UPDATE SET active=TRUE,assigned_by=EXCLUDED.assigned_by,assigned_at=NOW()`,
          [department_id, employee_id, req.user.id],
        );
      }
      await pool.query("COMMIT");
      await audit(req.user.id, "assign_department_head", "department", department_id, { employee_id: employee_id || null });
      res.json({ message: "Department head updated" });
    } catch (err) {
      await pool.query("ROLLBACK").catch(() => {});
      console.error(err);
      res.status(400).json({ error: err.message || "Department head update failed" });
    }
  },
);

app.post(
  "/supervisor/team-structure/assign",
  requireUser,
  requireAnyPermission("manage_supervisor_assignments", "view_department_time"),
  async (req, res) => {
    const { supervisor_employee_id, employee_id, department_id } = req.body;
    try {
      if (!(await canManageTeamStructure(req.user, Number(department_id)))) {
        return res.status(403).json({ error: "You cannot manage this department" });
      }
      const valid = await pool.query(
        `SELECT COUNT(*)::int AS count FROM employees
          WHERE id IN ($1,$2) AND department_id=$3 AND active=TRUE`,
        [supervisor_employee_id, employee_id, department_id],
      );
      if (valid.rows[0].count !== 2) return res.status(400).json({ error: "Supervisor and employee must be active members of the department" });
      await pool.query("BEGIN");
      await pool.query(
        `UPDATE supervisor_employee_assignments
            SET active=FALSE,ended_at=NOW()
          WHERE employee_id=$1 AND active=TRUE AND is_primary=TRUE`,
        [employee_id],
      );
      await pool.query(
        `INSERT INTO supervisor_employee_assignments(supervisor_employee_id,employee_id,department_id,is_primary,active,assigned_by)
         VALUES($1,$2,$3,TRUE,TRUE,$4)
         ON CONFLICT(supervisor_employee_id,employee_id)
         DO UPDATE SET department_id=EXCLUDED.department_id,is_primary=TRUE,active=TRUE,assigned_by=EXCLUDED.assigned_by,assigned_at=NOW(),ended_at=NULL`,
        [supervisor_employee_id, employee_id, department_id, req.user.id],
      );
      await pool.query("COMMIT");
      await audit(req.user.id, "assign_supervisor", "employee", employee_id, { supervisor_employee_id, department_id });
      res.json({ message: "Employee assigned to supervisor" });
    } catch (err) {
      await pool.query("ROLLBACK").catch(() => {});
      console.error(err);
      res.status(400).json({ error: err.message || "Assignment failed" });
    }
  },
);

app.post(
  "/supervisor/team-structure/unassign",
  requireUser,
  requireAnyPermission("manage_supervisor_assignments", "view_department_time"),
  async (req, res) => {
    const { employee_id, department_id } = req.body;
    try {
      if (!(await canManageTeamStructure(req.user, Number(department_id)))) {
        return res.status(403).json({ error: "You cannot manage this department" });
      }
      await pool.query(
        `UPDATE supervisor_employee_assignments SET active=FALSE,ended_at=NOW()
          WHERE employee_id=$1 AND active=TRUE`,
        [employee_id],
      );
      await audit(req.user.id, "unassign_supervisor", "employee", employee_id, { department_id });
      res.json({ message: "Employee removed from supervisor" });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message || "Unassign failed" });
    }
  },
);

app.get(
  "/supervisor/next-employee-number",
  requireUser,
  requireAnyPermission("manage_employee_timeclock_settings"),
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT employee_number
        FROM employees
        WHERE employee_number ~ '^[0-9]+$'
        ORDER BY employee_number::int DESC
        LIMIT 1
      `);

      let nextNumber = 1;

      if (result.rows.length > 0) {
        nextNumber = Number(result.rows[0].employee_number) + 1;
      }

      res.json({
        next_employee_number: String(nextNumber).padStart(3, "0"),
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Next employee number error");
    }
  },
);

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
