# County App Production Cleanup — TimeClock Context

## Original objective
Take the four county employee applications—Employee Portal, Finance, TimeClock, and FOIA—from their current working state to clean, secure, maintainable, production-test-ready applications without changing intended business behavior.

## Operating rules
- GitHub is the durable source of truth for source history.
- Live CTs are deployment/runtime targets, not primary editing workspaces.
- Preserve known-good production commits and rollback points.
- Never overwrite unexplained live changes; reconcile them into Git first.
- Refactor in small slices with tests, isolated builds, and diff review.
- Do not merge/deploy a refactor merely because it builds; validate live SSO, permissions, database access, proxying, and business workflows afterward.

## TimeClock production state
- CT205 live source: /opt/county-timeclock
- Production branch: production-baseline-20260811
- Latest production commit at this checkpoint: bb9002e (preserve exact punch times in adjustment dropdowns)
- Database/Adminer/backend host bindings are localhost-only; frontend remains exposed for proxy/tunnel access.
- Legacy PIN login removed; Employee Portal SSO is the active login model.
- SSO token launch uses URL fragments rather than query strings.
- Backend uses restricted PostgreSQL role timeclock_app, not the original superuser role.
- Production npm dependencies last verified at 0 known vulnerabilities.

## Refactor state
- Isolated worktree: /opt/county-timeclock-refactor
- Branch: refactor-timeclock-backend-20260812
- Production commit bb9002e has been merged into this branch.
- 74f55ba: extracted permission/role logic and added tests.
- 214135c: extracted Portal token verification and session primitives with tests.
- 3948265: extracted pay-period/date helpers with boundary tests.
- All committed refactor slices passed Node 20 syntax checks, isolated Docker builds, and focused tests before push.
- A draft backend/routes/auth.js exists but is intentionally untracked because its server.js wiring was blocked before validation. Do not treat it as completed work.

## Next refactor sequence
1. Finish auth route extraction (/auth/portal, /logout, /me) only after wiring can be applied and validated.
2. Extract employee quick-punch / timecard routes.
3. Extract supervisor routes.
4. Extract payroll routes.
5. Add broader HTTP/API regression tests before production deployment.
6. Review the complete branch diff, build an isolated image, then deploy to a test path/container before merging to production.

## Cross-app cleanup status
- Employee Portal: first security hardening pass completed; CSRF, safer temporary passwords, SSO URL hardening, dependency cleanup, obsolete-code cleanup committed. Running service-user reduction remains a future hardening item if a safe account-management path is available.
- Finance: first security hardening pass completed; portal-only login, JWT validation, rate limiting, upload/download hardening, localhost secret handling, backup cleanup committed. Runtime DB role ownership split remains future work.
- FOIA: first security hardening pass completed; PostgreSQL sessions, CSRF, SSO fragment exchange, upload validation, localhost Node bind, non-root www-data service committed. Dependency upgrade remains unresolved because npm write execution has been blocked by the infrastructure policy.

## Context guard
If a future chat resumes this work, inspect Git status and this file first, then inspect the live CT before making changes. The goal is production readiness and maintainability across all four apps—not refactoring for its own sake.
