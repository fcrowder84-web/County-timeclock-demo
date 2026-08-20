'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { transformServer } = require('../scripts/refactor-production-routes');

const serverPath = path.resolve(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');
const result = transformServer(source);

assert.match(result, /createEmployeeRouter/);
assert.match(result, /createSupervisorRouter/);
assert.match(result, /createPayrollRouter/);
assert.match(result, /createTeamStructureRouter/);
assert.match(result, /app\.get\("\/healthz"/);
assert.match(result, /refusing destructive sync/);
assert.match(result, /refusing mass deactivation/);
assert.match(result, /50% safety threshold/);
assert.doesNotMatch(result, /app\.post\(\n  "\/submit-timecard",/);
assert.doesNotMatch(result, /app\.get\(\n  "\/supervisor\/pay-period-status",/);
assert.doesNotMatch(result, /app\.get\(\n  "\/payroll\/export-current-period",/);
assert.doesNotMatch(result, /app\.get\(\n  "\/supervisor\/team-structure",/);
assert.doesNotMatch(result, /await pool\.query\("BEGIN"\)/);

assert.throws(() => transformServer(result), /route imports|already present|anchor/i);
console.log('production route refactor tests: PASS');
