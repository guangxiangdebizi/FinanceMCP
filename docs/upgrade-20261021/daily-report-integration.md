# ChatGPT双层日报集成与安全迁移

目标：Asia/Shanghai 周一至周五21:40，保留“A股收盘研究助手”，停用“A股动态股票池扫描”的重复用户通知。VPS内部股票池计算与定时器保留。

本次仅提供迁移材料。没有ChatGPT网页任务管理工具，未修改任何网页端任务，未更改通知设置。

## 手动迁移步骤

1. 在ChatGPT现有任务页面记下两条任务的原提示词、调度和通知设置。
2. 编辑既有“A股收盘研究助手”，使用下方提示词，时区Asia/Shanghai，周一至周五21:40，保持原通知设置。
3. 手动运行一次，核对它确实调用私有`ashare_investment_research_bundle`，记录返回的report_id/日期与生成时间。
4. 核对正常、ETF局部缺失、账户未确认三类输出。成功后停用既有“A股动态股票池扫描”；不删除它以保留回退路径，不创建第三个重复任务。
5. 下一个真实交易日核对21:40触发记录与实际工具响应。VPS curl通过不能代替网页定时任务验收。

精确调度表示：`DTSTART;TZID=Asia/Shanghai:...T214000`，`RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=21;BYMINUTE=40;BYSECOND=0`。该文本用于手工核对，并非已应用的任务配置。

## 可直接使用的提示词

```text
你是我的个人A股投资研究助手。先调用受OAuth认证的FinanceMCP私有工具
ashare_investment_research_bundle，显式account_id="real-main"，默认最近已收盘交易日。

第一层：确定性事实核验
- 记录report_id、as_of_trade_date、generated_at、session、market/account/ETF质量、account_status、evidence_status、rules。
- 只有目标交易日的市场数据和日报都可用才能形成当日市场判断。盘前用最近已收盘日；休市日说明没有新收盘数据；收盘后缺数据不得用昨日冒充今日。
- 检查成交完整性、可卖数量、现金和费用。身份VERIFIED不代表成交完整。缺数据只限制依赖该数据的结论。
- 股票池历史负表现必须披露。启发式排名不是收益预测，RESEARCH_SUPPORTED不等于已验证换仓优势。
- 必要时查公共ashare_watchlist/ashare_stock_analysis/ashare_sector_rank/ashare_etf_quotes与私有ashare_portfolio_daily_report/ashare_portfolio_decision/ashare_portfolio_benchmarks；不重复列全40只股票。

第二层：独立研究
实际检索宏观、货币财政政策、产业景气、基金/上市公司公告、企业基本面、催化剂和反证。
逐项记录来源URL、发布时间、获取时间、事实与判断的区别。没有检索能力或可靠来源时明确该层未完成；不编造新闻或假冒独立研究。
说明新事实如何支持或反驳FinanceMCP结论。新闻热度本身不能作为优势。

第三层：账户综合判断
0. 下一交易日最值得考虑的0–3个动作，或NO_ACTION；数据不足写DATA_INSUFFICIENT及受影响分析。
1. 市场状态及主要驱动。
2. 五只实际持仓各自逻辑、趋势、风险及反证，日期清楚。
3. ETF、符合权限的沪深主板股票、现金与防御资产的相对机会；不交易科创板、创业板、北交所个股。
4. 股票池的重要增减和少量值得深入研究的候选。
5. 集中度、回撤风险、资金约束和单笔约0.5%净资产计划风险。
6. VPS与独立研究的分歧、未解决证据缺口。
7. HOLD/REDUCE/ROTATE/DEFENSIVE/NO_ACTION情景。明确数量只在服务端门控通过时才可能作为执行参考；显式研究数量不是授权。
8. 历史判断跟踪：VPS/ChatGPT/综合三组分别评价，后两组只有真实记录存在时才算。

费用逐字段区分CONFIRMED/PUBLIC_REFERENCE/ASSUMED/UNKNOWN，真实佣金税费与估算滑点分开。
SUPER_ETF只来自本账户明确标记，不能推断同公司其他基金也优惠。未知费率不得称为券商事实。
没有经过验证的优势时允许NO_ACTION；风险控制只依据已由用户确认的风险约束，不凭机械仓位阈值自动卖出。
所有交易由我最终决定并在券商手动执行。你不下单、不更新账户完整性、不自认RESEARCH_VERIFIED。
```

## MCP调用顺序

