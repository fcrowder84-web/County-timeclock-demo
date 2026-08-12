# County Applications Production Cleanup — Chat Handoff

Date: 2026-08-12

## Mission / why this work started
The county has four employee-facing applications that were developed iteratively and are now working well enough to prepare for production testing. The goal is to clean, secure, modularize, test, and document all four WITHOUT changing intended business behavior:

1. Employee Portal — GitHub `fcrowder84-web/employee-portal`
2. TimeClock — GitHub `fcrowder84-web/County-timeclock-demo`
3. Finance — GitHub `fcrowder84-web/county-finance`
4. FOIA — GitHub `fcrowder84-web/county-foia`

The desired end state is production-test-ready code: smaller logical modules instead of giant files, obsolete/dead code removed only after verification, security review, database review, dependency review, authorization tests, good error handling/logging/configuration, and automated regression tests. Preserve working behavior and always keep rollback points.

## Preferred development workflow
The user specifically requested a Git-centered workflow rather than editing live CT source as the normal development method.

Preferred flow:
1. Read this handoff and repository context/history.
2. Use the built-in ChatGPT GitHub connector directly when available.
3. Work on a dedicated refactor branch in GitHub/local development context.
4. Make small bounded commits with tests.
5. Do not merge to production merely because code builds.
6. Before deployment inspect the live CT for uncommitted/drifted files.
7. Pull/merge the reviewed commit on the CT.
8. Rebuild/restart only what changed.
9. Validate live DB, Employee Portal SSO, authorization, proxy/tunnel, services, and application workflows.
10. Roll back to the previous known-good Git commit if validation fails.

The current chat did NOT have the built-in GitHub connector exposed even after reconnect. Another fresh chat verified that the built-in connector can access all 7 repos under `fcrowder84-web` and has admin/maintain/pull/push/triage permissions. Therefore the NEXT CHAT SHOULD USE THE BUILT-IN GITHUB CONNECTOR for code work if it is exposed there.

## Infrastructure / places to inspect
Before infrastructure work read the project operating manual `HIVE_PROJECT_OPERATING_MANUAL.txt` if available in project files/context.

Live infrastructure is on `proxoffice` and should be inspected through HIVE/AIssh/Deadfall tools rather than guessed from this document.

Current county app CT mapping used during this cleanup:
- CT204 Employee Portal
- CT205 TimeClock
- CT206 Finance
- CT207 FOIA

TimeClock live checkout: `/opt/county-timeclock` on CT205.
TimeClock isolated refactor worktree: `/opt/county-timeclock-refactor` on CT205.
TimeClock refactor branch: `refactor-timeclock-backend-20260812`.
TimeClock production branch: `production-baseline-20260811`.

GitHub repositories reported accessible in a GitHub-enabled chat:
- County-timeclock-demo
- ALssh-HIVE
- Honey
- spirit-legacy
- employee-portal
- county-finance
- county-foia

## Critical application architecture
Employee Portal is the sole login/authentication hub for the county employee applications. The downstream apps should use Employee Portal SSO/permissions rather than maintaining independent employee authentication behavior.

Do not casually change authorization semantics. Production cleanup is NOT an excuse to redesign working business rules unless a verified security flaw requires it.

## Work completed before the latest TimeClock refactor
### Employee Portal
A first security/production-hardening pass was completed and committed before this handoff. Work included CSRF protections, safer temporary-password behavior, SSO URL/token hardening, dependency cleanup, and obsolete-code cleanup. A future hardening item is reducing the running service user's privileges if a safe deployment/account-management path is available. Inspect Git history rather than relying only on this summary.

A coordinated FOIA SSO change was pushed as:
- `07447a8` — Keep FOIA SSO tokens out of request URLs

### Finance
A first security-hardening pass was completed before this handoff: Portal-only login, JWT validation, rate limiting, upload/download hardening, localhost secret handling, and backup cleanup were committed. A future item is DB runtime-role/ownership separation. Inspect the Git repository/history for exact commits and current state before further changes.

### FOIA — CT207 `/opt/edgefield-foia`
FOIA received a substantial hardening pass and was live-validated.

