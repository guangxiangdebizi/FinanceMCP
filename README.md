[![English](https://img.shields.io/badge/English-README_EN.md-blue?logo=github)](README_EN.md)

# FinanceMCP - 专业金融数据MCP服务器 🚀

[![smithery badge](https://smithery.ai/badge/@guangxiangdebizi/FinanceMCP)](https://smithery.ai/server/@guangxiangdebizi/FinanceMCP)

**基于MCP协议的专业金融数据服务器，集成Tushare API，为Claude等AI助手提供实时金融数据和技术指标分析。**

## 📑 目录

- [🌟 公共云服务(免费)](#-公共云服务免费)
- [⚡ 核心特色](#-核心特色)
- [🛠️ 工具概览](#️-工具概览)
- [🎯 技术亮点](#-技术亮点)
- [🚀 快速开始](#-快速开始)
- [💡 示例查询](#-示例查询)
- [🔧 本地部署](#-本地部署)
- [🆕 最新更新](#-最新更新)
- [📄 许可证](#-许可证)

## 🌟 公共云服务(免费)

**🎉 开箱即用，无需部署！**
我们提供多种免费公共云服务选项：

### 🌐 Web在线体验版
**🚀 最简单的使用方式！**

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/5a81b053-4d19-4285-b5a2-991d14425595" />

访问我们的在线体验网站：**[https://finvestai.top/](https://finvestai.top/)**

- ✨ **零配置体验** - 无需任何设置，打开网页即用
- 🤖 **集成大模型** - 直接与AI助手对话，获取金融分析
- 💬 **智能交互** - 自然语言提问，实时获取金融数据
- 📱 **多端适配** - 支持电脑、手机、平板访问

> ⚠️ **服务说明**: 这是个人小服务器，请合理使用，勿攻击滥用。

### ⚙️ Claude桌面版配置

#### 🆕 最新版本(v4.3.0) - 使用您的API密钥
**🎯 推荐生产环境使用，配置您自己的Tushare令牌：**

```json
{
  "mcpServers": {
    "finance-mcp": {
      "disabled": false,
      "timeout": 600,
      "type": "streamableHttp",
      "url": "https://finvestai.top/mcp",
      "headers": {
        "X-Tushare-Token": "您的tushare令牌"
      }
    }
  }
}
```

**🔑 如何获取您的Tushare令牌：**
1. 在 [tushare.pro](https://tushare.pro/register) 注册账户
2. 从个人中心获取API令牌
3. 将 `您的tushare令牌` 替换为您的实际令牌

#### 🎁 传统免费服务(有限制)
您也可以使用我们的共享服务，无需API密钥(可能有速率限制)：

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

**服务优势:**
- ✅ **最新版本(v4.3.0)** - 使用您自己的API密钥，享受无限制访问
- ✅ **7×24可用** - 服务器持续运行
- ✅ **完整功能** - 全部14个工具和技术指标
- ✅ **实时数据** - 连接Tushare专业数据
- ✅ **无速率限制** - 使用您自己的令牌，享受无限API调用
- ✅ **生产就绪** - 稳定的streamable HTTP协议

> 📺 **教程视频**: [FinanceMCP完整使用指南](https://www.bilibili.com/video/BV1qeNnzEEQi/)

## ⚡ 核心特色

### 🧠 智能技术指标系统
- **智能数据预取** - 自动计算所需历史数据，消除NaN值
- **强制参数化** - 要求明确指定参数（如`macd(12,26,9)`）确保精确性
- **模块化架构** - 参数解析、数据计算、指标引擎完全解耦
- **5大核心指标** - MACD、RSI、KDJ、BOLL、MA

### 🌍 全面市场覆盖
- **10大市场** - A股、美股、港股、外汇、期货、基金、债券、期权
- **实时新闻** - 智能搜索7+主流财经媒体
- **宏观数据** - 11个经济指标（GDP、CPI、PPI、PMI等）
- **公司分析** - 财务报表、管理层信息、股东结构

## 🛠️ 工具概览

| 工具名称 | 功能描述 | 核心特色 |
|---------|---------|---------|
| 🕐 **current_timestamp** | 当前时间戳 | UTC+8时区，多种输出格式 |
| 📰 **finance_news** | 财经新闻搜索 | 百度新闻爬虫；入参：`query`（空格分隔多关键词，OR 过滤） |
| 📈 **stock_data** | 股票/加密 + 技术指标 | 10大市场+加密(Binance默认)+5技术指标，智能预取 |
| 📊 **index_data** | 指数数据 | 主要市场指数历史数据 |
| 🧱 **csi_index_constituents** | CSI指数成分与权重摘要 | 仅支持中证指数公司(CSI)，指数区间行情 + 成分股权重与区间涨跌幅 + 估值/财务指标（PE、PB、股息率、ROE、ROA、净利率、经营现金流、资产负债率、营收同比、资产周转率、毛利率、三费比率、现金分红率） |
| 📉 **macro_econ** | 宏观经济数据 | 11指标：GDP/CPI/PPI/PMI/Shibor等 |
| 🏢 **company_performance** | A股公司财务分析 | 财务报表+管理层+基本面，13数据类型 |
| 🏛️ **company_performance_hk** | 港股公司财务分析 | 港股利润表、资产负债表、现金流量表 |
| 🇺🇸 **company_performance_us** | 美股公司财务分析 | 美股4大财务报表+综合财务指标分析 |
| 💰 **fund_data** | 基金数据 | 净值/持仓/分红，85%性能优化 |
| 👨‍💼 **fund_manager_by_name** | 基金经理查询 | 个人背景、管理基金列表 |
| 🪙 **convertible_bond** | 可转债数据 | 基本信息+发行数据+转换条款 |
| 🔄 **block_trade** | 大宗交易数据 | 交易详情+交易对手信息 |
| 💹 **money_flow** | 资金流向数据 | 个股/大盘/板块资金流向，主力/超大单/大单/中单/小单分析 |
| 💰 **margin_trade** | 融资融券数据 | 4个API：标的股票/汇总/明细/转融券 |
| 🐯 **dragon_tiger_inst** | 龙虎榜机构明细 | 指定交易日(可选代码)，买卖额/比例/净额/理由表格 |
| 🔥 **hot_news_7x24** | 7×24 热点 | 基于 Tushare 最新批次（单次至多1500条），内容相似度80%去重，条目间以`---`分隔 |

## 🎯 技术亮点

### 智能技术指标引擎
```
用户请求 → 参数解析 → 数据需求计算 → 扩展历史数据获取 → 指标计算 → 结果返回
```

**支持的指标:**
- **MACD** `macd(12,26,9)` - 趋势分析
- **RSI** `rsi(14)` - 超买超卖判断
- **KDJ** `kdj(9,3,3)` - 随机指标
- **BOLL** `boll(20,2)` - 布林带
- **MA** `ma(5/10/20/60)` - 移动平均线

### 核心技术优势
1. **智能预取** - 自动计算并获取指标所需的额外历史数据
2. **参数强制** - 避免默认参数造成的计算差异
3. **高性能** - 基金数据查询性能提升85%（5.2s→0.8s）
4. **数据集成** - 无缝集成43+个Tushare API接口
 
<!-- 移除内嵌 Mermaid，可跳转至独立 HTML -->
<!-- 参见 pain-method-gain.html -->

## 🚀 快速开始

### 1. 使用公共云服务(推荐)
复制上方JSON配置到Claude桌面配置文件，重启Claude即可开始使用！

### 2. 配置文件位置
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

### 3. 开始使用
配置完成后，直接在Claude中提问即可！

## 💡 示例查询

<details>
<summary><strong>📈 股票技术分析</strong></summary>

```
"分析茅台(600519.SH)技术面状况，计算MACD(12,26,9)、RSI(14)、KDJ(9,3,3)"
"查看宁德时代(300750.SZ)布林带BOLL(20,2)和四条均线MA(5,10,20,60)"
"苹果公司(AAPL)近一个月股价走势和MACD指标分析"
```

</details>

<details>
<summary><strong>📊 综合分析</strong></summary>

```
"比亚迪综合分析：财务状况、技术指标、资金流向、最新新闻"
"对比A股、美股、港股市场表现，包括主要指数和技术指标"
"评估宁德时代投资价值：基本面+技术面+资金流向"
"获取沪深300(000300.SH) 2024-01-01 至 2024-06-30 的CSI成分股区间摘要"
```

</details>

<details>
<summary><strong>🧱 CSI 指数成分与权重（含估值/财务）</strong></summary>

```
"获取中证证券公司(399975.SZ) 在 2024-01-01 至 2024-06-30 区间的成分股摘要（含PE、PB、股息率、ROE、ROA、净利率、经营现金流、资产负债率、营收同比、资产周转率、毛利率、三费比率、现金分红率）"
```

</details>

<details>
<summary><strong>💰 资金流向分析</strong></summary>

```
"查询证券板块(BK0447)近一个月的资金流向情况"
"分析2024年9月27日所有行业板块的资金流入排名"
"比亚迪(002594.SZ)最近的主力资金流向和超大单净流入"
"查看大盘整体资金流向，分析市场情绪"
"获取2024年10月所有概念板块的资金流向数据"
```

</details>

<details>
<summary><strong>📰 新闻与宏观</strong></summary>

```
"搜索新能源汽车板块最新政策和市场动态"
"分析当前宏观经济形势：GDP、CPI、PPI、PMI数据"
"美联储加息对中国股市的影响，相关新闻和数据"
```

</details>

<details>
<summary><strong>💰 基金与债券</strong></summary>

```
"查询沪深300ETF最新净值和持仓结构"
"分析张坤的基金业绩表现"
"可转债市场概况和投资机会"
```

</details>

<details>
<summary><strong>🏛️ 港股分析</strong></summary>

```
"获取腾讯控股(00700.HK) 2024年利润表，包含关键财务比率"
"分析阿里巴巴(09988.HK)资产负债表和财务结构"
"对比建设银行(00939.HK)多期现金流表现"
```

</details>

<details>
<summary><strong>🐯 龙虎榜</strong></summary>

```
"查询20240525的龙虎榜机构明细"
"查询20240525的龙虎榜机构明细（聚焦000001.SZ）"
```

</details>

<details>
<summary><strong>🇺🇸 美股分析</strong></summary>

```
"分析英伟达(NVDA) 2024年财务表现，包括利润表和现金流"
"获取苹果(AAPL)资产负债表，重点关注现金储备和负债结构"
"对比特斯拉(TSLA)多期财务指标，分析盈利能力变化趋势"
"查看微软(MSFT)综合财务指标，包括ROE、ROA、毛利率等"
```

</details>

<details>
<summary><strong>🪙 加密资产</strong></summary>

```
"查看比特币(BTC-USD) 2024-01-01 至 2024-06-30 的走势，计算 MACD(12,26,9) 和 RSI(14)"
"查看 USDT 对 CNY 的日线走势：market_type=crypto, code=USDT.CNY, start_date=20240101, end_date=20240630"
"使用 CoinGecko id 查询：market_type=crypto, code=bitcoin.usd, indicators=\"boll(20,2) ma(5) ma(10)\""
```

</details>

## 🔧 本地部署（Streamable HTTP）

<details>
<summary><strong>🛠️ 完整本地部署指南</strong></summary>

如果需要本地部署，请按以下步骤操作：

### 环境要求
- **Node.js >= 18** - 从[nodejs.org](https://nodejs.org/)下载
- **Tushare API令牌** - 从[tushare.pro](https://tushare.pro)获取

<details>
<summary><strong>📝 获取Tushare API令牌</strong></summary>

1. **注册账户** - 访问[tushare.pro](https://tushare.pro/register)注册
2. **获取令牌** - 从个人中心获取API令牌
3. **积分说明** - 部分高级数据需要积分

**学生福利** - 申请2000免费积分：
- 关注Tushare官方小红书并互动
- 加入学生QQ群：**290541801**
- 完善个人信息（学校邮箱/学号）
- 向管理员提交申请材料

</details>

### 安装步骤

#### 方法1：通过npm包安装(推荐)
```bash
# 全局安装
npm install -g finance-mcp

# 或本地安装
npm install finance-mcp
```

安装后可以直接使用：
```bash
# 如果全局安装
finance-mcp

# 如果本地安装
npx finance-mcp
```

#### 方法2：通过Smithery安装
```bash
npx -y @smithery/cli install @guangxiangdebizi/FinanceMCP --client claude
```

> **💡 提示**：FinanceMCP 支持两种部署模式
> - **stdio 模式**（默认，推荐本地使用）：`npx -y finance-mcp`
> - **HTTP 模式**（云端部署）：`npx -y finance-mcp-http`
> 
> 详细说明请参考 [DEPLOYMENT_MODES.md](./DEPLOYMENT_MODES.md)

#### 方法3：手动安装
```bash
# 1. 克隆仓库
git clone https://github.com/guangxiangdebizi/FinanceMCP.git
cd FinanceMCP

# 2. 安装依赖
npm install

# 3. 配置API密钥
echo "TUSHARE_TOKEN=your_token_here" > .env
# 或直接编辑 src/config.ts

# 4. 构建项目
npm run build
```

### 启动服务

**Streamable HTTP 模式（推荐）**
```bash
npm run build
node build/httpServer.js
# 或
npm run start:http
```

**SSE 模式**
```bash
npm run build
npm run start:sse
```

服务启动后：
- MCP 端点: `http://localhost:3000/mcp`
- 健康检查: `http://localhost:3000/health`

### Claude配置

配置文件位置：
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

#### ⭐ 推荐配置：stdio 模式（本地使用，零配置，默认）
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

**优势**：
- ✅ 更快的响应速度（1-2ms 延迟）
- ✅ 更低的资源占用
- ✅ 无需管理端口
- ✅ 开箱即用

#### 备选配置：HTTP 模式（云端部署或需要远程访问）

**步骤 1：启动 HTTP 服务器**
```bash
# 方式 1：使用 npx
npx -y finance-mcp-http

# 方式 2：全局安装后启动
npm install -g finance-mcp
finance-mcp-http

# 方式 3：本地开发
npm run start:http
```

**步骤 2：配置 Claude Desktop**
```json
{
  "mcpServers": {
    "finance-mcp-http": {
      "type": "streamableHttp",
      "url": "http://localhost:3000/mcp",
      "timeout": 600,
      "headers": {
        "X-Tushare-Token": "your_tushare_token_here"
      }
    }
  }
}
```

**HTTP 模式优势**：
- ✅ 支持远程访问
- ✅ 支持多客户端同时连接
- ✅ 完整的 HTTP 日志（参考 [LOGGING_GUIDE.md](./LOGGING_GUIDE.md)）
- ✅ 便于部署到 Smithery 等云平台

#### 传递 Token 的方式
- **stdio 模式**：通过 `env.TUSHARE_TOKEN` 环境变量
- **HTTP 模式**：
  - 优先从 `X-Tushare-Token` Header 读取
  - 或使用 `Authorization: Bearer <token>`
  - 或使用 `X-Api-Key`
  - 最后回退到环境变量 `TUSHARE_TOKEN`

（加密市场默认使用 Binance 公共行情接口，无需任何加密货币 API Key）

> 📖 **详细文档**：更多部署模式说明请参考 [DEPLOYMENT_MODES.md](./DEPLOYMENT_MODES.md)

### 验证安装
配置完成后，重启Claude桌面版并询问："获取当前时间"。如果返回时间信息，说明安装成功。

</details>

## 🆕 最新更新

### 💰 版本 4.7.0 - 板块资金流向功能

**最新更新**：资金流向工具全面升级，新增东方财富板块资金流向功能！

<details>
<summary><strong>🎯 v4.7.0 新功能</strong></summary>

- **📊 板块资金流向**：支持查询东方财富(DC)行业、概念、地域板块资金流向
- **🎲 智能识别**：自动识别查询类型（个股/大盘/板块），BK开头代码自动识别为板块
- **📈 多维度分析**：板块涨跌幅、资金流入排名、超大单/大单/中单/小单明细
- **🔍 灵活查询**：支持按板块代码、交易日期、板块类型（行业/概念/地域）查询
- **📋 完整展示**：板块基本信息、统计摘要、明细表格、资金流向趋势

**使用示例**：
```javascript
// 查询特定板块资金流向
{
  "ts_code": "BK0447",  // 东财板块代码
  "start_date": "20240901",
  "end_date": "20240930"
}

// 查询某日所有行业板块资金流向
{
  "query_type": "sector",
  "trade_date": "20240927",
  "content_type": "行业",
  "start_date": "20240927",
  "end_date": "20240927"
}
```

**API集成**：基于 [Tushare 东财板块资金流向API](https://tushare.pro/document/2?doc_id=344)（`moneyflow_ind_dc`）

</details>

### 🚀 版本 4.3.0 - 加密分钟线与 Binance 优化

**最新重大更新**：发布 v4.3.0，`stock_data_minutes` 新增 `market_type` 入参，支持加密市场（Binance）分钟级别K线；同时对加密日线做出多项优化。

<details>
<summary><strong>🎯 v4.3.0 新功能</strong></summary>

- **⏱ 分钟K线增强**：`stock_data_minutes` 新增 `market_type`（`cn`/`crypto`），支持 Binance 分钟线
- **🪙 加密分钟线**：兼容 `BTCUSDT`/`BTC-USDT`/`BTC/USDT`/`coinid.USDT`；频率映射 `1MIN/5MIN/15MIN/30MIN/60MIN → 1m/5m/15m/30m/1h`
- **📦 自动分页**：Binance 单次最多1000根K线，自动分页直至覆盖完整区间
- **🧭 智能扩展取数（日线）**：请求技术指标时自动扩展开始日期，保证计算窗口足够
- **🧩 友好错误提示**：无效交易对返回 400 时，明确提示“该币对在 Binance 不存在或已下线”
- **📈 A股前复权（日线）**：自动应用前复权（基于最新交易日因子）

其他能力保持不变：Web在线体验、NPM 包、Streamable HTTP、稳定会话管理等。

**迁移指南**：升级到 v4.3.0 后，分钟线新增必填 `market_type`：A股传 `cn`，加密传 `crypto`。

</details>

### 🧱 CSI 指数成分摘要工具增强 (NEW!)

- 指数区间行情 + 成分股权重与区间涨跌幅
- 新增估值/财务指标：PE(TTM)、PB、股息率、ROE、ROA、净利率、每股经营现金流、资产负债率、营收同比、资产周转率、毛利率、三费比率、现金分红率
- 支持 `.SH/.SZ` 形式的中证指数代码（如 `399975.SZ`），自动回退查找最近权重日与估值日

### 🇺🇸 美股财务分析模块 (NEW!)

**最新添加**：我们新增了完整的美股财务分析功能！

<details>
<summary><strong>📊 新增功能</strong></summary>

- **🇺🇸 company_performance_us** - 专业的美股财务分析工具
- **📈 利润表分析** - 营业收入、毛利率、净利润、每股收益分析
- **💰 资产负债表分析** - 资产、负债、股东权益结构与财务比率
- **💸 现金流量表分析** - 经营、投资、筹资现金流与自由现金流
- **📊 综合财务指标** - ROE、ROA、盈利能力、成长性、偿债能力等
- **🎯 智能数据处理** - 多期对比分析、趋势计算、关键指标提取
- **🌟 中英文兼容** - 支持中英文财务科目智能识别

**支持公司**：覆盖主要美股和中概股，包括英伟达(NVDA)、苹果(AAPL)、特斯拉(TSLA)、微软(MSFT)等。

**API集成**：基于[Tushare美股财务数据API](https://tushare.pro/document/2?doc_id=394)，4大数据接口完整集成。

</details>

### 🏛️ 港股财务分析模块

**已添加**：我们新增了全面的港股财务分析功能！

<details>
<summary><strong>📊 功能特色</strong></summary>

- **🏛️ company_performance_hk** - 专门的港股财务分析工具
- **📈 利润表分析** - 营业额、利润率、每股收益、综合收益分析
- **💰 资产负债表分析** - 资产、负债、权益结构与关键财务比率
- **💸 现金流量表分析** - 经营、投资、筹资活动与自由现金流计算
- **🎯 智能数据处理** - 自动财务比率计算和多期对比分析
- **🌟 增强用户体验** - 结构化表格、智能分类、趋势分析

**支持公司**：所有港交所上市公司，包括腾讯(00700.HK)、阿里巴巴(09988.HK)、建设银行(00939.HK)等。

**API集成**：基于[Tushare港股财务数据API](https://tushare.pro/document/2?doc_id=389)，完整数据格式优化。

</details>

## ⏱ 分钟K线工具

`stock_data_minutes`：A股（Tushare）与加密（Binance）分钟级别K线。

- 频率：`1MIN/5MIN/15MIN/30MIN/60MIN`（不区分大小写）
- 入参：
  - `market_type`: `cn` | `crypto`
  - `code`: A股如 `600519.SH`；加密如 `BTCUSDT`/`BTC-USDT`/`BTC/USDT`/`bitcoin.USDT`
  - `start_datetime`: `YYYYMMDDHHmmss` 或 `YYYY-MM-DD HH:mm:ss`
  - `end_datetime`: 同上
  - `freq`: 例 `1MIN`
- 返回：倒序表格（时间/开盘/最高/最低/收盘/成交量；A股含成交额(万元)）

示例（A股）：

```
name: stock_data_minutes
arguments:
  market_type: cn
  code: 600519.SH
  start_datetime: 2024-09-01 09:30:00
  end_datetime: 2024-09-01 10:30:00
  freq: 1MIN
```

示例（加密）：

```
name: stock_data_minutes
arguments:
  market_type: crypto
  code: BTCUSDT
  start_datetime: 2025-09-01 00:00:00
  end_datetime: 2025-09-01 12:00:00
  freq: 15MIN
```

## 📄 许可证

本项目采用MIT许可证。详见[LICENSE](LICENSE)文件。

---

**👨‍💻 作者**: 陈星宇  
**📧 邮箱**: guangxiangdebizi@gmail.com  
**🔗 GitHub**: [guangxiangdebizi](https://github.com/guangxiangdebizi)

⭐ 如果这个项目对您有帮助，请给我们一个Star！
