'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const hardening = require('../scripts/harden-frontend');

const frontend = path.resolve(__dirname, '..', '..', 'frontend');

function checkedFile(filename, transform) {
  const source = fs.readFileSync(path.join(frontend, filename), 'utf8');
  return source.includes('/safe-html.js') ? source : transform(source);
}

const employee = checkedFile('employee.html', hardening.hardenEmployee);
assert(employee.includes('/safe-html.js'));
assert(employee.includes('esc(request.employee_reason)'));
assert(employee.includes('esc(request.supervisor_note'));
assert(employee.includes('esc(entry.note'));
assert(employee.includes('esc(currentUser.first_name)'));

const supervisor = checkedFile('supervisor.html', hardening.hardenSupervisor);
assert(supervisor.includes('/safe-html.js'));
assert(supervisor.includes('esc(request.employee_reason)'));
assert(supervisor.includes('esc(item.reason'));
assert(supervisor.includes('esc(person.first_name)'));
assert(!supervisor.includes('async function createStaff('));
assert(!supervisor.includes('async function deactivateStaff('));
assert(!supervisor.includes('async function reactivateStaff('));

const payroll = checkedFile('payroll.html', hardening.hardenPayroll);
assert(payroll.includes('/safe-html.js'));
assert(payroll.includes('esc(request.employee_reason)'));
assert(payroll.includes('esc(department)'));
assert(payroll.includes('esc(row.last_name)'));

const printable = checkedFile('payroll-timecards.html', hardening.hardenPrintablePayroll);
assert(printable.includes('/safe-html.js'));
assert(printable.includes('esc(employee.first_name)'));
assert(printable.includes('esc(employee.department'));

const leave = checkedFile('leave.html', hardening.hardenLeave);
assert(leave.includes('/safe-html.js'));
assert(leave.includes('esc(x.name)'));
assert(leave.includes('esc(x.note'));
assert(leave.includes('esc(x.last_name)'));

const punches = checkedFile('punches.html', hardening.hardenPunches);
assert(punches.includes('/safe-html.js'));
assert(punches.includes('esc(entry.clock_in_display'));
assert(punches.includes('esc(entry.status'));

const timecard = fs.readFileSync(path.join(frontend, 'timecard.html'), 'utf8');
const timecardBase = fs.readFileSync(path.join(frontend, 'timecard-base.js'), 'utf8');
const timecardActions = fs.readFileSync(path.join(frontend, 'timecard-actions.js'), 'utf8');
assert(timecard.includes('/safe-html.js'));
assert(timecard.includes('/timecard-base.js'));
assert(timecard.includes('/timecard-actions.js'));
assert(timecardBase.includes('SafeHtml.escape'));
assert(timecardBase.includes('esc(e.name'));
assert(timecardBase.includes('esc(p.label'));
assert(timecardActions.includes('esc(i.text)'));
assert(!timecardBase.includes('innerHTML=currentUser'));
assert(!timecardActions.includes('innerHTML=currentUser'));

console.log('frontend security tests: PASS');
