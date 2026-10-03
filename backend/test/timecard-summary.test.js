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


// Regression: rounding differences must never be mistaken for a lunch break.
const continuousOddMinutePunch = summarizeTimecard({
  payPeriodStart: "2026-09-14",
  forcedLunchEnabled: true,
  forcedLunchMinutes: 30,
  entries: [
    {
      entry_date_iso: "2026-09-16",
      clock_in: "2026-09-16T07:30:00-04:00",
      clock_out: "2026-09-16T16:19:42-04:00",
      hours_worked: 8.8283333333
    }
  ],
});

assert.strictEqual(continuousOddMinutePunch.days.length, 1);
assert.strictEqual(continuousOddMinutePunch.days[0].existing_break_hours, 0);
assert.strictEqual(continuousOddMinutePunch.days[0].forced_lunch_deduction_hours, 0.5);

const effectiveDatedLunch = summarizeTimecard({
  payPeriodStart: '2026-09-14',
  forcedLunchSettings: [
    { effective_date_iso: '2026-09-21', enabled: true, minutes: 30 },
  ],
  entries: [
    { entry_date_iso: '2026-09-20', clock_in: '2026-09-20T08:00:00-04:00', clock_out: '2026-09-20T17:00:00-04:00', hours_worked: 9 },
    { entry_date_iso: '2026-09-21', clock_in: '2026-09-21T08:00:00-04:00', clock_out: '2026-09-21T17:00:00-04:00', hours_worked: 9 },
  ],
});
assert.strictEqual(effectiveDatedLunch.days.find(day => day.work_date === '2026-09-20').forced_lunch_deduction_hours, 0);
assert.strictEqual(effectiveDatedLunch.days.find(day => day.work_date === '2026-09-21').forced_lunch_deduction_hours, 0.5);

const changedLunchDuration = summarizeTimecard({
  payPeriodStart: '2026-09-28',
  forcedLunchSettings: [
    { effective_date_iso: '2026-09-01', enabled: true, minutes: 30 },
    { effective_date_iso: '2026-10-05', enabled: true, minutes: 60 },
  ],
  entries: [
    { entry_date_iso: '2026-10-04', clock_in: '2026-10-04T08:00:00-04:00', clock_out: '2026-10-04T17:00:00-04:00', hours_worked: 9 },
    { entry_date_iso: '2026-10-05', clock_in: '2026-10-05T08:00:00-04:00', clock_out: '2026-10-05T17:00:00-04:00', hours_worked: 9 },
  ],
});
assert.strictEqual(changedLunchDuration.days.find(day => day.work_date === '2026-10-04').forced_lunch_deduction_hours, 0.5);
assert.strictEqual(changedLunchDuration.days.find(day => day.work_date === '2026-10-05').forced_lunch_deduction_hours, 1);

const weeklyCapReducesLeave = summarizeTimecard({
  payPeriodStart: '2026-10-05',
  weeklyHoursCap: 40,
  entries: [
    { entry_date_iso: '2026-10-05', hours_worked: 10 },
    { entry_date_iso: '2026-10-06', hours_worked: 10 },
    { entry_date_iso: '2026-10-07', hours_worked: 8 },
    { entry_date_iso: '2026-10-08', hours_worked: 8 },
  ],
  leaveEntries: [
    { leave_date_iso: '2026-10-09', leave_type: 'sick', hours: 8, status: 'approved' },
  ],
});
assert.strictEqual(weeklyCapReducesLeave.weeks[0].total_worked_hours, 36);
assert.strictEqual(weeklyCapReducesLeave.weeks[0].total_leave_hours, 8);
assert.strictEqual(weeklyCapReducesLeave.weeks[0].adjusted_total_leave_hours, 4);
assert.strictEqual(weeklyCapReducesLeave.weeks[0].adjusted_leave_hours_by_type.sick, 4);
assert.strictEqual(weeklyCapReducesLeave.weeks[0].leave_hours_reduced_by_cap, 4);
assert.strictEqual(weeklyCapReducesLeave.weeks[0].total_paid_hours, 40);

