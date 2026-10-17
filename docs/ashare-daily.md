# A 股日频研究模块（`src/ashare/`）

FinanceMCP 内的轻量 A 股日频数据与分析模块，为 ChatGPT 网页版 A 股日报定时任务提供 MCP 工具。
所有计算在同一个 FinanceMCP 服务和同仓库 CLI 中完成；数据缓存为 SQLite（Node 内置 `node:sqlite`，
无新增运行时依赖），日报快照为 JSON 文件；定时更新使用 systemd user timer。

- 上游基线：`guangxiangdebizi/FinanceMCP` `main` @ `486494a`（v4.11.2，2026-10-16 拉取，基线 `npm test` 46/46 通过）
- 运行环境：Oracle ARM64（aarch64）Ubuntu 22.04，宿主 Node v24.16.0，容器 `node:lts-alpine` Node v24.22.0（arm64），SQLite 3.53
- 需要 Node ≥ 22.13（`node:sqlite`）。上游原有 19 个工具在未启用 A 股模块时仍可在 Node 20 上运行（A 股实现为惰性加载）。

## 架构

```
systemd user timer (18:40 / 21:10 Asia/Shanghai, 工作日)
  └─ deploy/ashare/run-daily.sh
       └─ docker exec finance-mcp-ashare node build/ashare/cli.js daily
            ├─ sync: trade_cal → stock_basic → 按交易日批量 daily / daily_basic / adj_factor / stk_limit
            │        → index_daily 增量 → fina_indicator_vip（按报告期批量）
            ├─ quality check → READY / DEGRADED / NOT_READY
            ├─ analysis: 指标 → 信号 → 行业强弱 → 评分 → 股票池（滞后/行业约束）
            ├─ evidence（超过 7 天自动重算）
            └─ report: data/reports/<日期>/<报告ID>.json + latest.json + report 表

finance-mcp-ashare 容器（唯一长期运行服务，127.0.0.1:8130）
  └─ httpServer.ts /mcp  ←  Caddy share.shijingchang.cn/ashare/mcp*（strip /ashare）
       └─ FINANCE_TOOL_PROFILE=ashare_daily → 5 个只读本地工具（不进入外部数据源 fallback 路由）
```

| 文件 | 作用 |
|---|---|
| `src/ashare/db.ts` | SQLite 结构（`daily/adj_factor/stk_limit` 以 `(ts_code, trade_date)` 为主键、`trade_date` 二级索引）、WAL、mmap、批量 upsert、同步日志 |
| `src/ashare/fetch.ts` | 复用 `callTushare`，增加 offset 分页、最小调用间隔、限频/网络错误退避重试 |
| `src/ashare/ingest.ts` | 交易日历、股票列表、按交易日批量下载、指数增量、财务指标、数据质量检查 |
| `src/ashare/sync.ts` | 区间增量同步 |
| `src/ashare/indicators.ts` | MA/EMA/MACD/RSI/BOLL（复用并修复上游实现）+ CCI/ATR/量能 |
| `src/ashare/signals.ts` | 9 条规则明确的技术信号（触发/失效/风险文本） |
| `src/ashare/market.ts` | 指数表现、成交额、涨跌家数、涨跌停、宽度、市场状态 |
| `src/ashare/analysis.ts` | 全市场扫描、行业强弱、启发式评分 |
| `src/ashare/fundamentals.ts` | 公告日约束（point-in-time）财务指标与财务风险 |
| `src/ashare/watchlist.ts` | 动态股票池（30~50 只、行业上限、滞后规则、历史） |
| `src/ashare/evidence.ts` | 最小历史信号效果检验（按市场状态分组） |
| `src/ashare/report.ts` | 日报快照、报告 ID、NOT_READY 策略 |
| `src/ashare/definitions.ts`, `tools.ts` | MCP 工具定义与实现 |
| `src/ashare/cli.ts`, `commands.ts` | `finance-ashare` CLI |
| `src/toolProfile.ts` | 工具暴露配置（profile / allowlist / 配置文件） |

## 对上游的修改（最小化）

