# 账户账本与对账

本文描述真实账户从“历史基线 + 事件账本”重建、导入、对账和门控的实现。费用见 `fee-model-and-calibration.md`。账户数据全部在私有账户库 `portfolio.sqlite`，公共 MCP 不提供任何账户读写工具；所有写操作只能通过本地 CLI。

## 事件账本

账本表由 `src/portfolio/ledger.ts` 维护。金额为整数分，价格为整数厘，数量为整数份。事件类型：

| 目标事件 | 账本类型 | 说明 |
| --- | --- | --- |
| BUY / SELL | `TRADE_BUY` / `TRADE_SELL` | 保存成交日、数量、价格、毛额、手续费、税费、来源 |
| CASH_IN / CASH_OUT | `CASH_DEPOSIT` / `CASH_WITHDRAW` | 出入金，不改变单位净值 |
| DIVIDEND | `DIVIDEND` | 现金增加，数量不变 |
| FEE | `FEE` | 现金减少 |
| CORRECTION | `REVERSE` | 以 `reverses_event_id` 撤销原事件，原行保留；更正需另导入替代行 |
| — | `SPLIT` | 拆分/合并，总成本与现金不变 |

来源只有 `synthetic` 与 `broker_statement`。事件早于基线日期时拒绝录入（基线已包含其影响）；`validateLedger` 报告越卖、悬空或重复撤销、重复事件 ID、基线之前的事件。

`replayAccount` 是确定性重放，不读当前时间：持仓、现金、均价成本（买入费用计入成本，卖出费用与税费冲减收入）、已实现盈亏均由基线加事件推导。没有事件的日期也可重建，返回 `reconstruction` 说明基线日期、基线快照、已应用事件数和可卖基准。

## 基线与重建

`initBaseline` 把一份已确认的快照登记为账户重建起点，重复以相同参数调用幂等（`created:false`），起点不会被静默改写。`resolveAccountState` 以基线加事件得到持仓数量与现金，价格只用于给派生数量估值；快照中没有的新证券使用成本回退价并带 `new_position_price_cost_fallback` 警告，来源标为 `ledger_reconstruction`。请求日期早于基线直接报错。市场行情从不改变持仓数量。

不传 `account_id` 时（`resolveAccountId`）：仅一个已确认真实账户则用它；多个则要求显式指定；不会回落到演示快照或名为 `default` 的账户；显式账户必须是本部署已配置账户。

## 可卖数量与交收

按品种推导交收规则：股票与权益 ETF 为 T+1，债券 ETF、黄金 ETF 及规则内的跨境 ETF 为 T+0，无法分类的按保守 T+1 并标注 `settlement_rule_assumed`。交收日取本地 `trade_cal` 的下一个开市日，缺日历时退回只跳周末并标注 `calendar_assumed`。

重放逐标的输出 `quantity`（持仓）、`sellable_quantity`（可卖）和 `settlement_rule`。T+1 品种排除决策日当日买入的批次，卖出先进先出消耗；超过可卖数量的卖出被拒（`insufficient_sellable_position`）。现金区分含未交收的买入力与只含已交收的可取金额，均为模型假设，未与券商交割单核对。

## 批量导入

`portfolio-ledger-import --account ID --file PATH [--format csv] [--broker ID] [--dry-run] [--continue-on-conflict]`。`.csv` 扩展名或 `--format csv` 按券商 CSV 解析（UTF-8，含 BOM、引号逗号、CRLF）；否则读取 JSON 事件数组。当前没有 Excel 读取能力，Excel 需先另存为 UTF-8 CSV。

CSV 规则（`src/portfolio/tradeImport.ts`）：

- 列名支持英文及常见券商中文别名（流水号、成交日期、业务名称、证券代码、成交数量、成交价格、成交金额、佣金、过户费、印花税、资金发生额等）；同一字段匹配到多列报错。
- 十进制以字符串转定点整数，不经浮点乘法；超过精度的小数拒绝。
- 成交行必须显式给出佣金与税费列（零也要写明）；缺失即拒绝，不默认为 0。
- 必须提供稳定的券商成交/流水号。事件 ID 为 `broker:<账户>:<券商>:<流水号>`，不使用行号或内容哈希，避免把相同的两笔成交合并。
- 同一文件内相同 ID 内容不同则拒绝。原始佣金、过户费、委托号和行哈希保存在事件备注中。
- 实际佣金原样入账，滑点不进入账本现金。按订单还是成交明细计收最低佣金、舍入规则仍为 UNKNOWN，除非另有证据。

幂等：相同 ID 且内容相同记为 `DUPLICATE`，不新增行、不重复现金与费用；相同 ID 内容不同只写冲突表，不覆盖原记录；默认冲突时整批回滚，零部分写入（`--continue-on-conflict` 例外）。

## 对账

`portfolio-ledger-reconcile` 与决策层使用的 `reconcileAccountVsLedger` 对同一日期比较快照与账本重放：

- 逐代码持仓数量（双向，快照有账本无、账本有快照无均报差异）；
- 现金；
- 证券市值（账本数量按快照自己的参考价折算，因此价格变动不会被误报）；
- 总资产（快照提供 `wealth_cents` 时核对，否则该项为 `UNKNOWN`）。

返回 `ok`、逐项 `mismatches` 与 `checks`（`MATCH`/`MISMATCH`/`UNKNOWN`、差额）。任何差异都使 `ok:false`，决策层降级。

## 完整性声明与真实账户确认

- `portfolio-completeness-set --account ID --as-of YYYYMMDD --recorded-by WHO --confirm [--events-through YYYYMMDD] [--unreported-risk yes|no]`：声明用户核对到哪个时点。缺省 `unreported_trade_risk=true`；没有 `--confirm` 或没有声明人则拒绝；`events-through` 不得晚于 `as-of`。
- 在声明之后再导入新事实会使声明失效，`unreported_trade_risk` 重新置为 true，需再次由用户声明。
- `portfolio-ledger-confirm-real --account ID --confirm`：需要账本基线，且账本不变量无违规、无未处理冲突。导入和计算路径永不自动置位。确认只表示用户声明账本反映真实账户，不改变事件的来源标记。

## 三类独立门控

决策层（`src/portfolio/decision.ts`）分别评估：

1. 账户状态：真实账户确认（`VERIFIED`/`PENDING`）、账本可重建、快照与账本对账；
2. 成交完整性：无声明则默认有风险；声明为无风险时，还必须 `reported_events_through >= 决策日`，且在该日期之后到决策日之间账本无事件，否则仍视为 `unreported_trade_risk`；
3. 行情新鲜度：缓存行情不是决策日则 `quote_stale`。

存在 `unreported_trade_risk`、`account_completeness_undeclared`、对账不一致、账本不可重建或真实账户未确认时，交易类表达只输出 `illustrative_legs`，各腿 `executable:false`，`legs` 为空，不给可执行买卖数量。只有各门控都满足且证据有效时才可能 `ACTIONABLE`。历史净值不足两个估值点时回撤为 `insufficient_history`，不从当前浮亏倒推历史最大回撤。

## 测试

`test/upgrade-ledger.test.mjs`（CSV 幂等、缺失字段拒绝、事件推导视图、新事实使声明失效、账户解析）、`test/portfolio-ledger.test.mjs`、`test/r2-ledger.test.mjs`（交收、可卖、对账、完整性）、`test/v1-account-import.test.mjs`（基线导入与幂等）、`test/r2-decision.test.mjs`（未声明/有风险/对账冲突均不可执行）。费用侧见 `test/upgrade-fees.test.mjs` 与 `test/upgrade-fees-calibration.test.mjs`。
