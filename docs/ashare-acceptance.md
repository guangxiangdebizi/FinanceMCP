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
| **连续 3 个真实交易日增量更新与报告验收** | ❌ **尚未完成**（需等待 2026-10-19/20/21 定时任务实际运行） |
| **ChatGPT 网页版手动调用 / 已有定时任务验证** | ❌ **待账号侧操作**（本机无法登录 ChatGPT） |

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

## 8. 尚未完成的验收（禁止视为已完成）

1. **连续 3 个真实交易日**：等待 2026-10-19、10-20、10-21 定时任务实际运行后执行
   ```
   docker exec finance-mcp-ashare node build/ashare/cli.js acceptance --days 3
   ```
   该命令要求每个交易日都有 `run_mode=live`、状态非 NOT_READY 且在交易日当天（北京时间）生成的报告。
   当前结果：`passed: false`（20261014/15 仅有重放报告，20261016 为次日凌晨补发）。
2. **ChatGPT 侧**：在 ChatGPT 添加 Custom MCP server `https://share.shijingchang.cn/ashare/mcp`（No authentication），
   手动调用 `ashare_daily_report`，并把已有 A 股日报定时任务改为调用该工具（建议北京时间 21:30 之后）。需账号侧完成。
