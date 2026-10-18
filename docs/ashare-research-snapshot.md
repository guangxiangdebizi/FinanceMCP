# A 股前瞻研究快照（P1）

> 基线 `feat/ashare-analysis-v2`（`fc24fef`），分支 `fix/ashare-phaseb-freeze`，本轮 `agent/chain-provenance`
> （协议 `fwd-snapshot-1.1.0`）。本功能从真实交易日开始独立记录 V1/V2 的研究结果，不修改正式日报、评分、
> 股票池或任何评分规则，不新增 systemd timer，不做部署变更。
> 真实缓存证据见 [`ashare-samples/phaseb-forward-snapshot-real-cache.json`](ashare-samples/phaseb-forward-snapshot-real-cache.json)
> 与 [`ashare-samples/phaseb-common-start-real-cache.json`](ashare-samples/phaseb-common-start-real-cache.json)。

## 1. 命令

```sh
finance-ashare research-snapshot --date YYYYMMDD [--db PATH] [--revise] [--horizon 10]
finance-ashare research-evaluate --date YYYYMMDD [--db PATH] [--as-of YYYYMMDD] [--horizon 10]
finance-ashare research-seed --date YYYYMMDD [--db PATH]
```

结果 JSON 写 stdout，进度与错误写 stderr，与现有 CLI 一致。`--db` 默认
`<ASHARE_DATA_DIR>/research/forward-observations.sqlite`，与正式库、`research.sqlite` 分开。
测试可直接调用导出的 `runResearchSnapshot()` / `runResearchEvaluate()` / `runResearchSeed()`（`src/ashare/snapshot.ts`）。

正式库始终以 `new DatabaseSync(ashareDbPath(), { readOnly: true })` 打开；命令不打开可写连接，
也不会执行建表或迁移。`report`、`watchlist`、`stock_score`、`quality_check` 只被读取。

## 2. 执行条件（`research-snapshot`）

按顺序检查，任一不满足即返回并**不写入任何内容**：

| 条件 | 返回 | 写入 |
|---|---|---|
| `--date` 不是合法 `YYYYMMDD` | 抛错（退出码 1） | 无 |
| `trade_cal` 缺少该日期 | `{status:'NOT_TRADE_DAY', is_open:null}` | 无 |
| `trade_cal.is_open = 0` | `{status:'NOT_TRADE_DAY', is_open:false}` | 无 |
| 正式缓存无 `daily` | `{status:'PENDING', reason:'no_cached_daily_data'}` | 无 |
| 请求日期晚于 `MAX(daily.trade_date)`（`data_cutoff`） | `{status:'PENDING', reason:'date_after_data_cutoff', data_cutoff}` | 无 |
| 请求日期晚于上海今天 | `{status:'PENDING', reason:'date_in_future'}` | 无 |
| 当日 `daily` 行数为 0 | `{status:'PENDING', reason:'no_daily_rows'}` | 无 |
| `checkQuality` 为 `NOT_READY` | `{status:'NOT_READY', reasons, quality}` | 无 |
| 无 `report` 行且 `run_mode='live'` | `{status:'PENDING', reason:'no_live_report'}` | 无 |
| V1 与正式 `stock_score` 不一致 | 抛错（拒绝写入） | 无 |
| 前一交易日没有原始状态（缺快照/缺交易日） | `{status:'CHAIN_GAP', expected_previous_trade_date, found_state_date, missing, note}` | 无 |
| 该交易日已有快照且未加 `--revise` | `{status:'EXISTS', snapshot_id}`（退出码 0） | 无 |
| `DEGRADED` | 正常写入，`quality_status:'DEGRADED'`，完整质量报告入库 | 写入 |

`data_cutoff` 是正式 `daily` 的最新交易日。只有该日及之前的数据会被读取：`scanMarket()` 的
K 线窗口与财务 as-of 查询都以快照日为界，评价阶段的所有行情读取受 `asOf` 约束。

正式 `report_id` 与 `status` 一并保存，快照因此可追溯到当日发布的正式报告。

## 3. 计算

