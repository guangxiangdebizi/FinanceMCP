#!/bin/sh
# Bootstrap the PRIVATE real-account ledger for AShareInvestor V1.0.
#
# Runs on the Oracle VPS against the deployed FinanceMCP container. It never
# prints account amounts to stdout beyond what the local operator needs, never
# writes to Git, and never touches the public market database.
#
# Usage:
#   init-private-account.sh <snapshot.json> [--account ID] [--as-of YYYYMMDD] [--confirm-current]
#
# The snapshot JSON must match the AccountSnapshot schema (integer cents for
# amounts, integer milli-yuan for prices, integer shares for quantities):
#   { snapshot_id, as_of, source, note, warnings, is_current,
#     positions: [{ts_code,name,quantity,ref_price_milli,ref_cost_milli,market_value_cents}],
#     totals: { total_assets_cents, securities_mv_cents, cash_cents, wealth_cents, unrealized_pnl_cents } }
#
# Safety: this script creates the private data directory, runs a DRY RUN first,
# and requires the operator to pass --apply to actually write.
set -eu

APPLY=0
ARGS=""
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    *) ARGS="$ARGS $a" ;;
  esac
done
set -- $ARGS

SNAPSHOT="${1:?usage: init-private-account.sh <snapshot.json> [--account ID] [--as-of YYYYMMDD] [--confirm-current] [--apply]}"
shift || true

CONTAINER="${ASHARE_CONTAINER:-finance-mcp-ashare}"
PRIVATE_DIR="${ASHARE_PRIVATE_HOST_DIR:-$HOME/.local/share/ashare-private}"
ACCOUNT="${ASHARE_ACCOUNT_ID:-real-main}"
DB="$PRIVATE_DIR/portfolio.sqlite"

mkdir -p "$PRIVATE_DIR"
chmod 700 "$PRIVATE_DIR"
if [ ! -f "$SNAPSHOT" ]; then
  echo "snapshot file not found: $SNAPSHOT" >&2
  exit 2
fi
cp -f "$SNAPSHOT" "$PRIVATE_DIR/$(basename "$SNAPSHOT")"
chmod 600 "$PRIVATE_DIR/$(basename "$SNAPSHOT")"
SNAPSHOT_IN_CONTAINER="/private/$(basename "$SNAPSHOT")"

run() { docker exec "$CONTAINER" node build/ashare/cli.js "$@"; }

echo "== 1. dry run (validation + per-item reconciliation, no write) =="
run portfolio-import --file "$SNAPSHOT_IN_CONTAINER" --dry-run --db "$DB" "$@"

if [ "$APPLY" -ne 1 ]; then
  echo
  echo "dry run only. Re-run with --apply to import, then initialize the ledger baseline."
  exit 0
fi

echo "== 2. import the confirmed snapshot =="
run portfolio-import --file "$SNAPSHOT_IN_CONTAINER" --db "$DB" --confirm-current "$@"

SNAP_ID="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('$SNAPSHOT','utf8'));process.stdout.write(String(j.snapshot_id))")"
AS_OF="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('$SNAPSHOT','utf8'));process.stdout.write(String(j.as_of).replace(/-/g,''))")"

echo "== 3. initialize the ledger baseline at $AS_OF (snapshot $SNAP_ID) =="
run portfolio-ledger-init --account "$ACCOUNT" --as-of "$AS_OF" --snapshot "$SNAP_ID" --db "$DB"

echo "== 4. declare completeness (no unreported trades known through $AS_OF) =="
run portfolio-completeness-set --account "$ACCOUNT" --as-of "$AS_OF" \
  --last-reconciled-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --events-through "$AS_OF" --unreported-risk no --recorded-by operator --confirm --db "$DB"

echo "== 5. the user themselves confirms the ledger is the real account =="
echo "   run: docker exec $CONTAINER node build/ashare/cli.js \\"
echo "        portfolio-ledger-confirm-real --account $ACCOUNT --confirm --db $DB"

echo
echo "done. Private ledger: $DB (mode 700 directory; never commit this path)."
