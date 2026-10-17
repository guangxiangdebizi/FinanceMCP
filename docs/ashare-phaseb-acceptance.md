# Phase B 验收记录（研究版，RESEARCH_ONLY）

分支 `feat/ashare-analysis-v2`，基线 `e8cbe4a`；本轮封版修复在 `fix/ashare-phaseb-freeze`（基线 `fc24fef`）。执行日期 2026-10-17。真实数据来自 Tushare Pro 正式缓存的一致性快照
`~/ashare-research/ashare-20261016.sqlite`（1.69 GB，sha256 `ac31a9eb0b65c756758e2af6bb97ec718775ae030454fbcadfc5a8d19e234dd1`），
未写入正式库、未部署、未修改 systemd timer 或 ChatGPT 任务。

## 1. 交付边界

| 项目 | 状态 |
|---|---|
| 正式评分/信号/股票池/证据版本 | 未变：`score-1.0.0`、`sig-1.0.0`、`wl-1.0.0`、`evi-1.0.0` |
| `daily` 流水线 | 仍调用原 `scanMarket()` / `updateWatchlist()` / `generateReport()`，使用 V1 |
| 新增研究入口 | `analyzeMarket()`、`ashare_factor_snapshot`、`run-research.mjs`、`research-snapshot` / `research-evaluate`，结果标 `RESEARCH_ONLY` |
| 正式数据库历史 | 未改写；研究结果只写独立 `research.sqlite` 与 `research/forward-observations.sqlite` |
| 生产部署 | 未部署 V2；本轮不切换（生产未改动证据见 §8） |

## 2. B0 数据层缺陷（已修复并验证）

| 缺陷 | 修复 | 反例测试 |
|---|---|---|
| 退市股历史中间缺口被判为待退市 | 仅在“有退市日、当日无行情、此后无任何 K 线、且有此前行情”时归入待退市；上市期中间缺口按缺口处理；停牌优先 | `test/ashare-b0.test.mjs` B0-1 |
| 单股 OHLC 非法导致整日重下四个数据集 | 整日无行情才整日刷新；`sync_log` 条数不足只刷新该数据集；非法 K 线只按股票+日期补 `daily`；缺口股票只补缺失的数据集 | B0-2 两个反例 |
| 财务历史泄露未来记录数 | 删除 `hidden_after_as_of`；as-of 查询不读取、不计数、不提及晚于 as-of 的公告或报告期；异常记录仅在期末与公告日都不晚于 as-of 时列出，其余只进缓存审计 | B0-3 |
| 停牌刷新失败未传播质量 | `suspend_d` 纳入 `checkQuality` 最新刷新判断；失败保留旧数据并降为 `DEGRADED`，查询标注 `suspend_refresh_failed_days` / `suspended_source`；成功刷新恢复 `READY` | B0-4 两个反例 |
| 上游“无数据”被永久化 | `gap_check` 带检查时间，默认 90 天过期，审计标 WARN，`audit --fix` 复查 | gap_check 反例 |

真实缓存副本验证（`docs/ashare-samples/phaseb-b0-real-cache.json`，`ok=true`）：

- 审计 673 个交易日，修复前 608 OK / 33 WARN / 32 GAP；新分类重新识别出 38 个股票日（32 天，均为 920xxx.BJ）的上市期中间缺口，旧规则误列为待退市。
- 逐股重查上游仍无行情与停牌记录；`audit --fix` 后 608 OK / 65 WARN / **0 GAP**，上游确认缺失 67 个股票日。
- 修补前后 `daily`、`daily_basic`、`adj_factor`、`stk_limit` 逐行差异为 0；`watchlist`、`watchlist_change`、`report`、`stock_score`、`signal_evidence` 差异为 0。
- 1812 次 as-of 财务查询无未来元数据泄漏；停牌刷新失败时 10 行停牌记录保留，状态 `READY → DEGRADED → READY`。
- 原始快照 sha256 前后不变。

### 2.1 P0：OHLC NULL 漏检（audit-1.2.0）

原 `audit-1.1.0` 的非法 K 线判定直接写 `open <= 0`、`vol < 0` 等比较。SQLite 中与 `NULL` 比较得到 `NULL` 而不是 `true`，因此 `open/high/low/vol/amount` 为 `NULL` 的行可以同时通过审计和 `checkQuality()`，在覆盖率正常时得到 `READY`。

修复（不改变任何评分、准入、信号或权重）：

