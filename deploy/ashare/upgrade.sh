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

echo "== 0. preconditions =="
echo "repo:     $REPO"
echo "revision: $REVISION"
echo "branch:   ${BRANCH:-$(git -C "$REPO" branch --show-current)}"
echo "container:$CONTAINER"

CLEAN="$(git -C "$REPO" status --porcelain --untracked-files=no | wc -l)"
[ "$CLEAN" -eq 0 ] || { echo "working tree is dirty ($CLEAN tracked changes); commit first" >&2; exit 3; }
HEAD="$(git -C "$REPO" rev-parse HEAD)"
[ "$HEAD" = "$REVISION" ] || { echo "HEAD $HEAD != --revision $REVISION" >&2; exit 3; }

OLD_IMAGE_ID="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || echo unknown)"
OLD_REPO_DIGEST="$(docker image inspect finance-mcp-ashare:local --format '{{index .RepoDigests 0}}' 2>/dev/null || echo none)"
echo "old image id: $OLD_IMAGE_ID"
echo "old repo digest: $OLD_REPO_DIGEST"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if [ ! -f "$BACKUP_DIR/ashare.pre-v1.0.sqlite" ]; then
  echo "== 1. consistent DB backup (VACUUM INTO) =="
  sqlite3 "$DATA_DIR/ashare.sqlite" "VACUUM INTO '$BACKUP_DIR/ashare.pre-v1.0.sqlite';"
else
  echo "== 1. pre-upgrade backup already present =="
fi
sqlite3 "$BACKUP_DIR/ashare.pre-v1.0.sqlite" "PRAGMA integrity_check;" | grep -qx ok || {
  echo "backup integrity_check failed" >&2; exit 4;
}

{
  echo "timestamp=$STAMP"
  echo "revision=$REVISION"
  echo "branch=${BRANCH:-}"
  echo "old_container_image=$OLD_IMAGE_ID"
  echo "old_repo_digest=$OLD_REPO_DIGEST"
  echo "old_container_id=$(docker inspect "$CONTAINER" --format '{{.Id}}' 2>/dev/null || echo none)"
  echo "compose_config_hash=$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.config-hash"}}' 2>/dev/null || echo none)"
  echo "db_sha256=$(sha256sum "$BACKUP_DIR/ashare.pre-v1.0.sqlite" | cut -d' ' -f1)"
} | tee "$BACKUP_DIR/rollback-$STAMP.env"

if [ "$DRY" -eq 1 ]; then
  echo "dry run: would run 'docker compose up -d --build' in $HERE"
  exit 0
fi

echo "== 2. rebuild and replace the same compose service in place =="
cd "$HERE"
export ASHARE_GIT_REVISION="$REVISION"
export ASHARE_GIT_BRANCH="${BRANCH:-$(git -C "$REPO" branch --show-current)}"
export ASHARE_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker compose up -d --build

echo "== 3. wait for health =="
for i in $(seq 1 60); do
  state="$(docker inspect "$CONTAINER" --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo missing)"
  [ "$state" = "running/healthy" ] && break
  sleep 2
done
echo "state: $state"
[ "$state" = "running/healthy" ] || { echo "container did not become healthy" >&2; exit 5; }

echo "== 4. revision label =="
docker inspect "$CONTAINER" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'

echo "== 5. health endpoint =="
curl -fsS -m 10 http://127.0.0.1:8130/health; echo

echo "done. rollback record: $BACKUP_DIR/rollback-$STAMP.env"
