[![中文版](https://img.shields.io/badge/中文-README.md-red?logo=github)](README.md)

# FinanceMCP - Professional Financial Data MCP Server 🚀

[![smithery badge](https://smithery.ai/badge/@guangxiangdebizi/FinanceMCP)](https://smithery.ai/server/@guangxiangdebizi/FinanceMCP)

**Professional financial data server based on MCP protocol, integrating Tushare API to provide real-time financial data and technical indicator analysis for Claude and other AI assistants.**

## 📑 Table of Contents

- [🌟 Public Cloud Service (Free)](#-public-cloud-service-free)
- [⚡ Core Features](#-core-features)
- [🛠️ Tool Overview](#️-tool-overview)
- [🎯 Technical Highlights](#-technical-highlights)
- [🚀 Quick Start](#-quick-start)
- [💡 Example Queries](#-example-queries)
- [🔧 Local Deployment](#-local-deployment)
- [🆕 What's New](#-whats-new)
- [📄 License](#-license)

## 🌟 Public Cloud Service (Free)

**🎉 Ready to use, no deployment needed!**

We provide multiple free public cloud service options:

### 🌐 Web Online Experience
**🚀 The simplest way to get started!**

Visit our online experience website: **[https://finvestai.top/](https://finvestai.top/)**

- ✨ **Zero Configuration Experience** - No setup required, just open and use
- 🤖 **Integrated AI Model** - Chat directly with AI assistant for financial analysis
- 💬 **Intelligent Interaction** - Natural language queries for real-time financial data
- 📱 **Multi-device Support** - Compatible with desktop, mobile, and tablet

> ⚠️ **Service Notice**: This is a personal small server. Please use responsibly and do not attack or abuse the service.

### ⚙️ Claude Desktop Configuration

#### 🆕 Latest Version (v4.3.0) - Streamable HTTP with Your API Key
**🎯 Recommended for production use with your own Tushare token:**

```json
{
  "mcpServers": {
    "finance-mcp": {
      "disabled": false,
      "timeout": 600,
      "type": "streamableHttp",
      "url": "https://finvestai.top/mcp",
      "headers": {
        "X-Tushare-Token": "your_tushare_token_here"
      }
    }
  }
}
```

**🔑 How to get your Tushare token:**
1. Register at [tushare.pro](https://tushare.pro/register)
2. Get your API token from personal center
3. Replace `your_tushare_token_here` with your actual token

#### 🎁 Legacy Free Service (Limited)
You can also use our shared service without API keys (may have rate limits):

```json
{
  "mcpServers": {
    "finance-data-server": {
      "disabled": false,
      "timeout": 600,
      "type": "sse",
      "url": "http://106.14.205.176:3101/sse"
    }
  }
}
```

**Service Benefits:**
- ✅ **Latest Version (v4.3.0)** - Use your own API key for unlimited access
- ✅ **24/7 Availability** - Server runs continuously
- ✅ **Full Features** - All 14 tools and technical indicators
- ✅ **Real-time Data** - Connected to Tushare professional data
- ✅ **No Rate Limits** - With your own token, enjoy unlimited API calls
- ✅ **Production Ready** - Stable streamable HTTP protocol

> 📺 **Tutorial Video**: [Complete FinanceMCP Usage Guide](https://www.bilibili.com/video/BV1qeNnzEEQi/)

## ⚡ Core Features

### 🧠 Intelligent Technical Indicator System
- **Smart Data Pre-fetching** - Automatically calculates required historical data, eliminates NaN values
- **Mandatory Parameterization** - Requires explicit parameter specification (e.g., `macd(12,26,9)`) for accuracy
- **Modular Architecture** - Parameter parsing, data calculation, and indicator engine fully decoupled
- **5 Core Indicators** - MACD, RSI, KDJ, BOLL, MA

### 🌍 Comprehensive Market Coverage
- **10 Major Markets + Crypto** - A-shares, US stocks, HK stocks, forex, futures, funds, bonds, options, and crypto via CoinGecko
- **Real-time News** - Smart search across 7+ major financial media
- **Macro Data** - 11 economic indicators (GDP, CPI, PPI, PMI, etc.)
- **Company Analysis** - Financial statements, management info, shareholder structure

## 🛠️ Tool Overview

| Tool Name | Function Description | Core Features |
|-----------|---------------------|---------------|
| 🕐 **current_timestamp** | Current timestamp | UTC+8 timezone, multiple output formats |
| 📰 **finance_news** | Financial news search | Baidu News crawler; input: `query` (space-separated keywords, OR filter) |
| 📈 **stock_data** | Stocks/Crypto + technical indicators | 10 markets + crypto (Binance by default) + 5 indicators, smart pre-fetching |
| 📊 **index_data** | Index data | Major market indices historical data |
| 🧱 **csi_index_constituents** | CSI index constituents summary | CSI-only; index range + all constituents with weights and returns |
| 📉 **macro_econ** | Macroeconomic data | 11 indicators: GDP/CPI/PPI/PMI/Shibor, etc. |
| 🏢 **company_performance** | Company financial analysis | Financial statements + management + fundamentals, 13 data types |
| 🏛️ **company_performance_hk** | Hong Kong stocks financial analysis | HK stocks income statement, balance sheet, cash flow statement |
| 🇺🇸 **company_performance_us** | US stocks financial analysis | US stocks 4 major financial statements + comprehensive indicators |
| 💰 **fund_data** | Fund data | NAV/holdings/dividends, 85% performance optimized |
| 👨‍💼 **fund_manager_by_name** | Fund manager query | Personal background, managed funds list |
| 🪙 **convertible_bond** | Convertible bond data | Basic info + issuance data + conversion terms |
| 🔄 **block_trade** | Block trade data | Trade details + counterparty information |
| 💹 **money_flow** | Money flow data | Main/super-large/large/medium/small order flow analysis |
| 💰 **margin_trade** | Margin trading data | 4 APIs: eligible stocks/summary/details/securities lending |
| 🐯 **dragon_tiger_inst** | Dragon-Tiger institutional details | By trade date (optional code); buy/sell/net and reason table |
| 🔥 **hot_news_7x24** | 7×24 Hot News | Based on Tushare latest batch (up to 1500 items), 80% content-similarity dedup, entries separated by `---` |

## 🎯 Technical Highlights

### Intelligent Technical Indicator Engine
```
User Request → Parameter Parsing → Data Requirement Calculation → Extended Historical Data Fetch → Indicator Calculation → Result Return
```

**Supported Indicators:**
- **MACD** `macd(12,26,9)` - Trend analysis
- **RSI** `rsi(14)` - Overbought/oversold judgment
- **KDJ** `kdj(9,3,3)` - Stochastic oscillator
- **BOLL** `boll(20,2)` - Bollinger Bands
- **MA** `ma(5/10/20/60)` - Moving averages

### Core Technical Advantages
1. **Smart Pre-fetching** - Automatically calculates and fetches additional historical data needed for indicators
2. **Parameter Enforcement** - Avoids calculation differences caused by default parameters
3. **High Performance** - Fund data query performance improved 85% (5.2s→0.8s)
4. **Data Integration** - Seamless integration of 43+ Tushare API endpoints

## 🚀 Quick Start

### 1. Use Public Cloud Service (Recommended)
Copy the JSON configuration above to your Claude Desktop config file, restart Claude and start using!

### 2. Configuration File Location
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

### 3. Start Using
After configuration, simply ask questions directly in Claude!

## 💡 Example Queries

<details>
<summary><strong>📈 Stock Technical Analysis</strong></summary>

```
"Analyze Moutai (600519.SH) technical status, calculate MACD(12,26,9), RSI(14), KDJ(9,3,3)"
"Check CATL (300750.SZ) Bollinger Bands BOLL(20,2) and four moving averages MA(5,10,20,60)"
"Apple Inc. (AAPL) stock trend and MACD indicator analysis for the past month"
```

</details>

<details>
<summary><strong>🪙 Crypto Assets</strong></summary>

```
"View Bitcoin (BTC-USD) trend from 2024-01-01 to 2024-06-30 and calculate MACD(12,26,9), RSI(14)"
"View USDT against CNY daily trend: market_type=crypto, code=USDT.CNY, start_date=20240101, end_date=20240630"
"Use CoinGecko id directly: market_type=crypto, code=bitcoin.usd, indicators=\"boll(20,2) ma(5) ma(10)\""
```

</details>

<details>
<summary><strong>📊 Comprehensive Analysis</strong></summary>

```
"Comprehensive analysis of BYD: financial status, technical indicators, money flow, latest news"
"Compare performance of A-shares, US stocks, and HK stocks markets including major indices and technical indicators"
"Evaluate CATL's investment value: fundamentals + technicals + money flow"
"Get CSI 300 (000300.SH) CSI constituents summary from 2024-01-01 to 2024-06-30"
```

</details>

<details>
<summary><strong>📰 News & Macro</strong></summary>

```
"Search latest policies and market dynamics for new energy vehicle sector"
"Analyze current macroeconomic situation: GDP, CPI, PPI, PMI data"
"Fed rate hike impact on Chinese stock market, related news and data"
```

</details>

<details>
<summary><strong>💰 Funds & Bonds</strong></summary>

```
"Query CSI 300 ETF latest NAV and holdings structure"
"Analyze Zhang Kun's fund performance"
"Convertible bond market overview and investment opportunities"
```

</details>

<details>
<summary><strong>🏛️ Hong Kong Stocks</strong></summary>

```
"Get Tencent Holdings (00700.HK) 2024 income statement with key financial ratios"
"Analyze Alibaba (09988.HK) balance sheet and financial structure"
"Compare China Construction Bank (00939.HK) cash flow performance over multiple periods"
```

</details>

<details>
<summary><strong>🐯 Dragon-Tiger List</strong></summary>

```
"Query dragon-tiger institutional details for 20240525"
"Query dragon-tiger institutional details for 20240525 (focus 000001.SZ)"
```

</details>

<details>
<summary><strong>🇺🇸 US Stocks Analysis</strong></summary>

```
"Get NVIDIA (NVDA) 2024 income statement and profitability analysis"
"Analyze Apple Inc. (AAPL) balance sheet structure and financial health"
"Compare Tesla (TSLA) cash flow performance over multiple periods"
"Get Microsoft (MSFT) comprehensive financial indicators and ratio analysis"
```

</details>

## 🔧 Local Deployment (Streamable HTTP)

<details>
<summary><strong>🛠️ Complete Local Deployment Guide</strong></summary>

If you need local deployment, follow these steps:

### Environment Requirements
- **Node.js >= 18** - Download from [nodejs.org](https://nodejs.org/)
- **Tushare API Token** - Get from [tushare.pro](https://tushare.pro)

<details>
<summary><strong>📝 Getting Tushare API Token</strong></summary>

1. **Register Account** - Visit [tushare.pro](https://tushare.pro/register) to register
2. **Get Token** - Obtain API Token from personal center
3. **Points Information** - Some advanced data requires points

**Student Benefits** - Apply for 2000 free points:
- Follow Tushare official Xiaohongshu and interact
- Join student QQ group: **290541801**
- Complete personal information (school email/student ID)
- Submit application materials to administrators

</details>

### Installation Steps

#### Method 1: Install via npm package (Recommended)
```bash
# Global installation
npm install -g finance-mcp

# Or local installation
npm install finance-mcp
```

After installation, you can use it directly:
```bash
# If globally installed
finance-mcp

# If locally installed
npx finance-mcp
```

#### Method 2: Install via Smithery
```bash
npx -y @smithery/cli install @guangxiangdebizi/FinanceMCP --client claude
```

> **💡 Tip**: FinanceMCP supports two deployment modes
> - **stdio mode** (default, recommended for local use): `npx -y finance-mcp`
> - **HTTP mode** (for cloud deployment): `npx -y finance-mcp-http`
> 
> See [DEPLOYMENT_MODES.md](./DEPLOYMENT_MODES.md) for details

#### Method 3: Manual Installation
```bash
# 1. Clone the repository
git clone https://github.com/guangxiangdebizi/FinanceMCP.git
cd FinanceMCP

# 2. Install dependencies
npm install

# 3. Configure API key
echo "TUSHARE_TOKEN=your_token_here" > .env
# Or edit src/config.ts directly

# 4. Build the project
npm run build
```

### Start Server

**Streamable HTTP (recommended)**
```bash
npm run build
node build/httpServer.js
# or
npm start
```

After starting:
- MCP endpoint: `http://localhost:3000/mcp`
- Health: `http://localhost:3000/health`

### Claude Configuration

Configuration file locations:
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

#### ⭐ Recommended: stdio Mode (Local, Zero Configuration, Default)
```json
{
  "mcpServers": {
    "finance-mcp": {
      "command": "npx",
      "args": ["-y", "finance-mcp"],
      "env": {
        "TUSHARE_TOKEN": "your_tushare_token_here"
      }
    }
  }
}
```

**Benefits**: Faster response (1-2ms), lower resources, no port management, works out of the box

#### Alternative: HTTP Mode (Cloud Deployment or Remote Access)

**Step 1: Start HTTP Server**
```bash
# Option 1: Using npx
npx -y finance-mcp-http

# Option 2: Global install then start
npm install -g finance-mcp
finance-mcp-http

# Option 3: Local development
npm run start:http
```

**Step 2: Configure Claude Desktop (streamableHttp type)**
```json
{
  "mcpServers": {
    "finance-mcp-http": {
      "type": "streamableHttp",
      "url": "http://localhost:3000/mcp",
      "timeout": 600,
      "headers": {
        "X-Tushare-Token": "your_tushare_token",
        // Or any one of the above:
        // "Authorization": "Bearer your_tushare_token",
        // "X-Api-Key": "your_tushare_token",

        // CoinGecko (choose ONE based on your plan)
        // Demo:
        // "X-CG-DEMO-API-KEY": "your_demo_key",
        // Free/Standard:
        // "X-CG-API-KEY": "your_standard_key",
        // Pro:
        // "X-CG-PRO-API-KEY": "your_pro_key"
      },
      "autoApprove": [
        "current_timestamp",
        "finance_news",
        "stock_data",
        "index_data",
        "macro_econ",
        "company_performance",
        "company_performance_hk",
        "company_performance_us",
        "fund_data",
        "fund_manager_by_name",
        "convertible_bond",
        "block_trade",
        "money_flow",
        "margin_trade"
      ]
    }
  }
}
```

**HTTP Mode Benefits**: Remote access, multiple clients, complete logging, cloud deployment

> 📖 **Documentation**: See [DEPLOYMENT_MODES.md](./DEPLOYMENT_MODES.md) for more deployment options

#### Header Token Resolution
- Prefer `X-Tushare-Token`.
- Fallback to `Authorization: Bearer <token>`.
- Fallback to `X-Api-Key`.
- If none provided, server may fallback to `TUSHARE_TOKEN` env var (optional).

(Crypto market now defaults to Binance public market data; no crypto API key is required.)

### Verify Installation
After configuration, restart Claude Desktop and ask: "Get current time". If it returns time information, the installation is successful.

</details>

## 🆕 What's New

### 🚀 Version 4.3.0 - Crypto Minutes & Binance Enhancements

**Latest Major Update**: v4.3.0 adds `market_type` to `stock_data_minutes` with Binance crypto minute-level K-lines, plus multiple enhancements to crypto daily data.

<details>
<summary><strong>🎯 New Features in v4.3.0</strong></summary>

- **⏱ Minutes Tool Enhanced**: `stock_data_minutes` adds `market_type` (`cn`/`crypto`), Binance minutes supported
- **🪙 Crypto Minutes (Binance)**: Supports `BTCUSDT`/`BTC-USDT`/`BTC/USDT`/`coinid.USDT`; frequency map `1MIN/5MIN/15MIN/30MIN/60MIN → 1m/5m/15m/30m/1h`
- **📦 Auto Pagination**: Binance returns up to 1000 candles per request; auto-paginate to cover full range
- **🧭 Smart Extended Fetch (Daily)**: When indicators requested, auto-extend start date to ensure enough history
- **🧩 Friendly Errors**: Clear message when symbol is invalid/unsupported on Binance
- **📈 A-share QFQ (Daily)**: Auto apply front-adjusted prices based on latest factor

Migration: After upgrading to v4.3.0, `stock_data_minutes` requires `market_type` (`cn` or `crypto`).

</details>

### 🏛️ Hong Kong Stocks Financial Analysis Module

**Latest Addition**: We've added comprehensive Hong Kong stocks financial analysis capabilities!

<details>
<summary><strong>📊 New Features</strong></summary>

- **🏛️ company_performance_hk** - Dedicated Hong Kong stocks financial analysis tool
- **📈 Income Statement Analysis** - Revenue, profit margins, earnings per share, comprehensive income
- **💰 Balance Sheet Analysis** - Assets, liabilities, equity structure with key financial ratios  
- **💸 Cash Flow Analysis** - Operating, investing, financing activities with free cash flow calculation
- **🎯 Smart Data Processing** - Automatic financial ratio calculations and multi-period comparisons
- **🌟 Enhanced User Experience** - Structured tables, intelligent categorization, and trend analysis

**Supported Companies**: All Hong Kong Stock Exchange listed companies including Tencent (00700.HK), Alibaba (09988.HK), China Construction Bank (00939.HK), and more.

**API Integration**: Based on [Tushare Hong Kong stocks financial data API](https://tushare.pro/document/2?doc_id=389) with full data format optimization.

</details>

### 🇺🇸 US Stocks Financial Analysis Module (NEW!)

**Latest Enhancement**: We've added comprehensive US stocks financial analysis capabilities!

<details>
<summary><strong>📊 New Features</strong></summary>

- **🇺🇸 company_performance_us** - Dedicated US stocks financial analysis tool
- **📈 Income Statement Analysis** - Revenue, operating income, net income, EPS with detailed profitability metrics
- **💰 Balance Sheet Analysis** - Assets, liabilities, shareholders' equity with comprehensive financial ratios
- **💸 Cash Flow Statement** - Operating, investing, financing activities with free cash flow analysis
- **📊 Financial Indicators** - 40+ comprehensive financial metrics including profitability, growth, solvency ratios
- **🎯 Multi-Period Comparison** - Automatic trend analysis and period-over-period comparisons
- **🌟 Bilingual Support** - Chinese and English financial terminology recognition

**Supported Companies**: All US-listed companies including NVIDIA (NVDA), Apple (AAPL), Tesla (TSLA), Microsoft (MSFT), and more.

**API Integration**: Based on Tushare US stocks financial data APIs with optimized data formatting and comprehensive indicator calculations.

</details>

## ⏱ Minute K-line Tool

`stock_data_minutes`: A-shares (Tushare) and Crypto (Binance) minutes.

- Frequencies: `1MIN/5MIN/15MIN/30MIN/60MIN` (case-insensitive)
- Params:
  - `market_type`: `cn` | `crypto`
  - `code`: A-shares like `600519.SH`; crypto like `BTCUSDT`/`BTC-USDT`/`BTC/USDT`/`bitcoin.USDT`
  - `start_datetime`: `YYYYMMDDHHmmss` or `YYYY-MM-DD HH:mm:ss`
  - `end_datetime`: same as above
  - `freq`: e.g., `1MIN`
- Output: Desc-sorted table (Time/Open/High/Low/Close/Volume; A-shares includes Amount(10k CNY))

Example (A-shares):

```
name: stock_data_minutes
arguments:
  market_type: cn
  code: 600519.SH
  start_datetime: 2024-09-01 09:30:00
  end_datetime: 2024-09-01 10:30:00
  freq: 1MIN
```

Example (Crypto):

```
name: stock_data_minutes
arguments:
  market_type: crypto
  code: BTCUSDT
  start_datetime: 2025-09-01 00:00:00
  end_datetime: 2025-09-01 12:00:00
  freq: 15MIN
```

## 📄 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

**👨‍💻 Author**: Xingyu Chen (陈星宇)  
**📧 Email**: guangxiangdebizi@gmail.com  
**🔗 GitHub**: [guangxiangdebizi](https://github.com/guangxiangdebizi)

⭐ If this project helps you, please give us a Star!
