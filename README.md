[![English](https://img.shields.io/badge/English-README_EN.md-blue?logo=github)](README_EN.md)

# FinanceMCP (Synapse)

[![MCP Toplist](https://mcptoplist.com/badge/pulsemcp%2Fguangxiangdebizi-finance-market-data.svg)](https://mcptoplist.com/server/pulsemcp%2Fguangxiangdebizi-finance-market-data)
[![Smithery](https://smithery.ai/badge/@guangxiangdebizi/FinanceMCP)](https://smithery.ai/server/@guangxiangdebizi/FinanceMCP)
[![npm](https://img.shields.io/npm/v/finance-mcp)](https://www.npmjs.com/package/finance-mcp)

<div align="center">
  <img src="LOGO/LOGO.png" alt="FinanceMCP Logo" width="290"/>
</div>

FinanceMCP 是面向 Claude、Cursor 等 MCP 客户端的金融数据服务器。当前版本为 **v4.9.0**，提供 19 个稳定工具，并在不改变工具名称和参数的前提下支持 Tushare、Qveris、Binance 等数据源路由。

- **Tushare**：A 股、港股、美股、基金、债券、宏观和特色市场数据
- **Qveris（可选）**：行情、公司资料、财务报表、宏观和新闻等扩展数据
- **Binance**：加密资产日线和分钟 K 线，无需 API Key
- **自动降级**：首选来源不支持或暂时不可用时，按请求级优先级继续尝试
- **来源透明**：每次工具返回都会标注实际数据来源和发生过的降级路径

在线体验：[https://finvestai.top/](https://finvestai.top/)

## 数据源路由

### 无需修改 Tool 参数

v4.9.0 没有新增 MCP Tool，也没有给现有 Tool 增加 `data_source` 参数。HTTP 服务根据本次请求携带的凭证选择数据源：

```http
X-Tushare-Token: YOUR_TUSHARE_TOKEN
X-Qveris-Api-Key: YOUR_QVERIS_API_KEY
X-Finance-Source-Priority: qveris,tushare,binance
```

默认优先级为：

```text
tushare,qveris,binance
```

路由规则：

1. 只有 Tushare Token 时使用 Tushare。
2. 只有 Qveris Key 时，对已适配能力使用 Qveris。
3. 两种凭证同时存在且未指定顺序时，Tushare 优先。
4. 指定 `qveris,tushare,binance` 时先尝试 Qveris；接口未覆盖、参数无法适配、超时、限流或上游失败时降级。
5. Header 中遗漏的数据源会按照默认顺序追加，重复项自动去重，未知项忽略。
6. 正常的空结果不会触发降级，避免重复请求和不必要的 credits 消耗。

返回示例：

```text
数据来源: Tushare
数据源路由: Qveris（接口未覆盖） → Tushare（成功）

原有工具结果……
```

Qveris 在内部执行 Discover → Inspect → Probe → Call。Probe 用于免费校验参数和费用，只有明确路由到 Qveris 后才会执行可能消耗 credits 的 Call。参考 [Qveris REST API 文档](https://qveris.ai/docs/rest-api)。

### HTTP 配置

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

两个 Key 都是可选的，可以只传其中一个。`Authorization: Bearer ...` 和 `X-Api-Key` 继续作为 Tushare Token 的兼容写法；Qveris 必须使用独立的 `X-Qveris-Api-Key`，避免凭证歧义。

### stdio 配置

stdio 没有 HTTP Header，使用等价的环境变量：

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

可选环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TUSHARE_TOKEN` | 空 | Tushare 凭证 |
| `QVERIS_API_KEY` | 空 | Qveris 凭证 |
| `QVERIS_BASE_URL` | `https://qveris.ai/api/v1` | Qveris REST API 地址 |
| `FINANCE_SOURCE_PRIORITY` | `tushare,qveris,binance` | stdio 或服务端默认来源顺序 |
| `PORT` | `3000` | HTTP 服务端口 |

## 工具列表

| Tool | 功能 |
|---|---|
| `current_timestamp` | UTC+8 当前时间戳 |
| `finance_news` | 财经新闻关键词检索 |
| `stock_data` | 股票、外汇、期货、基金、期权、加密资产行情及技术指标 |
| `stock_data_minutes` | A 股和加密资产分钟 K 线 |
| `index_data` | 指数日线、周线、月线、基本信息和估值 |
| `macro_econ` | GDP、CPI、PPI、PMI、Shibor、LPR、Libor 等宏观数据 |
| `company_performance` | A 股公司资料、财务报表、分红、股东和估值数据 |
| `company_performance_hk` | 港股利润表、资产负债表和现金流量表 |
| `company_performance_us` | 美股财务报表和财务指标 |
| `fund_data` | 基金净值、持仓、分红和基础资料 |
| `fund_manager_by_name` | 基金经理及管理基金查询 |
| `convertible_bond` | 可转债基本资料、强赎、转股、评级和持有人数据 |
| `block_trade` | 大宗交易明细 |
| `money_flow` | 个股、大盘、行业和沪深港通资金流 |
| `margin_trade` | 融资融券标的、汇总、明细和转融券数据 |
| `csi_index_constituents` | CSI 指数区间表现、成分权重和财务摘要 |
| `dragon_tiger_inst` | 龙虎榜机构交易明细 |
| `hot_news_7x24` | 7×24 财经热点和相似内容去重 |
| `futures_data` | 期货会员持仓排名 |

其中 Qveris 当前适配行情、分钟行情、指数、公司财务、宏观、新闻和指数成分等通用能力。其他工具在 Qveris 优先时会明确标记“接口未覆盖”，然后继续使用其原生数据源。

## 快速安装

### npm

```bash
npm install -g finance-mcp
finance-mcp
```

也可以直接使用：

```bash
npx -y finance-mcp
```

### 本地开发

```bash
git clone https://github.com/guangxiangdebizi/FinanceMCP.git
cd FinanceMCP
npm ci
```

复制 `.env.example` 为 `.env`，按需填写凭证，然后：

```bash
npm run build
npm test
npm run start:stdio
```

启动 Streamable HTTP：

```bash
npm run start:http
```

- MCP Endpoint：`http://127.0.0.1:3000/mcp`
- Health Check：`http://127.0.0.1:3000/health`

全局安装后可使用 `finance-mcp-http` 启动 HTTP 服务。

## 技术指标

`stock_data` 支持显式参数化的指标：

- MACD：`macd(12,26,9)`
- RSI：`rsi(14)`
- KDJ：`kdj(9,3,3)`
- BOLL：`boll(20,2)`
- MA：`ma(5) ma(10) ma(20)`

请求指标时会自动扩展历史窗口，完成计算后再裁剪回用户日期范围。带技术指标的请求保持使用原生数据源，确保现有计算和展示格式不变。

## 安全说明

- 不要把真实 API Key 提交到 Git；`.env` 已被忽略。
- HTTP 请求中的凭证按请求隔离，并在日志中统一显示为 `[REDACTED]`。
- `QVERIS_BASE_URL` 默认要求 HTTPS；仅本地回归测试允许 loopback HTTP。
- Qveris Call 可能消耗 credits。需要 Qveris 优先时请显式设置来源顺序。

## FinNote

FinanceMCP 可作为 [FinNote / MarkiNote](https://github.com/wink-wink-wink555/MarkiNote) 的金融数据后端。在线体验：[https://finvestai.top/](https://finvestai.top/)。

教程视频：[FinanceMCP 完整使用指南](https://www.bilibili.com/video/BV1qeNnzEEQi/)

## License

[MIT](LICENSE)
