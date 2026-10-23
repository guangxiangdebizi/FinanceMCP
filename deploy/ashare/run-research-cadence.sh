#!/bin/sh
# Weekly / monthly research cadence report, run inside the EXISTING production container.
#   usage: run-research-cadence.sh weekly|monthly
#
# The activation switch is set HERE (docker exec -e), not in the container's environment, so
# "is this cadence live" is answered by whether a reviewed unit file calls this script.
# Bounds: `timeout -s KILL` caps wall-clock and --max-old-space-size caps the Node heap, which
# is the resource bound the in-process modules do not have.
# A skip (disabled / not_enough_history / no_candidates / ...) is a legitimate outcome and exits 0,
# but it is printed as SKIPPED(<reason>) so it cannot be mistaken for a produced report.
set -eu
umask 077
CADENCE="${1:?usage: run-research-cadence.sh weekly|monthly}"
case "$CADENCE" in weekly|monthly) ;; *) echo "unknown cadence: $CADENCE" >&2; exit 2 ;; esac
CONTAINER="${ASHARE_CONTAINER:-finance-mcp-ashare}"
ACCOUNT="${ASHARE_CADENCE_ACCOUNT:-real-main}"
BUDGET_SECONDS="${ASHARE_CADENCE_TIMEOUT:-600}"
HEAP_MB="${ASHARE_CADENCE_HEAP_MB:-512}"
PRIVATE_DIR="${ASHARE_PRIVATE_HOST_DIR:-$HOME/.local/share/ashare-private}"
LOG_DIR="$PRIVATE_DIR/logs"
mkdir -p "$LOG_DIR"; chmod 700 "$LOG_DIR"
STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)"
OUT="$LOG_DIR/cadence-$CADENCE-$STAMP.json"
ERR="$LOG_DIR/cadence-$CADENCE-$STAMP.log"
if ! docker info >/dev/null 2>&1 && [ -z "${ASHARE_SG_REEXEC:-}" ] && getent group docker | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then
  ASHARE_SG_REEXEC=1 exec sg docker -c "ASHARE_SG_REEXEC=1 $0 $CADENCE"
fi
code=0
docker exec -e RESEARCH_CADENCE_ENABLED=1 -e NODE_OPTIONS="--max-old-space-size=$HEAP_MB" "$CONTAINER" \
  timeout -s KILL "$BUDGET_SECONDS" node build/ashare/cli.js research-cadence "$CADENCE" --as-of latest --account-id "$ACCOUNT" >"$OUT" 2>"$ERR" || code=$?
if [ "$code" -ne 0 ]; then
  [ "$code" -eq 137 ] && echo "finance-ashare cadence $CADENCE KILLED after ${BUDGET_SECONDS}s budget; see $ERR" >&2
  echo "finance-ashare cadence $CADENCE FAILED (exit $code); see private log $ERR" >&2
  exit "$code"
fi
reason="$(grep -o '"skip_reason": *"[a-z_]*"' "$OUT" | head -1 | sed 's/.*: *"\(.*\)"/\1/' || true)"
if grep -q '"produced": *true' "$OUT"; then
  echo "finance-ashare cadence $CADENCE produced (private log: $OUT)"
elif [ -n "$reason" ]; then
  echo "finance-ashare cadence $CADENCE SKIPPED($reason) (private log: $OUT)"
else
  echo "finance-ashare cadence $CADENCE produced nothing and gave no reason; see $OUT" >&2
  exit 78
fi
