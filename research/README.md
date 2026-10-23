# research/

Phase 5 起的历史研究实验运行器与结果。**只读**：本目录下的运行器不写生产数据库、
不调实盘 API、不激活任何定时器。

## 运行

```bash
node research/experimentA.mjs --db PATH --as-of YYYYMMDD [--cutoff YYYYMMDD] [--json OUT]
```

- `--db` 冻结研究快照（SQLite）。以 `mode=ro` + `readOnly: true` 打开；
  文件不存在时打开直接失败，不会创建空库。
- `--as-of` **信号日**。选股在这一天发生，只用这一天及之前可见的数据。
- `--cutoff` **评估截止日**，必须晚于 `--as-of`。默认取快照最后一个交易日。
  它与 `--as-of` 是两个独立参数，这一点是刻意的：`evaluateEvents` 的交易日历是
  `cal_date BETWEEN 信号日 AND cutoff`，把信号日当截止日传下去会让每个事件都变成
  `entry_after_as_of`，于是所有臂都报 `unavailable`、0 进场——一个看起来和真实
  结果一模一样的"无数据"。`cutoff <= as-of` 时运行器以退出码 2 拒绝。
- `--json` 把同一次运行写成机器可读证据，含 `code_sha`、`source_sha256` 与
  `runner_sha256`。没有它，数字只存在于终端回滚里，而无法 diff 的数字无法审计。

## 已记录的结果

| 文件 | 实验 | 结论 |
|---|---|---|
| `experimentA_results.json` | A 股票池选股有效性 | `DOES_NOT_SUPPORT_HYPOTHESIS` |

`--json` 输出的是**单次单信号日**的证据。多信号日的汇总（`experimentA_results.json`）
由多次单日运行合并而成，其 `code` 段记录的是合并时使用的代码身份。重跑时若代码
已变更，必须重新生成，不得沿用旧哈希。

## 一个实际踩到的陷阱

变异测试脚本会 `npx tsc` 把变异体编译进 `build/`，而本目录的运行器从 `build/`
导入。因此在变异测试进行中"验证修复效果"的真实数据运行，可能读到某个变异体的
编译产物——`git status` 干净、源码未改、`tsc` 无错，错数字看起来完全合法。
**跑真实数据前先确认 `build/` 比 `src/` 新。**
