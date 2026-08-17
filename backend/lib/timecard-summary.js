"use strict";

const OVERTIME_THRESHOLD_MINUTES = 40 * 60;

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function diffDays(start, value) {
  const a = new Date(`${start}T12:00:00Z`);
  const b = new Date(`${value}T12:00:00Z`);
  return Math.floor((b - a) / 86400000);
}

function durationMinutes(hours) {
  return Math.max(0, Math.round(number(hours) * 60));
}

function roundDailyMinutes(minutes) {
  const safe = Math.max(0, Math.round(number(minutes)));
  const completedQuarters = Math.floor(safe / 15) * 15;
  return completedQuarters + (safe % 15 > 5 ? 15 : 0);
}

function emptyWeek(weekNumber, start) {
  return {
    week_number: weekNumber,
    start_date: start,
    end_date: addDays(start, 6),
    regular_worked_hours: 0,
    overtime_hours: 0,
    total_worked_hours: 0,
    leave_hours_by_type: {},
    pending_leave_hours_by_type: {},
    total_leave_hours: 0,
    pending_leave_hours: 0,
    total_paid_hours: 0,
  };
}

function addByType(target, type, hours) {
  const key = String(type || 'other').trim().toLowerCase() || 'other';
  target[key] = round2(number(target[key]) + number(hours));
}

function summarizeTimecard({ entries = [], leaveEntries = [], payPeriodStart, overtimeThresholdHours = 40 }) {
  const start = dateOnly(payPeriodStart);
  if (!start) throw new Error('payPeriodStart is required');

  const thresholdMinutes = Math.max(0, Math.round(number(overtimeThresholdHours) * 60)) || OVERTIME_THRESHOLD_MINUTES;
  const weeks = [emptyWeek(1, start), emptyWeek(2, addDays(start, 7))];
  const dailyMinutes = new Map();

  for (const entry of entries) {
    const day = dateOnly(entry.entry_date_iso || entry.work_date || entry.clock_in);
    if (!day) continue;
    const offset = diffDays(start, day);
    if (offset < 0 || offset > 13) continue;
    dailyMinutes.set(day, (dailyMinutes.get(day) || 0) + durationMinutes(entry.hours_worked));
  }

  for (const [day, minutes] of dailyMinutes.entries()) {
    const weekIndex = diffDays(start, day) < 7 ? 0 : 1;
    weeks[weekIndex].total_worked_hours = round2(
      weeks[weekIndex].total_worked_hours + roundDailyMinutes(minutes) / 60,
    );
  }

  for (const leave of leaveEntries) {
    const day = dateOnly(leave.leave_date_iso || leave.leave_date || leave.work_date);
    if (!day) continue;
    const offset = diffDays(start, day);
    if (offset < 0 || offset > 13) continue;
    const week = weeks[offset < 7 ? 0 : 1];
    const hours = number(leave.hours ?? (number(leave.quarter_hours) / 4));
    if (leave.status === 'approved') {
      addByType(week.leave_hours_by_type, leave.leave_type, hours);
      week.total_leave_hours = round2(week.total_leave_hours + hours);
    } else if (leave.status === 'pending') {
      addByType(week.pending_leave_hours_by_type, leave.leave_type, hours);
      week.pending_leave_hours = round2(week.pending_leave_hours + hours);
    }
  }

  for (const week of weeks) {
    const workedMinutes = Math.round(week.total_worked_hours * 60);
    const overtimeMinutes = Math.max(0, workedMinutes - thresholdMinutes);
    week.overtime_hours = round2(overtimeMinutes / 60);
    week.regular_worked_hours = round2((workedMinutes - overtimeMinutes) / 60);
    week.total_paid_hours = round2(week.total_worked_hours + week.total_leave_hours);
  }

  const period = {
    regular_worked_hours: 0,
    overtime_hours: 0,
    total_worked_hours: 0,
    leave_hours_by_type: {},
    pending_leave_hours_by_type: {},
    total_leave_hours: 0,
    pending_leave_hours: 0,
    total_paid_hours: 0,
  };

  for (const week of weeks) {
    for (const key of ['regular_worked_hours','overtime_hours','total_worked_hours','total_leave_hours','pending_leave_hours','total_paid_hours']) {
      period[key] = round2(period[key] + week[key]);
    }
    for (const [type, hours] of Object.entries(week.leave_hours_by_type)) addByType(period.leave_hours_by_type, type, hours);
    for (const [type, hours] of Object.entries(week.pending_leave_hours_by_type)) addByType(period.pending_leave_hours_by_type, type, hours);
  }

  return {
    overtime_rule: 'weekly_worked_hours_over_40_only',
    overtime_threshold_hours: round2(thresholdMinutes / 60),
    weeks,
    period,
  };
}

module.exports = { summarizeTimecard, roundDailyMinutes };