Verified changes/results:
- PostgreSQL-backed sessions replace Express MemoryStore.
- Persisted `foia_sessions` rows were verified live.
- CSRF protection is active on public request and state-changing admin forms.
- Public form live HTTPS test returned 200 and contained CSRF token.
- Missing-CSRF POST was rejected 403.
- Valid CSRF reached normal validation (intentional missing fields returned 400 without creating a request).
- Employee Portal SSO callback uses URL fragment exchange rather than putting token in request URL.
- Invalid SSO test returned 401.
- Upload validation enforces allowed MIME/extension combinations.
- Node binds localhost behind reverse proxy.
- Strong session/SSO secret configuration required.
- FOIA now runs as `www-data`, not root.
- `www-data` was independently verified to read `.env`, write uploads, and query PostgreSQL.
- `.env` changed to `root:www-data` mode 0640.
- uploads directory ownership changed to `www-data:www-data`.
- tracked installer was updated to reproduce non-root direct-Node deployment.
- live security suite passed after switching service to non-root.

FOIA commits pushed during this chat:
- `da8f952` — Harden FOIA sessions SSO uploads and CSRF
- `5c6b664` — Run FOIA as non-root service user

Known unresolved FOIA issue at this checkpoint:
- npm production dependency audit previously reported 5 vulnerabilities including 2 high. Upgrade attempts were blocked by infrastructure execution policy in this chat. DO NOT claim these are fixed without rerunning a current dependency audit in the repo/build environment.

## TimeClock — production state and preservation work
The TimeClock Git history had been outdated earlier in the overall project; GitHub baselines/auth were repaired before this handoff.

During this chat an unexplained live dirty file was found before refactoring: `frontend/employee.html`. It was inspected and confirmed to be the clock-adjustment dropdown fix that preserves exact punch times. It was deliberately preserved, committed, pushed, and merged into the refactor branch rather than overwritten.

Production commit:
- `bb9002e` — Preserve exact punch times in adjustment dropdowns

This production commit was merged into the refactor branch in merge commit:
- `08a87f0`

At that point production and refactor histories were synchronized for this change.

Earlier TimeClock hardening context already documented in `PRODUCTION_CLEANUP_CONTEXT.md`:
- Database/Adminer/backend host bindings localhost-only; frontend remains exposed for proxy/tunnel use.
- Legacy PIN login removed; Employee Portal SSO is the active login model.
- SSO token launch uses URL fragments instead of query strings.
- Backend uses restricted PostgreSQL role `timeclock_app`, not original superuser role.
- Production npm dependencies were last verified at 0 known vulnerabilities at the time of that checkpoint. Recheck rather than assuming forever.

## TimeClock refactor branch — completed and pushed
Branch: `refactor-timeclock-backend-20260812`

### 1. Permission/role extraction
Commit:
- `74f55ba` — Extract TimeClock permission logic and add regression tests

Created:
- `backend/lib/permissions.js`
- `backend/test/permissions.test.js`

Extracted pure permission groups, role derivation, legacy permission mapping, permission-set checks, etc. Tests passed under Node 20. Isolated backend image built successfully.

### 2. Portal-token/session primitive extraction
Commit:
- `214135c` — Extract TimeClock SSO and session primitives

Created:
- `backend/lib/portal-token.js`
- `backend/lib/session-store.js`
- `backend/test/auth-primitives.test.js`

Covers HS256 verification, issuer/audience/expiry/nbf checks, timing-safe signature comparison, session creation/expiry/destruction, bearer token parsing. Tests passed and isolated image built.

### 3. Pay-period/date helper extraction
Commit:
- `3948265` — Extract TimeClock pay-period date helpers

Created:
- `backend/lib/pay-period.js`
- `backend/test/pay-period.test.js`

Pure calculations extracted while DB-backed config fetch remained in server. Tests cover 14-day boundaries, previous/current periods, explicit period starts, invalid starts, and date shifting/month boundaries. Tests passed; isolated image built.

### 4. Durable context checkpoint
Commit:
- `e76dea5` — Document county app production cleanup context

Created:
- `PRODUCTION_CLEANUP_CONTEXT.md`

READ THIS FILE FIRST in addition to this handoff. It captures the mission, rules, app status, and next sequence. This handoff supersedes/extends it where newer commits are listed.

### 5. Authentication route extraction
Commit:
- `f4aa5f7` — Extract TimeClock authentication routes

Created:
- `backend/routes/auth.js`

Extracted exactly:
- `POST /logout`
- `GET /me`
- `POST /auth/portal`