- **V1**：`scanMarket(db, date)`，即正式 `score-1.0.0` 的全市场扫描。
- **V2**：对 V1 扫描结果的 `structuredClone` 调用 `scoreRows(rows, sectors, 'score-2.0.0')`。
  两版使用完全相同的可评分集合、归一化分位数与行业强度；只有现金流项阈值不同。
- **一致性校验**：逐只可评分股票比较 V1 的 `score`/`rank` 与正式 `stock_score` 当日行，并核对
  `watchlist` 成员的分数与排名；任何不一致都会中止写入。结果记录为 `v1_parity`。
- 未改任何评分规则、权重、股票池规则或信号。逐股 `snapshot_factor` 复用 `rawFactors()` /
  `sourceQualityForDate()`：缺失观测保持 `null`，不转为 0。

## 4. 两个股票池

| 池 | 来源 | `pool_source` | 说明 |
|---|---|---|---|
| V1 | 当日正式 `watchlist`（只读） | `formal_live_watchlist` | 正式发布列表，成员、分数、排名、`entered_on`、状态与原因原样保存 |
| V2 | 独立的 V2 研究池状态 | `research_v2_sequential` | 按 `wl-1.0.0` 规则逐日推进，与正式池相互独立 |

V2 池的推进方式：快照库的 `pool_state` 保存每个交易日的 V2 池。新快照取**日期严格早于当前日期的最近一份**
V2 池作为上一状态，在内存库中建出同构 `watchlist` 表（外加从正式库复制的 `trade_cal`，`tradeDaysHeld` 需要），
调用未修改的 `updateWatchlist()`，再把结果写回 `pool_state`。首次运行没有上一状态，因此按初始建池规则生成。

V2 池是研究对象，不是正式建议；`v2_pool.note` 与 `v1_pool.source` / `v2_pool.source` 明确区分。
`pool_diff` 给出 `common` / `v1_only` / `v2_only`。

## 4.1 原始状态链（`fwd-snapshot-1.1.0`）

`pool_state` 只表示**原始快照的状态链**，加上一次性研究种子（§4.2）：

- **只有 `ORIGINAL` 快照写入 `pool_state`。** `--revise` 只追加 `snapshot` / `snapshot_member` /
  `snapshot_factor` 证据行，不再 `DELETE`/重写该交易日的 `pool_state`。修订前后该日与后续交易日的
  `pool_state` 行逐字节不变。
- 每份快照记录实际继承的来源：`v2_pool.previous_date`（上一交易日）、
  `v2_pool.previous_snapshot_id`（该日 **ORIGINAL** 快照 ID）、`v2_pool.previous_state_source`
  （`original_snapshot` / `seed` / `chain_start`）。`pool_state` 行同样带
  `previous_snapshot_id`、`state_source`、`source_id`、`seed_id`。
- **连续性**：上一状态必须是**紧邻前一交易日**的状态。取 `pool_state` 中日期早于当前日的最近一行后，
  断言其日期等于交易日历中的前一交易日、且该日存在 `ORIGINAL` 快照（或种子）；否则返回
  `{status:'CHAIN_GAP', date, expected_previous_trade_date, found_state_date, missing, note:'按顺序补齐缺失交易日后再继续'}`
  并**不写入任何内容**。没有 `--allow-gap` 之类的绕过开关，也不使用更早日期冒充逐日连续。
- **链首特例**：此前不存在任何更早的 `ORIGINAL` 快照、种子或池状态时，该日即链首
  （`previous_state_source:'chain_start'`、`previous_snapshot_id:null`、`v2_pool.seed.source:'chain_start'`），
  按 `wl-1.0.0` 初始建池规则初始化。为避免在已开始的链中间插入“链首”，若该日之后已有 `ORIGINAL` 快照，
  同样返回 `CHAIN_GAP`（`missing:'preceding_original_snapshot'`）。
- **修订不受后续日期阻塞**：`--revise` 与 `EXISTS` 的重算都使用原始行当时记录的上一状态
  （`recordedPredecessor()`），因此先修订 T 再计算 T+2 不会改变 T+2 的继承来源。
- **幂等**：同一交易日重复运行且未加 `--revise` 仍返回 `EXISTS`，不改变任何内容。

## 4.2 观察时间属性（前瞻 / 回补）

