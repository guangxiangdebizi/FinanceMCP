# A 股数据服务（模块 A）：数据契约 data-1.1.0

> Phase A 基线为 `feat/ashare-data-service-v1`；Phase B 分支 `feat/ashare-analysis-v2` 修订数据正确性契约。与
> [`ashare-data-research-architecture.md`](ashare-data-research-architecture.md) 的模块划分一致：本文件只描述**数据获取、
> 存储、质量与只读访问**；指标、信号、评分、股票池与历史检验属于模块 B（量化分析引擎），不在本契约内。
> 验收证据见 [`ashare-acceptance.md`](ashare-acceptance.md) §11。

## 1. 数据来源与覆盖范围

全部来自 Tushare Pro（服务端 `TUSHARE_TOKEN`，8000 积分），日常按交易日整市场批量获取；审计修补按缺陷范围逐股查询。

| 数据集（表） | Tushare 接口 | 主键 | 获取方式 / 频率 | 当前覆盖（2026-10-16） |
|---|---|---|---|---|
| `trade_cal` | `trade_cal`（SSE） | `cal_date` | 每次同步刷新 `start−400 天 ~ 今天+30 天` | 20221128~20261116，961 个交易日 |
| `stock_basic` | `stock_basic`（L/D/P 三次） | `ts_code` | 每次同步整表刷新（`updated_at`） | 5577 上市 + 339 退市，356 只 92xxxx.BJ |
| `daily` | `daily` | `(ts_code, trade_date)` | 每交易日一次批量；as-of 日每次运行都复查 | 20240102~20261016，673 天，3,642,948 行 |
| `daily_basic` | `daily_basic` | `(trade_date, ts_code)` | 同上 | 与 `daily` 一一对应（缺失 0） |
| `adj_factor` | `adj_factor` | `(ts_code, trade_date)` | 同上 | 有行情的股票缺失 0；停牌股也有因子 |
| `stk_limit` | `stk_limit` | `(ts_code, trade_date)` | 同上 | 含 86 个不在 `stock_basic` 的代码（B 股等），不影响 A 股 |
| `suspend_d`（新增） | `suspend_d`（`suspend_type=S`） | `(trade_date, ts_code)` | 每交易日一次；用于区分停牌与缺口 | 20240102~20261016（本轮回填） |
| `index_daily` | `index_daily`（8 个核心指数） | `(ts_code, trade_date)` | 按指数区间，向前补历史、向后追加，as-of 日复查；`audit --fix` 可补单日空洞 | 20221201~20261016，各 937 根 |
| `fina_indicator` | `fina_indicator_vip`（按报告期） | `(ts_code, end_date, ann_date)` | 最近 3 个报告期每次刷新，更早的取一次 | 20231231~20260930，12 期，69,187 行 |

审计与同步记录：`sync_log`（每个键最新一次）、`sync_history`（每次请求）、`quality_check`（每日质量）、`data_audit` + `audits/*.json`（历史审计）。

## 2. 数据访问契约（`src/ashare/data.ts`）

分析引擎与 MCP 数据工具共用同一组函数，不在各工具里复制 SQL 或复权计算：

| 函数 | 用途 | 消费者 |
|---|---|---|
| `resolveCode` / `parseYmd` / `intParam` / `listParam` | 代码、日期、整数与列表参数校验（参数绑定，无字符串拼接） | 全部工具 |
| `adjustmentRatio` / `baseFactor` | 复权定义（见 §4） | `bars.ts`（引擎 K 线）、`ashare_stock_history` |
| `financialsAsOf` | 公告日约束的全市场财务快照 | `fundamentals.ts`（引擎评分） |
| `financialHistory` | 单股财务历史（逐报告期、修订与异常） | `ashare_financial_data` |
| `breadthByDate` | 全市场涨跌、涨跌停、成交额计数 | `market.ts`（引擎市场宽度）、`ashare_market_data` |
| `stockCoverage` | 单股逐交易日分类：有行情 / 停牌 / 上市期外 / 待退市 / 缺口 | `ashare_stock_history` |
| `provenance` | 来源接口、首次/最近获取时间、刷新结果 | 全部数据工具 |
| `stockBasic` | 股票基础信息 | `ashare_stock_basic` |

