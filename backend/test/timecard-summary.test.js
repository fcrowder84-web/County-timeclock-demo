"use strict";
const assert = require('assert');
const { summarizeTimecard, roundDailyMinutes } = require('../lib/timecard-summary');

assert.strictEqual(roundDailyMinutes(485), 480);
assert.strictEqual(roundDailyMinutes(486), 495);

const leaveCannotCreateOt = summarizeTimecard({
  payPeriodStart: '2026-08-10',
  entries: [
    { entry_date_iso: '2026-08-10', hours_worked: 8 },
    { entry_date_iso: '2026-08-11', hours_worked: 8 },
    { entry_date_iso: '2026-08-12', hours_worked: 8 },
    { entry_date_iso: '2026-08-13', hours_worked: 8 },
    { entry_date_iso: '2026-08-14', hours_worked: 6 },
  ],
  leaveEntries: [{ leave_date_iso: '2026-08-14', leave_type: 'vacation', hours: 6, status: 'approved' }],
});
assert.strictEqual(leaveCannotCreateOt.weeks[0].total_worked_hours, 38);
assert.strictEqual(leaveCannotCreateOt.weeks[0].overtime_hours, 0);
assert.strictEqual(leaveCannotCreateOt.weeks[0].total_leave_hours, 6);
assert.strictEqual(leaveCannotCreateOt.weeks[0].total_paid_hours, 44);

const workedOtOnly = summarizeTimecard({
  payPeriodStart: '2026-08-10',
  entries: [
    { entry_date_iso: '2026-08-10', hours_worked: 9 },
    { entry_date_iso: '2026-08-11', hours_worked: 9 },
    { entry_date_iso: '2026-08-12', hours_worked: 8 },
    { entry_date_iso: '2026-08-13', hours_worked: 8 },
    { entry_date_iso: '2026-08-14', hours_worked: 8 },
  ],
  leaveEntries: [{ leave_date_iso: '2026-08-14', leave_type: 'sick', hours: 2, status: 'approved' }],
});
assert.strictEqual(workedOtOnly.weeks[0].total_worked_hours, 42);
assert.strictEqual(workedOtOnly.weeks[0].regular_worked_hours, 40);
assert.strictEqual(workedOtOnly.weeks[0].overtime_hours, 2);
assert.strictEqual(workedOtOnly.weeks[0].total_paid_hours, 44);

const twoWeek = summarizeTimecard({
  payPeriodStart: '2026-08-10',
  entries: [
    { entry_date_iso: '2026-08-10', hours_worked: 42 },
    { entry_date_iso: '2026-08-17', hours_worked: 38 },
  ],
  leaveEntries: [{ leave_date_iso: '2026-08-18', leave_type: 'vacation', hours: 6, status: 'approved' }],
});
assert.strictEqual(twoWeek.period.total_worked_hours, 80);
assert.strictEqual(twoWeek.period.overtime_hours, 2);
assert.strictEqual(twoWeek.period.total_leave_hours, 6);
assert.strictEqual(twoWeek.period.total_paid_hours, 86);

console.log('timecard summary tests passed');