`status`（`ORIGINAL` / `REVISED`）只表示身份；**观察时间属性独立**，写入 `snapshot` 表的列并在
`research-snapshot` / `research-evaluate` 输出中返回：

| 列 | 含义 |
|---|---|
| `observation_type` | `PROSPECTIVE` 或 `BACKFILLED` |
| `observation_reason` | 回补原因：`before_prospective_start`、`created_after_window`、`data_cutoff_after_trade_date`、`report_time_unknown`、`snapshot_time_unknown`、`report_generated_after_snapshot` |
| `report_generated_at` | 正式 live 报告的 `generated_at` |
| `created_at` | 快照写入时间（`snapshot` 表原有列） |
| `prospective_start` | `20261019`（常量 `PROSPECTIVE_START`） |
| `window_hours` | `24`（常量 `PROSPECTIVE_WINDOW_HOURS`） |

判定只用已存储事实，不看文件名（`classifyObservation()`）：

1. `trade_date < 20261019` → `BACKFILLED / before_prospective_start`；
2. `created_at - report.generated_at` 必须 ≤ 24 小时（按 `+08:00` 偏移解析真实时刻），否则
   `created_after_window`；报告时间无法解析 → `report_time_unknown`；
3. `data_cutoff` 必须等于交易日，否则 `data_cutoff_after_trade_date`（使用了更晚的数据）；
4. 全部满足才是 `PROSPECTIVE`。

修订**继承**原始行的观察属性：`--revise` 生成的行原样复制 `observation_type` / `observation_reason` /
`report_generated_at`，状态为 `REVISED`。因此修订后的前瞻观察仍是 `PROSPECTIVE`，回补记录也永远不能
因为事后重跑而变成前瞻证据——没有任何命令可以修改已写入的观察属性。
2026-10-16 的功能验证快照早于前瞻起点，固定为 `BACKFILLED / before_prospective_start`，保留其历史研究价值。
`prospectiveSnapshots(dbPath)` 只列出 `PROSPECTIVE` 观察，供后续统计排除回补数据。

## 4.3 共同起点（`research-seed`）

V1 已积累正式历史状态，而 V2 首次快照若从空池初始化，两版成员差异就无法归因。`research-seed --date`
以该日**正式 live `watchlist`**（只读）写入一次性共同起点：

- 写入一行 `pool_seed`（`seed_id`、`version`、`trade_date`、`source_report_id`、
  `source_report_generated_at`、`members_digest`、`member_count`、`created_at`、完整成员 JSON）与
  对应 `pool_state` 行（`state_source='seed'`、`previous_snapshot_id=NULL`），保留每只成员的
  `entered_on`、分数、排名、行业、状态与原因。
- **只设置一次**：相同内容重跑返回 `EXISTS`；同日期但成员摘要不同则抛错（种子内容冲突）；已有其他日期种子
  返回 `REFUSED / seed_already_exists`。
- **拒绝改写已开始的链**：该日期之后存在 `ORIGINAL` 快照 → `REFUSED / later_original_snapshot_exists`；
  该日期已有 `ORIGINAL` 快照 → `REFUSED / original_snapshot_on_seed_date`。
- 种子日之后的**第一份快照** `previous_snapshot_id = null`、`previous_state_source = 'seed'`、
  `v2_pool.seed` 记录 `seed_id` / `seed_date` / 来源报告；之后每份快照都带
  `comparison_baseline:{seed_date, seed_report_id, seed_members_digest}`，两版差异可归因于评分与由评分
  驱动的状态演化。种子日与请求日之间缺少 `ORIGINAL` 快照时，§4.1 的 `CHAIN_GAP` 规则照常生效。
- V1 始终是正式 `watchlist`（`pool_source='formal_live_watchlist'`）；V2 在研究库中推进。

**确定性验证**（`deploy/ashare/verify-common-start.mjs`，证据
`docs/ashare-samples/phaseb-common-start-real-cache.json`）：在冻结缓存上，对每一对相邻且有正式股票池的
交易日 D → D+1，以正式 `watchlist(D)` 为初始状态、用 `score-1.0.0` 扫描 D+1 并调用未修改的
`updateWatchlist()`，与正式 `watchlist(D+1)` 逐成员比较（成员集合、`score`、`rank`、`entered_on`）。
结果 **71/71 对全部逐字节复现**（含 20261015 → 20261016），说明共同起点设计与既有正式状态兼容；
正式股票池未被修改，源文件 sha256 前后不变。

