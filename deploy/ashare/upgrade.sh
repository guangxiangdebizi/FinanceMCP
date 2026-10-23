#!/usr/bin/env bash
# In-place upgrade of the EXISTING FinanceMCP container (A-share research service).
#
# One service, one container, one data volume: this script rebuilds the same
# compose project in place. It does NOT create a second long-running instance.
#
# Preconditions (checked by the script, not assumed):
#   - a verified pre-upgrade DB backup exists
#   - the old image digest is recorded
#   - the working tree is clean and on the expected branch
#
# Usage:
#   upgrade.sh --revision <full-git-sha> [--branch NAME] [--dry-run]
set -euo pipefail

REVISION=""; BRANCH=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --revision) REVISION="${2:?}"; shift 2 ;;
    --branch) BRANCH="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REVISION" ] || { echo "--revision <git sha> is required" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
STATE_DIR="${ASHARE_STATE_DIR:-$HOME/.local/share/ashare-v1}"
BACKUP_DIR="$STATE_DIR/backups"
CONTAINER="${ASHARE_CONTAINER:-finance-mcp-ashare}"
DATA_DIR="${ASHARE_HOST_DATA_DIR:-$HOME/.local/share/finance-mcp-ashare}"
PRIVATE_DIR="${ASHARE_PRIVATE_HOST_DIR:-$HOME/.local/share/ashare-private}"
umask 077

echo "== 0. preconditions =="
echo "repo:     $REPO"
echo "revision: $REVISION"
echo "branch:   ${BRANCH:-$(git -C "$REPO" branch --show-current)}"
echo "container:$CONTAINER"

CLEAN="$(git -C "$REPO" status --porcelain --untracked-files=no | wc -l)"
[ "$CLEAN" -eq 0 ] || { echo "working tree is dirty ($CLEAN tracked changes); commit first" >&2; exit 3; }
HEAD="$(git -C "$REPO" rev-parse HEAD)"
[ "$HEAD" = "$REVISION" ] || { echo "HEAD $HEAD != --revision $REVISION" >&2; exit 3; }
if [ -n "$BRANCH" ]; then
  [ "$(git -C "$REPO" branch --show-current)" = "$BRANCH" ] || { echo "checked-out branch does not match --branch" >&2; exit 3; }
fi
if [ "$DRY" -eq 1 ]; then
  echo "dry run: would build candidate, back up market/private/OAuth/research/config, verify restoration, then replace the existing service"
  exit 0
fi
# Build before touching the running service; a build failure leaves production in place.
export ASHARE_GIT_REVISION="$REVISION"
export ASHARE_GIT_BRANCH="${BRANCH:-$(git -C "$REPO" branch --show-current)}"
export ASHARE_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker compose -f "$HERE/docker-compose.yml" build

OLD_IMAGE_ID="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || echo unknown)"
OLD_REPO_DIGEST="$(docker image inspect finance-mcp-ashare:local --format '{{index .RepoDigests 0}}' 2>/dev/null || echo none)"
echo "old image id: $OLD_IMAGE_ID"
echo "old repo digest: $OLD_REPO_DIGEST"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# Keep the previous image under its own tag so a rebuild cannot garbage-collect it.
# This used to be `docker tag ... || true`, which swallowed a failed tag and then printed the tag name
# anyway: the 2026-10-22 upgrade recorded rollback-20261022T161641Z, and that image never existed.
# A rollback record that names a missing image is worse than none, so a missing or unverifiable
# rollback image now stops the upgrade BEFORE the running service is touched.
if [ "$OLD_IMAGE_ID" = "unknown" ] && [ "${ASHARE_ALLOW_NO_ROLLBACK:-0}" != "1" ]; then
  echo "cannot identify the running image, so there is nothing to roll back to; set ASHARE_ALLOW_NO_ROLLBACK=1 only for a first install" >&2; exit 4
fi
if [ "$OLD_IMAGE_ID" != "unknown" ]; then
  docker tag "$OLD_IMAGE_ID" "finance-mcp-ashare:rollback-$STAMP" || { echo "failed to tag the rollback image; stopping before any change" >&2; exit 4; }
  docker image inspect "finance-mcp-ashare:rollback-$STAMP" >/dev/null 2>&1 || { echo "rollback image tag not present after tagging; stopping before any change" >&2; exit 4; }
  echo "rollback image tag: finance-mcp-ashare:rollback-$STAMP (verified present)"
fi
# A fresh timestamped backup every run; a stale single file would not match the
# database a rollback would actually start from.
BACKUP_SQLITE="$BACKUP_DIR/ashare.$STAMP.sqlite"
echo "== 1. consistent DB backup (VACUUM INTO) =="
sqlite3 "$DATA_DIR/ashare.sqlite" "VACUUM INTO '$BACKUP_SQLITE';"
sqlite3 "$BACKUP_SQLITE" "PRAGMA integrity_check;" | grep -qx ok || {
  echo "backup integrity_check failed" >&2; exit 4;
}
market_restore="$BACKUP_DIR/market.restore-check.$STAMP.sqlite"
sqlite3 "$market_restore" ".restore '$BACKUP_SQLITE'"
[ "$(sqlite3 "$market_restore" 'PRAGMA integrity_check;')" = "ok" ] || { echo "market restore verification failed" >&2; exit 4; }
rm "$market_restore"
# Keep the historical pre-V1.0 copy as well; symlink the newest for convenience.
ln -sfn "$BACKUP_SQLITE" "$BACKUP_DIR/ashare.latest.sqlite"

{
  echo "timestamp=$STAMP"
  echo "revision=$REVISION"
  echo "branch=${BRANCH:-}"
  echo "old_container_image=$OLD_IMAGE_ID"
  echo "rollback_image_tag=finance-mcp-ashare:rollback-$STAMP"
  echo "old_repo_digest=$OLD_REPO_DIGEST"
  echo "old_container_id=$(docker inspect "$CONTAINER" --format '{{.Id}}' 2>/dev/null || echo none)"
  echo "compose_config_hash=$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.config-hash"}}' 2>/dev/null || echo none)"
  echo "db_backup=$BACKUP_SQLITE"
  echo "db_sha256=$(sha256sum "$BACKUP_SQLITE" | cut -d' ' -f1)"
} | tee "$BACKUP_DIR/rollback-$STAMP.env"

