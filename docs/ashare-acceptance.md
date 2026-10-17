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
| 第三轮修复（1017-fix2：手动报告隔离、刷新状态分离，见 §10） | ✅ 提交 `661e130`（分支 `ashare-v1-fix2`），`npm test` 83/83，真实缓存副本 6/6，已部署 |
| 阶段 A 数据服务（1017-data：数据访问契约、缓存审计、4 个数据工具，见 §11） | ✅ 提交 `4398808`（分支 `feat/ashare-data-service-v1`），`npm test` 94/94，真实缓存副本 12/12，已部署，公网 e2e 13/13 |
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
| `data_rechecked` | `sync_history` 中当日 `daily` 至少有 2 次 `refresh_status=REFRESH_OK` 的请求（第二次运行确实复查当日行情）；失败或不完整的请求不计入 |
| `final_status` | 最后一份 live 报告为 **READY**。DEGRADED（非核心缺口：涨跌停价覆盖率或非核心指数缺失）默认**不通过**；仅在 `--allow-degraded` 时记为 `PASS_DEGRADED`，不会显示为 PASS。NOT_READY 一律不通过 |
| `mcp_consistent` | MCP 工具对该日返回的报告 ID 等于最后一份 live 报告 |
| `watchlist_continuous` | 股票池 `previous_date` 为前一交易日，且数量 = 前一日数量 + 新增 − 移出 |

当天 21:15 前未满足的条件显示为 `PENDING`。

**两类证据分开核验**：`acceptance` 只证明*流水线执行*（数据库里的 live 报告与有效 Tushare 请求），不能证明这些运行由 systemd timer 触发
（手动 `systemctl start` 或 `docker exec … daily` 也会留下同样的记录）。*调度证据*由 `deploy/ashare/check-schedule.sh <YYYYMMDD>` 从
systemd journal 读取：只有北京时间 18:40–18:45 与 21:10–21:15 窗口内的 `Starting` 记为计划运行（timer `RandomizedDelaySec=120`），
并要求两次都 `Finished`、无失败。两者都通过，当日才算 PASS。
2026-10-17 实测（无计划运行的周六）：`check-schedule.sh 20261017` → 列出 00:35（上一轮部署调试）与 07:45（手动触发）的启动，
`run_1840=no run_2110=no`，`schedule=FAIL`，退出码 1，即手动启动不会被误计为计划运行。整体 `passed` 要求最近 N 个交易日全部 PASS（或允许时 PASS_DEGRADED）。
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
# 1. 调度证据：两次计划运行（journal，应输出 run_1840=yes run_2110=yes schedule=PASS）
deploy/ashare/check-schedule.sh <YYYYMMDD>
ls -la ~/.local/share/finance-mcp-ashare/logs/ | grep daily-<YYYYMMDD>
# 2. 流水线证据：当日判定（逐项 failed 列表、live_runs、daily_fetches[].refresh_status、final、mcp_report_id、watchlist）
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

## 10. 第三轮修复（2026-10-17，goal `docs/goal/1017-v1-fix2.md`）

审阅基线 `cb53e4b`。修复提交 `661e130`（分支 `ashare-v1-fix2`，基于 `ashare-v1-fix`）。部署前备份：
`~/ashare-backup/ashare-20261017-pre-fix2.sqlite`（`sqlite3 .backup`）与 `reports-20261017-pre-fix2.tgz`。
（上一轮的 `ashare-20261017-prefix.sqlite` 已由这份新备份替代并删除；两轮之间正式库只有 `run_mode`/`sync_history` 的增量迁移。）
评分权重、信号、股票池规则与历史表现均未改动。

