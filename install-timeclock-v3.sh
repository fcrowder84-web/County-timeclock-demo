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

OLD_BACKEND_IMAGE="$(docker inspect -f '{{.Image}}' county_timeclock_backend 2>/dev/null || true)"
OLD_FRONTEND_IMAGE="$(docker inspect -f '{{.Image}}' county_timeclock_frontend 2>/dev/null || true)"

wait_healthy() {
  local container="$1"
  local timeout_seconds="${2:-75}"
  local elapsed=0
  local status=""

  while (( elapsed < timeout_seconds )); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    case "$status" in
      healthy|running)
        echo "$container: $status"
        return 0
        ;;
      unhealthy|exited|dead)
        echo "$container became $status" >&2
        docker logs --tail 80 "$container" >&2 || true
        return 1
        ;;
    esac
    sleep 2
    elapsed=$((elapsed + 2))
  done

  echo "Timed out waiting for $container to become healthy (last status: ${status:-unknown})" >&2
  docker logs --tail 80 "$container" >&2 || true
  return 1
}

echo "===== BUILD ====="
docker compose build backend frontend

echo "===== TEST ====="
docker compose run --rm --no-deps backend npm test

echo "===== DATABASE ====="
docker compose up -d postgres

# If migration/deploy/health verification fails, retag the images that were
# running when deployment began and recreate the application containers.
rollback_on_error() {
  status=$?
  if [[ $status -ne 0 ]]; then
    echo "Deploy failed; attempting application image rollback." >&2
    if [[ -n "$OLD_BACKEND_IMAGE" ]]; then
      docker tag "$OLD_BACKEND_IMAGE" county-timeclock-backend:latest || true
    fi
    if [[ -n "$OLD_FRONTEND_IMAGE" ]]; then
      docker tag "$OLD_FRONTEND_IMAGE" county-timeclock-frontend:latest || true
    fi
    docker compose up -d --no-build backend frontend >/dev/null 2>&1 || true
    docker compose ps >&2 || true
  fi
  exit "$status"
}
trap rollback_on_error EXIT

docker compose stop backend
bash scripts/apply-migrations.sh

echo "===== DEPLOY ====="
docker compose up -d backend frontend

echo "===== HEALTH ====="
wait_healthy county_timeclock_backend 75
wait_healthy county_timeclock_frontend 75

# Deployment completed; do not run rollback.
trap - EXIT

echo "===== STATUS ====="
docker compose ps

echo "Deployment completed successfully and services are healthy."