Dockerfile was updated to copy `routes/` after an isolated build caught that packaging dependency. Router was inspected inside built image and exposed exactly those three endpoints. Full tests passed before commit/push.

### 6. Quick-punch route extraction
Commit:
- `562cbc2` — Extract TimeClock quick-punch routes

Created:
- `backend/routes/quick-punch.js`
- `backend/test/quick-punch.test.js`

Extracted exactly:
- `GET /quick-status`
- `POST /clock-in`
- `POST /clock-out`

Focused tests cover route presence, current clocked-in state, already-clocked-in rejection, and not-clocked-in clock-out rejection. The full test suite was run inside the built application image because bare `node:20` does not include Express.

Verified full suite at this checkpoint:
- permissions tests: PASS
- auth primitive tests: PASS
- pay-period tests: PASS
- quick-punch tests: PASS

Isolated image build at quick-punch checkpoint completed successfully and npm reported 0 vulnerabilities.

## Important: refactor has NOT been deployed
None of the TimeClock refactor branch commits listed above have been deployed into the running production TimeClock. The live production checkout is intentionally separate. Do not merge/deploy until the remaining route modularization and broader regression validation are complete.

## Exact next TimeClock work
Continue from GitHub branch `refactor-timeclock-backend-20260812`, currently pushed through `562cbc2` at this handoff.

Recommended sequence:
1. Fetch/read branch and both context files.
2. Confirm branch HEAD/current GitHub state; do not blindly trust the hash if newer work exists.
3. Inspect `backend/server.js` after current extractions.
4. Extract remaining employee timecard/request routes in a bounded group with regression tests.
5. Extract supervisor routes separately with authorization tests.
6. Extract payroll routes separately with authorization/business-rule tests.
7. Consider repository/service modules for repeated DB operations only after route boundaries are stable.
8. Add broader HTTP/API regression tests proving authorization boundaries, especially employee vs supervisor vs payroll vs app admin.
9. Run current npm audit/dependency checks and isolated Docker build.
10. Review complete branch diff against production.
11. Deploy to a separate test container/path/port before merging to production.
12. Validate live Employee Portal SSO, DB access, quick punch, adjustment request, employee timecard, supervisor approval/return, payroll workflow, pay-period navigation, and reverse proxy/tunnel behavior.
13. Only then merge into `production-baseline-20260811` and deploy production with rollback ready.

## Broader four-app sequence
The original cleanup sequence was Employee Portal -> TimeClock -> Finance -> FOIA because Employee Portal defines authentication/authorization. First hardening passes have already touched all four, but structural cleanup is currently focused on TimeClock. Finish TimeClock's structural refactor/test deployment before randomly jumping among apps unless a production bug requires interruption.

After TimeClock is production-tested, revisit each app systematically for:
- giant-file/module structure
- duplicate/dead code
- authorization/data-isolation tests
- DB constraints/indexes/schema assumptions
- secrets/config handling
- dependency audit
- logging/error handling
- health checks
- upload security where applicable
- service user/runtime privileges
- automated tests
- deployment documentation

## Tools / safety / operating behavior
For HIVE/Proxmox/server/database/deployment work:
- discover -> inspect -> dependencies -> risk -> authorization if required -> backup/snapshot -> execute -> validate -> rollback on failure -> report actual results.
- Verify live state before changes because saved context can become stale.
- Prefer structured HIVE/AIssh/Deadfall tools over raw shell.
- Before editing read current file/config.
- Before restarting inspect service status/logs.
- A successful command is not proof of completion; validate actual runtime behavior.
- Approval phrase when a controlled write in the current workflow requires it: `APPROVE-1DE446DD`.
- Do not use sudo inside LXC containers.
- Do not expose secrets.

## New-chat startup instruction
When starting the next chat, the user can say:

`Continue the county app production cleanup. Use the built-in GitHub connector. Start with fcrowder84-web/County-timeclock-demo branch refactor-timeclock-backend-20260812. Read CHAT_HANDOFF_20260812.md and PRODUCTION_CLEANUP_CONTEXT.md first, inspect Git history/status, and continue from the latest verified commit. Do not deploy or merge to production yet. Use HIVE tools only for live verification/deployment after the GitHub-side refactor is ready.`

If the GitHub connector is exposed in the new chat, use it as the primary code-development path. If it is unexpectedly absent, verify connector availability before falling back to CT-based Git operations.
