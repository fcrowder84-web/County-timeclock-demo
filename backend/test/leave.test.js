'use strict';
const assert = require('assert');
const {
  parseQuarterHours,
  datesBetween,
  assessDailyPaidHours,
  validateFixedHolidayDates,
  validateFloatingHolidayRequest,
  LEAVE_TYPES,
} = require('../routes/leave');
const { getHolidayCalendar, findFixedHoliday, isWorkday } = require('../lib/holiday-calendar');

assert.strictEqual(parseQuarterHours(0.25), 1);
assert.strictEqual(parseQuarterHours(4), 16);
assert.strictEqual(parseQuarterHours(7.75), 31);
assert.throws(() => parseQuarterHours(1.1), /15-minute/);
assert.throws(() => parseQuarterHours(0), /15-minute/);
assert.deepStrictEqual(datesBetween('2026-08-13','2026-08-13'), ['2026-08-13']);
assert.deepStrictEqual(datesBetween('2026-08-14','2026-08-17',true), ['2026-08-14','2026-08-17']);
assert(LEAVE_TYPES.includes('sick') && LEAVE_TYPES.includes('vacation'));
assert(LEAVE_TYPES.includes('holiday') && LEAVE_TYPES.includes('floating_holiday'));

const holidays = getHolidayCalendar(2026);
assert.strictEqual(holidays.length, 12);
assert.strictEqual(findFixedHoliday('2026-11-26').name, 'Thanksgiving');
assert.strictEqual(findFixedHoliday('2026-12-28').name, 'Christmas');
assert.strictEqual(findFixedHoliday('2026-08-17'), null);
assert.strictEqual(isWorkday('2026-08-17'), true);
assert.strictEqual(isWorkday('2026-08-16'), false);
assert.doesNotThrow(() => validateFixedHolidayDates(['2026-01-01','2026-12-28']));
assert.throws(() => validateFixedHolidayDates(['2026-08-17']), /County holiday calendar/);
assert.doesNotThrow(() => validateFloatingHolidayRequest(['2026-08-17'], 32));
assert.throws(() => validateFloatingHolidayRequest(['2026-08-16'], 32), /workday/);
assert.throws(() => validateFloatingHolidayRequest(['2026-08-17'], 16), /8-hour/);
assert.throws(() => validateFloatingHolidayRequest(['2026-08-17','2026-08-18'], 32), /one workday/);

let check = assessDailyPaidHours({ workedQuarterHours: 8, proposedQuarterHours: 24 });
assert.strictEqual(check.total_hours, 8);
assert.strictEqual(check.exceeds_standard_day, false);
assert.strictEqual(check.recommended_leave_hours, 6);
check = assessDailyPaidHours({ workedQuarterHours: 8, proposedQuarterHours: 28 });
assert.strictEqual(check.total_hours, 9);
assert.strictEqual(check.exceeds_standard_day, true);
assert.strictEqual(check.recommended_leave_hours, 6);
check = assessDailyPaidHours({ workedQuarterHours: 16, existingLeaveQuarterHours: 8, proposedQuarterHours: 16 });
assert.strictEqual(check.total_hours, 10);
assert.strictEqual(check.recommended_leave_hours, 2);
console.log('leave tests passed');
