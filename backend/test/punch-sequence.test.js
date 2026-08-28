'use strict';

const assert = require('assert');
const { insertPunchIntoSequence } = require('../lib/punch-sequence');

function compact(sql) { return String(sql).replace(/\s+/g, ' ').trim(); }
function iso(value) { return value == null ? null : new Date(value).toISOString(); }

function makeClient(initialEntries = []) {
  let nextId = Math.max(0, ...initialEntries.map((row) => Number(row.id))) + 1;
  const entries = initialEntries.map((row) => ({ ...row }));
  const audits = [];

  return {
    entries,
    audits,
    async query(sql, params = []) {
      const text = compact(sql);
      if (text.includes('FROM time_entries') && text.includes('(clock_in=$2::timestamp OR clock_out=$2::timestamp)')) {
        const [, punchAt] = params;
        return { rows: entries.filter((row) => !row.deleted_at && (iso(row.clock_in) === iso(punchAt) || iso(row.clock_out) === iso(punchAt))).slice(0, 1) };
      }
      if (text.includes('FROM time_entries') && text.includes('clock_in::date=$2::timestamp::date')) {
        const [, punchAt] = params;
        const day = iso(punchAt).slice(0, 10);
        return { rows: entries.filter((row) => !row.deleted_at && iso(row.clock_in).slice(0, 10) === day).sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in)).map((row) => ({ ...row })) };
      }
      if (text.includes('FROM time_change_requests') && text.includes('time_entry_id=ANY')) {
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO time_entry_audit')) {
        audits.push(params);
        return { rows: [] };
      }
      if (text.startsWith('UPDATE time_entries')) {
        const [clockIn, clockOut, id] = params;
        const row = entries.find((item) => Number(item.id) === Number(id));
        assert(row, `time entry ${id} missing`);
        row.clock_in = clockIn;
        row.clock_out = clockOut;
        row.status = clockOut ? 'closed' : 'open';
        return { rows: [{ ...row }] };
      }
      if (text.startsWith('INSERT INTO time_entries')) {
        const [employeeId, clockIn, clockOut, notes] = params;
        const row = { id: nextId++, employee_id: employeeId, clock_in: clockIn, clock_out: clockOut, notes, status: clockOut ? 'closed' : 'open', deleted_at: null };
        entries.push(row);
        return { rows: [{ ...row }] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

(async () => {
  // A mistaken 10:00 open punch plus an approved 8:00 punch is ordered as
  // 8:00 in / 10:00 out. The employee can delete the bad 10:00 first when
  // that is not what actually happened.
  let client = makeClient([
    { id: 1, employee_id: 7, clock_in: '2026-08-12T10:00:00Z', clock_out: null, status: 'open', deleted_at: null },
  ]);
  let result = await insertPunchIntoSequence({
    client,
    employeeId: 7,
    punchAt: '2026-08-12T08:00:00Z',
    actorEmployeeId: 22,
    reason: 'Forgot 8 AM punch',
  });
  assert.strictEqual(result.inferred_punch_type, 'clock_in');
  assert.strictEqual(result.entries.length, 1);
  assert.strictEqual(iso(result.entries[0].clock_in), '2026-08-12T08:00:00.000Z');
  assert.strictEqual(iso(result.entries[0].clock_out), '2026-08-12T10:00:00.000Z');

  // A later punch on an existing open row is placed as its clock out.
  client = makeClient([
    { id: 3, employee_id: 7, clock_in: '2026-08-12T08:00:00Z', clock_out: null, status: 'open', deleted_at: null },
  ]);
  result = await insertPunchIntoSequence({
    client,
    employeeId: 7,
    punchAt: '2026-08-12T17:00:00Z',
    actorEmployeeId: 22,
    reason: 'Forgot 5 PM punch',
  });
  assert.strictEqual(result.inferred_punch_type, 'clock_out');
  assert.strictEqual(iso(result.entries[0].clock_in), '2026-08-12T08:00:00.000Z');
  assert.strictEqual(iso(result.entries[0].clock_out), '2026-08-12T17:00:00.000Z');

  // With no punches on the date, the first approved punch starts an open row.
  client = makeClient([]);
  result = await insertPunchIntoSequence({
    client,
    employeeId: 7,
    punchAt: '2026-08-13T08:00:00Z',
    actorEmployeeId: 22,
    reason: 'Missing punch',
  });
  assert.strictEqual(result.inferred_punch_type, 'clock_in');
  assert.strictEqual(result.entries.length, 1);
  assert.strictEqual(iso(result.entries[0].clock_in), '2026-08-13T08:00:00.000Z');
  assert.strictEqual(result.entries[0].clock_out, null);

  console.log('punch sequence tests: PASS');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