- 判定只定义一次：`src/ashare/ingest.ts` 的 `INVALID_BAR_KINDS` / `INVALID_BAR_SQL`，显式检查 `open IS NULL OR high IS NULL OR low IS NULL OR close IS NULL`，并保留非正价格、`high < low`、收盘/开盘越界、负成交量/成交额、`vol > 0` 但成交额缺失的检查；`auditDay`、`audit --fix` 修补清单与 `checkQuality()` 共用同一表达式，三者不可能互相矛盾。
- 成交量/成交额语义明确：`NULL` 是缺失证据，任何地方都不转换为 0；`vol = 0` 且 `amount = 0` 合法，`vol = 0` 且 `amount IS NULL` 非法。
- `auditDay` 新增 `invalid_bar_kinds` 逐类计数（可同时命中多类），`invalid_bars` / `invalid_bar_codes` 含义不变；`AUDIT_VERSION` 升至 `audit-1.2.0`。
- `checkQuality()` 新增 `anomalies.null_ohlc / null_vol / null_amount / invalid_bar`，任一项大于 0 即 `NOT_READY`，与覆盖率无关；干净缓存的判定与修复前完全一致。
- `audit --fix` 仍只按 `(ts_code, trade_date)` 修补 `daily`，不扩大范围、不改写其他股票或数据集。

反例测试 `test/ashare-ohlc-audit.test.mjs`（9 项）：分别把 open、high、low、close 置 `NULL`，以及 `high < low` 非法关系，逐项验证审计 `GAP` + 精确股票定位、质量 `NOT_READY`、`--fix` 只请求该股票该日期（模拟 Tushare 调用日志断言）、修补后恢复 `OK/READY`、以及该股票技术观测为 `null`、信号被抑制而 V1 分数/排名与其他股票完全不变。另有“覆盖率全部正常但存在 NULL OHLC 仍为 NOT_READY”、成交量/成交额策略一致性、以及超过 200 只显示样本的修补清单完整性。

真实缓存验证（`deploy/ashare/verify-ohlc-audit.mjs`，证据 `docs/ashare-samples/phaseb-ohlc-audit-real-cache.json`，`PASS`）：

- 冻结快照 sha256 前后不变（`ac31a9eb…4dd1`），以 `mode=ro&immutable=1` + `query_only=ON` 只读打开。
- 最近 10 个交易日：`invalid_bars = 0`，全部 `invalid_bar_kinds` 为 0，审计 `OK`、质量 `READY`；对全部 3,642,948 行独立复核，12 类非法条件命中数均为 0。
- V1 一致性：与 `fc24fef` 基线构建对比 20261015/20261016 两个交易日，`scanMarket` 全市场逐行 JSON 相同、`analyzeMarket` V1 逐股评分/排名/组件/贡献相同，共 3,513 个可评分股票日 **0 差异**；两版扫描与信号计数一致。

## 3. B1/B2 分析契约与因子快照

- `src/ashare/engine.ts`：`engine-1.0.0` / `factor-1.0.0`。`analyzeMarket(db, {date, score_version, ts_codes, parameters})` 计算完整市场后筛选返回，分位数不随子集变化；只读、不发布、不写库。
- `ashare_factor_snapshot`：1–20 只股票，`date`/`score_version`/`include_components`；返回原始因子、标准化因子、公式代入值与默认规则、组件与逐因子加权贡献、排名、准入/剔除原因、信号与失效条件、数据质量。
- 缺失不置零：原始观测缺失为 `null`；源 OHLC 的 `NULL`/非正/不一致会使技术观测为 `null` 并抑制研究信号；20 日成交额缺失使流动性观测为 `null`。原因写入 `quality.risk_flags` 与 `imputations`；V1 评分/排名/贡献不变，便于审计。
- 单位表见 `docs/ashare-analysis-v2.md`；`ocf_to_profit` 明确为百分数。
- 真实快照证据（`docs/ashare-samples/phaseb-factor-real-cache.json`，11/11 通过）：MCP 结果与内部引擎深度相等、重复请求字节相同、20 只上限生效、停牌无行情股票返回显式 `null` 且 `eligible=false`、源文件 sha256 不变、写操作被拒。约 41 KB、单次约 9 秒（含全市场归一化）。
  该快照本身无非法 OHLC/NULL 成交额，因此真实验证证明掩码已接线且在干净数据上不误伤；脏数据行为由 `test/ashare-engine.test.mjs` 的 13 个反例覆盖。

### 3.1 ChatGPT 研究层接口检查

正式工具集仍为 **十个只读工具**（原九个 + `ashare_factor_snapshot`），定义顺序与名称未变（`src/ashare/definitions.ts`，测试断言完整列表）。`ashare_factor_snapshot` 保持 `RESEARCH_ONLY`：不写正式库、不发布报告、不更新股票池，且其导入路径不包含 `evaluation.ts`（唯一会读取未来价格的模块）。

`test/ashare-research-interface.test.mjs` 覆盖以下契约：

