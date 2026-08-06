[![中文](https://img.shields.io/badge/中文-README.md-red?logo=github)](README.md)

# FinanceMCP (Synapse)

[![MCP Toplist](https://mcptoplist.com/badge/pulsemcp%2Fguangxiangdebizi-finance-market-data.svg)](https://mcptoplist.com/server/pulsemcp%2Fguangxiangdebizi-finance-market-data)
[![Smithery](https://smithery.ai/badge/@guangxiangdebizi/FinanceMCP)](https://smithery.ai/server/@guangxiangdebizi/FinanceMCP)
[![npm](https://img.shields.io/npm/v/finance-mcp)](https://www.npmjs.com/package/finance-mcp)

<div align="center">
  <img src="LOGO/LOGO.png" alt="FinanceMCP Logo" width="290"/>
</div>

FinanceMCP is a financial data server for Claude, Cursor, and other MCP clients. Version **4.9.0** exposes 19 stable tools and routes them across Tushare, optional Qveris, and Binance without changing existing tool names or arguments.

- **Tushare**: China, Hong Kong, US, fund, bond, macro, and specialist market data
- **Qveris (optional)**: additional quotes, company profiles, statements, macro data, and news
- **Binance**: crypto daily and intraday candles without an API key
- **Automatic fallback**: continue through the request's source order when a provider is unsupported or unavailable
- **Source transparency**: every result identifies the selected source and any fallback path

Online demo: [https://finvestai.top/](https://finvestai.top/)

## Data-source routing

### No new tools or tool arguments

v4.9.0 does not add MCP tools and does not add a `data_source` argument. The HTTP server selects providers from credentials attached to the current request:

```http
X-Tushare-Token: YOUR_TUSHARE_TOKEN
X-Qveris-Api-Key: YOUR_QVERIS_API_KEY
X-Finance-Source-Priority: qveris,tushare,binance
```

The default order is:

```text
tushare,qveris,binance
```

Routing rules:

1. With only a Tushare token, use Tushare.
2. With only a Qveris key, use Qveris for mapped capabilities.
3. With both credentials and no custom order, Tushare wins.
4. With `qveris,tushare,binance`, try Qveris first and fall back on missing coverage, parameter incompatibility, timeout, rate limit, or upstream failure.
5. Known sources omitted from the header are appended in default order. Duplicates are removed and unknown values are ignored.
6. A valid empty result does not trigger fallback, avoiding duplicate requests and unnecessary credit use.

Example result prefix:

```text
Data source: Tushare
Source route: Qveris (capability unavailable) -> Tushare (success)

Original tool result...
```

Internally, Qveris uses Discover → Inspect → Probe → Call. Probe validates parameters and obtains a free quote; a potentially billable Call runs only after the request is routed to Qveris. See the [Qveris REST API documentation](https://qveris.ai/docs/rest-api).

### HTTP configuration

```json
{
  "mcpServers": {
    "finance-mcp": {
      "type": "streamableHttp",
      "url": "https://finvestai.top/mcp",
      "timeout": 600,
      "headers": {
        "X-Tushare-Token": "YOUR_TUSHARE_TOKEN",
        "X-Qveris-Api-Key": "YOUR_QVERIS_API_KEY",
        "X-Finance-Source-Priority": "qveris,tushare,binance"
      }
    }
  }
}
```

Both keys are optional; send either one or both. `Authorization: Bearer ...` and `X-Api-Key` remain compatible Tushare token forms. Qveris uses the dedicated `X-Qveris-Api-Key` header to avoid credential ambiguity.

### stdio configuration

stdio has no HTTP headers, so use equivalent environment variables:

```json
{
  "mcpServers": {
    "finance-mcp": {
      "command": "npx",
      "args": ["-y", "finance-mcp"],
      "env": {
        "TUSHARE_TOKEN": "YOUR_TUSHARE_TOKEN",
        "QVERIS_API_KEY": "YOUR_QVERIS_API_KEY",
        "FINANCE_SOURCE_PRIORITY": "tushare,qveris,binance"
      }
    }
  }
}
```

Optional environment variables:

| Variable | Default | Description |
|---|---|---|
| `TUSHARE_TOKEN` | empty | Tushare credential |
| `QVERIS_API_KEY` | empty | Qveris credential |
| `QVERIS_BASE_URL` | `https://qveris.ai/api/v1` | Qveris REST API base URL |
| `FINANCE_SOURCE_PRIORITY` | `tushare,qveris,binance` | stdio or server-side default source order |
| `PORT` | `3000` | HTTP server port |

## Tools

| Tool | Purpose |
|---|---|
| `current_timestamp` | Current UTC+8 timestamp |
| `finance_news` | Financial news keyword search |
| `stock_data` | Stocks, FX, futures, funds, options, crypto, and technical indicators |
| `stock_data_minutes` | China stock and crypto intraday candles |
| `index_data` | Index history, metadata, and valuation |
| `macro_econ` | GDP, CPI, PPI, PMI, Shibor, LPR, Libor, and related macro data |
| `company_performance` | China company profiles, statements, dividends, ownership, and valuation |
| `company_performance_hk` | Hong Kong income, balance-sheet, and cash-flow data |
| `company_performance_us` | US financial statements and ratios |
| `fund_data` | Fund NAV, holdings, dividends, and metadata |
| `fund_manager_by_name` | Fund manager and managed-fund lookup |
| `convertible_bond` | Convertible-bond profile, call, conversion, rating, and holder data |
| `block_trade` | Block-trade details |
| `money_flow` | Stock, market, industry, and Stock Connect money flow |
| `margin_trade` | Margin eligibility, summary, details, and securities lending |
| `csi_index_constituents` | CSI index performance, constituent weights, and financial summary |
| `dragon_tiger_inst` | Dragon-Tiger institutional trading details |
| `hot_news_7x24` | Deduplicated 7x24 financial headlines |
| `futures_data` | Futures member position rankings |

Qveris currently maps common quote, intraday, index, company-financial, macro, news, and constituent capabilities. For other tools, a Qveris-first request reports that coverage is unavailable and continues with the native source.

## Installation

### npm

```bash
npm install -g finance-mcp
finance-mcp
```

Or run it directly:

```bash
npx -y finance-mcp
```

### Local development

```bash
git clone https://github.com/guangxiangdebizi/FinanceMCP.git
cd FinanceMCP
npm ci
```

Copy `.env.example` to `.env`, add only the credentials you need, then run:

```bash
npm run build
npm test
npm run start:stdio
```

Start Streamable HTTP with:

```bash
npm run start:http
```

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- Health check: `http://127.0.0.1:3000/health`

After a global installation, `finance-mcp-http` starts the HTTP transport.

## Technical indicators

`stock_data` supports explicit indicator parameters:

- MACD: `macd(12,26,9)`
- RSI: `rsi(14)`
- KDJ: `kdj(9,3,3)`
- BOLL: `boll(20,2)`
- MA: `ma(5) ma(10) ma(20)`

FinanceMCP expands the historical window before calculation and trims the result back to the requested date range. Indicator requests continue to use the native provider so their current calculations and output format remain stable.

## Security

- Never commit live API keys. `.env` is ignored by Git.
- HTTP credentials are request-scoped and logged only as `[REDACTED]`.
- `QVERIS_BASE_URL` requires HTTPS except for loopback regression tests.
- Qveris Call may consume credits. Set the source order explicitly when Qveris should take precedence.

## FinNote

FinanceMCP can serve as the financial backend for [FinNote / MarkiNote](https://github.com/wink-wink-wink555/MarkiNote). Online demo: [https://finvestai.top/](https://finvestai.top/).

Tutorial video: [FinanceMCP Complete Guide](https://www.bilibili.com/video/BV1qeNnzEEQi/)

## License

[MIT](LICENSE)