```
npm test                         → tests 83, pass 83, fail 0（上一轮 76 + 新增 7）
npx tsc --noEmit -p .            → 无错误
node --test test/ashare-refresh.test.mjs        → 6/6（反例 A~E，含报告/MCP 层）
node --test test/ashare-correctness.test.mjs    → 10/10（新增最新 live 日期的 report 隔离）
ASHARE_DATA_DIR=<正式缓存副本> node deploy/ashare/verify-real-cache.mjs → 6/6 PASS（docs/ashare-samples/fix2-1017-real-cache.json）
node deploy/ashare/mcp-e2e.mjs https://share.shijingchang.cn/ashare/mcp 20261016 → 9/9 PASS（部署后，mcp-e2e-public-20261017-fix2.json）
```

回归有效性（在 build 中恢复旧逻辑后应失败的测试）：旧 `report` 路由（等于最新 live 日期时写正式库）→ “fix2 P0-1” 失败；
质量判定忽略刷新结果 → “A/D/E” 失败；短返回合并进完整快照并按缓存行数记为成功 → “A”、“A/D/E”、“P0-1 short refresh” 失败；
同日只降级 replay 的旧排序 → “P1-1” 失败；验收计入任意请求 → “P1-2” 失败。

### 10.1 P0：手动报告与正式数据隔离

- 根因：`report --date` 只有在 `date < lastLiveDate` 时才进入研究库；`date == lastLiveDate`（例如 20261016）会在正式库调用
  `generateReport(…, 'manual')`，重写当日正式股票池、评分与 `latest.json`，且该手动报告生成时间更晚，`latestReportMeta` 只降级 replay，
  MCP 会改为返回这份手动报告。
- 修改：`src/ashare/commands.ts`（`report --date` 一律使用研究库）、`src/ashare/report.ts`（`generateReport` 在正式库只接受 `live`、
  在研究库拒绝 `live`；`latestReportMeta` 同日排序 live → manual → 无 run_mode → replay）、`src/ashare/cli.ts`（用法说明）。
- 测试：最新 live 日期、更早 live 日期、研究库中尚未生成的日期各执行一次 `report`，结果均为 `space=research`、路径在 `research/reports/`；
  正式 watchlist / watchlist_change / stock_score / report / latest.json 前后完全一致；MCP 仍返回原 live report_id；正式库上
  `generateReport(…, 'manual'|'replay')` 抛错；下一 live 日的 `previous_date` 与数量连续。排序测试覆盖“同日更晚生成的 manual 不胜过 live”。
- 真实数据（副本）：`replay 20261012~20261016`，`report --date` 20261014 / **20261016** / 20261019 → 三份研究报告（READY/READY/NOT_READY），
  正式库快照哈希不变，MCP 返回 `ASR-20261016-20261016163620-ddd0d0`（live，40 只）。
- 正式库中没有遗留的 manual 记录（`run_mode`：live 1、replay 74）。

### 10.2 P0：缓存完整性与上游刷新状态分离

- 根因：同步状态只按写入后的 SQLite 行数判断。5500 → 3000 时缓存仍为 5500，状态仍为 `ok`，刷新异常被掩盖；偏短的返回还会被
  `INSERT OR REPLACE` 合并进完整快照，混入部分更新；Tushare 报错直接抛出，没有留下该数据集的失败记录。
- 修改：`src/ashare/db.ts`（`sync_log`/`sync_history` 增加 `refresh_status`、`before_rows`、`after_rows`、`write_mode`，启动时迁移；
  `logSync` 写入这些字段）、`src/ashare/ingest.ts`（`syncTradeDate` 区分 REFRESH_OK / INCOMPLETE / FAILED，完整缓存上的短返回 `kept`
  不写入，请求异常记录后继续；指数刷新同样记录；`checkQuality` 输出 `cache_status` 与 `refresh`，最新刷新异常时 READY → DEGRADED）。
  报告与 `ashare_data_status` 直接使用 `checkQuality`，无需单独改动；未引入新的状态服务或任务框架。
