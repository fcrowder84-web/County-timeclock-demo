'use strict';

const fs = require('fs');
const path = require('path');

function replaceOnce(source, oldText, newText, label) {
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`${label} anchor not found`);
  if (source.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error(`${label} anchor is ambiguous`);
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

function removeBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`${label} start marker not found`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`${label} end marker not found`);
  return source.slice(0, start) + source.slice(end);
}

function ensureSafeScript(source, anchor) {
  if (source.includes('src="/safe-html.js"')) return source;
  return replaceOnce(source, anchor, `    <script src="/safe-html.js"></script>\n${anchor}`, 'safe-html script');
}

function ensureEscConstant(source, anchor) {
  if (source.includes('const esc = SafeHtml.escape;') || source.includes('const esc=SafeHtml.escape;')) return source;
  return replaceOnce(source, anchor, `${anchor}\n        const esc = SafeHtml.escape;`, 'escape helper');
}

function hardenEmployee(source) {
  let out = ensureSafeScript(source, '    <script src="/timecard-summary-ui.js"></script>');
  out = ensureEscConstant(out, '        const apiBase = "/api";');
  const replacements = [
    ['${currentUser.first_name} ${currentUser.last_name}', '${esc(currentUser.first_name)} ${esc(currentUser.last_name)}'],
    ['${currentUser.department_name || currentUser.department || "-"}', '${esc(currentUser.department_name || currentUser.department || "-")}'],
    ['<td><span class="leave-badge">Leave · ${leaveType}</span></td>', '<td><span class="leave-badge">Leave · ${esc(leaveType)}</span></td>'],
    ['<td><span class="status-pill ${statusClass}">${entry.status}</span></td>', '<td><span class="status-pill ${statusClass}">${esc(entry.status)}</span></td>'],
    ['<td>${entry.note || "-"}</td>', '<td>${esc(entry.note || "-")}</td>'],
    ['${request.employee_reason}', '${esc(request.employee_reason)}'],
    ['${request.supervisor_note || "-"}', '${esc(request.supervisor_note || "-")}'],
  ];
  for (const [oldText, newText] of replacements) {
    out = replaceOnce(out, oldText, newText, `employee ${oldText}`);
  }
  return out;
}

function hardenSupervisor(source) {
  let out = ensureSafeScript(source, '    <script src="/timecard-summary-ui.js"></script>');
  out = ensureEscConstant(out, '        const apiBase = "/api";');

  const replacements = [
    ['${currentUser.first_name}\n                    ${currentUser.last_name}', '${esc(currentUser.first_name)}\n                    ${esc(currentUser.last_name)}'],
    ['${currentUser.department_name || currentUser.department || "-"}', '${esc(currentUser.department_name || currentUser.department || "-")}'],
    ['${row.first_name}\n                            ${row.last_name}', '${esc(row.first_name)}\n                            ${esc(row.last_name)}'],
    ['${row.department || "-"}', '${esc(row.department || "-")}'],
    ['${request.first_name}\n                                ${request.last_name}', '${esc(request.first_name)}\n                                ${esc(request.last_name)}'],
    ['${request.department || "-"}', '${esc(request.department || "-")}'],
    ['${request.employee_reason}', '${esc(request.employee_reason)}'],
    ['${data.employee.department || "-"}', '${esc(data.employee.department || "-")}'],
    ['<td>${entry.status}</td>', '<td>${esc(entry.status)}</td>'],
    ['<td>${entry.note || "-"}</td>', '<td>${esc(entry.note || "-")}</td>'],
    ['${request.supervisor_note || "-"}', '${esc(request.supervisor_note || "-")}'],
    ['${item.changed_by_first_name || ""}\n                                ${item.changed_by_last_name || ""}', '${esc(item.changed_by_first_name || "")}\n                                ${esc(item.changed_by_last_name || "")}'],
    ['${item.reason || "-"}', '${esc(item.reason || "-")}'],
    ['return `${person.first_name} ${person.last_name}`;', 'return `${esc(person.first_name)} ${esc(person.last_name)}`;'],
    ['<h2>${department.name}</h2>', '<h2>${esc(department.name)}</h2>'],
    ['${department.department_head_first_name ? `${department.department_head_first_name} ${department.department_head_last_name}` : "Not assigned"}', '${department.department_head_first_name ? `${esc(department.department_head_first_name)} ${esc(department.department_head_last_name)}` : "Not assigned"}'],
    ['${item.employee_first_name} ${item.employee_last_name}', '${esc(item.employee_first_name)} ${esc(item.employee_last_name)}'],
  ];
  for (const [oldText, newText] of replacements) {
    if (out.includes(oldText)) out = replaceOnce(out, oldText, newText, `supervisor ${oldText}`);
  }

  if (out.includes('            async function createStaff() {')) {
    out = removeBetween(out, '            async function createStaff() {', '            async function resetPin(employeeId) {', 'legacy createStaff');
  }
  if (out.includes('            async function deactivateStaff(employeeId) {')) {
    out = removeBetween(out, '            async function deactivateStaff(employeeId) {', '            async function reactivateStaff(employeeId) {', 'legacy deactivateStaff');
  }
  if (out.includes('            async function reactivateStaff(employeeId) {')) {
    out = removeBetween(out, '            async function reactivateStaff(employeeId) {', '        checkExistingLogin();', 'legacy reactivateStaff');
  }
  return out;
}