| 项目 | 约定 |
|---|---|
| 股票代码 | `600519.SH` / `000001.SZ` / `920xxx.BJ`；也接受 6 位数字或股票全称 |
| 日期 | `YYYYMMDD`（接受 `YYYY-MM-DD`），校验真实日期；区间为闭区间 `[start_date, end_date]` |
| 交易日 / 自然日 | 行情按交易日；区间内非交易日不返回行；长度上限用自然日（历史行情 ≤ 3700 天）或交易日（市场数据 ≤ 60 天）明确标注 |
| 最后可用日期 | 查询的 `end_date` / `as_of_date`：不读取之后的价格、复权因子或公告；`end_date` 晚于缓存最新交易日时给出提示 |
| 缺失值 | `null`，从不转换为 0；停牌、上市期外、待退市与缺口分别列出 |
| 来源与时间 | `source[]`：`Tushare Pro <接口>`、`first_synced_at`、`last_synced_at`、`refresh_status`、`cache_status` |
| 质量 | `data_quality`：`status`（READY/DEGRADED/NOT_READY）与 `cache_status`，见 §5 |
| 错误 | 参数错误、范围超限返回明确中文错误（MCP 400）；无数据返回 `empty: true` 或空 `rows` 与警告，不以相邻日期替代 |
| 输出体积 | 历史行情 ≤ 500 行/次（`next_start_date` 分页）；财务 ≤ 40 期；市场 ≤ 60 交易日；基础信息 ≤ 50 个代码或 ≤ 100 条/页（`next_offset`） |

## 3. 单位

| 字段 | 单位 |
|---|---|
| `open/high/low/close/pre_close` | 元（指数为点） |
| `pct_chg`、`turnover_rate` | % |
| `vol` | 手（100 股） |
| `amount`（个股与指数） | 千元；`amount_yi` = 亿元 |
| `total_mv`、`circ_mv` | 万元 |
| `roe`、`roe_dt`、`*_yoy`、`grossprofit_margin`、`debt_to_assets` | % |
| `ocf_to_profit` | **%**（Tushare 原值为百分数：600519 最新为 115.11，即 115.11%） |
| `eps`、`ocfps` | 元/股 |

> 数据契约发现（正式 V1 保持原规则，研究 V2 修正为 80，见 [分析契约](ashare-analysis-v2.md)）：`score-1.0.0` 的现金流项按 `ocf_to_profit ≥ 0.8` 判断，
> 把百分数当作比值，等价于“经营现金流相对利润 ≥ 0.8%”。结果是几乎所有现金流为正的公司都得满分。修订必须作为新的评分版本处理。

## 4. 复权方法

设 `f(t)` 为 Tushare `adj_factor`：

- `none`：交易所原始价格。
- `qfq`（前复权）：`price(t) × f(t) / f(base)`，`base` = 查询 `end_date` 当日或之前该股最后一个复权因子。**不使用 end_date
  之后的因子**；因此同一段历史在不同 `end_date` 下的前复权价格可以不同，分页时保持同一 `end_date`，基准不变。
- `hfq`（后复权）：`price(t) × f(t)`。
- 缺少当日因子：数据工具对该行返回 `adj_* = null`、`adj_factor_missing = true`，不向前填补；分析引擎（`bars.ts`）为显示连续
  而沿用前一因子，但该股票被标为不可评分、不输出信号（`analysis.ts`，上一轮已实现）。两者使用同一个 `adjustmentRatio`。
- 成交量与成交额不复权。

真实数据核验：600519 在除权除息日前后，前复权收益与交易所 `pct_chg` 一致；引擎 260 日 K 线与工具前复权逐日一致（§11）。

## 5. 更新、补齐与质量语义

**日常更新**（`daily`，18:40 / 21:10）：最近 5 个交易日补缺，as-of 日每次都重新请求 `daily/daily_basic/adj_factor/stk_limit/suspend_d`
与核心指数。完整返回（≥ 前一交易日与已存条数的 97%）时整日原子替换；短返回时，若已有完整缓存则保留原快照（`kept`），
否则合并有效行（`merged`）；请求报错不改动数据（`none`）。`suspend_d` 无法用条数判断完整性，请求成功即替换当日。

**两种状态**：
- `refresh_status`（`sync_log`/`sync_history`，每次请求）：`REFRESH_OK` / `REFRESH_INCOMPLETE` / `REFRESH_FAILED`，
  同时记录获取行数、原有行数、写入后行数与写入方式。