| 契约 | 断言 |
|---|---|
| 评分版本可见 | 响应顶层 `score_version` 等于请求版本；同一请求分别用 `score-1.0.0` / `score-2.0.0` 返回不同版本标识 |
| 版本可追溯 | `trade_date`、`engine_version`、`factor_version`、`indicator_version`、`signal_version`、逐行 `factor_version`、`policy`、`units` 全部返回 |
| 三层分离 | `raw`（源单位）、`normalized`（0–1 或 null）、`scoring_factors`（公式代入值）、`components` / `contributions` / `factor_contributions`（加权贡献）分别返回；逐因子贡献与组件贡献之和均还原总分（误差 < 0.011） |
| 缺失不置零 | 观测缺失保持 `null`，对应 `scoring_factors` 给出显式默认值并在 `imputations` 说明；`quality.missing_factors` 与 `raw` 的 null 一致 |
| 确定性 | 相同请求两次返回字节完全相同；MCP 入口与内部 `analyzeMarket()` 的 JSON 字节相同 |
| 无回测副作用 | 调用前后 `daily`/`stock_score`/`watchlist`/`watchlist_change`/`report` 行数不变、`total_changes()` 不变、缓存文件大小不变；只读连接下写入被拒绝 |

### 3.2 真实缓存性能复测

`deploy/ashare/verify-factor-performance.mjs` 在冻结真实快照（sha256 `ac31a9eb…4dd1`，1.69 GB）上对 2026-10-16 分别请求 1/5/20 只股票，各预热 1 次、测量 3 次取中位；证据 `docs/ashare-samples/phaseb-factor-performance.json`：

| 股票数 | 墙钟中位 | CPU 中位（user+sys） | 响应体积 | 进程峰值 RSS | 20/1 墙钟比 |
|---:|---:|---:|---:|---:|---:|
| 1 | 8,612 ms | 8,704 ms | 8,988 B | 1,169 MB | — |
| 5 | 8,389 ms | 8,465 ms | 15,308 B | 1,169 MB | — |
| 20 | 8,313 ms | 8,397 ms | 43,383 B | 1,171 MB | 0.965 |

每次调用都会扫描并归一化全市场（当日 3,933 只有估值观测、约 5.5k 只扫描），再筛选请求股票，因此耗时与请求只数基本无关（20 只与 1 只相差 < 3%），响应体积随只数线性增长。CPU ≈ 墙钟说明是单线程计算受限。三次重复响应 SHA256 一致，前后快照 SHA256 不变，写入被拒绝。

判定：**对研究型交互接口可接受**——最差中位 8.6 s，远低于 15 s 阈值，且不随请求规模恶化；未发现影响实际使用的问题，因此按任务要求**不新增缓存系统、不重构扫描引擎**。公网部署仍待正式流水线安全验收后决定。单次调用约 1.2 GB 峰值 RSS 需要在容器内存限制中留出余量（见 §7）。

### 3.3 真正的前瞻研究快照（`research-snapshot` / `research-evaluate`）

`src/ashare/snapshot.ts` 新增两个命令，从真实交易日开始独立记录 V1/V2 研究结果；完整说明见 [前瞻研究快照](ashare-research-snapshot.md)。

- `finance-ashare research-snapshot --date YYYYMMDD [--db PATH] [--revise] [--horizon 10]`：正式库以只读连接打开，结果写入独立的 `<ASHARE_DATA_DIR>/research/forward-observations.sqlite`。执行条件按顺序检查：交易日历、数据截止日（`MAX(daily.trade_date)`）、上海今天、当日行数、`checkQuality` 非 `NOT_READY`、存在 `run_mode='live'` 的正式报告；任一不满足返回 `NOT_TRADE_DAY` / `PENDING` / `NOT_READY` 且**不写入任何内容**。禁止用后续数据伪装当日快照。
- 计算：V1 = `scanMarket()`（`score-1.0.0`），V2 = 同一可评分集合克隆上的 `scoreRows(..., 'score-2.0.0')`；V1 分数/排名必须与正式 `stock_score` 当日行逐只相等，否则中止且不写库。
- 保存：交易日、实际创建时间、正式 `report_id`、完整质量报告与缺失原因、逐数据集 `written_at`/`spread_minutes`/`mixed` 与同步时间、各版本号、`build_sha256`、费用/持有期参数、每只可评分股票的原始因子与两版分数/排名/组件/归一化因子/逐因子贡献/默认值说明、两版股票池成员（含快照时信号）、池差异、逐股评分差异、`future_returns` 状态。
- 两个池明确区分：V1 池 = 正式 live `watchlist`（`pool_source=formal_live_watchlist`）；V2 池 = 按未修改 `wl-1.0.0` 规则从上一份 V2 研究池逐日推进的独立池（`pool_source=research_v2_sequential`）。
- 不可变：同一交易日已有快照时只返回 `EXISTS`（含重算 ID 与内容是否一致），绝不覆盖；`--revise` 追加 `REVISED` 行并指向原始 `snapshot_id`，原始行逐字节不变。
- `research-evaluate --date YYYYMMDD [--as-of YYYYMMDD]`：用保存的成员与当时信号、同一 `evaluateEvents()` 与同一 `as_of` 评价两版；持有期未结束返回 `PENDING`，完成数 0、收益 `null`，不生成任何假定未来收益；结果只追加到 `snapshot_evaluation`。