function hardenPayroll(source) {
  let out = ensureSafeScript(source, '    <script src="/timecard-summary-ui.js"></script>');
  out = ensureEscConstant(out, '        const apiBase = "/api";');
  const replacements = [
    ['${row.last_name}, ${row.first_name} - ${row.department || "Unassigned"}', '${esc(row.last_name)}, ${esc(row.first_name)} - ${esc(row.department || "Unassigned")}'],
    ['${currentUser.first_name} ${currentUser.last_name}', '${esc(currentUser.first_name)} ${esc(currentUser.last_name)}'],
    ['${currentUser.role}', '${esc(currentUser.role)}'],
    ['${currentUser.department_name || currentUser.department || "-"}', '${esc(currentUser.department_name || currentUser.department || "-")}'],
    ['<h3 class="department-header">${department}</h3>', '<h3 class="department-header">${esc(department)}</h3>'],
    ['${row.first_name} ${row.last_name}', '${esc(row.first_name)} ${esc(row.last_name)}'],
    ['${row.role || "employee"}', '${esc(row.role || "employee")}'],
    ['${data.employee.department || "-"}', '${esc(data.employee.department || "-")}'],
    ['<td>${request.employee_reason}</td>', '<td>${esc(request.employee_reason)}</td>'],
    ['<td>${request.supervisor_note || "-"}</td>', '<td>${esc(request.supervisor_note || "-")}</td>'],
  ];
  for (const [oldText, newText] of replacements) {
    out = replaceOnce(out, oldText, newText, `payroll ${oldText}`);
  }
  return out;
}

function hardenPrintablePayroll(source) {
  let out = ensureSafeScript(source, '    <script>');
  out = ensureEscConstant(out, '        const apiBase = "/api";');
  const replacements = [
    ['${employee.first_name}\n                                ${employee.last_name}', '${esc(employee.first_name)}\n                                ${esc(employee.last_name)}'],
    ['${employee.employee_number}', '${esc(employee.employee_number)}'],
    ['${employee.department || "-"}', '${esc(employee.department || "-")}'],
    ['${employee.approval_status || "pending"}', '${esc(employee.approval_status || "pending")}'],
  ];
  for (const [oldText, newText] of replacements) {
    out = replaceOnce(out, oldText, newText, `print payroll ${oldText}`);
  }
  return out;
}

