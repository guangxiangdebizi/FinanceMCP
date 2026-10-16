# A 股日频模块验收记录

记录时间：2026-10-16（UTC）/ 2026-10-17 凌晨（北京时间）。全部使用 Tushare Pro 真实数据（8000 积分，`TUSHARE_TOKEN` 来自 VPS 环境变量），未使用 mock 宣称生产可用。
样例与原始输出见 `docs/ashare-samples/`。

## 状态总览

| 项目 | 状态 |
|---|---|
| 上游源码锁定、现有构建与测试 | ✅ `486494a`，`npm test` 46/46 |
| ARM64 / Node / SQLite / Tushare / 现有 HTTPS 入口验证 | ✅ |
| M1 数据闭环（日历、批量日线、daily_basic、adj_factor、index_daily、质量检查、市场分析、JSON 快照、2 个工具） | ✅ |
| M2 指标/信号/行业/股票池 + 3 个工具 | ✅ |
| M3 公告日约束财务数据 + 历史信号检验 | ✅ |
| M4 CLI + systemd timer + 报告字段 + NOT_READY | ✅ |
| 历史日期重放（71 个交易日） | ✅ |
| 一次真实数据 E2E（同步→分析→报告→公网 MCP） | ✅ 交易日 20261016 |
| 自动调度配置 | ✅ 已启用，首次计划运行 2026-10-19 18:40 CST |
| 第二轮正确性修复（1017：P0-1~3、P1-1~6，见 §9） | ✅ 提交 `55b2b09`（分支 `ashare-v1-fix`），`npm test` 76/76，真实缓存副本 5/5，已部署 |
| **连续 3 个真实交易日增量更新与报告验收** | ⏳ **PENDING**（2026-10-19/20/21 尚未发生；判定规则见 §8） |
| **ChatGPT 网页版手动调用 / 已有定时任务验证** | ⏳ **PENDING，待账号侧操作**（本机无法登录 ChatGPT；步骤见 §8.3） |

## 1. 基线与环境

```
git rev-parse HEAD            → 486494a（origin/main，fetch 后无更新）
npm ci && npm test            → tests 46, pass 46, fail 0
uname -m                      → aarch64（Ubuntu 22.04.5）
node -v                       → v24.16.0；容器 node:lts-alpine → v24.22.0 arm64
node:sqlite                   → 宿主 SQLite 3.53.0；容器 3.53.4（无新增 npm 运行时依赖）
```

Tushare 接口实测（2026-10-16）：`trade_cal`、`stock_basic`（L 5577 / D 339 / P 0）、`daily`（20261016：5567 行）、
`daily_basic`（5567）、`adj_factor`（5577）、`stk_limit`（5655）、`index_daily`、`fina_indicator_vip`（20260630：10758 行，
`limit/offset` 分页 + `has_more` 生效）、`suspend_d`、`index_classify` 均可用。

现有入口：Caddy `share.shijingchang.cn` 已以路径方式将 `/mcp*` 反代到 XFullReader（`127.0.0.1:8125`），ChatGPT 使用
“No authentication” 的 `/mcp-public`。本模块复用同一 HTTPS 站点，新增 `/ashare/mcp*` → `127.0.0.1:8130`。
变更后核验：`GET /` 200（27533 B，与变更前一致）、`files.shijingchang.cn` 200、XFullReader `/mcp-public` initialize 200。

## 2. 测试

```
npm test   → tests 66, pass 66, fail 0（上游 46 + 新增 20）
```

| 文件 | 覆盖 |
|---|---|
| `test/ashare-indicators.test.mjs` | Wilder RSI（手算 + 公开参考值 ±0.1）、MACD DEA 对齐回归、SMA/BOLL/CCI/ATR 公式、`stock_data` 区间过滤后指标对齐、突破信号规则、信号无未来数据 |
| `test/ashare-pipeline.test.mjs` | 财务数据公告日约束（含更正记录）、股票池规模/行业上限/滞后/最短持有/每日新增上限、NOT_READY 报告不含股票池与信号、按交易日批量分页与重试 |
| `test/ashare-tools.test.mjs` | 默认 19 工具不变、`ashare_daily` profile 仅 5 工具、配置文件白名单、`MCP_AUTH_TOKEN` 认证且 Bearer 不作为 Tushare Token、忽略请求凭证、上游 Bearer 行为保持、A 股工具不进入 fallback 路由、限流、ping |

## 3. 历史回填（真实数据）

```
node build/ashare/cli.js sync --start 20240102 --end 20261016
```

