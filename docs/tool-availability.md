# Credential-Scoped MCP Tools

FinanceMCP advertises only tools backed by sources available to the current
MCP request. The same source check runs before `tools/call`, so a client cannot
bypass discovery by submitting a hidden tool name directly.

## Source policy

- `tushare`: native market, macro, company, fund, flow, and futures tools.
- `qveris`: tools covered by the Qveris adapter's Discover/Inspect/Probe/Call
  route, including historical prices, indexes, macro data, company data, news,
  and CSI constituents.
- `binance`: public crypto price tools.
- `web`: public finance news.
- `local`: local-only utilities such as `current_timestamp`.

When a request carries one or more API credentials, only tools backed by those
credential sources are advertised. Explicit request credentials take priority
over server environment fallbacks, so a shared server-side token does not
expand another tenant's visible tool set.

When no credential is configured, only public and local tools are advertised.
For example:

- Qveris key only: Qveris-covered existing tools.
- Tushare token only: Tushare-backed tools.
- Both keys: the union of Tushare and Qveris-covered tools.

Adding a new source requires updating its credential resolution in
`src/config.ts`, mapping covered tools in `src/dispatch.ts`, and adding list
and direct-call tests for the new credential combination.
