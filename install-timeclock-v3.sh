#!/usr/bin/env bash
set -euo pipefail
APP=/opt/county-timeclock
STAMP=$(date +%Y%m%d-%H%M%S)
[ -d "$APP" ] || { echo "$APP not found"; exit 1; }
cp -a "$APP" "/opt/county-timeclock-backup-$STAMP"
rsync -a --exclude='.env' --exclude='postgres/data' ./ "$APP"/
cd "$APP"
docker compose up -d --build
for f in migrations/001_portal_integration.sql migrations/002_team_structure.sql migrations/003_portal_directory_sync.sql; do
  docker exec -i county_timeclock_postgres psql -U timeclock_user -d county_timeclock < "$f"
done
docker compose restart backend
docker compose ps
