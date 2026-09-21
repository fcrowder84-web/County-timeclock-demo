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

const forcedLunchNoPunch = summarizeTimecard({
  payPeriodStart: '2026-09-21',
  forcedLunchMinutes: 60,
  entries: [{
    entry_date_iso: '2026-09-21',
    clock_in: '2026-09-21T08:00:00-04:00',
    clock_out: '2026-09-21T17:00:00-04:00',
    hours_worked: 9,
  }],
});
assert.strictEqual(forcedLunchNoPunch.daily['2026-09-21'].forced_lunch_deducted_hours, 1);
assert.strictEqual(forcedLunchNoPunch.daily['2026-09-21'].credited_worked_hours, 8);
assert.strictEqual(forcedLunchNoPunch.period.total_worked_hours, 8);

const forcedLunchPartialPunch = summarizeTimecard({
  payPeriodStart: '2026-09-21',
  forcedLunchMinutes: 60,
  entries: [
    {
      entry_date_iso: '2026-09-21',
      clock_in: '2026-09-21T08:00:00-04:00',
      clock_out: '2026-09-21T12:00:00-04:00',
      hours_worked: 4,
    },
    {
      entry_date_iso: '2026-09-21',
      clock_in: '2026-09-21T12:30:00-04:00',
      clock_out: '2026-09-21T17:00:00-04:00',
      hours_worked: 4.5,
    },
  ],
});
assert.strictEqual(forcedLunchPartialPunch.daily['2026-09-21'].recorded_break_hours, 0.5);
assert.strictEqual(forcedLunchPartialPunch.daily['2026-09-21'].forced_lunch_deducted_hours, 0.5);
assert.strictEqual(forcedLunchPartialPunch.daily['2026-09-21'].credited_worked_hours, 8);

const forcedLunchFullyPunched = summarizeTimecard({
  payPeriodStart: '2026-09-21',
  forcedLunchMinutes: 60,
  entries: [
    {
      entry_date_iso: '2026-09-21',
      clock_in: '2026-09-21T08:00:00-04:00',
      clock_out: '2026-09-21T12:00:00-04:00',
      hours_worked: 4,
    },
    {
      entry_date_iso: '2026-09-21',
      clock_in: '2026-09-21T13:00:00-04:00',
      clock_out: '2026-09-21T17:00:00-04:00',
      hours_worked: 4,
    },
  ],
});
assert.strictEqual(forcedLunchFullyPunched.daily['2026-09-21'].forced_lunch_deducted_hours, 0);
assert.strictEqual(forcedLunchFullyPunched.daily['2026-09-21'].credited_worked_hours, 8);

const forcedLunchShortDay = summarizeTimecard({
  payPeriodStart: '2026-09-21',
  forcedLunchMinutes: 60,
  entries: [{
    entry_date_iso: '2026-09-21',
    clock_in: '2026-09-21T08:00:00-04:00',
    clock_out: '2026-09-21T12:00:00-04:00',
    hours_worked: 4,
  }],
});
assert.strictEqual(forcedLunchShortDay.daily['2026-09-21'].forced_lunch_deducted_hours, 1);
assert.strictEqual(forcedLunchShortDay.daily['2026-09-21'].credited_worked_hours, 3);

const forcedLunchWaived = summarizeTimecard({
  payPeriodStart: '2026-09-21',
  forcedLunchMinutes: 60,
  lunchWaivers: [{ work_date_iso: '2026-09-21' }],
  entries: [{
    entry_date_iso: '2026-09-21',
    clock_in: '2026-09-21T08:00:00-04:00',
    clock_out: '2026-09-21T17:00:00-04:00',
    hours_worked: 9,
  }],
});
assert.strictEqual(forcedLunchWaived.daily['2026-09-21'].forced_lunch_deducted_hours, 0);
assert.strictEqual(forcedLunchWaived.daily['2026-09-21'].forced_lunch_waived, true);
assert.strictEqual(forcedLunchWaived.daily['2026-09-21'].credited_worked_hours, 9);

console.log('timecard summary tests passed');