## 5. 存储结构

快照库 `forward-observations.sqlite`：

| 表 | 主键 | 内容 |
|---|---|---|
| `snapshot` | `snapshot_id` | 完整快照 JSON（`content`）、`trade_date`、`status`、`revises`、`created_at`、`content_digest`，以及观察属性列 `observation_type`、`observation_reason`、`report_generated_at`、`prospective_start`、`window_hours` |
| `snapshot_member` | `(snapshot_id, version, ts_code)` | 两版股票池成员：分数、排名、行业、状态、原因、`entered_on`、**快照时信号** |
| `snapshot_factor` | `(snapshot_id, ts_code)` | 每只可评分股票的原始因子、V1/V2 分数排名与组件、归一化因子、逐因子贡献、默认值说明 |
| `snapshot_evaluation` | `(snapshot_id, version, as_of, horizon)` | 评价结果（只追加）：`summarizeEvaluation()` 完整输出、分母、成熟状态 |
| `pool_state` | `(version, trade_date, ts_code)` | 每个交易日的 V2 研究池状态；附 `score`、`rank`、`industry`、`status`、`previous_snapshot_id`、`state_source`、`source_id`、`seed_id`。**只由 `ORIGINAL` 快照与种子写入** |
| `pool_seed` | `seed_id` | 一次性共同起点：来源报告、日期、成员摘要、成员数、创建时间与完整成员 |

旧构建创建的数据库在打开时自动补列（`ALTER TABLE ADD COLUMN`），并按已存事实为历史行补写观察属性
（`before_prospective_start` 等）与 `pool_state.state_source`；已有 `snapshot_id`、`content` 与
`content_digest` 均不改变。

`snapshot` 内容字段：

```
snapshot_id, schema, status(ORIGINAL|REVISED), revises, trade_date, data_cutoff,
report{report_id,status,generated_at,run_mode}, quality_status, quality（完整质量报告，去掉 checked_at）,
data_snapshot{written_at,spread_minutes,mixed,counts,latest_sync}, versions, build_sha256,
parameters{horizon,buy_fee_bps=3,sell_fee_bps=8,slippage_bps=5,max_exit_delay=5},
score_inputs{score_rules,watchlist_rules},
universe{scanned,eligible,ineligible,suspended_or_missing,signal_counts,factor_rows,members_digest,factors_digest},
v1_pool{source,count,members[]},
v2_pool{source,count,previous_date,previous_snapshot_id,previous_state_source,seed,members[],note},
comparison_baseline{seed_date,seed_report_id,seed_members_digest,note} | null,
pool_diff{common,v1_only,v2_only},
v1_v2{changed_scores,score_delta,rank_correlation,diffs[逐股两版差异]},
v1_parity{ok,stock_score_rows,eligible,score_mismatches,rank_mismatches,watchlist_mismatches,sample},
future_returns{status:'PENDING',horizon,planned_exit_date,as_of,note},
limitations[]
```

`content` 仍不含任何墙钟时间（观察属性单独存表），因此内容确定性不变：相同输入与相同构建 → 相同
`snapshot_id` 与相同 `content_digest`。`observation_type` 由存储事实（`created_at` 与报告时间）决定，
**不参与** `snapshot_id`；重跑不会因分类而改变快照身份。

信号在快照时保存（`snapshot_member.signals`），评价阶段只使用当时保存的值，不用后来的数据重算。

## 6. 确定性：`snapshot_id` 的定义

```
snapshot_id = FWD-<trade_date>-<sha256(identity)[:16]>
```

`identity` 只包含输入，不含墙钟时间：日期、`data_cutoff`、正式 `report_id`/`status`/`generated_at`、
质量状态与原因、`snapshotInfo()` 的逐数据集 `written_at`/`spread_minutes`/`mixed`、质量计数、
各数据集最近同步时间、全部版本号（engine/factor/indicator/signal/score v1+v2/watchlist/evaluation/
data/snapshot）、`build_sha256`（`build/ashare/*.js` 排序后逐文件 SHA256）、评分与股票池规则、
`horizon` 与费用参数、上一份 V2 池的 `(ts_code, entered_on)`。

