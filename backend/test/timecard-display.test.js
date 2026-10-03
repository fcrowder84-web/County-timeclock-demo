'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { summarizeTimecard } = require('../lib/timecard-summary');

const frontend = path.resolve(__dirname, '..', '..', 'frontend');
const base = fs.readFileSync(path.join(frontend, 'timecard-base.js'), 'utf8');
const actions = fs.readFileSync(path.join(frontend, 'timecard-actions.js'), 'utf8');
const html = fs.readFileSync(path.join(frontend, 'timecard.html'), 'utf8');
const helpers = vm.runInNewContext(
  base.slice(base.indexOf('function allocateDailyWork('), base.indexOf('function punchCells(')) +
  base.slice(base.indexOf('function totalRow(')) +
  ';({allocateDailyWork,capAdjustedDaily,capAdjustedDisplay,totalRow})',
  {
    num: value => Number(value || 0),
    dateOnly: value => String(value).slice(0, 10),
    fmt: value => Number(value || 0) ? Number(value).toFixed(2) : '',
    esc: value => String(value),
    otherTotal: map => Object.entries(map || {}).filter(([type]) => !['holiday', 'vacation', 'sick', 'floating_holiday'].includes(type)).reduce((sum, [, hours]) => sum + Number(hours), 0),
  },
);

const dates = Array.from({ length: 14 }, (_, offset) => `2026-10-${String(5 + offset).padStart(2, '0')}`);
const entries = [8, 8, 8, 8, 10].map((hours_worked, offset) => ({ entry_date_iso: dates[offset], hours_worked }));
const uncapped = summarizeTimecard({ payPeriodStart: dates[0], entries });
const capped = summarizeTimecard({ payPeriodStart: dates[0], entries, weeklyHoursCap: 40 });
const days = dates.map(date => ({ date, worked: Number(capped.days.find(day => day.work_date === date)?.total_worked_hours || 0) }));

const normal = helpers.allocateDailyWork(days, false);
assert.strictEqual(normal[dates[4]].regular, 8);
assert.strictEqual(normal[dates[4]].ot, 2);
const customThreshold = helpers.allocateDailyWork(days, false, 38);
assert.strictEqual(customThreshold[dates[4]].regular, 6);
assert.strictEqual(customThreshold[dates[4]].ot, 4);
assert.strictEqual(uncapped.weeks[0].overtime_hours, 2);
assert.strictEqual(helpers.capAdjustedDaily(uncapped)[dates[4]], undefined);

const capWork = helpers.allocateDailyWork(days, true);
assert.strictEqual(capWork[dates[4]].regular, 10);
assert.strictEqual(capWork[dates[4]].ot, 0);
const payable = helpers.capAdjustedDaily(capped);
assert.strictEqual(payable[dates[4]].hours, 8);
assert.strictEqual(dates.slice(0, 7).reduce((sum, date) => sum + Math.round((payable[date]?.hours || 0) * 100), 0), 4000);

function columnCount(markup, cellTag) {
  return [...markup.matchAll(new RegExp(`<${cellTag}\\b([^>]*)>`, 'g'))]
    .reduce((sum, [, attributes]) => sum + Number(attributes.match(/colspan="(\d+)"/)?.[1] || 1), 0);
}

const header = html.match(/<thead><tr>(.*?)<\/tr><\/thead>/s)?.[1];
assert(header);
assert.strictEqual(columnCount(header, 'th'), 15);
assert(header.includes('<th>Total</th><th>Cap Adj</th>'));
for (const [summary, isCapped, expectedTotal, expectedCap] of [
  [uncapped.weeks[0], false, '42.00', ''],
  [capped.weeks[0], true, '42.00', '40.00'],
  [capped.period, true, '42.00', '40.00'],
]) {
  const row = helpers.totalRow('Total', summary, 'week-total', isCapped);
  assert.strictEqual(columnCount(row, 'td'), 15);
  assert(row.endsWith(`<td>42.00</td><td><strong>${expectedCap}</strong></td></tr>`));
  assert(row.includes(`<td>${expectedTotal}</td>`));
}

function renderedRows(summary, workEntries, leaveEntries = []) {
  const elements = {};
  const context = {
    currentData: {
      employee: { id: 1 }, entries: workEntries, leave_entries: leaveEntries,
      pay_period_start: dates[0], pay_period_end: dates[13], timecard_summary: summary,
    },
    currentUser: { id: 1 }, selectedPeriodStart: dates[0], currentMode: 'employee',
    document: { getElementById: id => elements[id] ||= {} },
    dateOnly: value => String(value).slice(0, 10),
    addDays: (date, count) => new Date(Date.parse(`${date}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10),
    num: value => Number(value || 0),
    fmt: value => Number(value || 0) ? Number(value).toFixed(2) : '',
    esc: value => String(value),
    allocateDailyWork: helpers.allocateDailyWork,
    capAdjustedDaily: helpers.capAdjustedDaily,
    capAdjustedDisplay: helpers.capAdjustedDisplay,
    dailyWorked: dayEntries => dayEntries.reduce((sum, entry) => sum + Number(entry.hours_worked), 0),
    approvedLeaveHours: (date, type) => leaveEntries.filter(entry => entry.leave_date_iso === date && entry.status === 'approved' &&
      (type === 'other' ? !['holiday', 'vacation', 'sick', 'floating_holiday'].includes(entry.leave_type) : entry.leave_type === type))
      .reduce((sum, entry) => sum + Number(entry.hours), 0),
    punchCells: () => '<td></td>'.repeat(4), leaveCell: () => '<td></td>',
    lunchStatusHtml: () => '', dayName: () => 'Mon', localDateLabel: value => value,
    has: () => false, selectedIsSelf: () => true, canAddEntries: () => false,
    punchSvg: '', leaveSvg: '', totalRow: helpers.totalRow,
    statusLabel: () => 'In Progress', payrollView: () => false,
    renderSignatures: () => {}, renderDenied: () => {}, renderPending: () => {},
    bindRowActions: () => {}, syncNavButtons: () => {},
  };
  const source = actions.slice(actions.indexOf('function renderTimecard(){'), actions.indexOf('function statusLabel('));
  vm.runInNewContext(`${source};renderTimecard()`, context);
  return [...elements.timeRows.innerHTML.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gs)].map(([, row]) => row);
}

for (const [summary, workEntries, leaveEntries, expectedDailyTotal, expectedDailyCap] of [
  [uncapped, entries, [], '10.00', ''],
  [capped, entries, [], '10.00', '8.00'],
]) {
  const rows = renderedRows(summary, workEntries, leaveEntries);
  assert.strictEqual(rows.length, 17);
  for (const row of rows) assert.strictEqual(columnCount(row, 'td'), 15);
  assert(rows[4].endsWith(`<td><strong>${expectedDailyTotal}</strong></td><td><strong>${expectedDailyCap}</strong></td>`));
}

const sickLeave = [{ leave_date_iso: dates[4], leave_type: 'sick', hours: 8, status: 'approved' }];
const workWithLeave = [{ entry_date_iso: dates[0], hours_worked: 36 }];
const cappedWithLeave = summarizeTimecard({
  payPeriodStart: dates[0], weeklyHoursCap: 40, entries: workWithLeave, leaveEntries: sickLeave,
});
const leaveRows = renderedRows(cappedWithLeave, workWithLeave, sickLeave);
assert(leaveRows[4].endsWith('<td><strong>8.00</strong></td><td><strong>4.00 Sick</strong></td>'));
assert(leaveRows[7].endsWith('<td>44.00</td><td><strong>40.00</strong></td>'));

console.log('timecard display tests passed');