function hardenLeave(source) {
  let out = ensureSafeScript(source, '<script>');
  if (!out.includes("const esc=SafeHtml.escape;")) {
    out = replaceOnce(out, "const api='\\/api', token=()=>localStorage.getItem('timeclock_token');", "const api='\\/api', token=()=>localStorage.getItem('timeclock_token');\nconst esc=SafeHtml.escape;", 'leave escape helper');
  }
  const replacements = [
    ["'<div class=\"holiday-item\"><strong>'+x.name+'</strong><br>'+formatHolidayDate(x.date)+'</div>'", "'<div class=\"holiday-item\"><strong>'+esc(x.name)+'</strong><br>'+formatHolidayDate(x.date)+'</div>'"],
    ["'<option value=\"'+me.id+'\">'+me.first_name+' '+me.last_name+' (myself)</option>'", "'<option value=\"'+me.id+'\">'+esc(me.first_name)+' '+esc(me.last_name)+' (myself)</option>'"],
    ["'<option value=\"'+x.id+'\">'+x.last_name+', '+x.first_name+' · '+(x.department_name||x.department||'')+'</option>'", "'<option value=\"'+x.id+'\">'+esc(x.last_name)+', '+esc(x.first_name)+' · '+esc(x.department_name||x.department||'')+'</option>'"],
    ["+'<td>'+x.created_by_first_name+' '+x.created_by_last_name+'</td><td>'+(x.note||'')+'</td>'", "+'<td>'+esc(x.created_by_first_name)+' '+esc(x.created_by_last_name)+'</td><td>'+esc(x.note||'')+'</td>'"],
  ];
  for (const [oldText, newText] of replacements) {
    out = replaceOnce(out, oldText, newText, `leave ${oldText}`);
  }
  return out;
}

function hardenPunches(source) {
  let out = ensureSafeScript(source, '<script>');
  if (!out.includes("const esc=SafeHtml.escape;")) {
    out = replaceOnce(out, "  const apiBase='/api';", "  const apiBase='/api';\n  const esc=SafeHtml.escape;", 'punches escape helper');
  }
  out = replaceOnce(
    out,
    '${entry.clock_in_display||\'-\'}</td><td data-label="Clock Out">${entry.clock_out_display||\'OPEN\'}</td><td data-label="Hours">${Number(entry.hours_worked||0).toFixed(2)}</td><td data-label="Status">${entry.status||\'-\'}',
    '${esc(entry.clock_in_display||\'-\')}</td><td data-label="Clock Out">${esc(entry.clock_out_display||\'OPEN\')}</td><td data-label="Hours">${Number(entry.hours_worked||0).toFixed(2)}</td><td data-label="Status">${esc(entry.status||\'-\')}',
    'punch row values',
  );
  return out;
}

const transforms = new Map([
  ['employee.html', hardenEmployee],
  ['supervisor.html', hardenSupervisor],
  ['payroll.html', hardenPayroll],
  ['payroll-timecards.html', hardenPrintablePayroll],
  ['leave.html', hardenLeave],
  ['punches.html', hardenPunches],
]);

function transformFrontend(frontendDir) {
  const results = [];
  for (const [filename, transform] of transforms) {
    const fullPath = path.join(frontendDir, filename);
    const original = fs.readFileSync(fullPath, 'utf8');
    const hardened = transform(original);
    if (!hardened.includes('safe-html.js')) throw new Error(`${filename} did not load safe-html.js`);
    fs.writeFileSync(fullPath, hardened, 'utf8');
    results.push({ filename, changed: hardened !== original });
  }
  return results;
}

if (require.main === module) {
  const frontendDir = path.resolve(__dirname, '..', '..', 'frontend');
  const results = transformFrontend(frontendDir);
  for (const result of results) console.log(`${result.changed ? 'HARDEN' : 'SKIP  '} ${result.filename}`);
}

module.exports = {
  hardenEmployee,
  hardenSupervisor,
  hardenPayroll,
  hardenPrintablePayroll,
  hardenLeave,
  hardenPunches,
  transformFrontend,
};
