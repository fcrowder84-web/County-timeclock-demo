'use strict';

const fs = require('fs');
const path = require('path');

function transformServer(source) {
  const importAnchor = 'const { createQuickPunchRouter } = require("./routes/quick-punch");';
  const employeeImport = 'const { createEmployeeRouter } = require("./routes/employee");';
  const blockStart = 'app.post(\n  "/submit-timecard",';
  const blockEnd = 'app.get(\n  "/supervisor/pay-period-status",';

  if (!source.includes(importAnchor)) throw new Error('quick-punch import anchor not found');
  if (source.includes(employeeImport)) throw new Error('employee router import already present');

  const start = source.indexOf(blockStart);
  const end = source.indexOf(blockEnd);
  if (start < 0) throw new Error('employee route block start not found');
  if (end < 0 || end <= start) throw new Error('supervisor route boundary not found after employee routes');
  if (source.indexOf(blockStart, start + 1) !== -1) throw new Error('employee route block start is ambiguous');

  const mounted = `app.use(createEmployeeRouter({\n  requireUser,\n  requireAnyPermission,\n  pool,\n  audit,\n  getRequestedPayPeriod,\n}));\n\n`;

  const withImport = source.replace(importAnchor, `${importAnchor}\n${employeeImport}`);
  const adjustedStart = withImport.indexOf(blockStart);
  const adjustedEnd = withImport.indexOf(blockEnd);
  return withImport.slice(0, adjustedStart) + mounted + withImport.slice(adjustedEnd);
}

if (require.main === module) {
  const serverPath = path.resolve(__dirname, '..', 'server.js');
  const source = fs.readFileSync(serverPath, 'utf8');
  const transformed = transformServer(source);
  const backupPath = `${serverPath}.pre-employee-router`;
  if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, source, 'utf8');
  fs.writeFileSync(serverPath, transformed, 'utf8');
  console.log(`Employee routes extracted from server.js; backup: ${backupPath}`);
}

module.exports = { transformServer };
