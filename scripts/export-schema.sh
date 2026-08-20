#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/county-timeclock}"
DB_CONTAINER="${DB_CONTAINER:-county_timeclock_postgres}"
DB_USER="${DB_USER:-timeclock_user}"
DB_NAME="${DB_NAME:-county_timeclock}"
OUTPUT="${SCHEMA_OUTPUT:-schema.sql}"

cd "$APP_DIR"

docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || {
  echo "Database container $DB_CONTAINER does not exist" >&2
  exit 1
}

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

{
  echo "-- County TimeClock database schema snapshot"
  echo "-- Structure only: no employee/timekeeping rows and no secrets are included."
  echo "-- Canonical changes remain the numbered SQL migrations; regenerate this file after schema changes."
  echo
  docker exec "$DB_CONTAINER" \
    pg_dump \
      -U "$DB_USER" \
      -d "$DB_NAME" \
      --schema-only \
      --no-owner \
      --no-privileges
} > "$tmp"

if ! grep -q 'CREATE TABLE public.time_entries' "$tmp"; then
  echo "Schema export does not contain time_entries; refusing to replace $OUTPUT" >&2
  exit 1
fi

if ! grep -q 'CREATE TABLE public.schema_migrations' "$tmp"; then
  echo "Schema export does not contain schema_migrations; refusing to replace $OUTPUT" >&2
  exit 1
fi

mv "$tmp" "$OUTPUT"
trap - EXIT

echo "Wrote current structure-only database schema to $APP_DIR/$OUTPUT"