const workWinsOverLeaveAtCap = summarizeTimecard({
  payPeriodStart: '2026-10-05',
  weeklyHoursCap: 40,
  entries: [{ entry_date_iso: '2026-10-05', hours_worked: 41 }],
  leaveEntries: [
    { leave_date_iso: '2026-10-06', leave_type: 'vacation', hours: 8, status: 'approved' },
  ],
});
assert.strictEqual(workWinsOverLeaveAtCap.weeks[0].total_worked_hours, 41);
assert.strictEqual(workWinsOverLeaveAtCap.weeks[0].adjusted_total_leave_hours, 0);
assert.strictEqual(workWinsOverLeaveAtCap.weeks[0].total_leave_hours, 8);
assert.strictEqual(workWinsOverLeaveAtCap.weeks[0].total_paid_hours, 40);
assert.strictEqual(workWinsOverLeaveAtCap.weeks[0].overtime_hours, 0);
assert.strictEqual(workWinsOverLeaveAtCap.weeks[0].regular_worked_hours, 40);

const weeklyCapDoesNotCrossWeeks = summarizeTimecard({
  payPeriodStart: '2026-10-05',
  weeklyHoursCap: 40,
  entries: [
    { entry_date_iso: '2026-10-05', hours_worked: 38 },
    { entry_date_iso: '2026-10-12', hours_worked: 32 },
  ],
  leaveEntries: [
    { leave_date_iso: '2026-10-06', leave_type: 'vacation', hours: 8, status: 'approved' },
    { leave_date_iso: '2026-10-13', leave_type: 'vacation', hours: 8, status: 'approved' },
  ],
});
assert.strictEqual(weeklyCapDoesNotCrossWeeks.weeks[0].adjusted_total_leave_hours, 2);
assert.strictEqual(weeklyCapDoesNotCrossWeeks.weeks[0].total_paid_hours, 40);
assert.strictEqual(weeklyCapDoesNotCrossWeeks.weeks[1].adjusted_total_leave_hours, 8);
assert.strictEqual(weeklyCapDoesNotCrossWeeks.weeks[1].total_paid_hours, 40);
assert.strictEqual(weeklyCapDoesNotCrossWeeks.period.total_paid_hours, 80);
assert.strictEqual(weeklyCapDoesNotCrossWeeks.period.adjusted_total_leave_hours, 10);
assert.strictEqual(weeklyCapDoesNotCrossWeeks.period.total_leave_hours, 16);

const noCapKeepsLegacyBehavior = summarizeTimecard({
  payPeriodStart: '2026-10-05',
  entries: [{ entry_date_iso: '2026-10-05', hours_worked: 38 }],
  leaveEntries: [
    { leave_date_iso: '2026-10-06', leave_type: 'vacation', hours: 8, status: 'approved' },
  ],
});
assert.strictEqual(noCapKeepsLegacyBehavior.weeks[0].total_paid_hours, 46);
assert.strictEqual(noCapKeepsLegacyBehavior.weeks[0].adjusted_total_leave_hours, 8);


const explicitNullCap = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: null,
  entries: [{ entry_date_iso:'2026-10-05', hours_worked:38 }],
  leaveEntries: [{ leave_date_iso:'2026-10-06', leave_type:'sick', hours:8, status:'approved' }],
});
assert.strictEqual(explicitNullCap.weeks[0].total_paid_hours, 46);

const zeroCap = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 0,
  entries: [{ entry_date_iso:'2026-10-05', hours_worked:8 }],
  leaveEntries: [{ leave_date_iso:'2026-10-06', leave_type:'vacation', hours:8, status:'approved' }],
});
assert.strictEqual(zeroCap.weeks[0].total_worked_hours, 8);
assert.strictEqual(zeroCap.weeks[0].adjusted_total_leave_hours, 0);
assert.strictEqual(zeroCap.weeks[0].total_paid_hours, 0);

const exactAndQuarterCap = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 38.25,
  entries: [{ entry_date_iso:'2026-10-05', hours_worked:38.25 }],
  leaveEntries: [{ leave_date_iso:'2026-10-06', leave_type:'sick', hours:2, status:'approved' }],
});
assert.strictEqual(exactAndQuarterCap.weeks[0].total_paid_hours, 38.25);
assert.strictEqual(exactAndQuarterCap.weeks[0].adjusted_total_leave_hours, 0);

