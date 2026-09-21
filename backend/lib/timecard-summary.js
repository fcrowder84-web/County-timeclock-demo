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

function timestampMs(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  const ms = parsed.getTime();
  return Number.isNaN(ms) ? null : ms;
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
    forced_lunch_deducted_hours: 0,
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

function summarizeTimecard({
  entries = [],
  leaveEntries = [],
  payPeriodStart,
  overtimeThresholdHours = 40,
  forcedLunchMinutes = 0,
  lunchWaivers = [],
}) {
  const start = dateOnly(payPeriodStart);
  if (!start) throw new Error('payPeriodStart is required');

  const thresholdMinutes = Math.max(0, Math.round(number(overtimeThresholdHours) * 60)) || OVERTIME_THRESHOLD_MINUTES;
  const configuredLunchMinutes = Math.max(0, Math.round(number(forcedLunchMinutes)));
  const waiverDays = new Set(
    (lunchWaivers || [])
      .map(item => dateOnly(item.work_date_iso || item.work_date))
      .filter(Boolean),
  );
  const weeks = [emptyWeek(1, start), emptyWeek(2, addDays(start, 7))];
  const rawDaily = new Map();
  const daily = {};

  for (const entry of entries) {
    const day = dateOnly(entry.entry_date_iso || entry.work_date || entry.clock_in);
    if (!day) continue;
    const offset = diffDays(start, day);
    if (offset < 0 || offset > 13) continue;

    const minutes = durationMinutes(entry.hours_worked);
    const state = rawDaily.get(day) || {
      workedMinutes: 0,
      firstClockInMs: null,
      lastClockOutMs: null,
    };
    state.workedMinutes += minutes;

    const inMs = timestampMs(entry.clock_in || entry.pending_clock_in);
    let outMs = timestampMs(entry.clock_out || entry.pending_clock_out);
    if (inMs != null && outMs == null && minutes > 0) outMs = inMs + minutes * 60000;

    if (inMs != null && (state.firstClockInMs == null || inMs < state.firstClockInMs)) state.firstClockInMs = inMs;
    if (outMs != null && (state.lastClockOutMs == null || outMs > state.lastClockOutMs)) state.lastClockOutMs = outMs;
    rawDaily.set(day, state);
  }

  for (const [day, state] of rawDaily.entries()) {
    const roundedWorkedMinutes = roundDailyMinutes(state.workedMinutes);
    let spanMinutes = state.workedMinutes;
    if (state.firstClockInMs != null && state.lastClockOutMs != null && state.lastClockOutMs >= state.firstClockInMs) {
      spanMinutes = Math.max(spanMinutes, Math.round((state.lastClockOutMs - state.firstClockInMs) / 60000));
    }

    const recordedBreakMinutes = Math.max(0, spanMinutes - state.workedMinutes);
    const waived = waiverDays.has(day);
    const requiredLunchMinutes = roundedWorkedMinutes > 0 ? configuredLunchMinutes : 0;
    const deductionMinutes = waived
      ? 0
      : Math.min(
          roundedWorkedMinutes,
          Math.max(0, requiredLunchMinutes - recordedBreakMinutes),
        );
    const creditedWorkedMinutes = Math.max(0, roundedWorkedMinutes - deductionMinutes);

    daily[day] = {
      date: day,
      raw_worked_hours: round2(roundedWorkedMinutes / 60),
      recorded_break_hours: round2(recordedBreakMinutes / 60),
      forced_lunch_required_hours: round2(requiredLunchMinutes / 60),
      forced_lunch_deducted_hours: round2(deductionMinutes / 60),
      forced_lunch_waived: waived,
      credited_worked_hours: round2(creditedWorkedMinutes / 60),
    };

    const weekIndex = diffDays(start, day) < 7 ? 0 : 1;
    weeks[weekIndex].total_worked_hours = round2(
      weeks[weekIndex].total_worked_hours + creditedWorkedMinutes / 60,
    );
    weeks[weekIndex].forced_lunch_deducted_hours = round2(
      weeks[weekIndex].forced_lunch_deducted_hours + deductionMinutes / 60,
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
    forced_lunch_deducted_hours: 0,
    leave_hours_by_type: {},
    pending_leave_hours_by_type: {},
    total_leave_hours: 0,
    pending_leave_hours: 0,
    total_paid_hours: 0,
  };

  for (const week of weeks) {
    for (const key of [
      'regular_worked_hours',
      'overtime_hours',
      'total_worked_hours',
      'forced_lunch_deducted_hours',
      'total_leave_hours',
      'pending_leave_hours',
      'total_paid_hours',
    ]) {
      period[key] = round2(period[key] + week[key]);
    }
    for (const [type, hours] of Object.entries(week.leave_hours_by_type)) addByType(period.leave_hours_by_type, type, hours);
    for (const [type, hours] of Object.entries(week.pending_leave_hours_by_type)) addByType(period.pending_leave_hours_by_type, type, hours);
  }

  return {
    overtime_rule: 'weekly_worked_hours_over_40_only',
    overtime_threshold_hours: round2(thresholdMinutes / 60),
    forced_lunch_minutes: configuredLunchMinutes,
    daily,
    weeks,
    period,
  };
}

module.exports = { summarizeTimecard, roundDailyMinutes };