因此：**相同输入与相同构建 → 相同 `snapshot_id` 与相同内容**；任一输入（数据、质量、报告、版本、
构建、上一 V2 池）变化 → 新 `snapshot_id`。`created_at` 是墙钟时间，不参与 `snapshot_id`，也不参与
`content_digest` 以外的比较（`content_digest` 同样不含 `created_at`）。观察属性（`observation_type` 等）
只存于表列，不参与 `snapshot_id`：同一输入不会因分类结果而改变身份。

重复运行相同日期：返回 `{status:'EXISTS', snapshot_id, recomputed_snapshot_id, content_matches_stored}`，
并报告重算内容是否与已存内容一致；不覆盖。

## 7. 不可变与 `REVISED`

- 一个交易日已有快照时，命令默认只返回 `EXISTS`，**绝不覆盖**。
- `--revise` 追加一行新快照：`status:'REVISED'`，`revises` 指向原始 `snapshot_id`，
  `snapshot_id` 追加 `-R<n>` 序号（内容身份仍由同一输入哈希决定，另记 `content_digest`）。
  原始行逐字节保持不变；成员与因子照常写入，供修订后重算审计。
  **修订不写 `pool_state`**：该日及后续交易日的状态链保持逐字节不变（§4.1）。
  观察属性从原始行复制，修订不能改变前瞻/回补归属（§4.2）。
- 后续数据源修订不会静默改写原始观察；只能通过 `REVISED` 另存。

## 8. 评价与未成熟收益（`research-evaluate`）

- 读取该日期已保存的全部快照（原始与各次修订，分别评价），用 `snapshot_member` 中保存的
  分数、行业与信号构造 `EvaluationEvent[]`，调用现有 `evaluateEvents()`；
  参数固定 `{buyFeeBps:3, sellFeeBps:8, slippageBps:5, maxExitDelay:5}` 与 `--horizon`（默认 10）。
- 每份快照的输出都带 `observation:{type, reason, report_generated_at, prospective_start, window_hours}`，
  后续统计可据此只采用 `PROSPECTIVE` 观察（`prospectiveSnapshots()`）。
- `as_of = min(--as-of 或上海今天, data_cutoff)`；`--as-of` 早于快照日期时报错。
- 计划退出日 = 快照日之后第 `horizon` 个交易日（完整交易日历）；`matured = 计划退出日 ≤ as_of`。
- **未成熟时**：快照评价状态为 `PENDING`，`completed = 0`，`net_return.mean = null`；
  所有事件保持 `pending`/`unpriced` 等既有状态，不伪造任何未来收益，也不使用之后的行情提前完成。
- 成熟后按同一方法、同一 `as_of` 分别评价 V1 与 V2，完整输出 `summarizeEvaluation()`（分母、
  状态、均值/中位/胜率/分位、基准覆盖、不重叠敏感性、相关性）。
- 结果写入 `snapshot_evaluation`（`snapshot_id + version + as_of + horizon` 唯一，只追加）；
  原始 `snapshot` 行不被修改。

## 9. 真实缓存证据

`deploy/ashare/verify-research-snapshot.mjs` 在冻结快照
`~/ashare-research/ashare-20261016.sqlite`（sha256 `ac31a9eb…4dd1`）上运行，输出
`docs/ashare-samples/phaseb-forward-snapshot-real-cache.json`（`ok=true`，17/17 通过；`snapshot_id` 含 `build_sha256`，合并本轮修复后的 `fwd-snapshot-1.1.0` 构建 `52a8e472…3b71` 下重新采集）：

- 源文件 sha256、大小与 mtime 前后不变；只读连接上的写操作被拒绝。
- 20261016 快照：`FWD-20261016-ca27b46ca33faac1`，引用正式报告 `ASR-20261016-20261016163620-ddd0d0`，
  质量 `READY`，扫描 5567 只、可评分 1756 只、因子行 1756。
- 观察属性：`BACKFILLED / before_prospective_start`（交易日早于 `20261019`），报告生成时间
  `2026-10-17T00:36:20.909+08:00` 已记录；该快照保留为历史研究，不计入前瞻统计。