反例测试 `test/ashare-snapshot.test.mjs`（9 项）：非交易日、超出缓存、无正式报告均不写库；成功写入后正式库文件字节与 `report/watchlist/stock_score` 内容不变；相同输入重跑返回 `EXISTS` 且内容一致；`--revise` 保留原始行；未到期 `PENDING` 且补足未来 K 线后两版出现完成观察；V2 池从存储状态推进；`horizon < 2` 与非法日期在写入前报错。

真实缓存验证（`deploy/ashare/verify-research-snapshot.mjs`，证据 `docs/ashare-samples/phaseb-forward-snapshot-real-cache.json`，17/17 PASS）：源文件 sha256、大小、mtime 前后不变；20261016 快照引用正式报告 `ASR-20261016-20261016163620-ddd0d0`，V1 与正式 `stock_score` 的 1,756 只逐只一致；V2 评分变化 430 只、全部 −3.75、排名相关 0.990175，与历史实验一致；重复运行 `EXISTS` 且只有一行快照；`research-evaluate --as-of 20261016` 计划退出日 20261030、两版 `PENDING`；20261019 返回 `PENDING (date_after_data_cutoff)` 且快照/池状态行数不变。

本轮不新增 systemd timer；接入正式日频流程的步骤见 `docs/ashare-research-snapshot.md` §11，在 2026-10-19~21 验收完成前不应启用。

## 4. B3 评分版本

`score-2.0.0` 只把现金流满分阈值从百分数 `0.8` 修正为 `80`，其余公式、权重、准入、技术/流动性/估值/行业规则不变。反例：115.11% → 1/1，20% → 1/0.5，−10% → 0/0，缺失 → 0.5/0.5，负 ROE 两版均剔除，非正 EPS 标注但不改分。

2026-10-16 实测（`docs/ashare-samples/phaseb-research-summary.json`）：

| 指标 | V1 | V2 |
|---|---|---|
| 可评分股票 | 1756 | 1756 |
| 评分均值 / 中位数 | 52.979 / 52.865 | 52.061 / 51.490 |
| 评分变化的股票 | — | 430 |
| 变化幅度 | — | 全部 −3.75（未舍入现金贡献差 `30/4×0.5`） |
| 排名相关 | — | 0.990175 |
| 最大排名变化 | — | 002409.SZ 1123 → 1301（−178） |
| 前 40 名行业 HHI | 0.0575 | 0.05125 |
| 采样池成员 | 30 | 34（共同 22，V1 独有 8，V2 独有 12） |

逐股核对：除现金项外所有因子贡献两版完全相同，评分差与现金贡献差一致，不存在无法归因的变化。

## 5. B4/B5 历史评价与可复现研究

- 时序：信号在 t 收盘确定；t+1 交易所开盘买入，t+h 收盘退出，缺失不后移；`h ≥ 2`（A 股 T+1），默认 10。
- 成交：停牌/零成交量/开盘涨停拒绝买入；收盘跌停或停牌可在显式 `maxExitDelay` 内延后；价格、成交量或涨跌停未知立即记为未知，不假设后续成交；退市、无后续行情、缺复权因子、未到期事件保留在分母。
- 成本：默认买入 3 bps、卖出 8 bps、每边不利滑点 5 bps，显式参数。
- 基准：信号日全市场等权、沪深 300 价格指数、当前行业等权，均按相同实际区间计算，标明为无费用端点观察；完整/部分覆盖分开报告。
- 统计：事件数、入场数、完成数、未完成数、均值、中位数、胜率、分位、样本波动、按日期观察序列、不重叠敏感性；不给出独立样本 t 值或年化 Sharpe。不重叠敏感性使用全部已入场持仓区间，未知退出按 `asOf` 截断。
- 复现：111 个采样交易日（84 形成 / 27 模拟），同一冻结扫描、同一评价函数、V1/V2 独立池状态；`run_id` 绑定市场快照、基线构建、每个扫描输入、实现源码与运行时构建的 SHA256。相同输入重跑结果与 `run_id` 一致；修改扫描会产生新 `run_id`。

### 5.1 三个时间区间（互不替代）

| 区间 | 起止 | 性质 | 当前状态 |
|---|---|---|---|
| 历史形成区间 | 2024-07 ~ **2026-03-31** | 评分/股票池规则在此区间内形成并被反复查看 | 已完整计算，收益在切分点截断 |
| 回溯模拟验证区间 | **2026-04-01 ~ 2026-10-16** | 同一冻结数据快照上的历史模拟；数据已存在、结果已部分被观察过 | 已计算，**不是未接触的样本外**，不得称为 out-of-sample |
| 真正前瞻观察区间 | **2026-10-19 起**的实际交易日 | 冻结规则后逐日新增、不可回填的观察 | **PENDING**，尚无数据 |