const leaveBelowCapacity = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  entries: [{ entry_date_iso:'2026-10-05', hours_worked:32 }],
  leaveEntries: [{ leave_date_iso:'2026-10-06', leave_type:'sick', hours:4, status:'approved' }],
});
assert.strictEqual(leaveBelowCapacity.weeks[0].adjusted_total_leave_hours, 4);
assert.strictEqual(leaveBelowCapacity.weeks[0].total_paid_hours, 36);

const multipleLeaveTypesAtCap = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  entries: [{ entry_date_iso:'2026-10-05', hours_worked:36 }],
  leaveEntries: [
    { leave_date_iso:'2026-10-06', leave_type:'vacation', hours:2, status:'approved' },
    { leave_date_iso:'2026-10-07', leave_type:'sick', hours:4, status:'approved' },
  ],
});
assert.strictEqual(multipleLeaveTypesAtCap.weeks[0].total_leave_hours, 6);
assert.strictEqual(multipleLeaveTypesAtCap.weeks[0].adjusted_total_leave_hours, 4);
assert.strictEqual(multipleLeaveTypesAtCap.weeks[0].total_paid_hours, 40);

// Capped payroll allocation is deterministic and independent of leave insertion order:
// worked (0), regular holiday (10), sick (20), floating holiday (30), vacation (40).
const weightedLeaveAtCap = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  entries: [{ entry_date_iso:'2026-10-05', hours_worked:32 }],
  leaveEntries: [
    { leave_date_iso:'2026-10-06', leave_type:'vacation', hours:8, status:'approved' },
    { leave_date_iso:'2026-10-07', leave_type:'floating holiday', hours:4, status:'approved' },
    { leave_date_iso:'2026-10-08', leave_type:'sick', hours:4, status:'approved' },
    { leave_date_iso:'2026-10-09', leave_type:'regular holiday leave', hours:4, status:'approved' },
  ],
});
assert.strictEqual(weightedLeaveAtCap.weeks[0].total_leave_hours, 20);
assert.strictEqual(weightedLeaveAtCap.weeks[0].leave_hours_by_type.vacation, 8);
assert.strictEqual(weightedLeaveAtCap.weeks[0].leave_hours_by_type['floating holiday'], 4);
assert.strictEqual(weightedLeaveAtCap.weeks[0].leave_hours_by_type.sick, 4);
assert.strictEqual(weightedLeaveAtCap.weeks[0].leave_hours_by_type['regular holiday leave'], 4);
assert.strictEqual(weightedLeaveAtCap.weeks[0].adjusted_leave_hours_by_type['regular holiday leave'], 4);
assert.strictEqual(weightedLeaveAtCap.weeks[0].adjusted_leave_hours_by_type.sick, 4);
assert.strictEqual(weightedLeaveAtCap.weeks[0].adjusted_leave_hours_by_type['floating holiday'], undefined);
assert.strictEqual(weightedLeaveAtCap.weeks[0].adjusted_leave_hours_by_type.vacation, undefined);
assert.strictEqual(weightedLeaveAtCap.weeks[0].adjusted_total_leave_hours, 8);
assert.strictEqual(weightedLeaveAtCap.weeks[0].leave_hours_reduced_by_cap, 12);
assert.strictEqual(weightedLeaveAtCap.weeks[0].total_paid_hours, 40);

// Regular Holiday is county-given time and is protected ahead of worked/taken leave.
const protectedHolidayWithWork = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  entries: [{ entry_date_iso:'2026-10-05', hours_worked:36 }],
  leaveEntries: [{ leave_date_iso:'2026-10-06', leave_type:'regular holiday leave', hours:8, status:'approved' }],
});
assert.strictEqual(protectedHolidayWithWork.weeks[0].regular_worked_hours, 32);
assert.strictEqual(protectedHolidayWithWork.weeks[0].adjusted_leave_hours_by_type['regular holiday leave'], 8);
assert.strictEqual(protectedHolidayWithWork.weeks[0].total_paid_hours, 40);

