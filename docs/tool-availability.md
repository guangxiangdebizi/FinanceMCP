# Credential-Scoped MCP Tools

FinanceMCP advertises only tools backed by the credentials available to the
current MCP request. The same filter is enforced before `tools/call`, so a
client cannot bypass discovery by submitting a hidden tool name directly.

## Source policy

- `tushare`: Tushare-backed market, macro, company, fund, flow, and futures tools.
- `qveris`: the `qveris_finance` Discover/Inspect/Call aggregate entry.
- `public`: public providers such as Binance and Baidu News.
- `local`: local-only utilities such as `current_timestamp`.

When a request carries one or more API credentials, only tools backed by those
credential sources are advertised. Explicit request credentials take priority
over server environment fallbacks. This prevents a shared server-side token
from expanding a tenant's visible tool set.

When no credential is configured, only public and local tools are advertised.
For example:

- Qveris key only: `qveris_finance`.
- Tushare token only: Tushare-backed tools, including the mixed-source price tools.
- Both keys: the union of Qveris and Tushare tools.

Adding a new upstream source requires three changes:

1. Add its request/environment credential resolution in `src/config.ts`.
2. Add the source to `ToolSource` and map each covered tool in `src/dispatch.ts`.
3. Add request-list and direct-call tests for the new credential combination.