`20260331` 只是历史回溯的切分点，不是“策略冻结后开始验证”的时点：V2 于 2026-10-17 才形成，2026-04-01 至 2026-10-16 的数据在规则形成前就已存在并被查看。任何把该区间表述为“样本外验证”的措辞都是错误的，本文档与本分支其他文档已统一改为“回溯模拟验证区间”。

### 5.2 统计口径（解释结果前必须读）

1. **已完成事件的收益是条件观察值**。均值/中位数/胜率只对已确认买入且已确认退出的 `completed` 事件计算；这些事件不等于全部信号事件，也不代表所有事件都能成交。
2. **未完成、未入场事件保留在完整分母中**。事件数 = 完成 + 未完成（已入场未退出）+ 未入场；任何收益指标旁边都必须同时给出完成率与无法退出比例，不能只报均值。
3. **V1/V2 的完成事件集合不完全相同**，因此两版均值之差不是严格配对的策略收益差。§5.5 给出了共同可比较事件的配对敏感性，用于说明差异来源。
4. **基准超额是条件于已定价子集的**。全市场与行业基准在事件层面均为部分覆盖：完整覆盖事件与部分覆盖事件分别统计（`excess_complete_coverage` / `excess_including_priced_subsets`），缺失成员数单列；不得把部分覆盖均值称为无偏全市场收益。
5. 持有期重叠、同一股票重复出现与跨股相关仍然存在；不给出独立样本 t 值、年化 Sharpe 或统计显著性结论。

### 5.3 结果（日期等权，已扣费，10 日持有，部分覆盖子集超额）

| 版本 | 区间 | 池日期 | 完成观察 | 净收益均值 | 净收益中位 | 胜率 | 全市场超额 | 沪深300 超额 | 行业超额 | 不重叠日期 | 不重叠全市场超额 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| V1 | 形成 | 84 | 2895 | +1.168% | −0.372% | 48.0% | −0.486% | +0.521% | −0.321% | 36 | −0.597% |
| V1 | 模拟 | 27 | 770 | −0.359% | −2.003% | 41.6% | −0.092% | +0.072% | +0.609% | 12 | +0.509% |
| V2 | 形成 | 84 | 2847 | +0.910% | −0.380% | 48.2% | −0.760% | +0.249% | −0.550% | 36 | −0.999% |
| V2 | 模拟 | 27 | 773 | −0.319% | −1.828% | 41.9% | −0.283% | −0.119% | +0.406% | 12 | +0.305% |

净收益均值/中位/胜率是**事件级**统计；超额列是**按日期等权**的观察序列均值（`by_date.excess`），两者口径不同，不可互相替代。逐日期序列见证据文件 `evaluation.<version>.<segment>.summary.by_date`。

### 5.4 分母与完成率（与上表配套，不可省略）

| 版本 | 区间 | 事件 | 入场 | 完成 | 已入场未完成 | 其中确认无法退出 | 未入场 | 完成率（/事件） | 完成率（/入场） | 未完成比例（/入场） | 无法退出比例（/入场） | 未入场比例（/事件） |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| V1 | 形成 | 3008 | 2965 | 2895 | 70 | 1 | 43 | 96.2% | 97.6% | 2.4% | 0.03% | 1.4% |
| V1 | 模拟 | 863 | 831 | 770 | 61 | 0 | 32 | 89.2% | 92.7% | 7.3% | 0.00% | 3.7% |
| V2 | 形成 | 2953 | 2914 | 2847 | 67 | 1 | 39 | 96.4% | 97.7% | 2.3% | 0.03% | 1.3% |
| V2 | 模拟 | 876 | 841 | 773 | 68 | 0 | 35 | 88.2% | 91.9% | 8.1% | 0.00% | 4.0% |

“已入场未完成”绝大多数是持有期尚未结束的 `pending`（`horizon_after_as_of`）事件，不是亏损未平仓：V1 形成 70 = 69 pending + 1 `unexited`（`exit_delay_exhausted`），V1 模拟 61 全部 pending，V2 形成 67 = 66 pending + 1 unexited，V2 模拟 68 全部 pending。“未入场”包含开盘涨停/停牌导致无法买入（`entry_blocked`：V1 5/2、V2 3/1）与数据截止日附近信号尚无 t+1 开盘（`entry_after_as_of`：V1 38/30、V2 36/34）。事件/入场/完成等计数与 `docs/ashare-samples/phaseb-research-audit.json` 的逐项校验一致。

### 5.5 共同可比较事件敏感性（描述性，不是策略收益差）

对同一日期、同一股票同时出现在 V1 与 V2 采样池的事件（同一评价函数、同一数据截止日）计算配对净收益差：