const protectedHolidayBeforeSick = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  entries: [{ entry_date_iso:'2026-10-05', hours_worked:32 }],
  leaveEntries: [
    { leave_date_iso:'2026-10-06', leave_type:'regular holiday leave', hours:8, status:'approved' },
    { leave_date_iso:'2026-10-07', leave_type:'sick', hours:8, status:'approved' },
  ],
});
assert.strictEqual(protectedHolidayBeforeSick.weeks[0].regular_worked_hours, 32);
assert.strictEqual(protectedHolidayBeforeSick.weeks[0].adjusted_leave_hours_by_type['regular holiday leave'], 8);
assert.strictEqual(protectedHolidayBeforeSick.weeks[0].adjusted_leave_hours_by_type.sick, undefined);
assert.strictEqual(protectedHolidayBeforeSick.weeks[0].total_paid_hours, 40);

// Equal-weight/unknown leave allocation must be deterministic regardless of insertion order.
const unknownLeaveForward = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  entries: [{ entry_date_iso:'2026-10-05', hours_worked:32 }],
  leaveEntries: [
    { leave_date_iso:'2026-10-06', leave_type:'zeta special', hours:8, status:'approved' },
    { leave_date_iso:'2026-10-07', leave_type:'alpha special', hours:8, status:'approved' },
  ],
});
const unknownLeaveReverse = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  entries: [{ entry_date_iso:'2026-10-05', hours_worked:32 }],
  leaveEntries: [
    { leave_date_iso:'2026-10-07', leave_type:'alpha special', hours:8, status:'approved' },
    { leave_date_iso:'2026-10-06', leave_type:'zeta special', hours:8, status:'approved' },
  ],
});
assert.deepStrictEqual(
  unknownLeaveForward.weeks[0].adjusted_leave_hours_by_type,
  unknownLeaveReverse.weeks[0].adjusted_leave_hours_by_type,
);
assert.strictEqual(unknownLeaveForward.weeks[0].adjusted_leave_hours_by_type['alpha special'], 8);
assert.strictEqual(unknownLeaveForward.weeks[0].adjusted_leave_hours_by_type['zeta special'], undefined);
assert.strictEqual(unknownLeaveForward.weeks[0].total_paid_hours, 40);

// The daily/approved leave audit remains untouched while payroll totals use adjusted leave.
const madeUpSickHours = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  entries: [{ entry_date_iso:'2026-10-06', hours_worked:36 }],
  leaveEntries: [{ leave_date_iso:'2026-10-05', leave_type:'sick', hours:8, status:'approved' }],
});
assert.strictEqual(madeUpSickHours.weeks[0].leave_hours_by_type.sick, 8);
assert.strictEqual(madeUpSickHours.weeks[0].total_leave_hours, 8);
assert.strictEqual(madeUpSickHours.weeks[0].adjusted_leave_hours_by_type.sick, 4);
assert.strictEqual(madeUpSickHours.weeks[0].adjusted_total_leave_hours, 4);
assert.strictEqual(madeUpSickHours.period.leave_hours_by_type.sick, 8);
assert.strictEqual(madeUpSickHours.period.adjusted_leave_hours_by_type.sick, 4);
assert.strictEqual(madeUpSickHours.period.total_paid_hours, 40);

// Uncapped employees retain the normal overtime rule.
assert.strictEqual(workedOtOnly.weeks[0].overtime_hours, 2);

const forcedLunchWithCap = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  forcedLunchEnabled: true, forcedLunchMinutes: 60,
  entries: [
    { entry_date_iso:'2026-10-05', hours_worked:9 },
    { entry_date_iso:'2026-10-06', hours_worked:9 },
    { entry_date_iso:'2026-10-07', hours_worked:9 },
    { entry_date_iso:'2026-10-08', hours_worked:9 },
  ],
  leaveEntries: [{ leave_date_iso:'2026-10-09', leave_type:'vacation', hours:8, status:'approved' }],
});
assert.strictEqual(forcedLunchWithCap.weeks[0].total_worked_hours, 32);
assert.strictEqual(forcedLunchWithCap.weeks[0].forced_lunch_hours, 4);
assert.strictEqual(forcedLunchWithCap.weeks[0].adjusted_total_leave_hours, 8);
assert.strictEqual(forcedLunchWithCap.weeks[0].total_paid_hours, 40);