- `cache_status` 与最终 `status`（`checkQuality`）：缓存不满足核心门槛 → `NOT_READY`；缓存满足但非核心不足或最新刷新异常 →
  `DEGRADED`（写明沿用上一次有效快照）；否则 `READY`。下一次 `REFRESH_OK` 后自动恢复。
- `snapshot`（新增）：每个数据集当日缓存最后一次被写入的时间；最大相差超过 60 分钟时 `mixed=true` 并说明较早的数据集是上一次
  有效快照。不改变 READY/DEGRADED 判定，只做披露（`ashare_data_status` 中显示）。本轮不实现跨数据集全局事务。

**历史审计与补齐**（`finance-ashare audit [--start] [--end] [--fix]`，`src/ashare/audit.ts`）：逐交易日检查
1. 整日缺少行情；
2. 当日处于上市期（当前 `stock_basic` 上市/退市日期）却无行情的股票，分为停牌（`suspend_d`）、待退市（已有退市日、最后一根 K 线之后）、
   **上游确认缺失**（`gap_check`：按代码向 Tushare 查询，既无行情也无停牌记录）与**无法解释的缺口**——不只看全市场条数比例；
3. 有行情但缺复权因子 / 每日指标 / 涨跌停价；
4. 核心与非核心指数缺失；
5. OHLC、成交量、成交额非法，涨跌幅与昨收不一致；
6. 昨收与前一交易日复权收盘不一致（不同时间修订混入的迹象）；复权因子在两根 K 线间的变化足以让昨收变动至少 1 个价位（0.01 元），
   但昨收仍等于前收盘——因子精度噪声或上游修订只被部分日期采用（更小的变化是分红不足 1 个价位，不标记）；
7. `sync_log` 记为 ok 但实际缓存条数不足（曾记录成功、后来缺失）；
8. 最新刷新异常（包含 `suspend_d`），停牌数据未同步。停牌刷新失败保留此前成功快照，查询标注沿用旧缓存并降为 DEGRADED；成功刷新后恢复。

`GAP` 为需要补齐，`WARN` 为披露但不是缺口。`--fix` 只处理审计发现的问题：
- 整日无行情 → 对四个数据集整日 refresh（完整返回才替换，短返回不混入）；单个数据集的 `sync_log` 记为成功但缓存条数不足 → 只刷新该数据集；单股 OHLC 非法 → 只修补该股票、日期的 daily，不改写其他股票的因子；
- 单只股票缺行情或缺复权因子 → **按股票**请求该日数据并合并，其他股票的已存数据不被改写（真实数据上发现：整日 refresh 会把上游
  修订过的其他股票复权因子写入少数日期，造成同一股票新旧因子并存，因此改为逐股修补）；仍缺行情的股票再按代码查询 `suspend_d`，
  查到停牌则写入，否则在 `gap_check` 记录“上游无数据”和检查时间；该结论默认 90 天后过期，`audit --fix` 会重新查询；
- 未同步停牌数据的日期补 `suspend_d`，缺失的指数补单日。
逐股修补记入 `sync_log`/`sync_history`（数据集名 `repair:<表>`，键 `<代码>:<日期>`），不覆盖按日的同步记录。重算被修补日期的质量检查；
不重下完整数据，不写股票池或报告。补齐前后两次审计都存入 `data_audit` 与
`audits/<audit_id>.json`（互相引用），`ashare_data_status` 显示最近一次审计。

## 6. 历史可得性规则与局限

| 时间 | 含义 | 字段 |
|---|---|---|
| 数据所属时间 | 行情交易日 / 财务报告期 | `trade_date` / `end_date` |
| 首次发布或披露时间 | 财务为公告日；行情的 Tushare 发布时间不可得 | `ann_date` |
| FinanceMCP 获取时间 | 本地首次与最近获取时间 | `first_synced_at` / `last_synced_at` |