- 反例测试（`test/ashare-refresh.test.mjs`）：
  - A 5500 → 3000：仍 5500 条、修订值未混入，`refresh_status=REFRESH_INCOMPLETE`、`write_mode=kept`，缓存 `status=ok`；
    报告层 DEGRADED，理由“最新一次刷新 daily 不完整（返回 33 条，沿用上一次有效快照 60 条…）”，`ashare_data_status` 与 `ashare_daily_report` 均显示。
  - B 3000 → 5500：首次 merged/partial（报告层 NOT_READY），第二次 replaced/REFRESH_OK，恢复 READY。
  - C 5500 → 5490（撤回 10 条）：REFRESH_OK、原子替换、撤回行不残留。
  - D 请求异常：数据保留，`REFRESH_FAILED` 与错误信息留在 sync_log/sync_history，其他数据集照常刷新；报告 DEGRADED（“adj_factor 请求失败”）。
  - E 连续运行：不完整 → 失败 → 成功后自动恢复 READY、原因清空，条数不变，同日股票池重建而非重复。
- 真实数据（副本，真实 Tushare 返回上注入短返回/错误）：短返回 3000 条 → kept，`cache_status=READY`、`status=DEGRADED`；
  注入错误 → REFRESH_FAILED，DEGRADED；真实刷新 → REFRESH_OK（replaced 5567），READY；三步四表条数均为 5567/5567/5577/5655。
- 剩余风险：`daily` 流程中较早的交易日一旦为 `ok` 不再刷新，若其最后一次刷新是 INCOMPLETE，该日报告保持 DEGRADED（如实，不自动消除）。
  本次修复之前的同步记录 `refresh_status` 为 null，不参与判定（正式 20261016 即如此，状态 READY）。

### 10.3 P1：连续三日验收证据

- `acceptance` 保留，`data_rechecked` 只统计 `REFRESH_OK` 的请求（单测：两次均 INCOMPLETE 时不通过）；DEGRADED 规则不变
  （仅 `--allow-degraded` 时 `PASS_DEGRADED`）。流水线证据与调度证据的区分与 `check-schedule.sh` 见 §8.1、§8.2。
- 2026-10-19 / 20 / 21 仍为 **PENDING**，未填写任何未来结果。

### 10.4 P2：MCP 只读初始化

- 已完成（小改动）：`getAshareDb()` 直接以只读方式打开，不再先开可写连接；结构不是最新时抛出“请先运行 finance-ashare migrate”。
  `deploy/ashare/docker-compose.yml` 的启动命令为 `cli.js migrate && exec node build/httpServer.js`，迁移只在容器启动时进行一次。
  部署后容器日志 `{"migrated": []}`，`sync_log` 已含新列，健康检查通过。

### 10.5 部署后验证

- `docker compose up -d --build`：数据卷仍为 `~/.local/share/finance-mcp-ashare → /data`，容器 healthy。
- 公网 MCP e2e 9/9；`ashare_watchlist(20261016)` → `ASR-20261016-20261016163620-ddd0d0`，40 只；`ashare_data_status(20261016)` →
  READY（`cache_status=READY`，旧同步记录 `refresh_status=null`）。
- 正式 `reports/`（72 个日期目录）与部署前备份逐字节一致；正式库 20261016 股票池 40 行；正式数据目录未生成 `research.sqlite`
  （研究库只在副本上使用过）。
- `finance-ashare-daily.timer` enabled，下次触发 2026-10-19 18:41 CST。

## 11. 阶段 A：数据获取模块与数据服务（2026-10-17，goal `docs/goal/1017-data.md`）

基线 `ashare-v1-fix2`（`c0420a4`）。代码提交 `4398808`（分支 `feat/ashare-data-service-v1`）。数据契约与工具说明见
[`ashare-data-service.md`](ashare-data-service.md)，架构文档 [`ashare-data-research-architecture.md`](ashare-data-research-architecture.md)
§6、§9 已同步更新。部署前备份：`~/ashare-backup/ashare-20261017-pre-data.sqlite` + `reports-20261017-pre-data.tgz`。
评分权重、信号规则、股票池规则与历史评价方法均未改动。