function capDay(summary, date) {
  return summary.cap_adjusted_days.find(day => day.work_date === date);
}
function assertCapDaysReconcile(summary) {
  assert.strictEqual(summary.cap_adjusted_days.length, 14);
  for (let weekIndex = 0; weekIndex < 2; weekIndex++) {
    const cents = summary.cap_adjusted_days.slice(weekIndex * 7, weekIndex * 7 + 7)
      .reduce((sum, day) => sum + Math.round(day.total_paid_hours * 100), 0);
    assert.strictEqual(cents, Math.round(summary.weeks[weekIndex].total_paid_hours * 100));
    assert(cents <= Math.round(summary.weeks[weekIndex].weekly_hours_cap * 100));
  }
  assert.strictEqual(
    summary.cap_adjusted_days.reduce((sum, day) => sum + Math.round(day.total_paid_hours * 100), 0),
    Math.round(summary.period.total_paid_hours * 100),
  );
}

assert.deepStrictEqual(workedOtOnly.cap_adjusted_days, []);
const lastWorkedDayCap = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  entries: [8, 8, 8, 8, 10].map((hours_worked, offset) => ({
    entry_date_iso: `2026-10-${String(5 + offset).padStart(2, '0')}`, hours_worked,
  })),
});
assert.strictEqual(lastWorkedDayCap.weeks[0].total_worked_hours, 42);
assert.strictEqual(lastWorkedDayCap.weeks[0].overtime_hours, 0);
assert.strictEqual(capDay(lastWorkedDayCap, '2026-10-09').paid_worked_hours, 8);
assert.strictEqual(capDay(lastWorkedDayCap, '2026-10-09').total_paid_hours, 8);
assertCapDaysReconcile(lastWorkedDayCap);

const leavePriorityByDay = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  entries: [{ entry_date_iso: '2026-10-05', hours_worked: 32 }],
  leaveEntries: [
    { leave_date_iso: '2026-10-06', leave_type: 'regular holiday leave', hours: 8, status: 'approved' },
    { leave_date_iso: '2026-10-07', leave_type: 'bereavement', hours: 8, status: 'approved' },
  ],
});
assert.strictEqual(capDay(leavePriorityByDay, '2026-10-06').paid_leave_hours, 8);
assert.strictEqual(capDay(leavePriorityByDay, '2026-10-07').paid_leave_hours, 0);
assertCapDaysReconcile(leavePriorityByDay);

const laterLeaveReduced = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  entries: [{ entry_date_iso: '2026-10-05', hours_worked: 36 }],
  leaveEntries: [
    { leave_date_iso: '2026-10-09', leave_type: 'sick', hours: 2, status: 'approved' },
    { leave_date_iso: '2026-10-10', leave_type: 'sick', hours: 4, status: 'approved' },
  ],
});
assert.strictEqual(capDay(laterLeaveReduced, '2026-10-09').paid_leave_hours, 2);
assert.strictEqual(capDay(laterLeaveReduced, '2026-10-10').paid_leave_hours, 2);
assertCapDaysReconcile(laterLeaveReduced);

const waivedLunchCap = summarizeTimecard({
  payPeriodStart: '2026-10-05', weeklyHoursCap: 40,
  forcedLunchEnabled: true, forcedLunchMinutes: 60,
  entries: [0, 1, 2, 3, 4].map(offset => ({
    entry_date_iso: `2026-10-${String(5 + offset).padStart(2, '0')}`, hours_worked: 9,
  })),
  lunchWaivers: [{ work_date_iso: '2026-10-09', active: true, reason: 'Worked through lunch' }],
});
assert.strictEqual(waivedLunchCap.weeks[0].forced_lunch_hours, 4);
assert.strictEqual(waivedLunchCap.weeks[0].total_worked_hours, 41);
assert.strictEqual(capDay(waivedLunchCap, '2026-10-09').paid_worked_hours, 8);
assertCapDaysReconcile(waivedLunchCap);

