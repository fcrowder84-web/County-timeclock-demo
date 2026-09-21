'use strict';

/*
 * OBSOLETE
 *
 * This one-time refactor script encoded the pre-2026-09-21 authorization
 * model, including app_admin_scope and legacy payroll/view permission aliases.
 * The live application now uses backend/lib/permissions.js plus explicit role
 * scope. Re-running the old transformer could reintroduce authorization bugs,
 * so it is intentionally disabled.
 */

throw new Error(
  'backend/scripts/apply-approval-model.js is obsolete after the 2026-09-21 permission-model refactor and must not be run.'
);
