#!/usr/bin/env bash
# Add the OAuth 2.1 discovery and authorization routes to Caddy.
#
# Run from a REAL terminal (sudo needs a password prompt):
#     sudo /tmp/enable-oauth-routes.sh
#
# The private MCP endpoint already works over /private/mcp. ChatGPT only starts
# the OAuth flow after it can read the protected-resource metadata, so these
# origin-level paths must reach the same container:
#     /.well-known/oauth-protected-resource*      (RFC 9728)
#     /.well-known/oauth-authorization-server*    (RFC 8414)
#     /oauth/*                                    (authorize/token/register/revoke)
#
# Safety: timestamped backup, idempotent, validate before reload, restore on
# failure.
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
cp -a "$CADDYFILE" "$BACKUP"

WORK="$(mktemp)"
cp -a "$CADDYFILE" "$WORK"

python3 - "$WORK" <<'PY'
import sys
path = sys.argv[1]
s = open(path).read()
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
open(path, "w").write(s.replace(marker, block + marker, 1))
PY

echo "== 2. validate candidate =="
if ! caddy validate --adapter caddyfile --config "$WORK" >/tmp/caddy-validate-oauth.log 2>&1; then
  echo "VALIDATION FAILED - nothing changed:" >&2
  tail -20 /tmp/caddy-validate-oauth.log >&2
  rm -f "$WORK"
  exit 2
fi
tail -1 /tmp/caddy-validate-oauth.log

echo "== 3. install =="
cp -a "$WORK" "$CADDYFILE"
rm -f "$WORK"

echo "== 4. reload =="
if ! systemctl reload caddy; then
  echo "RELOAD FAILED - restoring $BACKUP" >&2
  cp -a "$BACKUP" "$CADDYFILE"
  systemctl reload caddy || true
  exit 3
fi

echo "== 5. result =="
systemctl is-active caddy
sha256sum "$CADDYFILE"
diff -u "$BACKUP" "$CADDYFILE" || true

echo
echo "done. rollback with:  sudo cp -a $BACKUP $CADDYFILE && sudo systemctl reload caddy"