assertCapDaysReconcile(weeklyCapDoesNotCrossWeeks);
assertCapDaysReconcile(zeroCap);
assertCapDaysReconcile(exactAndQuarterCap);


const staleOpenPunchDoesNotAccrue = summarizeTimecard({
  payPeriodStart: '2026-10-05',
  asOf: new Date('2026-10-07T12:00:00-04:00'),
  entries: [{
    entry_date_iso: '2026-10-05',
    clock_in: '2026-10-05T08:00:00-04:00',
    clock_out: null,
    hours_worked: 52,
  }],
});
assert.strictEqual(staleOpenPunchDoesNotAccrue.weeks[0].total_worked_hours, 0);
assert.strictEqual(staleOpenPunchDoesNotAccrue.weeks[0].overtime_hours, 0);
assert.strictEqual(staleOpenPunchDoesNotAccrue.weeks[0].total_paid_hours, 0);

function punchSummary({clockIn, clockOut=null, asOf, hoursWorked=100, cap=null, others=[]}) {
  return summarizeTimecard({
    payPeriodStart:'2026-10-05', asOf:new Date(asOf), weeklyHoursCap:cap,
    entries:[{entry_date_iso:'2026-10-05',clock_in:clockIn,clock_out:clockOut,hours_worked:hoursWorked},...others],
  });
}
// Eastern Monday evening is already Tuesday in UTC. It remains a live punch.
const liveEvening=punchSummary({
  clockIn:'2026-10-05T20:00:00-04:00',asOf:'2026-10-05T21:00:00-04:00',
});
assert.strictEqual(liveEvening.weeks[0].total_worked_hours,1);
assert.strictEqual(liveEvening.weeks[0].total_paid_hours,1);
for(const cap of [null,40]) {
  const priorDay=punchSummary({
    clockIn:'2026-10-05T23:00:00-04:00',asOf:'2026-10-06T01:00:00-04:00',cap,
  });
  assert.strictEqual(priorDay.weeks[0].total_worked_hours,0);
  assert.strictEqual(priorDay.weeks[0].total_paid_hours,0);
  const old=punchSummary({
    clockIn:'2026-10-05T00:00:00-04:00',asOf:'2026-10-05T23:00:00-04:00',cap,
  });
  assert.strictEqual(old.weeks[0].total_worked_hours,0);
  assert.strictEqual(old.weeks[0].total_paid_hours,0);
  const alongside=punchSummary({
    clockIn:'2026-10-05T08:00:00-04:00',asOf:'2026-10-07T12:00:00-04:00',cap,
    others:[{entry_date_iso:'2026-10-06',clock_in:'2026-10-06T08:00:00-04:00',clock_out:'2026-10-06T16:00:00-04:00'}],
  });
  assert.strictEqual(alongside.weeks[0].total_worked_hours,8);
  assert.strictEqual(alongside.weeks[0].total_paid_hours,8);
}
const corrected=punchSummary({
  clockIn:'2026-10-05T08:00:00-04:00',clockOut:'2026-10-05T16:00:00-04:00',
  asOf:'2026-10-07T12:00:00-04:00',
});
assert.strictEqual(corrected.weeks[0].total_worked_hours,8);
const pendingCorrection=summarizeTimecard({
  payPeriodStart:'2026-10-05',asOf:new Date('2026-10-07T12:00:00-04:00'),
  entries:[{entry_date_iso:'2026-10-05',clock_in:'2026-10-05T08:00:00-04:00',
    clock_out:null,pending_clock_out:'2026-10-05T16:00:00-04:00',hours_worked:52}],
});
assert.strictEqual(pendingCorrection.weeks[0].total_paid_hours,0);