| 区间 | V1 池事件 | V2 池事件 | 共同事件 | 双方均完成 | 配对差均值/中位 | 非零配对差 | 仅 V1 完成均值 | 仅 V2 完成均值 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 形成 | 3008 | 2953 | 2302 | 2207 | 0 / 0 | 0 | +1.067%（688 个） | −0.092%（640 个） |
| 模拟 | 863 | 876 | 654 | 579 | 0 / 0 | 0 | +1.181%（191 个） | +1.316%（194 个） |

配对差在构造上恒为 0：同一事件在冻结价格下由同一 `evaluateEvents()` 计算，评分版本只影响股票池成员，不影响任何事件的买卖价。因此**两版历史均值之差完全来自池成员差异，而不是收益计算差异**；上表右两列显示差异主要来自各自独有的完成事件。该分析仅为描述性敏感性检查，不用于调参，也不能当作 V1/V2 的策略收益差。

### 5.6 参数未调整声明

本轮**没有因为 V2 在历史模拟中表现较差而修改任何参数**：评分权重、现金流阈值、V2 阈值、股票池准入/退出规则、信号定义、评价语义与数据截止规则均与 `fc24fef` 一致（`implementation_sha256` 见证据文件）。V2 的历史结果原样保留。

### 5.7 基准覆盖状态（未隐藏）

| 区间 | 基准 | 完整覆盖事件 | 部分覆盖事件 | 缺失（无法配对） | 成员数（可定价/全部） |
|---|---|---:|---:|---:|---|
| 形成 | 全市场等权 | 0 | 2895 | 0 | 15,603,783 / 15,670,122 |
| 形成 | 沪深300 | 2895 | 0 | 0 | 2,895 / 2,895 |
| 形成 | 行业等权 | 2087 | 808 | 0 | 346,692 / 347,885 |
| 模拟 | 全市场等权 | 0 | 770 | 0 | 4,241,028 / 4,258,118 |
| 模拟 | 沪深300 | 770 | 0 | 0 | 770 / 770 |
| 模拟 | 行业等权 | 560 | 210 | 0 | 100,149 / 100,448 |

全市场基准按定义永远包含无法定价成员（停牌、退市、无复权因子），因此完整覆盖事件恒为 0，只有“部分覆盖”均值可用；这不是数据缺陷，而是必须披露的覆盖状态。V2 的对应表见证据文件 `evaluation['score-2.0.0']`，口径相同。

结论（研究性，不是投资建议）：

1. V2 的单位修正在定义上正确，但两段历史中相对全市场的超额均未改善，V2 略差于 V1；结果如实保留，不据此后验调权重。
2. 两个版本相对全市场等权均无稳定正超额；相对沪深 300 在形成段为正、模拟段接近零，样本短且高度重叠，不构成显著结论。
3. 因子相关性与收益相关性均较弱（模拟段 `score` 与净收益相关约 0.04），说明评分是启发式排序，不是收益预测。
4. 采样池与正式每日股票池不是同一对象，不能直接外推正式池绩效。
5. 模拟区间完成率低于形成区间（V1 92.7% vs 97.6%），因为数据截止日附近的持有期尚未结束；这些事件留在分母中，不按零收益或假设收益处理。

### 5.8 统计核实记录

`deploy/ashare/verify-research-summary.mjs` 从冻结研究库（或完整 `summary.json`）重新推导上述每一个数字并逐项比对，输出 `docs/ashare-samples/phaseb-research-audit.json`（103 项检查，PASS）：

- 采样日期：形成 84 / 模拟 27 / 合计 111，stride 5，warmup 130，horizon 10，asOf `20261016`，split `20260331`，每个日期都有扫描输入 SHA256。
- 分母：V1 模拟 863/831/770/61/32；V2 模拟 876/841/773/68/35；V1 形成完成 2895，V2 形成完成 2847；状态计数之和等于事件数，完成数等于 `statuses.completed`。
- 重叠敏感性：不重叠形成 36 个日期、模拟 12 个日期，及文档中的不重叠全市场超额。
- 基准覆盖：完整/部分/缺失/成员数逐项可加。
- 共同事件配对差：从 `event` 表重新计算，确认恒为 0，并给出成员构成。

任何一项不符，脚本以非零状态退出；因此文档数字与代码输出不会静默漂移。

### 5.9 研究证据与复现

**仓库内保留**（`docs/ashare-samples/phaseb-research-summary.json`，约 158 KB，原 2.3 MB / 80,160 行）：

