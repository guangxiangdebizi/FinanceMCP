# 组合级风险政策（用户已批准，2026-10-22）

规则版本 `portfolio-drawdown-policy-1.0.0`，批准日期 `20261022`，批准来源由管理员 CLI 的 `--source` 记录（不在代码中编造）。实现：`src/portfolio/riskPolicy.ts`。

## 政策内容

| 级别 | 组合回撤 | 含义 |
| --- | --- | --- |
| L1 | ≥ 10% | 一级预警：复核仓位、集中度及风险来源 |
| L2 | ≥ 15% | 二级预警：提高风险控制优先级，新增风险敞口需要更充分依据 |
| L3 | ≥ 20% | 三级预警：优先比较降低风险、部分减仓和继续持有的方案 |

- 不自动减仓、不自动清仓、不设强制仓位上限；实际交易由用户手动决定。
- 保留单笔计划风险预算约为净资产 0.5%（`per_trade_risk_budget_bps = 50`）。
- 预警只触发"研究复核"，输出中 `action_boundary.sell_quantity = null`、`auto_trade = false`，不生成卖出数量。

## 回撤口径

- 来源：`buildNavSeries` 的单位净值序列（日终现金流法；出入金不改变净值），仅在账户已确认为真实账户（REAL_ACCOUNT_VERIFIED）时可用。
- 当前回撤 = 1 − 目标日单位净值 / 历史峰值单位净值；阈值以基点保存，用整数比较，**恰好等于阈值即触发**（9.9% 不触发，10.0% 触发）。
- 同时给出历史最大回撤供参考，但不据此触发预警。
- 明确不使用：累计浮亏、ETF 自身最大回撤、单次压力损失（`excluded_bases` 字段列出）。
- 价格来自行情库 `fund_daily`/`daily` 收盘价（只读）；缺价沿用最近价时 `valuation_quality = incomplete`。
- 无基线、账户未核验、可用净值点 < 2、目标日无净值 → `HISTORICAL_DRAWDOWN_UNAVAILABLE`（含 `reason`），`warning.level = UNKNOWN`，但集中度、敞口与压力情景仍照常输出。

## 持久化与迁移

- 私有账户库新表 `portfolio_risk_policy`（主键 `account_id + rule_version`），`CREATE TABLE IF NOT EXISTS`，在可写打开时幂等建立，不改动既有表。
- 同版本同内容重复写入 → `created:false`；同版本内容不同 → 报错，**不覆盖**；变更政策必须新增 `rule_version`。
- 写入只通过本地管理员 CLI，无 MCP/公开写工具：

```
portfolio-risk-policy-set  --account real-main --source "<批准来源>" --confirm
portfolio-risk-policy-show --account real-main [--date YYYYMMDD]
```

## 集成与可复现性

- 账户日报新增可选字段 `portfolio_risk`；统一研究数据包新增同名顶层字段并并入 facts。
- 版本门控：仅当目标日 ≥ 批准日且已记录政策时才出现；此前的日报/研究记录输出与 `report_id` 不变。日报的 `report_id` 不包含该字段，故记录政策不会改变既有日报 ID。
- 数据包 `report_id` 在政策生效日起纳入 `portfolio_risk`（政策或回撤状态变化会改变数据包 ID，这是有意的）。

## 测试

`test/upgrade-risk-policy.test.mjs`：10/15/20% 边界与低于阈值、缺历史、未核验账户、出入金、峰值回撤（非成本）、政策幂等/不覆盖/批准日门控、集中度在缺历史时保留、无自动交易、日报加性且 `report_id` 不变、端到端 L3。
