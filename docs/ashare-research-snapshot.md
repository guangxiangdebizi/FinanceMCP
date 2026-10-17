# A 股前瞻研究快照（P1）

> 基线 `feat/ashare-analysis-v2`（`fc24fef`），分支 `fix/ashare-phaseb-freeze`。本功能从真实交易日开始独立记录
> V1/V2 的研究结果，不修改正式日报、评分、股票池或任何评分规则，不新增 systemd timer，不做部署变更。
> 真实缓存证据见 [`ashare-samples/phaseb-forward-snapshot-real-cache.json`](ashare-samples/phaseb-forward-snapshot-real-cache.json)。

## 1. 命令

```sh
finance-ashare research-snapshot --date YYYYMMDD [--db PATH] [--revise] [--horizon 10]
finance-ashare research-evaluate --date YYYYMMDD [--db PATH] [--as-of YYYYMMDD] [--horizon 10]
```

结果 JSON 写 stdout，进度与错误写 stderr，与现有 CLI 一致。`--db` 默认
`<ASHARE_DATA_DIR>/research/forward-observations.sqlite`，与正式库、`research.sqlite` 分开。
测试可直接调用导出的 `runResearchSnapshot()` / `runResearchEvaluate()`（`src/ashare/snapshot.ts`）。

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

V2 池的推进方式：快照库的 `pool_state(version, ts_code, trade_date, entered_on)` 保存每个交易日
的 V2 池。新快照取**日期严格早于当前日期的最近一份** V2 池作为上一状态，在内存库中建出同构
`watchlist` 表（外加从正式库复制的 `trade_cal`，`tradeDaysHeld` 需要），调用未修改的
`updateWatchlist()`，再把结果写回 `pool_state`。首次运行没有上一状态，因此按初始建池规则生成。

V2 池是研究对象，不是正式建议；`v2_pool.note` 与 `v1_pool.source` / `v2_pool.source` 明确区分。
`pool_diff` 给出 `common` / `v1_only` / `v2_only`。

## 5. 存储结构

快照库 `forward-observations.sqlite`：

| 表 | 主键 | 内容 |
|---|---|---|
| `snapshot` | `snapshot_id` | 完整快照 JSON（`content`）、`trade_date`、`status`、`revises`、`created_at`、`content_digest` |
| `snapshot_member` | `(snapshot_id, version, ts_code)` | 两版股票池成员：分数、排名、行业、状态、原因、`entered_on`、**快照时信号** |
| `snapshot_factor` | `(snapshot_id, ts_code)` | 每只可评分股票的原始因子、V1/V2 分数排名与组件、归一化因子、逐因子贡献、默认值说明 |
| `snapshot_evaluation` | `(snapshot_id, version, as_of, horizon)` | 评价结果（只追加）：`summarizeEvaluation()` 完整输出、分母、成熟状态 |
| `pool_state` | `(version, trade_date, ts_code)` | 每个交易日的 V2 研究池状态 |

`snapshot` 内容字段：

```
snapshot_id, schema, status(ORIGINAL|REVISED), revises, trade_date, data_cutoff,
report{report_id,status,generated_at,run_mode}, quality_status, quality（完整质量报告，去掉 checked_at）,
data_snapshot{written_at,spread_minutes,mixed,counts,latest_sync}, versions, build_sha256,
parameters{horizon,buy_fee_bps=3,sell_fee_bps=8,slippage_bps=5,max_exit_delay=5},
score_inputs{score_rules,watchlist_rules},
universe{scanned,eligible,ineligible,suspended_or_missing,signal_counts,factor_rows,members_digest,factors_digest},
v1_pool{source,count,members[]}, v2_pool{source,count,previous_date,members[],note},
pool_diff{common,v1_only,v2_only},
v1_v2{changed_scores,score_delta,rank_correlation,diffs[逐股两版差异]},
v1_parity{ok,stock_score_rows,eligible,score_mismatches,rank_mismatches,watchlist_mismatches,sample},
future_returns{status:'PENDING',horizon,planned_exit_date,as_of,note},
limitations[]
```

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
`content_digest` 以外的比较（`content_digest` 同样不含 `created_at`）。

