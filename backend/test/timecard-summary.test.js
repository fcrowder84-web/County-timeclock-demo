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


const forcedShortDay = summarizeTimecard({
  payPeriodStart: '2026-08-10',
  forcedLunchEnabled: true,
  forcedLunchMinutes: 60,
  entries: [
    { entry_date_iso: '2026-08-10', clock_in: '2026-08-10T08:00:00-04:00', clock_out: '2026-08-10T12:00:00-04:00', hours_worked: 4 },
  ],
});
assert.strictEqual(forcedShortDay.days[0].forced_lunch_deduction_hours, 1);
assert.strictEqual(forcedShortDay.days[0].total_worked_hours, 3);

const partialActualLunch = summarizeTimecard({
  payPeriodStart: '2026-08-10',
  forcedLunchEnabled: true,
  forcedLunchMinutes: 60,
  entries: [
    { entry_date_iso: '2026-08-10', clock_in: '2026-08-10T08:00:00-04:00', clock_out: '2026-08-10T12:00:00-04:00', hours_worked: 4 },
    { entry_date_iso: '2026-08-10', clock_in: '2026-08-10T12:30:00-04:00', clock_out: '2026-08-10T17:00:00-04:00', hours_worked: 4.5 },
  ],
});
assert.strictEqual(partialActualLunch.days[0].existing_break_hours, 0.5);
assert.strictEqual(partialActualLunch.days[0].forced_lunch_deduction_hours, 0.5);
assert.strictEqual(partialActualLunch.days[0].total_worked_hours, 8);

const fullActualLunch = summarizeTimecard({
  payPeriodStart: '2026-08-10',
  forcedLunchEnabled: true,
  forcedLunchMinutes: 60,
  entries: [
    { entry_date_iso: '2026-08-10', clock_in: '2026-08-10T08:00:00-04:00', clock_out: '2026-08-10T12:00:00-04:00', hours_worked: 4 },
    { entry_date_iso: '2026-08-10', clock_in: '2026-08-10T13:00:00-04:00', clock_out: '2026-08-10T17:00:00-04:00', hours_worked: 4 },
  ],
});
assert.strictEqual(fullActualLunch.days[0].forced_lunch_deduction_hours, 0);
assert.strictEqual(fullActualLunch.days[0].total_worked_hours, 8);

const waivedLunch = summarizeTimecard({
  payPeriodStart: '2026-08-10',
  forcedLunchEnabled: true,
  forcedLunchMinutes: 60,
  entries: [
    { entry_date_iso: '2026-08-10', clock_in: '2026-08-10T08:00:00-04:00', clock_out: '2026-08-10T17:00:00-04:00', hours_worked: 9 },
  ],
  lunchWaivers: [
    { work_date_iso: '2026-08-10', reason: 'Worked through lunch', source: 'supervisor', active: true },
  ],
});
assert.strictEqual(waivedLunch.days[0].forced_lunch_deduction_hours, 0);
assert.strictEqual(waivedLunch.days[0].lunch_waived, true);
assert.strictEqual(waivedLunch.days[0].total_worked_hours, 9);

const lunchPreventsArtificialOt = summarizeTimecard({
  payPeriodStart: '2026-08-10',
  forcedLunchEnabled: true,
  forcedLunchMinutes: 60,
  entries: [
    { entry_date_iso: '2026-08-10', hours_worked: 9 },
    { entry_date_iso: '2026-08-11', hours_worked: 9 },
    { entry_date_iso: '2026-08-12', hours_worked: 9 },
    { entry_date_iso: '2026-08-13', hours_worked: 9 },
    { entry_date_iso: '2026-08-14', hours_worked: 9 },
  ],
});
assert.strictEqual(lunchPreventsArtificialOt.weeks[0].gross_worked_hours, 45);
assert.strictEqual(lunchPreventsArtificialOt.weeks[0].forced_lunch_hours, 5);
assert.strictEqual(lunchPreventsArtificialOt.weeks[0].total_worked_hours, 40);
assert.strictEqual(lunchPreventsArtificialOt.weeks[0].overtime_hours, 0);

console.log('timecard summary tests passed');
