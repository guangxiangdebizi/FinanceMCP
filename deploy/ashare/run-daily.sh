#!/bin/sh
# Trading-day pipeline entry point used by the systemd timer:
# sync (batch by trade date) -> quality check -> analysis -> JSON report snapshot.
set -eu
# A systemd user manager started before the account joined the docker group
# lacks that group; re-exec under it so `docker exec` can reach the socket.
if ! docker info >/dev/null 2>&1 && [ -z "${ASHARE_SG_REEXEC:-}" ] && getent group docker | cut -d: -f4 | tr "," "\n" | grep -qx "$(id -un)"; then
  ASHARE_SG_REEXEC=1 exec sg docker -c "ASHARE_SG_REEXEC=1 $0 $*"
fi
DATA_DIR="${ASHARE_HOST_DATA_DIR:-$HOME/.local/share/finance-mcp-ashare}"
LOG_DIR="$DATA_DIR/logs"
mkdir -p "$LOG_DIR"
STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)"
OUT="$LOG_DIR/daily-$STAMP.json"
ERR="$LOG_DIR/daily-$STAMP.log"
CONTAINER="${ASHARE_CONTAINER:-finance-mcp-ashare}"

# After a reboot the timer (Persistent=true) can fire before the docker daemon or the
# container is up; the user manager cannot order itself after the system docker.service.
# Wait a bounded time, then fail loudly so the unit is marked failed in journald.
WAIT="${ASHARE_DOCKER_WAIT_SECONDS:-300}"
waited=0
until state="$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)" \
  && { [ "$state" = "running/healthy" ] || [ "$state" = "running/none" ]; }; do
  if [ "$waited" -ge "$WAIT" ]; then
    if ! docker info >/dev/null 2>&1; then
      echo "finance-ashare daily FAILED: docker daemon not reachable after ${WAIT}s" | tee "$ERR" >&2
    else
      echo "finance-ashare daily FAILED: container $CONTAINER not ready after ${WAIT}s (state: ${state:-missing})" | tee "$ERR" >&2
    fi
    exit 75
  fi
  sleep 10
  waited=$((waited + 10))
done
[ "$waited" -gt 0 ] && echo "waited ${waited}s for $CONTAINER ($state)"
if docker exec "$CONTAINER" node build/ashare/cli.js daily "$@" >"$OUT" 2>"$ERR"; then
  echo "finance-ashare daily ok: $OUT"
  grep -E '"(report_id|status|trade_date|skipped)"' "$OUT" | head -5
  # Observe frozen research only after the market pipeline finishes. Uses the same
  # container runtime and a separate registry, never rewriting the live pool.
  if docker exec "$CONTAINER" test -f /data/research-validation/validation.sqlite; then
    if docker exec "$CONTAINER" node build/ashare/cli.js research-validation observe \
      --source /data/ashare.sqlite --research-db /data/research-validation/validation.sqlite \
      >"$LOG_DIR/validation-$STAMP.json" 2>"$LOG_DIR/validation-$STAMP.log"; then
      echo "finance-ashare validation observation finished: $LOG_DIR/validation-$STAMP.json"
    else
      echo "finance-ashare validation observation FAILED (market report retained); see $LOG_DIR/validation-$STAMP.log" >&2
      exit 76
    fi
  else
    # Not an error, but never silent: without a frozen protocol nothing counts as forward observation.
    echo "finance-ashare validation observation SKIPPED: no frozen protocol (/data/research-validation/validation.sqlite missing); run 'research-validation freeze' to start the forward record" >&2
  fi
else
  code=$?
  echo "finance-ashare daily FAILED (exit $code), see $ERR" >&2
  tail -20 "$ERR" >&2
  exit "$code"
fi