- 673 个交易日（20240102~20261016），每日 4 个全市场批量请求；共 2709 次 Tushare 调用，0 次重试，14,676,800 行，1907 秒
- 数据质量：673 天全部 `READY`
- `daily` 3,642,948 行；`adj_factor` 3,663,225 行；`fina_indicator` 69,187 行（20231231~20260930，12 个报告期）
- 8 个核心指数 20221201~20261016 各 937 根
- 发现并修复：指数增量只向后追加导致早期历史缺口（现向前补齐）；全量扫描临时排序写满容器 `/tmp`；按日期主键导致个股扫描慢（改为 `(ts_code, trade_date)` 主键 + `migrate` 命令，260 日全市场扫描 19s → 6.6s）

## 4. 信号历史检验（evi-1.0.0）

```
docker exec finance-mcp-ashare node build/ashare/cli.js evidence    → 136 s，1,473,812 个事件，533 个信号日
```

10 日超额收益（次日开盘进场，相对等权市场，按日期聚类 t 值）：

| 信号 | 方向 | 超额 | t | 分类 |
|---|---|---|---|---|
| 多头趋势 trend_up | 看多 | -0.47% | -3.87 | contradicted |
| 20日放量突破 breakout_20d | 看多 | -1.32% | -9.27 | contradicted |
| MACD金叉 | 看多 | -0.41% | -4.12 | contradicted |
| MACD底背离 | 看多 | -0.37% | -2.77 | contradicted |
| RSI超卖反弹 | 看多 | -0.09% | -0.45 | research_only |
| 布林收口突破 | 看多 | -1.00% | -5.50 | contradicted |
| 跌破中期均线 trend_breakdown | 风险 | -0.59% | -4.90 | evidence_supported |
| MACD顶背离 | 风险 | -0.29% | -2.04 | evidence_supported |
| 短期过热 overheated | 风险 | -1.73% | -6.48 | evidence_supported |

结论：在 2024-01~2026-10 样本内，看多类技术信号短期跑输等权市场（A 股短期反转特征），只能作为研究指标，
不能作为交易规则；风险类信号具备统计证据。分市场状态结果见 `docs/ashare-samples/evidence-20240102-20261016.json`。

## 5. 历史日期重放

```
docker exec finance-mcp-ashare node build/ashare/cli.js replay --start 20260701 --end 20261015   → 606 s
docker exec finance-mcp-ashare node build/ashare/cli.js pool-eval --start 20260701 --end 20261015
```

- 71 个交易日全部 `READY`，股票池规模 33~40，单行业最多 4 只
- 建池后日均新增 2.33 只（最大 6），9 天无变动；被移出成员平均持有约 20 个自然日；移出原因：排名跌出 150（150 次）、流通市值不达标（6）、替换（6）、停牌（1）
- **股票池实际表现（研究记录）**：67 个池日期，成员“次日开盘→第 5 日收盘”相对全市场等权平均 **-2.11%**，跑赢比例 16%。
  score-1.0.0 的动量/趋势偏好在该区间显著跑输，与第 4 节信号证据一致。报告与 `ashare_watchlist` 中均展示该滚动记录。
  评分未据此调参（避免在 3 个月样本上过拟合），修订评分需要更长样本外检验。
  - **1017 更正（as-of）**：上述数字由旧版 `evaluateWatchlist` 计算，持有窗口可越过 `--end`（20261015）读取 20261016 行情。
    修复后严格截至 end：`pool-eval --start 20260701 --end 20261015` → **66 个池日期，-2.12%，跑赢比例 16.7%**，5 个窗口未完成不计入。
    负面结论不变；原数字保留于此以便对照。
  - 上述 71 个重放报告与其股票池写在正式库中（修复前的做法）。它们保留不删，`run_mode=replay` 已回填到 `report` 表，
    排序时次于正式/手动报告；此后的重放只写研究库（§9.2）。

## 6. 真实数据 E2E（交易日 20261016）

先删除 20261016 的 daily/daily_basic/adj_factor/stk_limit/index_daily 行与同步记录，确保流水线重新下载：

```
deploy/ashare/run-daily.sh --date 20261016   （= docker exec finance-mcp-ashare node build/ashare/cli.js daily --date 20261016）
```