1. **RSI 口径**（`src/tools/stockDataDetail/rsi.ts`）：原实现为滚动简单平均（Cutler RSI），改为 Wilder 平滑，与通达信/同花顺 `SMA(X,N,1)` 一致。
2. **MACD 时间对齐**（`macd.ts`）：原实现对 DIF 求 EMA 后在前面再填充 `slow-1` 个 NaN，导致 DEA/柱状图相对 DIF 整体后移 25 根 K 线；改为对完整 DIF 序列直接求 EMA。
3. **指标时间索引**（`stockData.ts`、`dataCalculator.ts`）：Tushare 分支在 `reverse()` 前未显式排序（假定接口返回倒序）；截取用户区间时只过滤了行情行而未过滤指标数组。现显式按交易日倒序排序，并用同一掩码过滤行情与指标（`filterRowsAndIndicators`）。MACD/RSI 预热期加长（EMA/Wilder 需要收敛）。
4. **客户端认证与数据源认证分离**（`httpServer.ts`）：原逻辑把 `Authorization: Bearer` 直接当作 Tushare Token。
   - `MCP_AUTH_TOKEN` 设置后：Bearer 仅用于客户端认证（常量时间比较，401），永不转发给 Tushare。
   - 未设置时保持上游行为；可用 `MCP_BEARER_AS_TUSHARE_TOKEN=0` 关闭。
   - `MCP_ACCEPT_REQUEST_CREDENTIALS=0`：忽略请求中所有数据源凭证，仅使用服务端环境变量。
   - `MCP_RATE_LIMIT`（每 IP 每分钟）与 `MCP_TRUST_PROXY`（反向代理后获取真实 IP）；新增 `ping` 响应。
5. **工具暴露配置**（`toolProfile.ts`、`dispatch.ts`）：默认行为不变（19 个工具，A 股工具隐藏）。
   - `FINANCE_TOOL_PROFILE=ashare_daily`：只暴露 5 个 A 股工具。
   - `ASHARE_ENABLED=1`：在 full 配置中追加 A 股工具。
   - `FINANCE_ENABLED_TOOLS=a,b`：白名单；`FINANCE_TOOL_CONFIG=/path/tools.json`（`{"profile":"full","enabled_tools":[...]}`）。
   - 被隐藏的工具直接调用同样被拒绝；A 股工具不受请求凭证范围影响，也**不进入** `routeToolCall` 外部数据源 fallback。
6. `@types/node` 升级到 22（仅类型定义，用于 `node:sqlite`）。

## 数据下载策略

- **按交易日批量**：`daily`、`daily_basic`、`adj_factor`、`stk_limit` 每个交易日各 1 个全市场请求（约 5.5k 行），绝不逐股下载。
- **分页**：所有请求带 `limit/offset`，直到返回短页为止（`fetchAll`）；`fina_indicator_vip` 单期约 1.1 万行，分 3 页。
- **速率**：调用间隔 ≥ 160ms（`ASHARE_TUSHARE_MIN_INTERVAL_MS`）；“每分钟最多访问”类错误等待 61s 重试；网络/超时错误指数退避，最多 4 次；权限/参数类错误不重试。
- **缺失与不完整**：某数据集当日条数 < 前一交易日 97% 记为 `partial`，下次运行自动重取；`daily` 命令每次复查最近 5 个交易日。
- **指数**：8 个核心指数按区间增量（向前补齐历史缺口、向后追加新数据）。
- **财务**：`fina_indicator_vip` 按报告期批量（最近 12 期，最近 3 期每次刷新），保存 `(ts_code, end_date, ann_date)` 全部版本。

## 数据质量与 NOT_READY

当日满足以下任一条件即 `NOT_READY`：非交易日/日历缺失；日线缺失或条数 < 前一交易日 97%；复权因子覆盖率 < 97%；
每日指标覆盖率 < 95%；核心指数（上证指数、深证成指、沪深300）缺失；存在无效收盘价或大量 OHLC 不一致。
涨跌停价覆盖不足或非核心指数缺失为 `DEGRADED`（报告照常生成并在风险中标注）。

`NOT_READY` 报告不包含市场判断、股票池或信号，明确写明“不使用前一交易日数据替代”，仅给出最近一份可用报告的 ID 供参考。
MCP 工具在当日无报告时：数据未就绪返回 `NOT_READY`；数据已就绪但定时任务尚未发布返回 `PENDING`。工具从不生成或改写报告（只读）。

## 分析口径

见源码注释（均为规则版本的一部分）：

