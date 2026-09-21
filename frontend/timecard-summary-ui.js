(function (global) {
    const esc = value => global.SafeHtml.escape(value);
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
        return rows.length ? rows.map(([type, value]) => `${esc(label(type))} ${hours(value)}`).join(' · ') : 'None';
    }

    function render(summary) {
        if (!summary || !summary.period) return '';
        const p = summary.period;
        const weekRows = (summary.weeks || []).map(week => `
            <tr>
                <td><strong>Week ${esc(week.week_number)}</strong><br><small>${esc(week.start_date)} through ${esc(week.end_date)}</small></td>
                <td>${hours(week.regular_worked_hours)}</td>
                <td><strong>${hours(week.overtime_hours)}</strong></td>
                <td>${hours(week.total_worked_hours)}</td>
                <td>${hours(week.forced_lunch_hours)}</td>
                <td>${leaveText(week.leave_hours_by_type)}</td>
                <td>${hours(week.total_leave_hours)}</td>
                <td><strong>${hours(week.total_paid_hours)}</strong></td>
            </tr>`).join('');

        return `
            <div class="summary-row timecard-hours-summary">
                <div class="summary-box"><strong>Regular Worked</strong><br>${hours(p.regular_worked_hours)}</div>
                <div class="summary-box"><strong>Overtime Worked</strong><br>${hours(p.overtime_hours)}</div>
                <div class="summary-box"><strong>Total Worked</strong><br>${hours(p.total_worked_hours)}</div>
                ${summary.forced_lunch_enabled ? `<div class="summary-box"><strong>Forced Lunch</strong><br>−${hours(p.forced_lunch_hours)}</div>` : ``}
                <div class="summary-box"><strong>Total Leave</strong><br>${hours(p.total_leave_hours)}</div>
                <div class="summary-box"><strong>Total Paid</strong><br>${hours(p.total_paid_hours)}</div>
            </div>
            <div style="margin:12px 0 18px;overflow-x:auto;">
                <table>
                    <thead><tr><th>Week</th><th>Regular Worked</th><th>OT Worked</th><th>Total Worked</th><th>Forced Lunch</th><th>Approved Leave</th><th>Total Leave</th><th>Total Paid</th></tr></thead>
                    <tbody>${weekRows}</tbody>
                </table>
                ${Number(p.pending_leave_hours || 0) > 0 ? `<p><strong>Pending leave:</strong> ${leaveText(p.pending_leave_hours_by_type)}. Pending leave is not included in paid totals.</p>` : ''}
                ${summary.forced_lunch_enabled ? `<p style="font-size:0.9em;margin-top:8px;"><strong>Forced lunch:</strong> ${Number(summary.forced_lunch_minutes || 0)} minutes is required on each worked day. Clocked-out break time satisfies the requirement first; only the remaining amount is deducted. Approved daily waivers remove the deduction.</p>` : ``}<p style="font-size:0.9em;margin-top:8px;"><strong>Overtime rule:</strong> OT is calculated separately for each week from actual worked hours after lunch deductions over ${hours(summary.overtime_threshold_hours)} hours. Leave never creates overtime.</p>
            </div>`;
    }

    global.TimecardSummaryUi = { render };

    function requestDescription(request) {
        const singlePunch = request.time_entry_id == null
            && Boolean(request.requested_clock_in) !== Boolean(request.requested_clock_out);
        if (singlePunch) {
            const value = request.requested_clock_in_display || request.requested_clock_out_display || 'Requested punch';
            return `<strong>Requested Punch:</strong><br>${esc(value)}`;
        }
        const parts = [];
        if (request.requested_clock_in_display) parts.push(`<strong>Requested Clock In:</strong><br>${esc(request.requested_clock_in_display)}`);
        if (request.requested_clock_out_display) parts.push(`<strong>Requested Clock Out:</strong><br>${esc(request.requested_clock_out_display)}`);
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
            global.reviewLunchRequest = async function reviewLunchRequest(requestId, status) {
                const note = global.prompt(`Supervisor note for ${status === 'approved' ? 'approval' : 'denial'} (optional):`) || '';
                const response = await global.apiFetch('/api/supervisor/review-lunch-waiver-request', {
                    method: 'POST',
                    body: JSON.stringify({ request_id: Number(requestId), status, review_note: note }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    global.alert(data.error || 'Unable to review lunch removal request');
                    return;
                }
                if (typeof global.showMessage === 'function') global.showMessage(data.message || 'Lunch request reviewed');
                await global.loadRequests();
                if (typeof global.loadDashboard === 'function') await global.loadDashboard();
            };

            global.loadRequests = async function loadRequestsUpdated() {
                const [changeResponse, lunchResponse] = await Promise.all([
                    global.apiFetch('/api/supervisor/change-requests'),
                    global.apiFetch('/api/supervisor/lunch-waiver-requests'),
                ]);
                const changes = changeResponse.ok ? await changeResponse.json() : [];
                const lunches = lunchResponse.ok ? await lunchResponse.json() : [];
                let html = `<div class="card"><h2>Pending Change Requests</h2>`;
                if (!changes.length && !lunches.length) {
                    html += '<p>No pending requests.</p>';
                } else {
                    html += `<table><thead><tr><th>Employee</th><th>Department</th><th>Requested Change</th><th>Reason</th><th>Actions</th></tr></thead><tbody>`;
                    changes.forEach(request => {
                        html += `<tr>
                            <td>${esc(request.first_name)} ${esc(request.last_name)}</td>
                            <td>${esc(request.department || '-')}</td>
                            <td>${requestDescription(request)}</td>
                            <td>${esc(request.employee_reason || '-')}</td>
                            <td>
                                <button class="btn-approve" onclick="approveRequest(${Number(request.id)})">Approve</button>
                                <button class="btn-return" onclick="denyRequest(${Number(request.id)})">Deny</button>
                            </td>
                        </tr>`;
                    });
                    lunches.forEach(request => {
                        html += `<tr>
                            <td>${esc(request.first_name)} ${esc(request.last_name)}</td>
                            <td>${esc(request.department || '-')}</td>
                            <td><strong>Remove Forced Lunch</strong><br>${esc(String(request.work_date || '').slice(0, 10))}</td>
                            <td>${esc(request.reason || '-')}</td>
                            <td>
                                <button class="btn-approve" onclick="reviewLunchRequest(${Number(request.id)},'approved')">Approve</button>
                                <button class="btn-return" onclick="reviewLunchRequest(${Number(request.id)},'denied')">Deny</button>
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