- 同步最近 5 个交易日（20261012~20261016）：24 次调用，46,500 行，13 秒；20261014/15/16 质量 `READY`
- 报告 `ASR-20261016-20261016163620-ddd0d0`，生成于 2026-10-17T00:36:20+08:00（**收盘后补发，非当日定时发布**），总耗时 27.9 秒
- 市场：沪深300 下降趋势；上涨 3301 / 下跌 2128，涨停 63 / 跌停 12；成交额 15691 亿（20 日均值 90%）；站上 MA20 16.9%
- 股票池 40 只（相对 20261015 无增减），行业分布 24 个行业

公网 MCP（`deploy/ashare/mcp-e2e.mjs`，经 Caddy HTTPS）：initialize、tools/list（5 个工具）、6 次 tools/call 及报告字段检查共 9 项全部通过，
单次调用 9~123 ms。结果：`docs/ashare-samples/mcp-e2e-public-20261016.json`。

NOT_READY 实测：`ashare_daily_report {date: 20261019}` → “当日日线缺失、核心指数缺失”；`{date: 20261017}` → “不是交易日”；
无参数调用（周六）→ 明示“今天 20261017 非交易日，使用最近交易日 20261016”。

## 7. 自动调度

```
systemctl --user list-timers  → finance-ashare-daily.timer，下次 Mon 2026-10-19 10:40 UTC（18:40 CST），另有 21:10 CST
systemctl --user start finance-ashare-daily.service（20261017 周六）→ {"trade_date":"20261017","skipped":true,"reason":"非交易日"}
```

修复：systemd user manager 早于 docker 组授权启动、缺少 docker 组 → `run-daily.sh` 检测后经 `sg docker` 重新执行。
运行日志：`~/.local/share/finance-mcp-ashare/logs/daily-<时间戳>.{json,log}` 与 journald。

## 8. 连续真实交易日验收（PENDING）

### 8.1 判定规则（`acceptance`，`src/ashare/acceptance.ts`）

每个交易日五项全部满足才为 `PASS`：

| 条件 | 含义 |
|---|---|
| `scheduled_runs` | 当日（北京时间）至少 2 份 `run_mode=live` 报告，即 18:40 与 21:10 两次定时运行都触发并完成 |
| `data_rechecked` | `sync_history` 中当日 `daily` 至少被请求 2 次（第二次运行确实复查当日行情，而不是沿用第一次结果） |
| `final_status` | 最后一份 live 报告为 **READY**。DEGRADED（非核心缺口：涨跌停价覆盖率或非核心指数缺失）默认**不通过**；仅在 `--allow-degraded` 时记为 `PASS_DEGRADED`，不会显示为 PASS。NOT_READY 一律不通过 |
| `mcp_consistent` | MCP 工具对该日返回的报告 ID 等于最后一份 live 报告 |
| `watchlist_continuous` | 股票池 `previous_date` 为前一交易日，且数量 = 前一日数量 + 新增 − 移出 |

当天 21:15 前未满足的条件显示为 `PENDING`。整体 `passed` 要求最近 N 个交易日全部 PASS（或允许时 PASS_DEGRADED）。
修复前的版本把 DEGRADED 计为通过、只要求一份非 NOT_READY 报告，且无法证明第二次运行重新拉取了数据。

部署后基线（2026-10-17 周六）：`acceptance --days 3` → `passed: false`；20261014/15 无 live 报告，20261016 仅一次补发、
无两次当日拉取记录（`scheduled_runs`、`data_rechecked` 未满足）。这是预期结果。

### 8.2 2026-10-19 / 10-20 / 10-21 记录（只在日期真实发生并产生证据后填写）

| 项目 | 20261019 | 20261020 | 20261021 |
|---|---|---|---|
| 18:40 / 21:10 计划运行是否触发 | PENDING | PENDING | PENDING |
| 每次 Tushare 同步是否成功 | PENDING | PENDING | PENDING |
| 是否真正复查当日行情（`daily_fetches` ≥ 2） | PENDING | PENDING | PENDING |
| 最终报告状态 / 生成时间 | PENDING | PENDING | PENDING |
| 股票池数量及增减是否连续 | PENDING | PENDING | PENDING |
| MCP 返回报告 ID 与数据库一致 | PENDING | PENDING | PENDING |
| 数据缺失 / 容器重启 / 存储或权限错误 | PENDING | PENDING | PENDING |
| ChatGPT 手动与定时任务调用（用户侧） | PENDING | PENDING | PENDING |

每个交易日 21:20 CST 之后在 VPS 上执行并把输出存入 `docs/ashare-samples/acceptance-<日期>.txt`：

