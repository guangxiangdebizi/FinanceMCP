#!/bin/sh
# 账户研究日报 + 前瞻记录的定时入口。
#
# 与 run-daily.sh 一样，在缺少 docker 补充组的 systemd user manager 下重新执行，
# 但这里不调用 docker：它直接运行仓库内的 Node（宿主机 node >= 20）。
set -eu
DATA_DIR="${ASHARE_HOST_DATA_DIR:-$HOME/.local/share/finance-mcp-ashare}"
LOG_DIR="$DATA_DIR/logs"
mkdir -p "$LOG_DIR"
STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)"
OUT="$LOG_DIR/account-daily-$STAMP.json"
ERR="$LOG_DIR/account-daily-$STAMP.log"
REPO="${ASHARE_REPO:-$HOME/workspace/FinanceMCP}"

# 账户库与市场库都在宿主机上；令牌/变量由 .env 提供。
if [ -f "$REPO/deploy/ashare/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO/deploy/ashare/.env"
  set +a
fi
export ASHARE_DATA_DIR="$DATA_DIR"
export ASHARE_DB_PATH="${ASHARE_DB_PATH:-$DATA_DIR/ashare.sqlite}"
export ASHARE_PORTFOLIO_DB_PATH="${ASHARE_PORTFOLIO_DB_PATH:-$HOME/.local/share/ashare-private/portfolio.sqlite}"
export ASHARE_ACCOUNT_REPORT_DIR="${ASHARE_ACCOUNT_REPORT_DIR:-$DATA_DIR/account-reports}"

if node "$REPO/deploy/ashare/run-account-daily.mjs" --record >"$OUT" 2>"$ERR"; then
  echo "finance-ashare account-daily ok: $OUT"
  grep -E '"(as_of_trade_date|account_id|status|plan_id|recorded)"' "$OUT" | head -6
else
  code=$?
  echo "finance-ashare account-daily FAILED (exit $code), see $ERR" >&2
  tail -20 "$ERR" >&2
  exit "$code"
fi