- 财务：as-of 查询只使用 `ann_date ≤ as_of` 的记录；同一报告期多次公告取 as-of 前最新一条，其余作为 `revisions` 列出变动字段；
  `ann_date` 早于报告期末的记录（当前 1 条：603400.SH 20260630 报告期标注 20260422 公告，数值与 20260803 公告相同）视为上游异常，
  **不参与** as-of 选择（引擎 `financialsAsOf` 与工具同一规则）。常规查询仅列出报告期末及公告日都不晚于 as_of 的异常；其他异常只出现在缓存审计 `global.fina_ann_date_before_period_end`。修复前该记录使引擎在 20260422~20260802 期间
  提前看到尚未结束的报告期；20260430 实测只影响这一只股票，且其当日不在评分候选内，正式输出未变化。
- 财务不是严格 Point-in-Time：Tushare 不保留修订版本，同一公告日的更正（`update_flag=1`）覆盖原值；
  北交所旧代码（43/83/87）下仍有一份 2023~2026 年的财务记录，与 92 代码的记录重复，工具按所查代码返回。
- 当前口径数据：行业、名称（ST 标记）、上市状态来自当前 `stock_basic`，不代表历史日期的状态。
- 代码变更未合并：例如 300114.SZ（2025-02-14 前的 268 根 K 线）→ 302132.SZ。旧代码不在 `stock_basic` 中，
  `ashare_stock_history` 仍能返回其行情，并提示基础信息不可得；引擎的全市场扫描以 `stock_basic` 为股票全集，历史重放中不含这类旧代码。
- 行情的上游修订只在 as-of 日的两次运行内被纳入；更早日期的事后修订需要手动 `sync --force` 或在审计发现不一致时 `audit --fix`。

## 7. MCP 数据工具

全部只读（SQLite 只读连接，`readOnlyHint`），返回单行 JSON 文本，带 `contract_version`。

### 7.1 `ashare_stock_history`

| 参数 | 说明 |
|---|---|
| `ts_code`（必填） | 股票代码、6 位数字或全称 |
| `start_date` | 缺省 = `end_date` 往前 `limit` 个交易日 |
| `end_date` | 缺省 = 最近交易日；也是前复权基准日 |
| `adjust` | `none` / `qfq`（默认）/ `hfq` |
| `limit` | 默认 120，最大 500；超出时 `truncated=true`、`next_start_date` |
| `include_basic` | 附带 `turnover_rate, volume_ratio, pe_ttm, pb, total_mv, circ_mv` |

返回：`fields` + `rows`（列式，便于引擎复用）、`adjust{mode, formula, base}`、`units`、`coverage{trade_days, bars, suspended_days,
not_listed_days, pending_delisting_days, missing_days, suspend_data_missing_days, adj_factor_missing_days}`、`data_quality`、`source[]`、`warnings[]`。

```json
{
 "ts_code": "600519.SH",
 "name": "贵州茅台",
 "list_date": "20010827",
 "delist_date": null,
 "list_status": "L",
 "query": {
  "start_date": "20261015",
  "end_date": "20261016",
  "adjust": "qfq",
  "limit": 2,
  "include_basic": false
 },
 "returned": {
  "first": "20261015",
  "last": "20261016",
  "rows": 2
 },
 "truncated": false,
 "next_start_date": null,
 "adjust": {
  "mode": "qfq",
  "formula": "…",
  "base": {
   "trade_date": "20261016",
   "adj_factor": 8.6463
  }
 },
 "fields": [
  "trade_date",
  "open",
  "high",
  "low",
  "close",
  "pre_close",
  "pct_chg",
  "vol",
  "amount",
  "adj_factor",
  "adj_open",
  "adj_high",
  "adj_low",
  "adj_close",
  "adj_factor_missing"
 ],
 "rows": [
  [
   "20261015",
   1286,
   1317.76,
   1282,
   1312.97,
   1286,
   2.0972,
   57677.22,
   7537706.224,
   8.6463,
   1286,
   1317.76,
   1282,
   1312.97,
   false
  ],
  [
   "20261016",
   1311.57,
   1329.88,
   1301.68,
   1329,
   1312.97,
   1.2209,
   38501.75,
   5075528.306,
   8.6463,
   1311.57,
   1329.88,
   1301.68,
   1329,
   false
  ]
 ],
 "coverage": {
  "trade_days": 2,
  "bars": 2,
  "suspended_days": [],
  "not_listed_days": 0,
  "pending_delisting_days": [],
  "upstream_missing_days": [],
  "missing_days": [],
  "suspend_data_missing_days": 0,
  "adj_factor_missing_days": []
 },
 "data_quality": {
  "trade_date": "20261016",
  "status": "READY",
  "cache_status": "READY"
 },
 "warnings": [],
 "contract_version": "data-1.0.0"
}
```
（真实输出，省略 `units`、`source` 与公式文本；20261016 的复权因子即基准，故前复权价等于原始价。更多真实检验见 `docs/ashare-samples/data-service-real-cache.json`。）

