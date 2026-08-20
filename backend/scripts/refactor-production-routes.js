'use strict';

const fs = require('fs');
const path = require('path');
const { transformServer: transformEmployeeRoutes } = require('./refactor-employee-routes');

function replaceBetween(source, startMarker, endMarker, replacement = '') {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0) throw new Error(`start marker not found: ${startMarker.slice(0, 80)}`);
  if (end < 0 || end <= start) throw new Error(`end marker not found after start: ${endMarker.slice(0, 80)}`);
  if (source.indexOf(startMarker, start + 1) !== -1) {
    throw new Error(`ambiguous start marker: ${startMarker.slice(0, 80)}`);
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

function replaceOnce(source, oldText, newText, label) {
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`${label || 'replacement'} anchor not found`);
  if (source.indexOf(oldText, first + 1) !== -1) throw new Error(`${label || 'replacement'} anchor is ambiguous`);
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

const portalSyncFunction = `async function syncPortalDirectory(trigger = "scheduled") {
  if (portalSyncRunning) return { skipped: true, reason: "sync already running", lastPortalSync };
  if (!PORTAL_DIRECTORY_URL || !PORTAL_DIRECTORY_API_KEY) throw new Error("Portal directory sync is not configured");

  portalSyncRunning = true;
  let logId = null;
  let client = null;
  try {
    const log = await pool.query(\`INSERT INTO portal_directory_sync_log(status) VALUES('running') RETURNING id\`);
    logId = log.rows[0].id;

    const response = await fetch(PORTAL_DIRECTORY_URL, {
      headers: { "x-internal-api-key": PORTAL_DIRECTORY_API_KEY, "accept": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(\`Portal directory returned HTTP \${response.status}\`);

    const body = await response.json();
    if (!body || !Array.isArray(body.employees)) {
      throw new Error("Portal directory response is missing the employees array; refusing destructive sync");
    }

    const employees = body.employees;
    const ids = new Set();
    for (const item of employees) {
      if (!item || !item.portal_user_id || !item.first_name || !item.last_name) {
        throw new Error("Portal directory contains an incomplete employee record; refusing destructive sync");
      }
      const id = String(item.portal_user_id);
      if (ids.has(id)) throw new Error(\`Portal directory contains duplicate portal_user_id \${id}\`);
      ids.add(id);
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const current = await client.query(
      \`SELECT COUNT(*)::int AS count FROM employees WHERE auth_source='portal' AND active=TRUE\`,
    );
    const currentActive = Number(current.rows[0]?.count || 0);
    if (currentActive > 0 && employees.length === 0) {
      throw new Error("Portal directory returned zero employees while active Portal users exist; refusing mass deactivation");
    }
    if (currentActive >= 5 && employees.length < Math.ceil(currentActive * 0.5)) {
      throw new Error(
        \`Portal directory shrank from \${currentActive} active users to \${employees.length}; refusing automatic deactivation below 50% safety threshold\`,
      );
    }

    let activated = 0;
    for (const item of employees) {
      const result = await upsertDirectoryEmployee(client, item);
      if (result.activated) activated += 1;
    }

    const removed = await client.query(
      \`UPDATE employees
          SET active=FALSE,
              is_active=FALSE,
              portal_permissions='[]'::jsonb,
              access_removed_at=COALESCE(access_removed_at,NOW()),
              directory_sync_state='removed',
              last_portal_sync_at=NOW()
        WHERE auth_source='portal'
          AND active=TRUE
          AND NOT (portal_user_id::text = ANY($1::text[]))
        RETURNING id\`,
      [Array.from(ids)],
    );

    await client.query('COMMIT');
    client.release();
    client = null;

    const deactivated = removed.rowCount;
    lastPortalSync = {
      at: new Date().toISOString(),
      trigger,
      received: employees.length,
      activated,
      deactivated,
      ok: true,
    };
    await pool.query(
      \`UPDATE portal_directory_sync_log
          SET completed_at=NOW(),status='success',received_count=$1,activated_count=$2,deactivated_count=$3
        WHERE id=$4\`,
      [employees.length, activated, deactivated, logId],
    );
    return lastPortalSync;
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      client = null;
    }
    lastPortalSync = { at: new Date().toISOString(), trigger, ok: false, error: err.message };
    if (logId != null) {
      await pool.query(
        \`UPDATE portal_directory_sync_log SET completed_at=NOW(),status='failed',error_message=$1 WHERE id=$2\`,
        [err.message, logId],
      ).catch((logErr) => console.error('Portal directory failure log error:', logErr.message));
    }
    throw err;
  } finally {
    portalSyncRunning = false;
  }
}

`;

function transformServer(input) {
  let source = input;

  if (!source.includes('const { createEmployeeRouter } = require("./routes/employee");')) {
    source = transformEmployeeRoutes(source);
  }

  const employeeImport = 'const { createEmployeeRouter } = require("./routes/employee");';
  const routeImports = `${employeeImport}\nconst { createSupervisorRouter } = require("./routes/supervisor");\nconst { createPayrollRouter } = require("./routes/payroll");\nconst { createTeamStructureRouter } = require("./routes/team-structure");`;
  source = replaceOnce(source, employeeImport, routeImports, 'route imports');

  source = replaceBetween(
    source,
    'async function syncPortalDirectory(trigger = "scheduled") {',
    "app.post('/admin/sync-portal-directory'",
    portalSyncFunction,
  );

  const leaveMount = `app.use(createLeaveRouter({\n  requireUser,\n  requireAnyPermission,\n  pool,\n  audit,\n  canAccessEmployee,\n  getRequestedPayPeriod,\n  userHasAnyPermission,\n}));`;
  const routeMounts = `${leaveMount}\n\napp.use(createSupervisorRouter({\n  requireUser,\n  requireAnyPermission,\n  pool,\n  audit,\n  canAccessEmployee,\n  getRequestedPayPeriod,\n  userHasPermission,\n}));\n\napp.use(createPayrollRouter({\n  requireUser,\n  requireAnyPermission,\n  pool,\n  getRequestedPayPeriod,\n}));\n\napp.use(createTeamStructureRouter({\n  requireUser,\n  requireAnyPermission,\n  pool,\n  audit,\n  canManageTeamStructure,\n  userPermissionSet,\n}));`;
  source = replaceOnce(source, leaveMount, routeMounts, 'route mounts');

  const blocks = [
    ['app.get(\n  "/supervisor/pay-period-status",', 'app.get(\n  "/supervisor/change-requests",'],
    ['app.get(\n  "/supervisor/change-requests",', 'app.post(\n  "/supervisor/approve-change-request",'],
    ['app.post(\n  "/supervisor/approve-change-request",', 'app.post(\n  "/supervisor/deny-change-request",'],
    ['app.post(\n  "/supervisor/deny-change-request",', 'app.get(\n  "/payroll/department-summary",'],
    ['app.get(\n  "/payroll/department-summary",', 'app.get(\n  "/payroll/export-current-period",'],
    ['app.get(\n  "/payroll/export-current-period",', 'app.get(\n  "/supervisor/employee-timecard/:employeeId",'],
    ['app.get(\n  "/supervisor/employee-timecard/:employeeId",', 'app.post(\n  "/supervisor/approve-timecard",'],
    ['app.post(\n  "/supervisor/approve-timecard",', 'app.post(\n  "/supervisor/return-timecard",'],
    ['app.post(\n  "/supervisor/return-timecard",', 'app.post(\n  "/supervisor/edit-time-entry",'],
    ['app.post(\n  "/supervisor/edit-time-entry",', 'app.get(\n  "/supervisor/time-entry-audit/:timeEntryId",'],
    ['app.get(\n  "/supervisor/time-entry-audit/:timeEntryId",', 'app.post("/employee/change-pin"'],
    ['app.get(\n  "/payroll/print-timecards",', 'app.get(\n  "/supervisor/staff",'],
    ['app.get(\n  "/supervisor/staff",', 'app.post(\n  "/supervisor/create-staff",'],
    ['app.post(\n  "/supervisor/create-staff",', 'app.post(\n  "/supervisor/deactivate-staff",'],
    ['app.post(\n  "/supervisor/deactivate-staff",', 'app.post(\n  "/supervisor/reactivate-staff",'],
    ['app.post(\n  "/supervisor/reactivate-staff",', 'app.get(\n  "/supervisor/departments",'],
    ['app.get(\n  "/supervisor/departments",', 'app.get(\n  "/supervisor/team-structure",'],
    ['app.get(\n  "/supervisor/team-structure",', 'app.post(\n  "/supervisor/team-structure/department-head",'],
    ['app.post(\n  "/supervisor/team-structure/department-head",', 'app.post(\n  "/supervisor/team-structure/assign",'],
    ['app.post(\n  "/supervisor/team-structure/assign",', 'app.post(\n  "/supervisor/team-structure/unassign",'],
    ['app.post(\n  "/supervisor/team-structure/unassign",', 'app.get(\n  "/supervisor/next-employee-number",'],
    ['app.get(\n  "/supervisor/next-employee-number",', 'app.listen(3000'],
  ];

  for (const [start, end] of blocks) {
    source = replaceBetween(source, start, end, '');
  }

  const rootRoute = `app.get("/", (req, res) => {\n  res.send("County Timeclock API Running");\n});`;
  const healthRoutes = `app.get("/healthz", async (_req, res) => {\n  try {\n    await pool.query("SELECT 1");\n    return res.json({ ok: true, service: "county-timeclock" });\n  } catch (err) {\n    console.error("Health check failed", err);\n    return res.status(503).json({ ok: false, service: "county-timeclock" });\n  }\n});\n\n${rootRoute}`;
  source = replaceOnce(source, rootRoute, healthRoutes, 'health route');

  const forbidden = [
    'app.post(\n  "/submit-timecard",',
    'app.get(\n  "/supervisor/pay-period-status",',
    'app.get(\n  "/payroll/export-current-period",',
    'app.get(\n  "/supervisor/team-structure",',
    'await pool.query("BEGIN")',
  ];
  for (const needle of forbidden) {
    if (source.includes(needle)) throw new Error(`refactor left forbidden production pattern: ${needle}`);
  }

  for (const required of [
    'createEmployeeRouter',
    'createSupervisorRouter',
    'createPayrollRouter',
    'createTeamStructureRouter',
    'Portal directory response is missing the employees array',
    'app.get("/healthz"',
  ]) {
    if (!source.includes(required)) throw new Error(`refactor missing required pattern: ${required}`);
  }

  return source;
}

if (require.main === module) {
  const serverPath = path.resolve(__dirname, '..', 'server.js');
  const source = fs.readFileSync(serverPath, 'utf8');
  const transformed = transformServer(source);
  fs.writeFileSync(serverPath, transformed, 'utf8');
  console.log('Production routes refactored into employee/supervisor/payroll/team modules with Portal sync fail-safes.');
}

module.exports = { transformServer };