重复运行相同日期：返回 `{status:'EXISTS', snapshot_id, recomputed_snapshot_id, content_matches_stored}`，
并报告重算内容是否与已存内容一致；不覆盖。

## 7. 不可变与 `REVISED`

- 一个交易日已有快照时，命令默认只返回 `EXISTS`，**绝不覆盖**。
- `--revise` 追加一行新快照：`status:'REVISED'`，`revises` 指向原始 `snapshot_id`，
  `snapshot_id` 追加 `-R<n>` 序号（内容身份仍由同一输入哈希决定，另记 `content_digest`）。
  原始行逐字节保持不变；成员、因子与 V2 池状态照常写入，供修订后重算审计。
- 后续数据源修订不会静默改写原始观察；只能通过 `REVISED` 另存。

## 8. 评价与未成熟收益（`research-evaluate`）

- 读取该日期已保存的全部快照（原始与各次修订，分别评价），用 `snapshot_member` 中保存的
  分数、行业与信号构造 `EvaluationEvent[]`，调用现有 `evaluateEvents()`；
  参数固定 `{buyFeeBps:3, sellFeeBps:8, slippageBps:5, maxExitDelay:5}` 与 `--horizon`（默认 10）。
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
`docs/ashare-samples/phaseb-forward-snapshot-real-cache.json`（`ok=true`，17/17 通过）：

- 源文件 sha256、大小与 mtime 前后不变；只读连接上的写操作被拒绝。
- 20261016 快照：`FWD-20261016-01b5d0a42f65e11b`，引用正式报告 `ASR-20261016-20261016163620-ddd0d0`，
  质量 `READY`，扫描 5567 只、可评分 1756 只、因子行 1756。
- V1 一致性：1756 只全部与正式 `stock_score` 的分数和排名一致（0 差异）。
- V1 池 40 只（`formal_live_watchlist`），V2 池 40 只（`research_v2_sequential`，首次运行无上一状态）；
  共同 29、V1 独有 11、V2 独有 11。
- V2 评分变化 430 只，全部为 −3.75（`30/4×0.5` 现金流贡献差），排名相关 0.990175，与 Phase B 记录一致。
- 重复运行返回 `EXISTS`，`snapshot_id` 与存储内容完全一致，库中仍只有 1 行快照。
- `research-evaluate --as-of 20261016`：计划退出日 20261030，`matured=false`，V1/V2 均 `PENDING`，
  完成数 0、净收益均值 `null`。
- 20261019：`{status:'PENDING', reason:'date_after_data_cutoff', data_cutoff:'20261016'}`，快照与池状态行数不变。

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

`node --test test/ashare-*.test.mjs`：105/105 通过（原 96 项 + 新增 9 项）。

## 11. 后续接入日频流程（本轮不做）

本轮只提供命令与验证脚本，不新增 timer、不改容器、不改 ChatGPT 定时任务。接入时建议在正式
`daily` 完成并发布 live 报告之后追加一步：

```sh
finance-ashare research-snapshot --date "$TRADE_DATE"
```

即可在真实交易日保存首份前瞻观察；持有期结束后用 `research-evaluate --date "$TRADE_DATE"` 评价。
由于命令本身幂等（已存在即返回 `EXISTS`），重复执行不会产生重复快照；需要重算时显式使用
`--revise`。在 2026-10-19 ~ 10-21 正式流水线验收完成前，不应启用该步骤。

## 12. 限制

- 行业、名称与 ST 标记为当前 `stock_basic` 口径，不是快照日的时点历史。
- V2 池是研究池，成员与正式池不同不构成正式建议；首次快照的 V2 池没有历史连续性，只能从该日起积累。
- 快照只记录当时缓存可见的数据；`data_snapshot` 与 `build_sha256` 用于追溯，但无法还原上游此后修订前的原始响应。
- `research-evaluate` 不重叠敏感性、相关性等统计的局限与 `evaluation.ts` 相同：事件级观察，不是资金组合回测。