### 7.2 `ashare_financial_data`

参数：`ts_code`（必填）、`as_of_date`（缺省最近交易日）、`start_period` / `end_period`（报告期末日）、`limit`（默认 8，最大 40）、
`include_revisions`。返回 `periods[]{end_date, ann_date, values, announcements, revisions?}`、`units`、`anomalies[]`、`selection_rule`、`availability`、`source[]`。data-1.1.0 删除 `hidden_after_as_of`；常规 as-of 查询不暴露之后公告的记录数或尚未结束的异常报告期。

### 7.3 `ashare_market_data`

参数：`start_date`（缺省 = `end_date`）、`end_date`（缺省最近交易日）、`indices`（8 个核心指数的子集）、`include_breadth`（默认 true）。
单次最多 60 个交易日。每日返回 `indices[]`（OHLC、昨收、涨跌幅、成交量、成交额）、`missing_indices`、`breadth{stocks_traded, up, down,
flat, limit_up, limit_down, limit_price_coverage, limit_counts_complete, amount, amount_yi, listed, suspended}`、`data_quality`。
计数与正式日报 `market.breadth` 使用同一函数（20261016 实测一致）；不含市场状态或择时判断。

### 7.4 `ashare_stock_basic`

参数：`ts_codes`（≤ 50）或 `query`（名称/代码片段，`LIKE` 通配符已转义）、`industry`、`list_status`、`limit`（≤ 100）、`offset`。
返回 `stocks[]`（代码、名称、地域、行业、板块、交易所、上市/退市日期、状态、`updated_at`）、`not_found`、`total`、`next_offset`、`limitations`。
现有五个工具无法查询上市/退市日期与按条件检索，因此新增；不新增其他基础信息工具。

### 7.5 不在本轮实现

`ashare_factor_snapshot`（阶段 B 已实现，见 [分析契约](ashare-analysis-v2.md)）：1–20 只股票的原始/标准化因子、单位、准入、V1/V2 贡献、信号与质量；不改变本数据契约的定义。

## 8. 与量化分析引擎的边界

- 模块 A（本文件）：`fetch.ts`、`ingest.ts`、`sync.ts`、`audit.ts`、`data.ts`、`db.ts`、`bars.ts`（行情序列）。不计算指标、信号或评分。
- 模块 B：`indicators.ts`、`signals.ts`、`market.ts`（市场状态）、`analysis.ts`、`watchlist.ts`、`evidence.ts`。本轮只把它们读取数据的
  三处改为调用 `data.ts`（复权比例、财务快照、宽度计数），公式、评分、股票池规则与证据方法均未改动。
- 正式/研究隔离不变：只有 `daily` 写正式股票池与报告；`audit --fix` 与 `sync` 只写行情与质量记录。

## 9. 下一阶段（分析引擎）可直接使用的数据契约

| 需求 | 接口 |
|---|---|
| 单股或股票集的前复权日线（as-of 基准、无未来因子） | `forEachStockBars(db, start, end, cb, codes)`；单股带分类 `stockHistory` |
| 停牌/缺口分类（可成交性、样本筛选） | `stockCoverage`、`suspend_d` 表 |
| 涨跌停价（不可成交判断） | `stk_limit`、`Bars.upLimit` |
| 按公告日的财务快照与历史 | `financialsAsOf(db, asOf)`、`financialHistory` |
| 全市场宽度与成交额 | `breadthByDate(db, start, end)` |
| 当前口径元数据与其局限 | `stockBasic`、`DATA_CONTRACT.availability` |
| 数据质量与来源 | `checkQuality(db, date, false)`（`status/cache_status/refresh/snapshot`）、`provenance`、`auditCache` |

阶段 B 需要自行处理的已知数据局限：代码变更未合并、行业与 ST 为当前口径、财务无修订版本、`ocf_to_profit` 为百分数。
