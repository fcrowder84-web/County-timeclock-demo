'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  hardenEmployee,
  hardenSupervisor,
  hardenPayroll,
  hardenPrintablePayroll,
  hardenLeave,
  hardenPunches,
} = require('../scripts/harden-frontend');

const frontend = path.resolve(__dirname, '..', '..', 'frontend');
const read = name => fs.readFileSync(path.join(frontend, name), 'utf8');

const employee = hardenEmployee(read('employee.html'));
assert.match(employee, /safe-html\.js/);
assert.match(employee, /esc\(request\.employee_reason\)/);
assert.match(employee, /esc\(request\.supervisor_note/);
assert.match(employee, /esc\(entry\.note/);
assert.match(employee, /esc\(currentUser\.first_name\)/);

const supervisor = hardenSupervisor(read('supervisor.html'));
assert.match(supervisor, /safe-html\.js/);
assert.match(supervisor, /esc\(request\.employee_reason\)/);
assert.match(supervisor, /esc\(item\.reason/);
assert.match(supervisor, /return `\$\{esc\(person\.first_name\)\}/);
assert.doesNotMatch(supervisor, /async function createStaff\(/);
assert.doesNotMatch(supervisor, /async function deactivateStaff\(/);
assert.doesNotMatch(supervisor, /async function reactivateStaff\(/);

const payroll = hardenPayroll(read('payroll.html'));
assert.match(payroll, /safe-html\.js/);
assert.match(payroll, /esc\(request\.employee_reason\)/);
assert.match(payroll, /esc\(department\)/);
assert.match(payroll, /esc\(row\.last_name\)/);

const printable = hardenPrintablePayroll(read('payroll-timecards.html'));
assert.match(printable, /safe-html\.js/);
assert.match(printable, /esc\(employee\.first_name\)/);
assert.match(printable, /esc\(employee\.department/);

const leave = hardenLeave(read('leave.html'));
assert.match(leave, /safe-html\.js/);
assert.match(leave, /esc\(x\.name\)/);
assert.match(leave, /esc\(x\.note/);
assert.match(leave, /esc\(x\.last_name\)/);

const punches = hardenPunches(read('punches.html'));
assert.match(punches, /safe-html\.js/);
assert.match(punches, /esc\(entry\.clock_in_display/);
assert.match(punches, /esc\(entry\.status/);

for (const [name, contents] of [
  ['employee', employee],
  ['supervisor', supervisor],
  ['payroll', payroll],
  ['printable', printable],
  ['leave', leave],
  ['punches', punches],
]) {
  assert.doesNotMatch(contents, /<script[^>]+src=["']https?:\/\//i, `${name} must not load third-party scripts`);
}

console.log('frontend security tests: PASS');
