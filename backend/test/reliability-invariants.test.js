'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(name) {
  return fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
}

const supervisor = read('routes/supervisor.js');
const payroll = read('routes/payroll.js');
const team = read('routes/team-structure.js');
const quick = read('routes/quick-punch.js');
const employee = read('routes/employee.js');
const mobilePairing = read('../frontend/mobile-pairing.js');
const timecardActions = read('../frontend/timecard-actions.js');
const supervisorFrontend = read('../frontend/supervisor.html');
const timecardHtml = read('../frontend/timecard.html');
const frontendDockerfile = read('../frontend/Dockerfile');
const schema = read('../schema.sql');
const deniedPunchMigration = read('../migrations/015_denied_punch_acknowledgement.sql');

for (const [label, source] of [
  ['supervisor', supervisor],
  ['payroll', payroll],
  ['quick-punch', quick],
]) {
  assert.match(source, /deleted_at IS NULL/, `${label} must explicitly ignore soft-deleted punches`);
}

assert.match(supervisor, /FOR UPDATE/);
assert.match(supervisor, /BEGIN/);
assert.match(supervisor, /COMMIT/);
assert.match(supervisor, /status=CASE WHEN \$2::timestamp IS NULL THEN 'open' ELSE 'closed' END/);
assert.match(supervisor, /pending_leave_count|pendingLeave/);
assert.match(supervisor, /pending_change_count|pendingChanges/);
assert.match(supervisor, /status='pending'/);
assert.match(supervisor, /invalidated_approval_ids/);
assert.doesNotMatch(supervisor, /status\s*=\s*'closed'[\s\S]{0,120}WHERE id/, 'correction approval must not blindly mark null-clock-out entries closed');

assert.match(payroll, /WHERE te\.deleted_at IS NULL/);
assert.match(payroll, /period_te\.deleted_at IS NULL/);
assert.match(payroll, /te\.deleted_at IS NULL[\s\S]*te\.clock_in/);

assert.match(team, /client = await pool\.connect\(\)/);
assert.match(team, /await client\.query\('BEGIN'\)/);
assert.doesNotMatch(team, /await pool\.query\(["']BEGIN["']\)/);
assert.match(team, /cannot be assigned as their own supervisor/);

assert.match(quick, /UPDATE time_change_requests[\s\S]*status='voided'/);
assert.match(quick, /deleted_at=NOW\(\)/);
assert.match(quick, /clock_out IS NULL\s+RETURNING \*/);

// Denied punch requests require a non-empty reason in the API and both
// supervisor UI surfaces, capped at 1000 characters.
assert.match(supervisor, /A reason is required when denying a punch request/);
assert.match(supervisor, /Denial reason must be 1000 characters or less/);
assert.match(timecardActions, /Reason for denying this punch request \(required\):/);
assert.match(timecardActions, /note\.length>1000/);
assert.match(supervisorFrontend, /Reason for denying this punch request \(required\):/);
assert.match(supervisorFrontend, /note\.length > 1000/);

// Employee acknowledgement is a timestamp-only state change; the denial row
// and audit history remain intact.
assert.match(employee, /employee_acknowledged_at=COALESCE\(employee_acknowledged_at,NOW\(\)\)/);
assert.doesNotMatch(employee, /DELETE FROM time_change_requests/i);
assert.match(schema, /employee_acknowledged_at timestamp with time zone/);
assert.match(deniedPunchMigration, /ADD COLUMN IF NOT EXISTS employee_acknowledged_at TIMESTAMPTZ/);

// The red home alert links directly to the denied request on the timecard.
assert.match(mobilePairing, /Denied Punch Request/);
assert.match(mobilePairing, /employee\/denied-change-requests/);
assert.match(mobilePairing, /timecard\.html\?deniedRequest=/);

// Activity log access is server-side scoped and represents actions concerning
// the selected employee, not merely actions the employee happened to perform.
assert.match(employee, /canAccessEmployee\(/);
assert.doesNotMatch(employee, /a\.actor_employee_id=\$1/);
assert.match(employee, /portal_sso_login/);
assert.match(employee, /trusted_mobile_session/);
assert.match(employee, /generate_mobile_pairing_code/);
assert.match(employee, /redeem_mobile_pairing_code/);

// Logs navigation and nginx image inclusion are deployment requirements.
assert.match(timecardHtml, /href="\/logs\.html"/);
assert.match(frontendDockerfile, /COPY logs\.html \/usr\/share\/nginx\/html\/logs\.html/);

console.log('reliability invariant tests: PASS');
