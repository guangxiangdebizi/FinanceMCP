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
if docker exec finance-mcp-ashare node build/ashare/cli.js daily "$@" >"$OUT" 2>"$ERR"; then
  echo "finance-ashare daily ok: $OUT"
  grep -E '"(report_id|status|trade_date|skipped)"' "$OUT" | head -5
else
  code=$?
  echo "finance-ashare daily FAILED (exit $code), see $ERR" >&2
  tail -20 "$ERR" >&2
  exit "$code"
fi
