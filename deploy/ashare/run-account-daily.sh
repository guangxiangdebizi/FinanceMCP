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
if docker exec "$CONTAINER" node build/ashare/cli.js investment-research-record >"$OUT" 2>"$ERR"; then
  printf 'finance-ashare account-daily ok (private log: %s)\n' "$OUT"
else
  code=$?
  printf 'finance-ashare account-daily FAILED (exit %s); see private log %s\n' "$code" "$ERR" >&2
  exit "$code"
fi
