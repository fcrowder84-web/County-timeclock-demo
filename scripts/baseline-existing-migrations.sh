#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/county-timeclock}"
DB_CONTAINER="${DB_CONTAINER:-county_timeclock_postgres}"
DB_USER="${DB_USER:-timeclock_user}"
DB_NAME="${DB_NAME:-county_timeclock}"

cd "$APP_DIR"

command -v sha256sum >/dev/null 2>&1 || {
  echo "sha256sum is required" >&2
  exit 1
}

docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || {
  echo "Database container $DB_CONTAINER does not exist" >&2
  exit 1
}

psql_at() {
  docker exec "$DB_CONTAINER" \
    psql -At -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "$1"
}

require_true() {
  local description="$1"
  local sql="$2"
  local value
  value="$(psql_at "$sql")"
  if [[ "$value" != "t" ]]; then
    echo "ERROR: legacy baseline check failed: $description" >&2
    exit 1
  fi
  echo "OK    $description"
}

tracking_table="$(psql_at "SELECT to_regclass('public.schema_migrations');")"
if [[ -n "$tracking_table" ]]; then
  existing_count="$(psql_at "SELECT COUNT(*) FROM schema_migrations;")"
  if [[ "$existing_count" != "0" ]]; then
    echo "ERROR: schema_migrations already contains $existing_count row(s); refusing to baseline over existing history." >&2
    exit 1
  fi
fi

echo "===== VERIFY LEGACY SCHEMA THROUGH MIGRATION 008 ====="
require_true "base time_entries table exists" \
  "SELECT to_regclass('public.time_entries') IS NOT NULL;"
require_true "Employee Portal integration columns exist" \
  "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='employees' AND column_name='portal_user_id');"
require_true "timeclock audit table exists" \
  "SELECT to_regclass('public.timeclock_audit_log') IS NOT NULL;"
require_true "team-structure tables exist" \
  "SELECT to_regclass('public.department_heads') IS NOT NULL AND to_regclass('public.supervisor_employee_assignments') IS NOT NULL;"
require_true "portal directory sync table exists" \
  "SELECT to_regclass('public.portal_directory_sync_log') IS NOT NULL;"
require_true "leave table exists" \
  "SELECT to_regclass('public.leave_entries') IS NOT NULL;"
require_true "punch metadata table exists" \
  "SELECT to_regclass('public.time_punch_metadata') IS NOT NULL;"
require_true "soft-delete columns exist" \
  "SELECT COUNT(*)=3 FROM information_schema.columns WHERE table_schema='public' AND table_name='time_entries' AND column_name IN ('deleted_at','deleted_by_employee_id','deletion_reason');"
require_true "time_entries RLS is disabled after migration 007" \
  "SELECT NOT relrowsecurity FROM pg_class WHERE oid='public.time_entries'::regclass;"
require_true "negative-time constraint exists" \
  "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.time_entries'::regclass AND conname='time_entries_clock_order_check');"
require_true "time-change validation trigger exists" \
  "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.time_change_requests'::regclass AND tgname='trg_validate_time_change_request_order' AND NOT tgisinternal);"

# Migration 009 must remain unapplied so the normal runner can apply and record
# it after this one-time baseline.
require_true "migration 009 open-punch index is not already present" \
  "SELECT to_regclass('public.idx_time_entries_one_active_open_per_employee') IS NULL;"

if [[ -z "$tracking_table" ]]; then
  docker exec "$DB_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "
      CREATE TABLE schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    " >/dev/null
fi

shopt -s nullglob
migrations=(migrations/*.sql)
recorded=0
for migration in "${migrations[@]}"; do
  filename="$(basename "$migration")"
  if [[ "$filename" == 009_* ]]; then
    continue
  fi

  checksum="$(sha256sum "$migration" | awk '{print $1}')"
  escaped_filename="${filename//\'/\'\'}"
  escaped_checksum="${checksum//\'/\'\'}"

  docker exec "$DB_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "
      INSERT INTO schema_migrations(filename, checksum)
      VALUES ('$escaped_filename', '$escaped_checksum')
      ON CONFLICT (filename) DO NOTHING;
    " >/dev/null
  echo "BASE  $filename"
  recorded=$((recorded + 1))
done

echo "Baseline recorded for $recorded historical migration file(s)."
echo "Migration 009 remains pending and must be applied by scripts/apply-migrations.sh."