### 11.1 审计记录（A1）

在正式缓存上逐数据集检查（只读查询）：

| 结论 | 内容 |
|---|---|
| **真实缺陷（已修）** | ① `fina_indicator` 中 603400.SH 20260630 报告期标注 20260422 公告（早于报告期末，数值与 20260803 公告相同），引擎 `fundamentalsAsOf` 在 0422~0802 会提前用到它（未来信息）；20260430 实测仅影响这一只股票、其当日不在评分候选内，正式输出未变。② 缺少停牌数据，905 只股票在首末两根 K 线之间共有 6814 个无行情的股票日，无法区分停牌与缺口。③ 指数只向两端追加，区间中间的空洞不会补齐（新增单日补齐路径）。④ `ashare_stock_basic` 功能缺失：上市/退市日期无法通过 MCP 获取。 |
| **审计中发现并修正的自身问题** | 初版 `audit --fix` 对缺口日期整日 refresh，会把上游后来修订过的其他股票复权因子写进少数日期（真实副本：000100.SZ 24 天 3.725→3.7253，其余日期仍为 3.725），已改为逐股修补；初版“因子修订”检查把不足一个价位的分红计入（1677 处误报），已改为只标记应使昨收变动 ≥ 0.01 元却未变的情况。 |
| **已知限制（披露，不修改）** | 行业/名称/ST/上市状态为当前 `stock_basic` 口径；代码变更未合并（300114.SZ 2025-02-14 前 268 根 K 线，`stock_basic` 已无此代码）；财务无修订版本（同公告日更正覆盖原值）；北交所旧代码财务记录与 92 代码重复；`stk_limit` 含 86 个 B 股等非 A 股代码；Tushare 复权因子在 20240515 改为 3 位小数、20240625 有 225 只股票单日 +0.001 次日恢复（缓存与上游一致）；**`ocf_to_profit` 为百分数，而 `score-1.0.0` 按比值 0.8 判断**（属于模块 B，按本轮规定不改，留待新评分版本）。 |
| **无需修改** | `trade_cal` 与 `daily` 交易日完全一致（673 天，0 缺日、0 非交易日行情）；`daily`/`daily_basic`/`adj_factor` 在有行情处一一对应；OHLC/成交量/成交额非法 0 条；涨跌幅与昨收不一致 0 条；上市前/退市后行情 0 条；单位（行情元、量手、额千元，市值万元）与现有换算一致；前复权以 as-of 前最后因子为基准、证据与股票池评价已严格 as-of（上一轮）。 |

### 11.2 实现（A2~A5）

- `src/ashare/data.ts`：数据访问契约（代码/日期/单位/缺失值/来源/错误；复权公式、公告日约束、市场宽度计数、单股覆盖分类、基础信息）。
  分析引擎改为调用其中三个函数：`bars.ts` 的前复权比例、`fundamentals.ts` 的财务快照、`market.ts` 的宽度计数。
- `suspend_d` 数据集（`ingest.ts` `syncSuspend`，纳入 `sync`/`daily`）；`syncIndexRange` 单日指数补齐。
- `src/ashare/audit.ts` + CLI `audit [--fix]`：缺口分类与一致性检查，`data_audit` 表与 `audits/*.json` 留存前后记录，`gap_check` 记录上游确认缺失。
- `checkQuality` 新增 `snapshot`：各数据集当日缓存的写入时间与是否来自不同批次（`ashare_data_status` 显示，同时显示最近一次审计）。
- 新 MCP 工具：`ashare_stock_history`、`ashare_financial_data`、`ashare_market_data`、`ashare_stock_basic`（参数校验、参数绑定、行数/区间/代码数上限、
  `next_start_date`/`next_offset` 分页、稳定排序、明确错误）。`ashare_factor_snapshot` 未实现（阶段 B）。

### 11.3 测试（A7）

