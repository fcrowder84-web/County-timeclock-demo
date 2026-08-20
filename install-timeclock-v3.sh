#!/usr/bin/env bash
set -euo pipefail

APP="${APP_DIR:-/opt/county-timeclock}"
cd "$APP"

if [[ ! -f docker-compose.yml || ! -d backend || ! -d migrations ]]; then
  echo "$APP does not look like a County TimeClock checkout" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to deploy with uncommitted files in $APP" >&2
  git status --short >&2
  exit 1
fi

# Validate Compose/environment references before spending time building.
docker compose config --quiet

echo "===== BUILD ====="
docker compose build backend frontend

echo "===== TEST ====="
docker compose run --rm --no-deps backend npm test

echo "===== DATABASE ====="
docker compose up -d postgres

# Keep the service available if a migration preflight discovers data that must
# be corrected manually.  Migrations are transactional, so the previous
# backend can safely be brought back up after a failed migration.
restart_on_error() {
  status=$?
  if [[ $status -ne 0 ]]; then
    echo "Deploy failed; restoring backend/frontend service state." >&2
    docker compose up -d backend frontend >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap restart_on_error EXIT

docker compose stop backend
bash scripts/apply-migrations.sh

echo "===== DEPLOY ====="
docker compose up -d backend frontend

# Deployment completed; do not run the failure recovery trap.
trap - EXIT

echo "===== STATUS ====="
docker compose ps

echo "Deployment completed successfully."
