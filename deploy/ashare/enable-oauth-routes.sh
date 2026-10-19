#!/usr/bin/env bash
# Add the OAuth 2.1 discovery and authorization routes to Caddy.
#
# Run from a REAL terminal (sudo needs a password prompt):
#     sudo /tmp/enable-oauth-routes.sh
#
# Why these routes: ChatGPT reads the discovery documents from the origin root,
# so /.well-known/oauth-* and /oauth/* must reach the same container as
# /private/mcp.
#
# Safety: timestamped backup, idempotent, validate BEFORE installing, restore
# and reload on failure.
#
# Note: the working file is created next to the Caddyfile, not in /tmp. On this
# host fs.protected_regular=2 rejects writing a /tmp file whose ownership was
# changed by `cp -a`, which made the previous version fail.
set -euo pipefail

CADDYFILE=/etc/caddy/Caddyfile
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/etc/caddy/Caddyfile.bak.${STAMP}"

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root: sudo $0" >&2
  exit 1
fi

if grep -q 'handle /.well-known/oauth-protected-resource' "$CADDYFILE"; then
  echo "== OAuth routes already present; nothing to do =="
  exit 0
fi

echo "== 0. current state =="
sha256sum "$CADDYFILE"
systemctl is-active caddy

echo "== 1. backup -> $BACKUP =="
cat "$CADDYFILE" > "$BACKUP"
chmod 0644 "$BACKUP"

NEW="/etc/caddy/Caddyfile.new.$$"
trap 'rm -f "$NEW"' EXIT

echo "== 2. build candidate =="
python3 - "$CADDYFILE" "$NEW" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
block = (
    "\t# OAuth 2.1 discovery and authorization endpoints for the private account\n"
    "\t# MCP. Same container as /ashare/mcp; only metadata and token exchange.\n"
    "\thandle /.well-known/oauth-protected-resource* {\n"
    "\t\treverse_proxy 127.0.0.1:8130\n"
    "\t}\n"
    "\thandle /.well-known/oauth-authorization-server* {\n"
    "\t\treverse_proxy 127.0.0.1:8130\n"
    "\t}\n"
    "\thandle /oauth/* {\n"
    "\t\treverse_proxy 127.0.0.1:8130\n"
    "\t}\n\n"
)
marker = "\t# X Full Reader MCP (streamable HTTP) - local loopback upstream."
if marker not in s:
    sys.exit("cannot find insertion marker in Caddyfile")
open(dst, "w").write(s.replace(marker, block + marker, 1))
PY

echo "== 3. validate candidate =="
if ! caddy validate --adapter caddyfile --config "$NEW" >/tmp/caddy-validate-oauth.log 2>&1; then
  echo "VALIDATION FAILED - nothing installed:" >&2
  tail -20 /tmp/caddy-validate-oauth.log >&2
  exit 2
fi
tail -1 /tmp/caddy-validate-oauth.log

echo "== 4. install =="
mv -f "$NEW" "$CADDYFILE"

echo "== 5. reload =="
if ! systemctl reload caddy; then
  echo "RELOAD FAILED - restoring $BACKUP" >&2
  cat "$BACKUP" > "$CADDYFILE"
  systemctl reload caddy || true
  exit 3
fi

echo "== 6. result =="
systemctl is-active caddy
sha256sum "$CADDYFILE"
diff -u "$BACKUP" "$CADDYFILE" || true

echo
echo "done. rollback with:  sudo cp -a $BACKUP $CADDYFILE && sudo systemctl reload caddy"
