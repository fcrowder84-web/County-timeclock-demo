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

    function requestDescription(request) {
        const singlePunch = request.time_entry_id == null
            && Boolean(request.requested_clock_in) !== Boolean(request.requested_clock_out);
        if (singlePunch) {
            const value = request.requested_clock_in_display || request.requested_clock_out_display || 'Requested punch';
            return `<strong>Requested Punch:</strong><br>${value}`;
        }
        const parts = [];
        if (request.requested_clock_in_display) parts.push(`<strong>Requested Clock In:</strong><br>${request.requested_clock_in_display}`);
        if (request.requested_clock_out_display) parts.push(`<strong>Requested Clock Out:</strong><br>${request.requested_clock_out_display}`);
        return parts.length ? parts.join('<br><br>') : '<strong>Punch correction requested</strong>';
    }

    global.addEventListener('load', () => {
        const requestsBox = document.getElementById('requestsBox');
        const summaryBox = document.getElementById('summaryBox');
        if (!requestsBox) return;

        // Put actionable requests ahead of the employee timecards so a supervisor
        // sees them without scrolling through the roster first.
        if (summaryBox && requestsBox.parentNode === summaryBox.parentNode) {
            summaryBox.parentNode.insertBefore(requestsBox, summaryBox);
        }

        if (typeof global.apiFetch === 'function') {
            global.loadRequests = async function loadRequestsUpdated() {
                const response = await global.apiFetch('/api/supervisor/change-requests');
                const requests = await response.json();
                let html = `<div class="card"><h2>Pending Change Requests</h2>`;
                if (!requests.length) {
                    html += '<p>No pending requests.</p>';
                } else {
                    html += `<table><thead><tr><th>Employee</th><th>Department</th><th>Requested Change</th><th>Reason</th><th>Actions</th></tr></thead><tbody>`;
                    requests.forEach(request => {
                        html += `<tr>
                            <td>${request.first_name} ${request.last_name}</td>
                            <td>${request.department || '-'}</td>
                            <td>${requestDescription(request)}</td>
                            <td>${request.employee_reason || '-'}</td>
                            <td>
                                <button class="btn-approve" onclick="approveRequest(${request.id})">Approve</button>
                                <button class="btn-return" onclick="denyRequest(${request.id})">Deny</button>
                            </td>
                        </tr>`;
                    });
                    html += '</tbody></table>';
                }
                html += '</div>';
                requestsBox.innerHTML = html;
            };
        }

        // Single Add Punch requests use chronological punch placement rather than
        // the legacy paired clock-in/clock-out change endpoint.
        if (typeof global.approveRequest === 'function' && typeof global.apiFetch === 'function') {
            const originalApproveRequest = global.approveRequest;
            global.approveRequest = async function approveRequestWithSinglePunch(requestId) {
                try {
                    const listResponse = await global.apiFetch('/api/supervisor/change-requests');
                    const requests = await listResponse.json();
                    const request = (requests || []).find(item => Number(item.id) === Number(requestId));
                    const singlePunch = request
                        && request.time_entry_id == null
                        && Boolean(request.requested_clock_in) !== Boolean(request.requested_clock_out);
                    if (!singlePunch) return originalApproveRequest(requestId);

                    const note = global.prompt('Supervisor note (optional):') || '';
                    const response = await global.apiFetch('/api/supervisor/approve-single-punch', {
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
        }

        // loadDashboard may already have started before this compatibility layer
        // was installed, so refresh just the request section with the new layout.
        if (typeof global.loadRequests === 'function') global.loadRequests().catch(() => {});
    });
})(window);