- 链首：`previous_snapshot_id=null`、`previous_state_source='chain_start'`（研究库中此前没有状态）。
- V1 一致性：1756 只全部与正式 `stock_score` 的分数和排名一致（0 差异）。
- V1 池 40 只（`formal_live_watchlist`），V2 池 40 只（`research_v2_sequential`，首次运行无上一状态）；
  共同 29、V1 独有 11、V2 独有 11。
- V2 评分变化 430 只，全部为 −3.75（`30/4×0.5` 现金流贡献差），排名相关 0.990175，与 Phase B 记录一致。
- 重复运行返回 `EXISTS`，`snapshot_id` 与存储内容完全一致，库中仍只有 1 行快照。
- `research-evaluate --as-of 20261016`：计划退出日 20261030，`matured=false`，V1/V2 均 `PENDING`，
  完成数 0、净收益均值 `null`。
- 20261019：`{status:'PENDING', reason:'date_after_data_cutoff', data_cutoff:'20261016'}`，快照与池状态行数不变。

共同起点验证 `deploy/ashare/verify-common-start.mjs` 输出
`docs/ashare-samples/phaseb-common-start-real-cache.json`：源文件只读且 sha256/大小/mtime 不变；
20261016 是缓存中最后一个正式股票池（40 只，摘要 `e7eb0999…cb7a`，来源报告
`ASR-20261016-20261016163620-ddd0d0`），下一交易日 20261019；71 对相邻交易日的正式股票池全部可由
上一日正式股票池 + `score-1.0.0` 逐字节复现，`compatible=true`。

`research-seed --date 20261016` 在真实缓存上执行结果：`SEEDED`，40 只成员，摘要
`1611905f…9891`，来源报告同上；重复执行返回 `EXISTS`，正式库 sha256 仍为 `ac31a9eb…4dd1`。

## 10. 测试

`test/ashare-snapshot.test.mjs`（9 项，合成市场 fixture + 临时 `ASHARE_DATA_DIR`）：

| 用例 | 内容 |
|---|---|
| a | 非交易日 → `NOT_TRADE_DAY`，无写入 |
| b | 日期超出缓存 → `PENDING`，无写入 |
| c | 无正式 live 报告 → `PENDING`，无写入 |
| d | 成功写入；V1 一致性通过；正式库文件字节与 `report/watchlist/stock_score` 行内容前后不变 |
| e | 相同输入重跑 → `EXISTS`，`snapshot_id` 与存储内容一致 |
| f | `--revise` 保留原始行，新增 `REVISED` 行并引用原 `snapshot_id` |
| g | 未到期 → `PENDING`、完成数 0、收益 `null`；补足未来 K 线后两版均出现完成观察，原始快照不变 |
| h | V2 池从存储状态推进到下一交易日，保留 `entered_on`，与正式池来源不同 |
| i | `horizon < 2`、非法日期在写入前报错 |

`test/ashare-snapshot-chain.test.mjs`（9 项，原始状态链与观察属性）：

| 用例 | 内容 |
|---|---|
| 链记录 | 链首 `chain_start`；T+1 的 `previous_snapshot_id` 指向 T 的 `ORIGINAL`，`pool_state` 行带 `state_source`/`source_id` |
| 修订隔离 | 先保存 T、T+1，再 `--revise T`：T 与 T+1 的 `pool_state` 行逐字节不变，T+1 成员与 `previous_snapshot_id` 不变，只多一行修订 |
| 后续继承 | 修订后计算 T+2，仍继承 T+1 的原始状态；任何 `pool_state` 都不引用 `-R1` 修订 ID；重跑 T 返回 `EXISTS` |
| 缺口 | T 与 T+2、缺 T+1 → `CHAIN_GAP`（`expected_previous_trade_date=T+1`、`found_state_date=T`、`missing=original_snapshot`），快照与池状态均无写入；按顺序补齐后可继续 |
| 乱序链首 | 已有 T+1 的 `ORIGINAL` 时再请求 T → `CHAIN_GAP / preceding_original_snapshot` |
| 分类规则 | 起点前 → `before_prospective_start`；窗口内且截止日相等 → `PROSPECTIVE`；超 24h → `created_after_window`；用了更晚数据 → `data_cutoff_after_trade_date`；报告时间不可解析 → `report_time_unknown` |
| 存储与修订 | 20261016 类历史快照为 `BACKFILLED/before_prospective_start`；重复 `--revise` 仍为 `BACKFILLED`；`research-evaluate` 输出 `observation`；`prospectiveSnapshots()` 为空 |
| 真前瞻 | 用受控时钟：当日及时创建 → `PROSPECTIVE`；修订后仍 `PROSPECTIVE` + `REVISED`；次日及时创建 → `PROSPECTIVE`；三天后回补 → `BACKFILLED/created_after_window`；`prospectiveSnapshots()` 只列出前两者 |
| 迁移 | 旧构建数据库自动补列，历史行按已存事实分类，`content` 与 `snapshot_id` 不变 |

