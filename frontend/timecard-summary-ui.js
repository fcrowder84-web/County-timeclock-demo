(function (global) {
    function hours(value) {
        return Number(value || 0).toFixed(2);
    }

    function label(type) {
        return String(type || 'other')
            .replaceAll('_', ' ')
            .replace(/\b\w/g, letter => letter.toUpperCase());
    }

    function leaveText(map) {
        const rows = Object.entries(map || {}).filter(([, value]) => Number(value) > 0);
        return rows.length ? rows.map(([type, value]) => `${label(type)} ${hours(value)}`).join(' · ') : 'None';
    }

    function render(summary) {
        if (!summary || !summary.period) return '';
        const p = summary.period;
        const weekRows = (summary.weeks || []).map(week => `
            <tr>
                <td><strong>Week ${week.week_number}</strong><br><small>${week.start_date} through ${week.end_date}</small></td>
                <td>${hours(week.regular_worked_hours)}</td>
                <td><strong>${hours(week.overtime_hours)}</strong></td>
                <td>${hours(week.total_worked_hours)}</td>
                <td>${leaveText(week.leave_hours_by_type)}</td>
                <td>${hours(week.total_leave_hours)}</td>
                <td><strong>${hours(week.total_paid_hours)}</strong></td>
            </tr>`).join('');

        return `
            <div class="summary-row timecard-hours-summary">
                <div class="summary-box"><strong>Regular Worked</strong><br>${hours(p.regular_worked_hours)}</div>
                <div class="summary-box"><strong>Overtime Worked</strong><br>${hours(p.overtime_hours)}</div>
                <div class="summary-box"><strong>Total Worked</strong><br>${hours(p.total_worked_hours)}</div>
                <div class="summary-box"><strong>Total Leave</strong><br>${hours(p.total_leave_hours)}</div>
                <div class="summary-box"><strong>Total Paid</strong><br>${hours(p.total_paid_hours)}</div>
            </div>
            <div style="margin:12px 0 18px;overflow-x:auto;">
                <table>
                    <thead><tr><th>Week</th><th>Regular Worked</th><th>OT Worked</th><th>Total Worked</th><th>Approved Leave</th><th>Total Leave</th><th>Total Paid</th></tr></thead>
                    <tbody>${weekRows}</tbody>
                </table>
                ${Number(p.pending_leave_hours || 0) > 0 ? `<p><strong>Pending leave:</strong> ${leaveText(p.pending_leave_hours_by_type)}. Pending leave is not included in paid totals.</p>` : ''}
                <p style="font-size:0.9em;margin-top:8px;"><strong>Overtime rule:</strong> OT is calculated separately for each week from actual worked hours over ${hours(summary.overtime_threshold_hours)} hours. Leave never creates overtime.</p>
            </div>`;
    }

    global.TimecardSummaryUi = { render };

    // The legacy supervisor dashboard posts every request to the full
    // change-request approval endpoint. A new single Add Punch request has
    // only one requested timestamp, so route just that request to the
    // chronological punch-placement endpoint. All older correction requests
    // retain their original approval path.
    global.addEventListener('load', () => {
        if (typeof global.approveRequest !== 'function' || !document.getElementById('requestsBox')) return;
        const originalApproveRequest = global.approveRequest;
        global.approveRequest = async function approveRequestWithSinglePunch(requestId) {
            try {
                const listResponse = await global.apiFetch(`${global.apiBase}/supervisor/change-requests`);
                const requests = await listResponse.json();
                const request = (requests || []).find(item => Number(item.id) === Number(requestId));
                const singlePunch = request
                    && request.time_entry_id == null
                    && Boolean(request.requested_clock_in) !== Boolean(request.requested_clock_out);
                if (!singlePunch) return originalApproveRequest(requestId);

                const note = global.prompt('Supervisor note (optional):') || '';
                const response = await global.apiFetch(`${global.apiBase}/supervisor/approve-single-punch`, {
                    method: 'POST',
                    body: JSON.stringify({ request_id: Number(requestId), supervisor_note: note }),
                });
                const data = await response.json();
                global.showMessage(data.message || data.error, !!data.error);
                global.loadDashboard();
            } catch (err) {
                if (err?.message !== 'Login required') global.showMessage(err?.message || 'Unable to approve punch request', true);
            }
        };
    });
})(window);
