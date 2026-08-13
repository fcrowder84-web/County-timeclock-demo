'use strict';

const assert = require('assert');
const { transformServer } = require('../scripts/refactor-employee-routes');

const source = `const { createQuickPunchRouter } = require("./routes/quick-punch");\n\napp.use(createQuickPunchRouter({}));\n\napp.post(\n  "/submit-timecard",\n  requireUser,\n  async () => {}\n);\n\napp.get("/employee/my-timecard", requireUser, async () => {});\n\napp.post("/employee/request-time-change", requireUser, async () => {});\n\napp.get(\n  "/supervisor/pay-period-status",\n  requireUser,\n  async () => {}\n);\n`;

const result = transformServer(source);
assert.match(result, /createEmployeeRouter/);
assert.match(result, /app\.use\(createEmployeeRouter/);
assert.doesNotMatch(result, /app\.post\(\n  "\/submit-timecard"/);
assert.doesNotMatch(result, /\/employee\/my-timecard/);
assert.match(result, /\/supervisor\/pay-period-status/);
assert.throws(() => transformServer(result), /already present/);
assert.throws(() => transformServer('const x = 1;'), /anchor not found/);
console.log('employee transform tests: PASS');