const easternWeekBoundary=summarizeTimecard({
  payPeriodStart:'2026-10-05',weeklyHoursCap:40,
  forcedLunchEnabled:true,forcedLunchMinutes:60,
  lunchWaivers:[{work_date_iso:'2026-10-11',active:true}],
  entries:[
    {entry_date_iso:'2026-10-11',clock_in:'2026-10-11T20:00:00-04:00',clock_out:'2026-10-12T05:00:00-04:00'},
    {entry_date_iso:'2026-10-12',clock_in:'2026-10-12T08:00:00-04:00',clock_out:'2026-10-12T17:00:00-04:00'},
  ],
});
assert.strictEqual(easternWeekBoundary.days.find(day=>day.work_date==='2026-10-11').total_worked_hours,9);
assert.strictEqual(easternWeekBoundary.days.find(day=>day.work_date==='2026-10-12').forced_lunch_deduction_hours,1);
assert.strictEqual(easternWeekBoundary.weeks[0].total_paid_hours,9);
assert.strictEqual(easternWeekBoundary.weeks[1].total_paid_hours,8);
assertCapDaysReconcile(easternWeekBoundary);


// Effective-dated caps preserve historical payroll even when the employee's
// current-value cache has changed.
const effectiveDatedCap = summarizeTimecard({
  payPeriodStart: '2026-09-28',
  weeklyHoursCap: 32,
  weeklyHoursCapHistory: [
    { effective_date_iso: '2026-09-14', weekly_hours_cap: 40 },
    { effective_date_iso: '2026-10-05', weekly_hours_cap: 32 },
  ],
  entries: [
    { entry_date_iso: '2026-09-28', hours_worked: 36 },
    { entry_date_iso: '2026-09-29', hours_worked: 8 },
    { entry_date_iso: '2026-10-05', hours_worked: 30 },
    { entry_date_iso: '2026-10-06', hours_worked: 8 },
  ],
});
assert.deepStrictEqual(effectiveDatedCap.weekly_hours_caps, [40, 32]);
assert.strictEqual(effectiveDatedCap.weeks[0].weekly_hours_cap, 40);
assert.strictEqual(effectiveDatedCap.weeks[0].total_paid_hours, 40);
assert.strictEqual(effectiveDatedCap.weeks[1].weekly_hours_cap, 32);
assert.strictEqual(effectiveDatedCap.weeks[1].total_paid_hours, 32);
assert.strictEqual(effectiveDatedCap.period.total_paid_hours, 72);

const septemberHistoryIgnoresLaterCurrentValue = summarizeTimecard({
  payPeriodStart: '2026-09-14',
  weeklyHoursCap: 32,
  weeklyHoursCapHistory: [
    { effective_date_iso: '2026-09-14', weekly_hours_cap: 40 },
    { effective_date_iso: '2026-10-05', weekly_hours_cap: 32 },
  ],
  entries: [
    { entry_date_iso: '2026-09-14', hours_worked: 44 },
    { entry_date_iso: '2026-09-21', hours_worked: 44 },
  ],
});
assert.deepStrictEqual(septemberHistoryIgnoresLaterCurrentValue.weekly_hours_caps, [40, 40]);
assert.strictEqual(septemberHistoryIgnoresLaterCurrentValue.period.total_paid_hours, 80);

const effectiveUncappedWeek = summarizeTimecard({
  payPeriodStart: '2026-09-28',
  weeklyHoursCap: null,
  weeklyHoursCapHistory: [
    { effective_date_iso: '2026-09-14', weekly_hours_cap: 40 },
    { effective_date_iso: '2026-10-05', weekly_hours_cap: null },
  ],
  entries: [
    { entry_date_iso: '2026-09-28', hours_worked: 44 },
    { entry_date_iso: '2026-10-05', hours_worked: 42 },
  ],
  leaveEntries: [
    { leave_date_iso: '2026-10-06', leave_type: 'sick', hours: 8, status: 'approved' },
  ],
});
assert.deepStrictEqual(effectiveUncappedWeek.weekly_hours_caps, [40, null]);
assert.strictEqual(effectiveUncappedWeek.weeks[0].total_paid_hours, 40);
assert.strictEqual(effectiveUncappedWeek.weeks[1].total_paid_hours, 50);
assert.strictEqual(effectiveUncappedWeek.weeks[1].overtime_hours, 2);

console.log("timecard summary tests passed");