- 指标 `ind-1.0.0`：`src/ashare/indicators.ts` 顶部（前复权，以 as-of 日为基准）。
- 信号 `sig-1.0.0`：`SIGNAL_DEFINITIONS`（多头趋势、20 日放量突破、MACD 金叉、MACD 底背离、RSI 超卖反弹、布林收口突破、跌破 MA60、MACD 顶背离、短期过热）。
- 市场状态：沪深300 收盘相对 MA60 与 MA20 五日斜率 → 上升趋势/下降趋势/震荡。
- 行业强弱：Tushare `stock_basic.industry`；强度 = 0.5·pr(20日中位收益) + 0.3·pr(5日中位收益) + 0.2·pr(站上MA20比例)。
- 评分 `score-1.0.0`：`SCORE_RULES` 与 `analysis.ts` 注释（技术 35 / 流动性 15 / 基本面 30 / 估值 10 / 行业 10）。**评分为启发式排序，不代表盈利概率。**
- 股票池 `wl-1.0.0`：目标 40（30~50）、单行业 ≤ 4、入池需排名前 40、排名跌出 150 且持有满 5 个交易日才移出、每日新增 ≤ 6、仅当前 10 名候选对排名 > 100 的成员才替换。
- 证据 `evi-1.0.0`：`evidence.ts` 注释（次日开盘进场、相对等权市场超额、按日期聚类 t 统计、按市场状态分组，区分 `evidence_supported` / `research_only` / `contradicted`）。

## 运行命令

```bash
npm ci && npm run build
export TUSHARE_TOKEN=...            # 仅服务端环境变量
export ASHARE_DATA_DIR=$HOME/.local/share/finance-mcp-ashare

node build/ashare/cli.js sync --start 20240102 --end 20261016    # 历史回填（按交易日批量）
node build/ashare/cli.js evidence                                # 信号历史检验
node build/ashare/cli.js replay --start 20260701 --end 20261015  # 历史日期重放（写入研究库 research.sqlite，不改正式数据）
node build/ashare/cli.js daily                                   # 定时任务入口（今天；每次都重新查询当日行情）
node build/ashare/cli.js report --date 20261016                  # 仅用本地缓存生成指定日报告（始终写入研究库）
node build/ashare/cli.js pool-eval --start 20260701 --end 20261009 [--research] # 股票池实际表现（严格截至 end）
node build/ashare/cli.js acceptance --days 3 [--allow-degraded]  # 连续真实交易日验收
node build/ashare/cli.js status                                  # 数据完整性状态
node build/ashare/cli.js quality --date 20261016
node build/ashare/cli.js migrate                                 # 旧版缓存（按日期主键）一次性迁移
```

正式库与研究库：
- `ashare.sqlite`（正式库）：行情缓存 + 定时流水线的股票池、评分、报告。**只有 `daily` 写入**正式股票池/评分/报告/`latest.json`
  （`generateReport` 在正式库上拒绝 manual/replay 模式）；`daily --date` 早于正式最新股票池日期时直接拒绝，避免改写后续日期的连续性。
- `research.sqlite`（研究库，`ASHARE_RESEARCH_DB_PATH` 可改）：`replay`、任意日期的 `report --date`（包括正式最新日期）与 `pool-eval --research` 使用。
  它只保存自己的股票池/评分/质量检查/报告表，行情与信号证据通过只读 `ATTACH` 读取正式库；报告文件写在 `research/reports/`，
  不会覆盖正式 `reports/<日期>/latest.json`。
- MCP 工具只以只读连接打开正式库（不再先用可写连接初始化）；建表与迁移由容器启动命令 `cli.js migrate` 完成，结构过旧时工具报错提示运行 migrate。
  读取每个交易日的报告时按“交易日 → live → manual（旧库遗留）→ 无 run_mode → replay → 生成时间”排序。

同日重复同步：`daily` 对 as-of 交易日总是重新请求 `daily/daily_basic/adj_factor/stk_limit` 与核心指数；返回完整（≥ 前一交易日
和已存条数的 97%）时按交易日整体替换（修订值覆盖、撤回的行删除）。每次请求记入 `sync_history`（`sync_log` 仅保留最新状态）。

