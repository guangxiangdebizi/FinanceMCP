# Deploy Your Own Remote FinanceMCP Instance

FinanceMCP already serves a public Streamable HTTP endpoint at
[`https://finvestai.top/mcp`](https://finvestai.top/mcp). That endpoint is the
default and nothing here changes it.

This guide covers the other case: you want your own remote `/mcp` URL, on your
own account and your own credentials, without running a VPS or a Docker host.
It uses [Dockhold](https://dockhold.eu) as a worked example. The repo-side facts
below apply to any container platform that terminates HTTPS and assigns a port.

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

[![Deploy to Dockhold](https://img.shields.io/badge/Deploy%20to-Dockhold-2563eb?style=for-the-badge)](https://app.dockhold.eu/new?repo=https://github.com/guangxiangdebizi/FinanceMCP&name=finance-mcp)

The button opens Dockhold's deploy form with this repository prefilled. You
review every field before anything is created.

1. Click the button. To control when your instance picks up upstream changes,
   fork the repo first and point
   [app.dockhold.eu/new](https://app.dockhold.eu/new) at your fork instead.
2. The root `Dockerfile` is used automatically, so a free account needs nothing
   extra.
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

The HTTP server checks the `Host` header against `MCP_ALLOWED_HOSTS` for DNS
rebinding protection. Two consequences for a hosted deployment:

- Binding to `0.0.0.0` with `MCP_ALLOWED_HOSTS` unset leaves validation off and
  logs a `[SECURITY]` warning at startup. It serves traffic, but without the
  protection.
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

> [!WARNING]
> Apps on Dockhold's free plan are public. A public app with `TUSHARE_TOKEN` set
> server side lets anyone who knows the URL spend your Tushare quota. Either
> leave it unset and pass the token per request, or put the app behind an access
> token (a paid Dockhold feature) before setting it.

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

Check the deployment before wiring a client into it:

```bash
curl https://<your-app>.dockhold.app/health

curl -X POST https://<your-app>.dockhold.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'X-Tushare-Token: YOUR_TUSHARE_TOKEN' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Sizing and operations

- The server keeps no state on disk, so an ephemeral filesystem is fine and no
  volume is needed.
- It idles at roughly 25 MB RSS, so Dockhold's free 256 MB app size covers
  personal use. Increase it if you expect concurrent traffic.
- The built image is roughly 200 MB, under the 300 MB image ceiling that applies
  to free accounts.
- Dockhold restarts the process if it exits, and there is no separate
  health-check hook to configure, so use `GET /health` for your own uptime
  monitoring.
- Logs, CPU, and memory are in the app's dashboard. The server logs every
  request and shows sensitive headers as `[REDACTED]`.

Dockhold documentation: <https://dockhold.eu/docs>. Its MCP-specific recipe:
<https://dockhold.eu/docs/recipes/deploy-an-mcp-server>.