```bash
# 1. 两次计划运行（应各有一次 Started/Finished，且无 failed）
journalctl --user -u finance-ashare-daily.service --since "<YYYY-MM-DD> 18:00" --until "<YYYY-MM-DD> 23:59" --no-pager
ls -la ~/.local/share/finance-mcp-ashare/logs/ | grep daily-<YYYYMMDD>
# 2. 当日判定（逐项 failed 列表、live_runs、daily_fetches、final、mcp_report_id、watchlist）
docker exec finance-mcp-ashare node build/ashare/cli.js acceptance --days 1 --end <YYYYMMDD>
# 3. 公网 MCP 返回的报告 ID（与上一步 final.report_id 对比）
node deploy/ashare/mcp-e2e.mjs https://share.shijingchang.cn/ashare/mcp <YYYYMMDD>
# 4. 容器重启/存储/权限
docker inspect -f '{{.State.StartedAt}} restarts={{.RestartCount}} health={{.State.Health.Status}}' finance-mcp-ashare
df -h ~ ; ls -la ~/.local/share/finance-mcp-ashare/reports/<YYYYMMDD>/
```

10-21 21:20 之后执行 `docker exec finance-mcp-ashare node build/ashare/cli.js acceptance --days 3`，`passed: true` 才可把
“连续 3 个真实交易日”改为 ✅。任何一天 FAIL：记录 `failed` 列表与日志，不得用手动补跑替代（手动 `report` 为 `run_mode=manual`，不计入）。

### 8.3 ChatGPT 侧（用户账号操作，PENDING）

1. ChatGPT → 设置 → Connectors（开发者模式）→ 添加 Custom MCP server：`https://share.shijingchang.cn/ashare/mcp`，认证选 “No authentication”。
2. 新对话中手动调用：“调用 ashare_data_status 查看 20261019 的数据状态”“调用 ashare_daily_report（date=20261019）”，
   记录回复中的报告 ID，应与 §8.2 第 2 步 `final.report_id` 一致；截图保存。
3. 将已有 A 股日报定时任务改为调用 `ashare_daily_report`（不带 date 即为当日），时间设在北京时间 **21:30 之后**；
   次日查看任务输出中的报告 ID 与生成时间，同样与数据库比对。
4. 在 21:10 之前调用会得到 `PENDING`/旧的 18:40 版本或 `NOT_READY`，属预期行为，不算失败。

## 9. 第二轮正确性修复（2026-10-17，goal `docs/goal/1017-v1-fix.md`）

审阅基线 `371c2c4`。修复提交 `55b2b09`（分支 `ashare-v1-fix`，基于 `ashare-daily`）。修复前已将正式库备份为
`~/ashare-backup/ashare-20261017-prefix.sqlite`（`sqlite3 .backup`）。

测试命令与结果：

```
npm test                         → tests 76, pass 76, fail 0（上一轮 66 + 新增 10）
npx tsc --noEmit -p .            → 无错误
node --test test/ashare-correctness.test.mjs   → 9/9（P0-1×2、P0-2、P0-3、P1-1、P1-2×2、P1-3、5 个 MCP 工具）
# 回归有效性：在 build 中逐一恢复旧逻辑（不复查当日、评价窗口不截止、报告按生成时间排序），对应 5 个测试失败。
ASHARE_DATA_DIR=<正式缓存副本> node deploy/ashare/verify-real-cache.mjs   → 5/5 PASS（docs/ashare-samples/fix-1017-real-cache.json）
node deploy/ashare/mcp-e2e.mjs https://share.shijingchang.cn/ashare/mcp 20261016 → 9/9 PASS（部署后，mcp-e2e-public-20261017-fix.json）
```

`verify-real-cache.mjs` 在正式库的 1.6 GB 副本上运行（脚本拒绝指向正式目录），使用真实 Tushare 请求（34 次调用，0 重试）。

### 9.1 P0-1 当天核心数据强制复查

- 根因：`syncTradeDate()` 在 `sync_log` 为 `ok` 时直接跳过；18:40 拉到 ≥97% 的数据即标记 `ok`，21:10 不再请求 Tushare。
  且写入只用 `INSERT OR REPLACE`，上游撤回的行不会删除；`syncIndexDaily()` 只追加最后一根之后的指数 K 线，当日指数也不会复查。
- 修改：`src/ashare/ingest.ts`（`syncTradeDate` 的 `refresh` 模式、整日替换/合并规则、指数 `refreshFrom`）、`src/ashare/db.ts`
  （`replaceDate` 事务内整日替换、`sync_history` 追加表）、`src/ashare/sync.ts`（`refreshFrom`，返回 `refreshed`/`datasets`）、
  `src/ashare/commands.ts`（`daily` 对 as-of 日 `refreshFrom=date`，最近 5 日其余日期仍只补缺）。
