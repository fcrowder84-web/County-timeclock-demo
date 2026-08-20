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

assert.match(quick, /UPDATE time_change_requests[\s\S]*status='denied'/);
assert.match(quick, /deleted_at=NOW\(\)/);
assert.match(quick, /clock_out IS NULL\s+RETURNING \*/);

console.log('reliability invariant tests: PASS');
