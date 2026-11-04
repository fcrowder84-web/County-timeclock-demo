"use strict";

// The timecard has 15 existing columns. Extra hours use their own summary
// rows instead of adding a sixteenth column to every day.
function weeklyExtraValue(week, index) {
  const cell = document.createElement("td");
  cell.className = "weekly-extra-value";
  const value = Number(week?.cap_extra_hours || 0);
  if (week?.weekly_hours_cap == null) {
    cell.textContent = "—";
  } else if (currentMode === "supervisor" && currentData?.can_edit_weekly_extra) {
    const input = document.createElement("input");
    input.className = "weekly-extra-input";
    input.type = "number";
    input.step = "0.01";
    input.min = "0";
    input.max = Number(week.max_cap_extra_hours || 0).toFixed(2);
    input.value = value.toFixed(2);
    input.dataset.week = String(index + 1);
    input.setAttribute("aria-label", "Week " + (index + 1) + " approved extra hours");
    input.title = "Maximum worked hours removed by cap: " + input.max;
    cell.appendChild(input);
  } else {
    const display = document.createElement("span");
    display.className = "weekly-extra-display";
    display.textContent = value.toFixed(2);
    cell.appendChild(display);
  }
  return cell;
}

function extraHoursSummaryRow(label, valueCell, className) {
  const row = document.createElement("tr");
  row.className = "weekly-extra-row " + className;
  const labelCell = document.createElement("td");
  labelCell.colSpan = 14; // Day, four punches, and nine totals before Cap Adj.
  labelCell.className = "weekly-extra-label";
  labelCell.textContent = label;
  row.append(labelCell, valueCell);
  return row;
}

const originalRenderTimecard = renderTimecard;
renderTimecard = function renderTimecardWithExtraRows() {
  originalRenderTimecard();
  const summary = currentData?.timecard_summary || {};
  const rows = [...document.querySelectorAll("#timeRows tr")];
  let weekIndex = 0;
  for (const row of rows) {
    if (row.classList.contains("week-total")) {
      const week = summary.weeks?.[weekIndex];
      row.before(extraHoursSummaryRow(
        "Approved Extra Hours",
        weeklyExtraValue(week, weekIndex),
        "weekly-extra-week",
      ));
      weekIndex++;
    } else if (row.classList.contains("period-total")) {
      const totalCell = document.createElement("td");
      totalCell.className = "weekly-extra-value";
      const total = document.createElement("span");
      total.className = "weekly-extra-display";
      total.textContent = Number(summary.period?.cap_extra_hours || 0).toFixed(2);
      totalCell.appendChild(total);
      row.before(extraHoursSummaryRow(
        "Pay Period Approved Extra Hours",
        totalCell,
        "weekly-extra-period",
      ));
    }
  }
};

document.getElementById("timeRows").addEventListener("change", async event => {
  const input = event.target;
  if (!input.matches(".weekly-extra-input")) return;
  const value = Number(input.value), max = Number(input.max);
  if (input.value.trim() === "" || !Number.isFinite(value) || value < 0
      || value > max || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    showMessage(`Approved extra hours must be between 0.00 and ${max.toFixed(2)} in hundredths`, "error");
    await loadTimecard();
    return;
  }
  input.disabled = true;
  try {
    await jsonOrError(await apiFetch(`${apiBase}/supervisor/weekly-cap-extra`, {
      method: "POST",
      body: JSON.stringify({
        employee_id: selectedEmployeeId,
        week_number: Number(input.dataset.week),
        extra_hours: value,
      }),
    }));
    showMessage("Approved extra hours saved");
    await loadTimecard();
  } catch (err) {
    showMessage(err.message, "error");
    await loadTimecard();
  }
});