- 规则：返回 ≥ 前一交易日与已存条数的 97% → 当日整体替换；否则只合并，不缩减已有数据。
- 测试：首次 97+1 行（含一条之后被撤回的行）→ 第二次 100 行且有修订值：第二次确实再次请求、修订值覆盖、撤回行删除、更早日期不重下、
  第三次同数据无重复；首次 50 行 `partial`/NOT_READY → 补齐为 `ok`；完整数据上的短返回只合并。
- 真实数据：副本上把 000001.SZ 收盘价翻倍、插入一条假行、删除 50 条 daily_basic 与 1000 条 stk_limit（→ DEGRADED），
  执行两次 daily 同步：收盘价恢复为 11.5、假行删除、四表条数恢复为 5567/5567/5577/5655，两次结果一致，只刷新 20261016。
  该检验同时发现初版规则（要求返回条数 ≥ 已存条数）在多一条脏行时退化为合并，已改为 97% 阈值并补单测。
- 剩余风险：Tushare 对已发布日期的事后修订若发生在当日 21:10 之后，只会在手动 `sync --force` 时被纳入。

### 9.2 P0-2 正式运行与历史回放隔离

- 根因：`replay` 先 `resetWatchlistFrom(start)` 删除正式库中 start 之后的全部股票池，再逐日重建；`report --date` 对任意历史日期
  调用 `updateWatchlist` 覆盖当日股票池，使后续日期的“上一期”不再对应；两者都覆写 `reports/<日期>/latest.json`。
- 修改：`src/ashare/db.ts`（`openResearchDb`：研究库只含状态表，正式库以 `mode=ro` ATTACH）、`src/ashare/report.ts`
  （研究库报告写入 `research/reports/`，不写 `latest.json`）、`src/ashare/commands.ts`（`replay` 只用研究库；`report --date`
  早于正式最新股票池日期或带 `--research` 时用研究库；`daily --date` 早于正式最新日期直接拒绝；`pool-eval --research`）。
- 测试：5 个 live 日期后执行重叠的 19 日 replay 与回溯 `report`，正式库股票池、变更、评分、报告表与 `latest.json` 完全不变；
  研究库对正式库的写入被 SQLite 拒绝（readonly）；下一 live 日的 `previous_date` 与数量连续。
- 真实数据：副本上 `replay 20261012~20261016` + `report --date 20261014` → 正式库快照哈希不变，最新报告仍为 `ASR-20261016-…-ddd0d0`。
  正式环境 `daily --date 20261015` → 退出码 1，提示改用研究库。
- 剩余风险：修复前写入正式库的 71 个重放报告与股票池保留（不改写已有研究结果）；20261016 的正式股票池以这些重放结果为前一期。

### 9.3 P0-3 历史效果评价严格 as-of

- 根因：`evaluateWatchlist()` 的交易日列表只有下界，持有窗口可读取 `end` 之后的行情；报告读取全局唯一的 `signal_evidence`，
  历史重放会把之后计算的证据分类当作当日已知。
- 修改：`src/ashare/evidence.ts`（交易日 `BETWEEN start AND end`，输出 `as_of`、`pending_dates`；`loadVerdicts(db, asOf)` 在证据窗口
  晚于 asOf 时不予引用并说明）、`src/ashare/report.ts`、`src/ashare/tools.ts`（按报告日期加载证据）。
- 测试：追加 end 之后 14 个交易日行情，`evaluateWatchlist(start, end)` 结果逐字段相同；证据截至较晚日期时，较早日期的重放报告中
  全部信号为 `research_only` 且标注“晚于…当时不可得”。
- 真实数据：end=20261009，删除副本中 20261009 之后的全部行情前后结果相同（62 个日期，-2.25%）；旧逻辑等价结果为 67 个日期 / -2.11%，
  多出 0928~1009 五个未完成窗口。20261016 正式报告的 track_record 不受影响（生成时没有更晚的数据）。
- 剩余风险：行业分类与 ST 判断仍为当前 `stock_basic` 口径（已在报告 risks 中声明）。

### 9.4 P1 小范围修复