| 内容 | 字段 |
|---|---|
| 协议与版本 | `run_id`、`status`、`data_cutoff`、`split`、`split_interpretation`、`stride`、`warmup_trade_days`、`options`、`versions`、`score_policy`、`weights`、`pool_rules`、`units`、`limitations` |
| 数据身份 | `source_sha256`（冻结市场快照）、`baseline_build_sha256`、`runtime_build_sha256`、`implementation_sha256`、`input_scan_sha256`（111 个日期逐日扫描哈希） |
| 采样日期 | `selection_dates`（111 个） |
| 逐日比较指标 | `comparisons`（列式 111 行：扫描数、可评分数、两版评分均值/中位、评分差、排名相关、行业 HHI、池成员计数） |
| 评价汇总 | `evaluation.<version>.<segment>.summary`：分母与状态、收益分布、基准完整/部分覆盖、逐日观察序列（列式）、不重叠敏感性、相关性（每因子对收益/超额的 n 与 r） |
| 数据质量 | `quality_by_date`（列式 111 行：状态、四数据集计数、覆盖率、异常计数） |
| 敏感性 | `paired_sensitivity`（共同可比较事件配对差与成员构成，见 §5.5） |
| 必要样本 | `sample`（数据截止日的完整原始比较记录与质量记录，用于核对列式字段的原始格式） |
| 复现命令 | `reproducible_commands` |

**仓库外保留**（不可重新生成前的完整证据，位于研究输出目录，不进入 Git）：

| 文件 | 大小 | SHA256 |
|---|---|---|
| `/home/jcshi/ashare-research/phaseb/summary.json`（完整实验输出，80,160 行） | 2,344,579 B | `ef72c793447f7578316121c2f1937c5876b796651da22b5d5c733e8323be0bdc` |
| `/home/jcshi/ashare-research/phaseb/research.sqlite`（冻结研究库） | 10,191,745,024 B | `e680ba8a4af54c54aed22ee9e3ad1e1a7b9673ed9ca2daa4f8fed2d8d3475279` |
| `/home/jcshi/ashare-research/ashare-20261016.sqlite`（冻结市场快照） | 1,685,577,728 B | `ac31a9eb0b65c756758e2af6bb97ec718775ae030454fbcadfc5a8d19e234dd1` |
| `/home/jcshi/ashare-research/phaseb/scans/`（111 个输入扫描） | 约 612 MB | 逐日哈希见 `input_scan_sha256` |

完整结果可从研究库原样重发（只读校验已通过：`experiment.result` 与 `summary.json` 内容完全相等；研究库内该 JSON 的 SHA256 为 `7068f4f331c2661f7266daf061fba243e17e539ee8ebbb3bee58466ceb71206d`）。仓库文件是它的**无损投影**：只做列式重排、6 位小数舍入与重复限制列表去重，不重算任何评分、收益或统计；`verify-research-summary.mjs --summary <仓库文件> --full-summary <完整文件> --research-db <研究库>` 会逐字段确认投影一致（103 项检查）。

复现步骤：

```sh
npm ci && npm run build

# 1) 从研究库重发完整 summary（只读；不重算，不写库）
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/home/jcshi/ashare-research/phaseb/research.sqlite',{readOnly:true});process.stdout.write(db.prepare(\"SELECT result FROM experiment WHERE run_id='PHB-2853b1b630df4bcc98c4'\").get().result)" > /tmp/full-summary.json

# 2) 从零重跑实验（需要冻结快照 + e8cbe4a 编译的 baseline build + 已采集 scans）
node deploy/ashare/harvest-research.mjs --source <frozen-ashare.sqlite> --build <baseline-build> --output <research-dir> --workers 2
node deploy/ashare/run-research.mjs --source <frozen-ashare.sqlite> --inputs <research-dir> --output <research-dir>

# 3) 重发仓库精简证据并重新审计
node deploy/ashare/compact-research-summary.mjs /home/jcshi/ashare-research/phaseb/summary.json docs/ashare-samples/phaseb-research-summary.json --source-label /home/jcshi/ashare-research/phaseb/summary.json
node deploy/ashare/verify-research-summary.mjs --summary docs/ashare-samples/phaseb-research-summary.json --research-db /home/jcshi/ashare-research/phaseb/research.sqlite --run-id PHB-2853b1b630df4bcc98c4 --snapshot /home/jcshi/ashare-research/ashare-20261016.sqlite --output docs/ashare-samples/phaseb-research-audit.json
```

`test/ashare-research-evidence.test.mjs` 在每次测试中校验仓库文件的 `run_id`、源哈希、111 个日期、111 行比较/质量记录、形成/模拟切分与 300 KB 上限，因此精简文件无法在无人察觉时漂移。


## 6. 测试与一致性证据

