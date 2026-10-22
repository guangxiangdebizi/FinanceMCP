#!/bin/sh
# Use the existing production container's Node runtime and private volume.
set -eu
umask 077
CONTAINER="${ASHARE_CONTAINER:-finance-mcp-ashare}"
PRIVATE_DIR="${ASHARE_PRIVATE_HOST_DIR:-$HOME/.local/share/ashare-private}"
LOG_DIR="$PRIVATE_DIR/logs"
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"
STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)"
OUT="$LOG_DIR/account-daily-$STAMP.json"
ERR="$LOG_DIR/account-daily-$STAMP.log"
if ! docker info >/dev/null 2>&1 && [ -z "${ASHARE_SG_REEXEC:-}" ] && getent group docker | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then
  ASHARE_SG_REEXEC=1 exec sg docker -c "ASHARE_SG_REEXEC=1 $0"
fi
# No host shell sourcing of credentials and no dependency on login-shell Node PATH.
# 1) record the VPS raw research snapshot into the immutable journal;
# 2) always run the forward review (append matured-window evaluations, write the review file),
#    even if step 1 reported DATA_INSUFFICIENT, so earlier windows keep maturing;
# 3) exit non-zero if either step failed so the unit is visibly failed in journald.
REVIEW_OUT="$LOG_DIR/forward-review-$STAMP.json"
REVIEW_ERR="$LOG_DIR/forward-review-$STAMP.log"
record_code=0
if docker exec "$CONTAINER" node build/ashare/cli.js investment-research-record >"$OUT" 2>"$ERR"; then
  printf 'finance-ashare account-daily ok (private log: %s)\n' "$OUT"
else
  record_code=$?
  printf 'finance-ashare account-daily FAILED (exit %s); see private log %s\n' "$record_code" "$ERR" >&2
fi
review_code=0
if docker exec "$CONTAINER" node build/ashare/cli.js portfolio-journal-review --record --confirm >"$REVIEW_OUT" 2>"$REVIEW_ERR"; then
  printf 'finance-ashare forward-review ok (private log: %s)\n' "$REVIEW_OUT"
else
  review_code=$?
  printf 'finance-ashare forward-review FAILED (exit %s); see private log %s\n' "$review_code" "$REVIEW_ERR" >&2
fi
[ "$record_code" -ne 0 ] && exit "$record_code"
[ "$review_code" -ne 0 ] && exit 77
exit 0