1. `latestReportMeta`：按交易日 → 正式/手动优先于重放 → 生成时间排序；`report` 表新增 `run_mode`（启动时从 JSON 回填：live 1、replay 74）；
   NOT_READY 报告引用的“最近可用报告”限制在 as-of 之前。测试覆盖“较晚生成的旧日期重放不成为最新”。
2. 验收 READY / DEGRADED：见 §8.1；单测覆盖 READY 通过、DEGRADED 默认不通过/`--allow-degraded` 记 PASS_DEGRADED、单次运行、缺少复查、
   较晚重放不影响 MCP 一致性、当日 21:15 前 PENDING。
3. 复权因子缺失：`bars.ts` 统计 `adjMissing`；有缺失的股票不合格（“复权因子缺失，价格序列不连续”）、不输出信号、风险提示注明；
   信号证据计算跳过这类股票；`ashare_stock_analysis` 给出警告且不列信号。当前正式缓存中缺失为 0 行（已查询）。
4. `evidence_supported` 表述：报告 `signals.evidence_scope` 与 Markdown 说明“样本内方向性证据”，列出收益窗口重叠、多重检验未校正、
   样本内、未计成本四项限制；`basis` 前缀“样本内”。未开发新的统计引擎，分类规则与阈值不变。
5. 匿名 MCP 部署（§9.5）。
6. systemd（§9.6）。

### 9.5 匿名 MCP 入口的边界与实际风险

| 项目 | 现状 |
|---|---|
| 认证 | 无（`MCP_AUTH_TOKEN` 为空，实测无凭证 POST 返回 200）。ChatGPT 的 “No authentication” 依赖于此 |
| 只读 | 5 个工具只做 SELECT；本轮改为 SQLite **只读连接**（写入抛 `readonly`，单测覆盖）；Docker 根文件系统只读，`cap_drop: ALL` |
| 数据范围 | 仅本地 A 股缓存（Tushare 衍生行情/财务/报告）；不接受请求中的数据源凭证，不调用外部 API，`TUSHARE_TOKEN` 只在服务端 |
| 请求大小 | 由 10 MB 降为 64 KB（`MCP_BODY_LIMIT`）；公网实测 100 KB 请求 → 413 |
| 限流 | 每 IP 每分钟 30 次（Caddy 转发的真实 IP） |
| 会话 | `initialize` 产生的会话表原先无上限，现上限 1000（淘汰最久未活动） |

实际风险（接受并记录）：任何知道 URL 的人都能读取全部报告、股票池与个股分析，内容等同于对外公开；Tushare 衍生数据的再分发
可能不符合其用户协议；多 IP 可绕过每 IP 限流，`ashare_stock_analysis`/`ashare_data_status` 单次约 0.1 s CPU，
大量并发可拖慢同机其他服务；`GET /mcp` 的 SSE 长连接没有数量上限（Caddy 与 Node 连接数为最终约束）。
未引入 OAuth。若需收紧：设置 `MCP_AUTH_TOKEN`（需 ChatGPT 侧支持 OAuth）或在 Caddy 层加 IP 白名单。

### 9.6 systemd 定时任务的持续性

- 注销：`loginctl show-user jcshi` → `Linger=yes`，用户管理器不随会话退出。
- 重启：timer `enabled`（`timers.target.wants`）、`Persistent=true`（停机期间错过的运行在开机后补跑）；`docker`、`containerd` 均 `enabled`；
  容器 `restart=unless-stopped`。未实际重启 VPS（同机还有其他生产服务），以上为配置级证据。
- Docker 未就绪：用户管理器无法依赖系统级 `docker.service`（单元里的 `After=docker.service` 不生效）。`run-daily.sh` 现等待
  守护进程与容器 `running/healthy` 最长 300 s（`ASHARE_DOCKER_WAIT_SECONDS`），超时以退出码 75 失败并写明原因，systemd 记为 failed。
  实测：`ASHARE_CONTAINER=finance-mcp-nonexistent ASHARE_DOCKER_WAIT_SECONDS=10` → “container … not ready after 10s (state: missing)”，退出 75。
- 定时单元调用的是仓库工作区中的 `deploy/ashare/run-daily.sh`：工作区必须保持在包含本修复的分支上。
- 部署：`docker compose up -d --build` 重建并重启容器后健康；`docker restart` 后 MCP 仍返回同一报告；数据目录
  `ashare.sqlite`、`reports/20261016/ASR-…-ddd0d0.json` 与 `latest.json` 在宿主卷上持久存在。
- 周六手动触发服务：`{"trade_date":"20261017","skipped":true,"reason":"非交易日"}`，单元正常结束。
