# 统一投资研究事实包

工具：`ashare_investment_research_bundle`，只在已认证的 `/private/mcp` 提供。公共工具清单和公共直接调用均拒绝此工具。默认只读，不建表，不联网，不导入成交。

## 参数

```json
{"account_id":"real-main","as_of_trade_date":"20261020","max_candidates":8}
```

`account_id`省略只允许唯一已配置真实账户；多账户显式选择。日期省略使用Asia/Shanghai最近已收盘交易日。盘前/盘中默认前交易日；显式请求未收盘日返回不可用。收盘后缺今日数据不能静默回退昨日。

## JSON结构

- `schema/report_id/generated_at/as_of_trade_date/session`：内容身份与实际生成时间、交易日历阶段。
- `account_id/account_status/evidence_status/status`：账户身份、研究优势与数据包可用性分开。
- `data_quality.market/account/etf/synchronized_at`：各维独立状态与实际数据时间。
- `market/sectors/watchlist/technical_signals`：精确目标日期的已发布市场报告投影，股票池只给增减、分布与少量重点，完整40只仍用`ashare_watchlist`。
- `research_validation`：可选只读验证注册表的结果ID、规则/实现hash、负面表现、时间分割及证据范围，历史验证不升级为未来盈利优势。
- `etf_candidates`：实际持仓保留、动态发现范围、候选质量与摘要上限；评分是启发式排序。
- `portfolio`：复用账户日报，事件重建的数量/现金、估值/费用/五种情景、可执行性门控。
- `transaction_fees`：私有账户逐证券覆盖与逐字段证据，真实记账费用和估算滑点分离。
- `benchmarks`：固定基准按原始基线起点至同一as-of；缺数据不缩短区间；多资产权重仍provisional。
- `research_tracking`：旧预案、不可变研究记录与已到期评估；不存在ChatGPT原始记录时不计算其增量价值。
- `evidence_gaps/rules/markdown_summary/boundaries`：缺口、版本、摘要和只读/手动交易边界。

## 状态传播

关键市场数据或精确当日报告缺失 -> `DATA_INSUFFICIENT`，不得输出当日市场判断。
局部ETF/账户完整性/研究来源缺口 -> `DEGRADED`，只限制对应依赖；身份VERIFIED不等于成交已确认。
证据保持`UNVERIFIED`，不因候选得分高、字符串`RESEARCH_VERIFIED`或任意ID提升。
无充分优势/用户批准风险控制条件 -> 日报允许`NO_ACTION`。明确研究数量仅供示意，不构成执行授权。

## 持久化与CLI

- `finance-ashare investment-research-bundle`：只读查询。
- `finance-ashare investment-research-record`：本地可信写入口；完整VPS包追加到私有研究日志，私有目录0600文件，不写账户成交。
- `finance-ashare portfolio-journal-import --file PATH --confirm`：只导入实际获得的外部记录；ChatGPT需真实来源，combined需既存VPS+ChatGPT父记录。
- `portfolio-journal-evaluate`：5/10/20/60交易日成熟窗口；未成熟PENDING、缺价/费用/复权UNAVAILABLE；不改原判断。

每日读取包只输出决策相关事实，避免重复原始K线。完整原始研究细节保留在各现有工具及私有不可变日志。