```
npm test                          → tests 94, pass 94, fail 0（上一轮 83 + 新增 11）
npx tsc --noEmit -p .             → 无错误
node --test test/ashare-data.test.mjs → 11/11
```

`test/ashare-data.test.mjs` 使用专门构造的反例：除权（送转 10 送 10，原始价减半、因子翻倍：前复权连续、后复权 = 价×因子、截止日早于除权日时前复权 = 原始价、
引擎 K 线与工具一致）；分页基准不变与重复查询一致；停牌 / 无记录缺口 / 新股上市前 / 退市后与待退市 / 缺复权因子（null 且标记、不向前填补）；
非交易日区间、空结果、超限与非法参数、注入式代码；财务公告日晚于 as-of（隐藏，仅计数）、报告期与公告日不同、同期修订（取 as-of 前最新、列出变动字段）、
公告早于报告期末（排除，引擎同一规则）、空值保持 null；市场宽度与引擎 `marketBreadth` 一致、停牌数、60 交易日上限、未知指数；
基础信息检索转义、分页、去重；审计：停牌不是缺口、无记录缺口是 GAP、`sync_log` 为 ok 但缓存不足、`--fix` 只请求缺口日期、
整日快照问题才整日 refresh、单股缺口逐股修补且**其他股票的已存因子不被上游修订值改写**、上游确认缺失写入 `gap_check` 后降为 WARN、
逐股查到的停牌写入；停牌同步失败保留旧数据；不同批次快照识别；MCP 只读连接下 9 个工具均可用、写入被拒绝。
上游短返回、API 错误、数据源修订与连续恢复沿用并通过 `test/ashare-refresh.test.mjs`、`test/ashare-correctness.test.mjs`。

回归有效性（在 build 中恢复错误行为后对应测试失败）：前复权使用 end_date 之后的因子；财务接受公告早于报告期末的记录；审计把停牌计为缺口；
缺复权因子时沿用前值。

### 11.4 真实缓存副本验证

正式库副本（截至 20261016）上执行：

1. **分析层不变**（`deploy/ashare/compare-analysis.mjs`，旧版 `c0420a4` 与新版各自在独立研究库生成报告）：20250102 / 20260430 / 20261016
   的全部评分（1660 / 2112 / 1756 只）、40 只股票池成员与分数、市场、行业、信号段**逐字段相同**。
2. **停牌回填**：`sync --start 20240102 --end 20261016 --no-fina` → 686 次调用、0 重试、357 s；其余数据集按 `ok` 跳过；
   `suspend_d` 9171 行、673 天；`index_daily` 另向前补了 20221128~20221130 共 24 根（`sync` 原有的 400 天前缀规则）。
3. **审计**：GAP 29 天（29 个股票日、4 只北交所股票：920964/920174/920808/920961，无行情且无停牌记录）；停牌 8700、待退市 38；
   `--fix` 29 次逐股修补（各 4 个数据集 + `suspend_d`，183 s）：上游同样无数据 → `gap_check` 29 条；之后 **GAP 0**、WARN 33
   （29 上游确认缺失、1 昨收冲突 603081.SH 20240625、因子精度/上游修订 325 处集中于 4 天）。按股票向 Tushare 直接查询这 4 只股票的
   缺口区间，确认上游既无行情也无停牌记录。
   早一次的副本试运行中，688766.SH 的 7 天先被判为缺口，原因是当时按日期查询的 `suspend_d` 少返回一条；重查后 Tushare 返回完整记录，
   说明停牌数据的上游返回也会变化，`--fix` 的重查是必要的。
4. **补齐前后对比备份**：`daily`、`adj_factor`、`daily_basic`、`stk_limit` 行数与数值**完全相同**，`watchlist`、`report`、`stock_score` 不变，
   673 天质量均为 READY（`docs/ashare-samples/data-audit-real-cache.json`）。
