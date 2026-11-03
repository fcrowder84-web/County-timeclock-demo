'use strict';

async function fetchWeeklyExtraHours(db, employeeIds, payPeriodStart) {
  const ids = [...new Set((employeeIds || []).map(Number).filter(Number.isInteger))];
  const result = new Map(ids.map(id => [id, [0, 0]]));
  if (!ids.length) return result;
  const rows = await db.query(
    `SELECT employee_id, week_number, extra_hours
       FROM weekly_cap_extra_hours
      WHERE employee_id = ANY($1::int[])
        AND pay_period_start = $2::date`,
    [ids, payPeriodStart],
  );
  for (const row of rows.rows) {
    const week = Number(row.week_number);
    if (week === 1 || week === 2) result.get(Number(row.employee_id))[week - 1] = Number(row.extra_hours);
  }
  return result;
}

module.exports = { fetchWeeklyExtraHours };
