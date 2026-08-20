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

# Track exactly which migration file was applied.  A checksum mismatch means a
# historical migration was edited after deployment; fail instead of silently
# applying a different definition under the same filename.
docker exec "$DB_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  " >/dev/null

shopt -s nullglob
migrations=(migrations/*.sql)
if (( ${#migrations[@]} == 0 )); then
  echo "No migration files found" >&2
  exit 1
fi

for migration in "${migrations[@]}"; do
  filename="$(basename "$migration")"
  checksum="$(sha256sum "$migration" | awk '{print $1}')"

  recorded="$(
    docker exec "$DB_CONTAINER" \
      psql -At -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
      -c "SELECT checksum FROM schema_migrations WHERE filename = '$filename';"
  )"

  if [[ -n "$recorded" ]]; then
    if [[ "$recorded" != "$checksum" ]]; then
      echo "ERROR: migration $filename was already applied with a different checksum" >&2
      echo " recorded: $recorded" >&2
      echo " current:  $checksum" >&2
      exit 1
    fi
    echo "SKIP  $filename"
    continue
  fi

  echo "APPLY $filename"
  docker exec -i "$DB_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
    < "$migration"

  escaped_checksum="${checksum//\'/\'\'}"
  escaped_filename="${filename//\'/\'\'}"
  docker exec "$DB_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "
      INSERT INTO schema_migrations(filename, checksum)
      VALUES ('$escaped_filename', '$escaped_checksum');
    " >/dev/null

done

echo "All migrations are current."