# All databases use SQLite's online backup operation; never copy a live WAL file.
for spec in "$PRIVATE_DIR/portfolio.sqlite:portfolio" "$PRIVATE_DIR/oauth.sqlite:oauth" "$DATA_DIR/research.sqlite:research" "$DATA_DIR/research-validation/validation.sqlite:validation"; do
  source_db="${spec%:*}"; label="${spec##*:}"
  [ -f "$source_db" ] || continue
  target="$BACKUP_DIR/$label.$STAMP.sqlite"
  sqlite3 "$source_db" ".backup '$target'"
  [ "$(sqlite3 "$target" 'PRAGMA integrity_check;')" = "ok" ] || { echo "$label backup invalid" >&2; exit 4; }
  # Restore into an isolated scratch file and check it before any switch.
  restore_check="$BACKUP_DIR/$label.restore-check.$STAMP.sqlite"
  sqlite3 "$restore_check" ".restore '$target'"
  [ "$(sqlite3 "$restore_check" 'PRAGMA integrity_check;')" = "ok" ] || { echo "$label restore invalid" >&2; exit 4; }
  rm "$restore_check"
  printf '%s_backup=%s\n' "$label" "$target" >> "$BACKUP_DIR/rollback-$STAMP.env"
done
cp "$HERE/.env" "$BACKUP_DIR/private-config.$STAMP.env"
chmod 600 "$BACKUP_DIR/private-config.$STAMP.env"
config_files=("$HERE/docker-compose.yml")
for config in "$HOME/.config/systemd/user/finance-ashare-daily.service" "$HOME/.config/systemd/user/finance-ashare-daily.timer" "$HOME/.config/systemd/user/finance-ashare-account-daily.service" "$HOME/.config/systemd/user/finance-ashare-account-daily.timer"; do
  [ ! -f "$config" ] || config_files+=("$config")
done
tar -czf "$BACKUP_DIR/deploy-config.$STAMP.tar.gz" "${config_files[@]}"
echo "== 2. replace the same compose service using the prebuilt candidate =="
cd "$HERE"
docker compose up -d --no-build

echo "== 3. wait for health =="
for i in $(seq 1 60); do
  state="$(docker inspect "$CONTAINER" --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo missing)"
  [ "$state" = "running/healthy" ] && break
  sleep 2
done
echo "state: $state"
if [ "$state" != "running/healthy" ]; then
  echo "candidate unhealthy; restoring previous image (database backups retained)" >&2
  docker tag "$OLD_IMAGE_ID" finance-mcp-ashare:local
  docker compose up -d --no-build
  exit 5
fi

echo "== 4. revision label =="
ACTUAL_REVISION="$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
printf '%s\n' "$ACTUAL_REVISION"
[ "$ACTUAL_REVISION" = "$REVISION" ] || { echo "running image revision mismatch; stop acceptance" >&2; exit 6; }

echo "== 5. health endpoint =="
curl -fsS -m 10 http://127.0.0.1:8130/health; echo

echo "done. rollback record: $BACKUP_DIR/rollback-$STAMP.env"