缓存完整性与刷新状态分开记录：`status`（ok/partial/empty）描述写入后的本地缓存；`refresh_status` 描述本次 Tushare 请求——
`REFRESH_OK`（完整返回）、`REFRESH_INCOMPLETE`（明显偏短）、`REFRESH_FAILED`（请求报错）；同时记录获取行数、原有行数、同步后行数与写入方式
（replaced / kept / merged / none）。偏短返回时：已有完整缓存则原样保留上一次快照（kept，不混入部分更新）；缓存本身不完整则合并有效行（merged）。
请求报错不改动数据。`checkQuality` 输出 `cache_status`（仅看缓存）与各数据集最新 `refresh`：缓存满足门槛但最新刷新不完整或失败时，
最终状态为 **DEGRADED** 并写明“沿用上一次有效快照”；缓存不满足核心门槛仍为 NOT_READY；下一次 `REFRESH_OK` 后自动恢复。
`ashare_data_status` 与 `ashare_daily_report` 均显示这些原因。本次修复之前的同步记录没有 `refresh_status`（显示为 null，不参与判定）。

## 部署（本 VPS）

```bash
cd deploy/ashare
cp .env.example .env && chmod 600 .env       # 填 TUSHARE_TOKEN；MCP_AUTH_TOKEN 留空 = ChatGPT “No authentication”
docker compose up -d --build                 # 唯一长期服务：finance-mcp-ashare，127.0.0.1:8130
cp finance-ashare-daily.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now finance-ashare-daily.timer
```

Caddy（`/etc/caddy/Caddyfile`，`share.shijingchang.cn` 块首部新增，路径隔离，不影响 `/mcp*` XFullReader 与其余站点）：

```
handle /ashare/mcp* {
	uri strip_prefix /ashare
	reverse_proxy 127.0.0.1:8130
}
```

备份：`/etc/caddy/Caddyfile.bak.20261016T154629Z`、`deploy/ashare/caddy/Caddyfile.before`、`caddy_config_before.json`。
回滚：用备份覆盖 Caddyfile 后 `caddy reload --config /etc/caddy/Caddyfile`。

### ChatGPT 接入

与已验证的 XFullReader 接入方式一致（Custom MCP server，“No authentication”）：

- Server URL：`https://share.shijingchang.cn/ashare/mcp`
- 暴露工具：`ashare_data_status`、`ashare_daily_report`、`ashare_watchlist`、`ashare_stock_analysis`、`ashare_sector_rank`（均 `readOnlyHint`）
- 定时任务建议在北京时间 21:30 之后运行（两次数据更新之后）；更早调用当日报告会得到 `PENDING`/`NOT_READY`，这是预期行为。
- 匿名入口的安全边界：工具只读（SQLite 只读连接），只访问本地 A 股缓存，不接受请求中的数据源凭证，不触发 Tushare 等外部 API；
  每 IP 每分钟 30 次（`MCP_RATE_LIMIT`）、请求体 ≤ 64 KB（`MCP_BODY_LIMIT`）、会话表 ≤ 1000（`MCP_MAX_SESSIONS`）。
  匿名开放的实际风险见 `docs/ashare-acceptance.md` §9.5。如需收紧，设置 `MCP_AUTH_TOKEN`（ChatGPT 侧需改用 OAuth，当前不支持静态 Bearer）。

## 验收记录

见 `docs/ashare-acceptance.md`（真实数据回填、信号检验、历史重放、E2E、调度，以及尚未完成的连续交易日与 ChatGPT 侧验收）。

## 已知限制

- 行业分类与股票名称（ST 判断）使用当前 `stock_basic` 口径，历史重放存在行业归属与 ST 状态偏差。
- `fina_indicator_vip` 同一公告日的更正记录（`update_flag=1`）覆盖原记录，真实更正发布时间不可得。
- 证据检验为本地缓存样本内统计，未计交易成本、滑点、退市，不是回测框架。`evidence_supported` 只表示样本内方向性证据：
  相邻事件日的持有期重叠（t 值偏高），9 信号 × 3 持有期 × 4 状态分组未做多重检验校正，不能称为策略有效性。
  报告只引用证据窗口截至报告日期之前的统计；更晚计算的证据在历史重放中显示为“当时不可得”。
- 复权因子缺失的股票不进入评分、不输出技术信号（风险提示中注明）。
- 评分权重为第一版启发式规则，未做收益验证。
