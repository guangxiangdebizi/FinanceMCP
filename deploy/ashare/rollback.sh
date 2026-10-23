#!/usr/bin/env bash
# Roll the EXISTING container back to the image recorded by upgrade.sh.
#
#   rollback.sh <rollback-record.env> [--dry-run]
#
# It restores the IMAGE only. The market cache is append/upsert-only and `migrate` is idempotent, so
# the previous image can read the database the new one used; restoring a database backup would
# throw away every session ingested since the upgrade, so it is deliberately NOT done here. The
# exact manual command is printed instead, for the case where a database really is damaged.
# Timers, unit files and .env are not touched.
set -euo pipefail
RECORD="${1:?usage: rollback.sh <rollback-record.env> [--dry-run]}"; shift || true
DRY=0
while [ $# -gt 0 ]; do case "$1" in --dry-run) DRY=1; shift ;; *) echo "unknown argument: $1" >&2; exit 2 ;; esac; done
[ -f "$RECORD" ] || { echo "no such record: $RECORD" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${ASHARE_CONTAINER:-finance-mcp-ashare}"
get() { grep -E "^$1=" "$RECORD" | head -1 | cut -d= -f2-; }
TAG="$(get rollback_image_tag)"; OLD_ID="$(get old_container_image)"; DB="$(get db_backup)"; SHA="$(get db_sha256)"
[ -n "$TAG" ] && [ "$OLD_ID" != "unknown" ] || { echo "record has no usable rollback image" >&2; exit 3; }
docker image inspect "$TAG" >/dev/null 2>&1 || { echo "rollback image $TAG is gone; cannot roll back" >&2; exit 3; }
TARGET_REV="$(docker image inspect "$TAG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
CURRENT_REV="$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || echo none)"
echo "current revision : $CURRENT_REV"
echo "rollback target  : $TARGET_REV  ($TAG)"
echo "db backup (NOT restored by this script): $DB"
if [ -f "$DB" ] && [ -n "$SHA" ]; then
  [ "$(sha256sum "$DB" | cut -d' ' -f1)" = "$SHA" ] && echo "db backup sha256 verified" || echo "WARNING: db backup sha256 does NOT match the record" >&2
fi
if [ "$DRY" -eq 1 ]; then echo "dry run: would retag $TAG as finance-mcp-ashare:local and recreate the service without building"; exit 0; fi
docker tag "$TAG" finance-mcp-ashare:local
( cd "$HERE" && docker compose up -d --no-build )
for _ in $(seq 1 60); do
  state="$(docker inspect "$CONTAINER" --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo missing)"
  [ "$state" = "running/healthy" ] && break; sleep 2
done
echo "state: $state"
[ "$state" = "running/healthy" ] || { echo "rolled-back container is not healthy" >&2; exit 5; }
ACTUAL="$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
echo "running revision: $ACTUAL"
[ "$ACTUAL" = "$TARGET_REV" ] || { echo "revision mismatch after rollback" >&2; exit 6; }
curl -fsS -m 10 http://127.0.0.1:8130/health; echo
cat <<MSG
rolled back. If (and only if) the database itself is damaged, restore by hand with the service stopped:
  docker compose -f $HERE/docker-compose.yml stop && cp "$DB" \$HOME/.local/share/finance-mcp-ashare/ashare.sqlite
MSG
