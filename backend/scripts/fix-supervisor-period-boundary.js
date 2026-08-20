'use strict';

const fs = require('fs');
const path = require('path');

const oldBlock = `          const periodStart = new Date(\`${'${'}String(approval.pay_period_start).slice(0,10)}T00:00:00\`);
          const periodEnd = new Date(\`${'${'}String(approval.pay_period_end).slice(0,10)}T23:59:59.999\`);
          if (parsedIn < periodStart || parsedIn > periodEnd) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Supervisor edits cannot move an entry to a different pay period; payroll must make that correction.' });
          }`;

const newBlock = `          const periodBoundary = await client.query(
            \`SELECT ($1::timestamp >= $2::date AND $1::timestamp < ($3::date + INTERVAL '1 day')) AS in_period\`,
            [newClockIn, approval.pay_period_start, approval.pay_period_end],
          );
          if (!periodBoundary.rows[0]?.in_period) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Supervisor edits cannot move an entry to a different pay period; payroll must make that correction.' });
          }`;

function transform(source) {
  if (source.includes('const periodBoundary = await client.query(')) return source;
  const index = source.indexOf(oldBlock);
  if (index < 0) throw new Error('Supervisor pay-period boundary block not found');
  if (source.indexOf(oldBlock, index + oldBlock.length) !== -1) {
    throw new Error('Supervisor pay-period boundary block is ambiguous');
  }
  return source.slice(0, index) + newBlock + source.slice(index + oldBlock.length);
}

if (require.main === module) {
  const file = path.resolve(__dirname, '..', 'routes', 'supervisor.js');
  const source = fs.readFileSync(file, 'utf8');
  const updated = transform(source);
  fs.writeFileSync(file, updated, 'utf8');
  console.log(updated === source ? 'Supervisor pay-period boundary already hardened.' : 'Supervisor pay-period boundary moved to PostgreSQL comparison.');
}

module.exports = { transform };
