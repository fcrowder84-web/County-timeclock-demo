# Critical security regressions

Fixes Critical findings 1 and 5 from the integrated production review.

Employee notes, correction reasons, reviewer notes, and employee/department labels are escaped at the deployed HTML sinks. The text remains visible. Existing SafeHtml is loaded before use; no notes, views, or endpoints are removed.

Punch creation/deletion requires explicit operational permissions. Other-employee edits require an active supervisor assignment or department-head responsibility; merely sharing a department, read-all access, an admin role label, or Application Admin no longer grants punch mutation authority. Supervisor changes require the employee-submitted stage before supervisory approval. Payroll override requires edit_payroll_time; finalized-card add/delete requires reopen_timecard. Self-deletion requires edit_own_pending_entry and retains the existing signed-card lock. Matching older add-entry and payroll-override paths use the explicit permissions as well.

The existing Employee → assigned Supervisor OR Department Head → Payroll flow is preserved. The Docker transformation is tested for department-wide head backup authority, head self-approval, and no supervisory approval from Payroll or Application Admin alone. Existing pending_clock_in/pending_clock_out handling is unchanged.

Validation:
- 29 new security/build checks pass: node --test tests/security/*.test.cjs.
- The same regression assertions against pinned pre-fix commit 997dfa60f74e7ceed33969cfdb255db7ce6bfc32 reproduce unsafe punch mutations and raw HTML rendering (20 failures, 7 passing preservation cases).
- All 13 other existing test scripts pass after updating the legitimate self-delete fixture to carry its own-edit permission.
- Existing permissions.test.js still fails because it expects the Payroll role to include approve_timecard. Both that test and permissions.js are unchanged from baseline; granting it would violate the requested operational model.
- Docker approval transformation and transformed JS syntax pass on disposable Linux-line-ending copies; frontend inline scripts parse.

Database calls in security tests are mocked. No live production writes or deployment. Important/Cleanup work is outside this PR.

## Reproducing the pre-fix behavior

Run the tests normally for the fixed tree. Set SECURITY_BASELINE=1 to load application sources from the pinned original Git commit; the test code stays identical. This intentionally produces failures on the old vulnerabilities. New helper contract checks may also fail because those helpers do not exist in the old tree.

PowerShell:
```powershell
node --test tests/security/*.test.cjs
$env:SECURITY_BASELINE='1'
node --test tests/security/regressions.test.cjs
Remove-Item Env:SECURITY_BASELINE
```

POSIX shell:
```sh
node --test tests/security/*.test.cjs
SECURITY_BASELINE=1 node --test tests/security/regressions.test.cjs
```

## Second-review blockers

Second-review blockers 2–4: the external timecard-summary-ui.js compatibility renderer escapes reason, name, department and date/summary text through SafeHtml.escape; action IDs are numeric. Displayed information is preserved.

The supervisor edit endpoint uses canEditPunch on the locked employee entry. Self-edits are denied even for Department Heads. Assigned Supervisors and department-head backups retain employee_submitted-stage edits. Payroll requires employee signature plus one supervisory approval and supervisor_approved/payroll_finalized status. Finalized source or destination cards require both edit_payroll_time and reopen_timecard. Both affected cards are locked and checked before writes. Deliberate reopening includes finalized card IDs in the existing audit event. Existing post-edit approval invalidation and re-review behavior is preserved.

Added 18 targeted tests in second-review.test.cjs, covering every requested positive/negative edit case, destination-period bypasses and the actual external renderer with malicious content. Full security/build suite: 47/47 pass. All 13 other existing test scripts pass. permissions.test.js retains its pre-existing failure expecting Payroll to have approve_timecard; the test and permissions implementation are unchanged. Docker transformation/self-approval compatibility checks pass.

Before/after reproduction against the first PR revision:
```sh
SECURITY_BASELINE=1 SECURITY_BASELINE_REF=59fa50b6ed1793c1548607f23c5c1679e80b77e6 node --test tests/security/second-review.test.cjs
node --test tests/security/*.test.cjs
```

Database calls are mocked. No live production/database writes, deployments, or changes to Finance/FOIA were performed.