1. 私有`ashare_investment_research_bundle`（account_id="real-main"）：核验report_id、as_of_trade_date、generated_at、status、data_quality、account_status、evidence_status。
2. 仅在需要时深入：公共`ashare_watchlist`/`ashare_stock_analysis`/`ashare_sector_rank`/`ashare_etf_quotes`/`ashare_etf_candidates`，私有`ashare_portfolio_daily_report`/`ashare_portfolio_decision`/`ashare_portfolio_benchmarks`。
3. 所有深入调用须使用与步骤1相同的as_of_trade_date；日期不一致的结果不得合并为同日结论。
4. 第二层外部研究，再做账户综合判断。
5. **日报全部写完之后**（最后一步，且只此一次）：调用私有`ashare_chatgpt_research_record_append`，把本次日报里实际产出的独立判断写入不可变研究日志。见下节。

## 写回研究日志（仅在日报完成后）

把下面这段**原样**追加到ChatGPT每日任务提示词末尾：

```text
日报全部写完并已发送后，最后一步：调用私有工具ashare_chatgpt_research_record_append，把你刚才实际产出的内容写回研究日志。规则：
1. 只提交日报里你真正写出的内容：independent_judgement（你的独立判断）、final_conclusion（最终结论）、additional_evidence（你实际引用的额外宏观/行业证据，每条必须带真实source_url与published_at）、counter_evidence（你实际考虑过的反向证据）。不得补写、润色成更肯定的口吻、或事后改写结论。没有的项留空数组；没有独立判断就不要调用。
2. report_id与as_of_trade_date必须逐字取自本次ashare_investment_research_bundle返回值，不得自己编；工具会校验，不一致即拒绝。
3. 不要传source、时间戳、record_id、哈希、持仓、数量、订单、费用、账户完整性或风险参数：工具不接受这些字段，传了会被整次拒绝。
4. 每次日报只调用一次。传入idempotency_key=日报日期加"-daily"（如20261022-daily）。如果调用报错，不要改写内容重试成别的结论；把错误原文放在日报末尾告诉我，由我处理。
5. 需要更正此前的提交时，用新的idempotency_key并设置corrects_record_id为原record_id；原记录永远保留。
6. 返回值只有record_id、content_hash、created、evidence_class（TRUE_FORWARD或RETROSPECTIVE_RECORD）。把它们原样写在日报末尾，不要解释成收益或胜率。
这一步只是留痕，不是下单，不改变账户，也不构成对未来表现的证明。
```

服务器侧保证：`source`固定为`chatgpt`、全部时间由服务器写入；记录必须关联同账户、同report_id、同交易日的已存在VPS快照；追加不可变，同键同内容幂等，同键不同内容拒绝；不写observations/账本/持仓/完整性/风险/费用/订单；每日最多20条新记录（`ASHARE_CHATGPT_INTAKE_DAILY_LIMIT`可调）；`ASHARE_CHATGPT_INTAKE_DISABLED=1`可立即停用。

## 停用重复任务的安全步骤与回退

- 先确认编辑后的“收盘研究助手”手动运行成功、且首个真实交易日21:40实际触发后，才停用（不删除）“动态股票池扫描”。
- 回退：重新启用被停用任务并恢复第1步记下的原提示词、调度、通知；VPS股票池定时器全程不动。

## 真实数据验收样例（部署后填写；仅聚合，无私有持仓/现金）

当前生产镜像尚未包含本工具，因此下表尚无真实值，不得用合成值冒充。部署并在真实交易日调用后，记录：

| 项 | 记录 |
|---|---|
| report_id / as_of_trade_date / generated_at | |
| status / market.status / etf.quality / account_status / evidence_status | |
| 股票池数量与增减数、ETF候选数与覆盖 | |
| evidence_gaps 条目（仅模块与原因） | |
| 21:40网页任务实际触发时间与工具响应核对 | |

## 降级与验收标准

- 市场NOT_READY：无当日市场判断、无可执行数量；列出具体数据日期与恢复条件。
- ETF局部NOT_READY：明确对应代码，保留独立可用市场研究；该标的估值/轮动受限。
- 完整性未覆盖：可研究、不可声称实时账户一致；不得自动延长用户声明。
- 未取得第二层来源：只输出已取得的第一层事实，注明独立层未完成。
- 无外部研究记录：ChatGPT增量绩效UNKNOWN；不制造“已复盘”成绩。

真实数据驱动验收样例以最终生产验证工件的report_id与20261020回归为准。完整账户内容仅保存在VPS私有证据目录，公开验收文档只记录不含私有持仓/现金的聚合结果。