5. **数据工具**（`deploy/ashare/verify-data-service.mjs`，12/12 PASS，`docs/ashare-samples/data-service-real-cache.json`）：
   - 大市值长期上市 + 除权除息：600519.SH 除息日 20260626（因子 8.4464 → 8.6463），前复权日收益与交易所 `pct_chg` 最大偏差 0.0003 个百分点，
     后复权 = 原始价 × 因子，截止 20260625 时基准为 20260625、前复权 = 原始价；引擎 260 日 K 线与工具前复权逐日一致（分页拼接）。
   - 近期上市、已退市、停牌股票（样本见结果文件 `samples`）：首根 K 线、上市期外天数、退市日后无行情、停牌日与 `suspend_d` 完全一致、无未分类缺口。
   - 多期财报 600519.SH as-of 20260801：全部记录公告日 ≤ as-of 且 ≥ 报告期末，之后公告的条数与库内一致；603400.SH as-of 20260501 不含 20260630 期，
     异常记录列出，as-of 20260901 取 20260803 公告。
   - 市场数据 20261016：涨跌家数、涨跌停、成交额、8 个指数收盘与正式日报 `ASR-20261016-…-ddd0d0` 一致；61 交易日以上被拒绝。
   - 基础信息：4 只样本返回，300114.SZ 列入 `not_found`，其行情仍可查询并提示代码不在 `stock_basic`。
   - 重复查询结果逐字节一致；MCP 连接写入被拒绝（readonly）。
6. **耗时**（真实缓存）：`stock_history` 20~35 ms（≤ 34 KB）、`financial_data` 1~2 ms、`stock_basic` 1 ms、`market_data` 单日 57 ms、
   32 个交易日 531 ms。未发现需要优化的查询，未做性能改动。

### 11.5 部署（A6）

- `docker compose up -d --build`：数据卷 `~/.local/share/finance-mcp-ashare → /data` 不变，启动迁移创建 `suspend_d`、`data_audit`、`gap_check`，healthy。
- 正式库执行与副本相同的停牌回填（686 次调用、0 重试、454 s）与 `audit --fix`：补齐前 GAP 29 → 补齐后 GAP 0（29 只股票日上游确认缺失），
  与副本结果一致。审计记录 `AUD-20240102-20261016-20261017140838-582c`（前）→ `…141046-fddd`（后）→ `…141201-b9a1`（复核），
  日志 `logs/backfill-suspend-20261017-215948.*`、`logs/audit-fix-20261017-215948.*`。
- 与部署前备份对比：`daily`、`adj_factor`、`daily_basic`、`stk_limit` 数值不变，`watchlist`/`report`/`stock_score` 行数不变，
  `reports/` 与备份逐字节一致，673 天质量 READY。
- 公网 MCP e2e 13/13（9 个工具 + 报告字段，`docs/ashare-samples/mcp-e2e-public-20261017-data.json`）；20261016 报告仍为
  `ASR-20261016-20261016163620-ddd0d0`，40 只；`ashare_data_status` 显示最近审计。
- 公网安全检查：`limit` 超限、注入式代码、673 个交易日的市场区间均返回 400 与明确信息；`%` 检索返回 0 条；100 KB 请求 413；
  容器内 MCP 连接写入报 `attempt to write a readonly database`。
- `finance-ashare-daily.timer` enabled，下次触发 2026-10-19 18:41 CST；未改动 ChatGPT 侧定时任务，未执行连续三日验收（§8 仍为 PENDING）。

### 11.6 剩余问题

- 北交所 4 只股票的 29 个股票日为上游缺失（无行情也无停牌记录），只能披露，不能补齐。
- 停牌数据的完整性无法用条数判断；按日期查询的返回可能变化（688766.SH 实例），依赖审计复查。
- 历史日期的上游修订（复权因子精度调整等）不会自动回溯；审计披露但不整体重下，以免把新旧口径混入未出错的股票。
- 以上 §11.1 已知限制，及 `ocf_to_profit` 单位问题留给阶段 B。
