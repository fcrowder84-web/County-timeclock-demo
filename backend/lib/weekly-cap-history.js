"use strict";

function normalizeCap(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function capsEqual(left, right) {
  return normalizeCap(left) === normalizeCap(right);
}

async function recordWeeklyCapChange(client, {
  employeeId,
  previousCap,
  weeklyHoursCap,
  source = 'portal-sync',
  effectiveDate = null,
}) {
  if (capsEqual(previousCap, weeklyHoursCap)) return false;
  await client.query(
    `INSERT INTO weekly_hours_cap_history(
       employee_id,effective_date,weekly_hours_cap,source
     )
     VALUES($1,COALESCE($2::date,CURRENT_DATE),$3::numeric,$4)
     ON CONFLICT (employee_id,effective_date)
     DO UPDATE SET weekly_hours_cap=EXCLUDED.weekly_hours_cap,
                   source=EXCLUDED.source,
                   created_at=NOW()`,
    [employeeId, effectiveDate, normalizeCap(weeklyHoursCap), source],
  );
  return true;
}

async function fetchWeeklyCapHistory(client, employeeIds, throughDate) {
  const ids = [...new Set((Array.isArray(employeeIds) ? employeeIds : [employeeIds])
    .map(Number).filter(Number.isInteger))];
  if (!ids.length) return new Map();
  const result = await client.query(
    `SELECT employee_id,
            to_char(effective_date,'YYYY-MM-DD') AS effective_date_iso,
            weekly_hours_cap
       FROM weekly_hours_cap_history
      WHERE employee_id=ANY($1::int[])
        AND effective_date <= $2::date
      ORDER BY employee_id,effective_date,id`,
    [ids, throughDate],
  );
  const grouped = new Map();
  for (const row of result.rows) {
    const id = Number(row.employee_id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  return grouped;
}

module.exports = {
  capsEqual,
  fetchWeeklyCapHistory,
  normalizeCap,
  recordWeeklyCapChange,
};
