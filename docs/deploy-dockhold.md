# Deploy Your Own Remote FinanceMCP Instance

FinanceMCP already serves a public Streamable HTTP endpoint at
[`https://finvestai.top/mcp`](https://finvestai.top/mcp). That endpoint is the
default and nothing here changes it.

This guide covers the other case: you want a dedicated remote `/mcp` URL, on
your own account and your own credentials, without running a VPS or a Docker
host. It uses [Dockhold](https://dockhold.eu) as a worked example.

> [!NOTE]
> Dockhold is one worked example of a managed host, not an affiliated or
> preferred FinanceMCP platform. The hosted endpoint above and a generic
> container deployment remain the primary paths. Everything under "What the repo
> already provides" is platform-neutral and applies to any host that runs the
> root `Dockerfile`, terminates HTTPS, and assigns a port.

## What the repo already provides

Nothing in this section needs changing. It is listed so you know what the
platform is running.

| Item | Value |
|---|---|
| Start command | `node build/httpServer.js` (the `Dockerfile` `CMD`) |
| Build | Root `Dockerfile`, multi-stage, `node:lts-alpine`, non-root `appuser` |
| Bind address | `MCP_HTTP_HOST`, already set to `0.0.0.0` by the `Dockerfile` |
| Port | `PORT`, default `3000`, overridden by whatever the platform injects |
| MCP endpoint | `POST /mcp` (Streamable HTTP), `GET /mcp` for the SSE stream |
| Health check | `GET /health`, returns `{"status":"healthy",...}` as JSON |
| State | In memory only. No volume, no database, no disk writes. |

## Deploy

1. Open the
   [Dockhold deploy form for this repository](https://app.dockhold.eu/new?repo=https://github.com/guangxiangdebizi/FinanceMCP).
   The link prefills the repository field. Nothing is created until you submit
   the form. To control when your instance picks up upstream changes, fork the
   repo first and point the form at your fork instead.
2. Dockhold builds from the root `Dockerfile`.
3. Set the variables in the next section. Credentials go in the Vault, not in
   plain dashboard variables.
4. Deploy. The app comes up at `https://<your-app>.dockhold.app` and your MCP
   endpoint is `https://<your-app>.dockhold.app/mcp`. HTTPS is handled for you.

If you deployed a fork with GitHub connected, later pushes to its main branch
redeploy automatically.

## Platform configuration

| Variable | Where | Value |
|---|---|---|
| `PORT` | injected by the platform | Do not set it. The server reads it. |
| `MCP_HTTP_HOST` | already `0.0.0.0` in the `Dockerfile` | Only set it if you build differently. |
| `MCP_ALLOWED_HOSTS` | dashboard variable | The hostname the app actually serves on. See below. |
| `TUSHARE_TOKEN` | Vault, optional | See credentials below. |
| `QVERIS_API_KEY` | Vault, optional | Same. |
| `QVERIS_BASE_URL` | dashboard variable, optional | Defaults to `https://qveris.ai/api/v1`. |
| `FINANCE_SOURCE_PRIORITY` | dashboard variable, optional | For example `tushare,qveris,binance`. |

## Host header validation

The HTTP server can check the `Host` header against `MCP_ALLOWED_HOSTS` for DNS
rebinding protection. Setting it is strongly recommended for any non-loopback
deployment that is reachable from the internet. It is not required to run.

- With `MCP_ALLOWED_HOSTS` unset and the server bound to `0.0.0.0`, validation
  is off. The server starts normally and serves every request, and it logs a
  `[SECURITY]` warning at startup.
- With it set, the match is on hostname and ignores the port, so the bare
  hostname is enough. Any request arriving with a different `Host`, `/health`
  included, gets a `403`. If you attach a custom domain, add it to the list,
  comma separated.

Use the hostname the app is actually served on, which is assigned at deploy time
and is not always the app name you picked. It can carry a suffix, so an app
named `finance-mcp` may land on `finance-mcp-a1b2c3.dockhold.app`. Read the real
hostname from the dashboard after the first deploy, then set the variable.

Confirm it afterwards:

```bash
curl -i https://<your-app>.dockhold.app/health
```

A `200` means the value matches. A `403` means it does not match the `Host` your
app receives, and the app will reject every request until you correct it.

## Credentials

FinanceMCP accepts credentials two ways and both keep working here.

**Per request.** The client sends `X-Tushare-Token` and `X-Qveris-Api-Key` on
every call and the server stores nothing. Credential-scoped discovery means a
caller with no token sees only the tools that need no credential, so an exposed
URL does not expose your Tushare quota. This is the safer default for an
endpoint that anyone can reach.

**Server side.** Put `TUSHARE_TOKEN` and `QVERIS_API_KEY` in the Dockhold Vault,
which encrypts them and injects them as environment variables at runtime. Every
caller then shares your quota, so use this only on an endpoint whose access you
control.

> [!IMPORTANT]
> Per-request credentials still cross your hosting provider's infrastructure.
> They travel over HTTPS, but TLS is terminated at the platform edge, so the
> host is inside the trust boundary for every provider token you send. This is
> true of any managed platform, not only Dockhold. FinanceMCP does not persist
> credentials and redacts them from its own logs, and that covers FinanceMCP's
> logs only. It says nothing about edge, proxy, or platform logging you do not
> control. Treat a managed host like any other party you hand a provider token
> to, and prefer credentials you can scope and rotate.

> [!WARNING]
> Whether an app is publicly reachable depends on your plan. On a plan where the
> app is public, setting `TUSHARE_TOKEN` server side lets anyone who knows the
> URL spend your Tushare quota. Either leave it unset and pass the token per
> request, or put the app behind an access token before setting it. Check
> Dockhold's current plan behaviour at <https://dockhold.eu/pricing>.

If you do lock the app down, note that Dockhold's edge uses
`Authorization: Bearer <dockhold-token>` for its own access check, and
FinanceMCP also accepts `Authorization: Bearer` as a Tushare token form. Use the
dedicated `X-Tushare-Token` header for the Tushare credential so the two do not
collide.

## Connect a client

```json
{
  "mcpServers": {
    "finance-mcp": {
      "type": "streamableHttp",
      "url": "https://<your-app>.dockhold.app/mcp",
      "timeout": 600,
      "headers": {
        "X-Tushare-Token": "YOUR_TUSHARE_TOKEN",
        "X-Qveris-Api-Key": "YOUR_QVERIS_API_KEY"
      }
    }
  }
}
```

## Verify the deployment

Run a full Streamable HTTP handshake rather than a bare `tools/list`, so you
exercise the same sequence a real client uses.

```bash
BASE=https://<your-app>.dockhold.app

# 1. Liveness.
curl -fsS "$BASE/health"

# 2. Initialize, and keep the session id the server returns.
SID=$(curl -sS -D - -o /dev/null -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}' \
  | tr -d '\r' | grep -i '^mcp-session-id:' | cut -d' ' -f2)
echo "session: $SID"

# 3. Complete the handshake. Expect 204.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 4. List tools on that session.
curl -sS -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' \
  -H "Mcp-Session-Id: $SID" \
  -H 'X-Tushare-Token: YOUR_TUSHARE_TOKEN' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Step 2 should print a UUID. Step 3 should print `204`. Step 4 should return the
tools your credentials unlock, which is more than the keyless set.

## Sizing and operations

- The server keeps no state on disk, so an ephemeral filesystem is enough and no
  volume is needed. That is a property of FinanceMCP, not of any host.
- Measured from this repo's `Dockerfile` on 2026-08-24: the image builds to
  roughly 200 MB and the server idles at roughly 25 MB RSS in a container
  limited to 256 MB and 0.25 vCPU.
- Use `GET /health` for your own uptime monitoring.
- The server logs every request and shows sensitive headers as `[REDACTED]`.

Platform specifics change, so this repository does not restate them as fixed
values. App sizes, image size ceilings, which plans expose an app publicly,
restart behaviour, and whether a configurable health-check hook exists were
checked on 2026-08-24. Confirm the current ones before relying on them:

- Plans and limits: <https://dockhold.eu/pricing>
- Runtime behaviour and injected variables: <https://dockhold.eu/docs/concepts/runtime>
- Documentation: <https://dockhold.eu/docs>
- MCP-specific recipe: <https://dockhold.eu/docs/recipes/deploy-an-mcp-server>