| 证据 | 结果 |
|---|---|
| `npm test` | 174/174 通过，0 失败，0 跳过 |
| `node --test test/ashare-*.test.mjs` | 128/128 通过（基线 96 + P0 9 + 前瞻快照 9 + 研究接口 7 + 证据自洽 7） |
| P0 NULL OHLC 反例 | `test/ashare-ohlc-audit.test.mjs` 9/9 通过（见 §2.1） |
| P0 真实缓存一致性 | `docs/ashare-samples/phaseb-ohlc-audit-real-cache.json` PASS，3,513 个股票日 0 差异（见 §2.1） |
| 前瞻快照反例 | `test/ashare-snapshot.test.mjs` 9/9 通过（见 §3.3） |
| 前瞻快照真实缓存 | `docs/ashare-samples/phaseb-forward-snapshot-real-cache.json` 17/17 PASS（见 §3.3） |
| 独立复核三项审查问题 | PASS（NULL OHLC 掩码、未退出区间、`horizon<2`）及执行器整合 PASS（`/tmp/phaseb-fix-verification.txt`） |
| V1 一致性（`docs/ashare-samples/phaseb-v1-parity.json`） | PASS：9 个日期全部精确匹配，源快照与基线构建哈希不变 |
| V1 一致性（封版复测，`docs/ashare-samples/phaseb-v1-parity-freeze.json`） | PASS：基线 `fc24fef` 构建 vs 封版构建，9 个日期全市场逐字段精确匹配，0 差异；6 个连续股票池日期输出与持久化状态哈希相同 |
| 真实因子证据 | 11/11 通过（见 §3） |
| 研究接口契约 | `test/ashare-research-interface.test.mjs` 7/7 通过（见 §3.1） |
| 研究统计核实 | `docs/ashare-samples/phaseb-research-audit.json` 103 项检查 PASS（见 §5.8） |
| 证据文件自洽 | `test/ashare-research-evidence.test.mjs` 7/7 通过（见 §5.9） |
| 真实缓存性能 | `docs/ashare-samples/phaseb-factor-performance.json` 11 项检查 PASS（见 §3.2） |
| 真实缓存 B0 | 全部检查通过（见 §2） |
| 研究可复现 | 相同输入重跑 `run_id` 与结果一致；扫描内容变化生成新 `run_id` |

构建树 sha256：封版构建 `680448b9…6aac`（含 audit-1.2.0 与 snapshot.ts）；历史实验与因子证据所用 `77897886…32b0` 为 `fc24fef` 基线构建，二者评分模块源码相同，逐字段一致性见上表。

## 7. 后续生产切换前仍需完成

1. 2026-10-19 ~ 10-21 三个真实交易日的正式流水线验收（`docs/ashare-acceptance.md` §8，仍 PENDING）。
2. ChatGPT 账号侧工具调用与定时任务检查（同上 §8.3）。
3. 从 2026-10-19 起积累真正的未来观察样本，再评估 V2；当前结果仅为历史模拟。
4. 生产容器镜像升级到含 10 个工具的本分支前，需重新跑容器内迁移与公网 e2e。
5. 是否切换正式评分版本由后续验收决定；本轮不切换。
6. 若将 `ashare_factor_snapshot` 公网开放，容器内存需覆盖单次约 1.2 GB 峰值 RSS（§3.2）；未新增缓存层。
7. 前瞻快照命令已就绪，但尚未接入日频流程；接入前需完成 10-19~21 验收，并按 `docs/ashare-research-snapshot.md` §11 在 live 报告发布后追加执行。

## 8. 生产未改动证据

`deploy/ashare/verify-production-untouched.mjs` 只读记录正式环境，基线在改动前采集、结束前复查，结果 `docs/ashare-samples/phaseb-production-untouched.json`（`PASS`，8/8）：

| 检查 | 结果 |
|---|---|
| 正式 `ashare.sqlite` 文件 sha256 / 大小 | 未变（`0f071b4f…6d19`，1,685,577,728 B） |
| 容器 `finance-mcp-ashare` 身份 / 镜像 / 启动时间 / 重启次数 | 未变（镜像 `sha256:7c4b8d90…970e`，`Up`，重启 0） |
| 容器内 `/app/build/ashare` 文件清单 | 未变（无 `snapshot.js`，即未部署本轮代码） |
| `report` / `watchlist` / `watchlist_change` / `stock_score` / `quality_check` / `signal_evidence` / `data_audit` 行数 | 未变（75 / 2847 / 366 / 138195 / 673 / 108 / 3） |
| 本机 A 股 systemd unit / timer | 均为 0（不存在，本轮也未新增） |

本轮未修改生产容器、systemd timer、Caddy 或 ChatGPT 定时任务；研究计算全部在冻结快照副本或只读连接上完成。

## 9. 已知限制

- 行业、名称、ST 状态为当前 `stock_basic` 口径，非历史时点；代码变更未合并。
- 财务无完整修订历史，不是严格 Point-in-Time；北交所旧代码财务记录重复。
- 日线级涨跌停近似，无盘口排队与开板流动性模拟；停牌按整日无法成交处理。
- 费用与滑点为情景参数，不是逐日历史税费还原。
- 采样调仓情景不等于资金约束组合；合成观察回撤不是实盘回撤。
- 全市场/行业基准在事件层面均为部分覆盖，超额基于已定价子集，明确单列缺失数。