`test/ashare-research-seed.test.mjs`（8 项，共同起点）：

| 用例 | 内容 |
|---|---|
| 写入种子 | 从正式 V1 股票池写入 `pool_seed` 与 `pool_state(state_source='seed')`，保留 `entered_on`/分数/排名/行业 |
| 幂等 | 相同内容重跑 → `EXISTS`，只有一行种子 |
| 首个快照 | `previous_snapshot_id=null`、`previous_state_source='seed'`、`v2_pool.seed` 记录来源；`comparison_baseline` 写入；V1 仍是正式池 |
| 后续快照 | 继承上一 `ORIGINAL`，`comparison_baseline` 保持；`pool_diff` 与两池计数自洽 |
| 链已开始 | 已有更晚 `ORIGINAL` → `REFUSED / later_original_snapshot_exists`，无种子写入 |
| 同日已有快照 | → `REFUSED / original_snapshot_on_seed_date` |
| 非交易日/无股票池 | → `REFUSED` |
| 内容冲突 | 同日正式股票池变化 → 抛错，原种子不变 |

`node --test test/ashare-*.test.mjs`：146/146 通过（基线 129 + 链/观察 9 + 种子 8；其中基线内
`test/ashare-snapshot.test.mjs` 仍为 9 项）。

## 11. 后续接入日频流程（本轮不做）

本轮只提供命令与验证脚本，不新增 timer、不改容器、不改 ChatGPT 定时任务。接入时建议在正式
`daily` 完成并发布 live 报告之后追加一步：

```sh
finance-ashare research-snapshot --date "$TRADE_DATE"
```

即可在真实交易日保存首份前瞻观察；持有期结束后用 `research-evaluate --date "$TRADE_DATE"` 评价。
由于命令本身幂等（已存在即返回 `EXISTS`），重复执行不会产生重复快照；需要重算时显式使用
`--revise`。链不连续时命令返回 `CHAIN_GAP` 而不是悄悄跳日，需按交易日顺序补齐后再继续。

在 2026-10-19 正式前瞻窗口开始前，建议先执行一次共同起点（只读正式库，幂等）：

```sh
finance-ashare research-seed --date 20261016
```

在 2026-10-19 ~ 10-21 正式流水线验收完成前，不应启用定时步骤。

## 12. 限制

- 行业、名称与 ST 标记为当前 `stock_basic` 口径，不是快照日的时点历史。
- V2 池是研究池，成员与正式池不同不构成正式建议。
- 快照只记录当时缓存可见的数据；`data_snapshot` 与 `build_sha256` 用于追溯，但无法还原上游此后修订前的原始响应。
- `observation_type` 依据本地记录的 `created_at` 与报告 `generated_at` 判定；若主机时钟或缓存中的报告时间
  不可信，分类也随之不可信。窗口内补录仍算前瞻，这是设计上的取舍，已用 24 小时常量显式限定。
- `research-evaluate` 不重叠敏感性、相关性等统计的局限与 `evaluation.ts` 相同：事件级观察，不是资金组合回测。
- 共同起点只保证 V2 研究池与正式 V1 池从同一成员集合与入池日期出发；正式 V1 池此后仍以真实发布为准，
  两版差异因此可归因于评分规则与状态演化，但不构成对评分有效性的证明。
