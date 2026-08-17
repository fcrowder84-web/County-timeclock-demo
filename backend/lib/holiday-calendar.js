'use strict';

const FIXED_HOLIDAYS = {
  2026: [
    { date: '2026-01-01', name: "New Year's Day" },
    { date: '2026-01-19', name: 'Martin Luther King, Jr. Day' },
    { date: '2026-04-03', name: 'Good Friday' },
    { date: '2026-05-25', name: 'Memorial Day' },
    { date: '2026-07-03', name: 'Independence Day' },
    { date: '2026-09-07', name: 'Labor Day' },
    { date: '2026-11-11', name: 'Veterans Day' },
    { date: '2026-11-26', name: 'Thanksgiving' },
    { date: '2026-11-27', name: 'Thanksgiving' },
    { date: '2026-12-24', name: 'Christmas' },
    { date: '2026-12-25', name: 'Christmas' },
    { date: '2026-12-28', name: 'Christmas' },
  ],
};

const FLOATING_HOLIDAY_POLICY = {
  days_per_year: 1,
  hours_flexible: true,
  prior_supervisor_approval_required: true,
  any_workday: true,
};

function normalizeDate(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return null;
}

function holidayYear(value) {
  const date = normalizeDate(value);
  return date ? Number(date.slice(0, 4)) : null;
}

function getHolidayCalendar(year) {
  const numericYear = Number(year);
  return (FIXED_HOLIDAYS[numericYear] || []).map((holiday) => ({ ...holiday }));
}

function findFixedHoliday(value) {
  const date = normalizeDate(value);
  if (!date) return null;
  return getHolidayCalendar(holidayYear(date)).find((holiday) => holiday.date === date) || null;
}

function isWorkday(value) {
  const date = normalizeDate(value);
  if (!date) return false;
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

module.exports = {
  FIXED_HOLIDAYS,
  FLOATING_HOLIDAY_POLICY,
  normalizeDate,
  holidayYear,
  getHolidayCalendar,
  findFixedHoliday,
  isWorkday,
};
