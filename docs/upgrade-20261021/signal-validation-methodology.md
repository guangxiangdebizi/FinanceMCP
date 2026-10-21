# 技术信号与评分验证方法

实现：`src/ashare/validation.ts`、`validationCli.ts`。协议 `validation-1.0.0`。生产评分仍为 `score-1.0.0`，35/15/30/10/10 权重未修改，旧 evidence 与历史报告未重写。

## 三类研究时间语义

- `RETROSPECTIVE_HOLDOUT`：形成期截至 2026-03-31，此后历史回放可能已经被观察，不能宣称真正未见的样本外证据。
- `WALK_FORWARD_VALIDATION`：按时间顺序扩展形成集，每 20 个采样日期作为一个验证折。模型均为预先定义的固定对照，不利用验证收益挑选参数或胜出模型。形成期标签必须连同最长退出延迟全部结束于切分日之前。
- `TRUE_FORWARD_OBSERVATION`：只有写入独立注册库、绑定冻结协议，且在次一交易日开盘前真实保存的 ORIGINAL 判断可以进入。规则、成本、实现摘要必须匹配；修订、迟到、历史补录全部保留为回顾记录。没有足够已成熟观察时证据等级仍为 `UNVERIFIED`。

冻结协议将规则、观察起点、成本、实现 hash 和持有期写入追加数据库。UPDATE/DELETE 触发器阻止覆盖冻结和原始观察；相同内容 ID 幂等。后续更正应添加新协议或新观察，不能改写旧判断。原有 `snapshot.ts` 的 `PROSPECTIVE` 只表示报告后 24 小时内，不能单独作为本次 TRUE_FORWARD 认定；已有 ORIGINAL/REVISED 和 V2 日序状态链继续保留。

`freeze` 的起始观察日必须晚于服务器实际冻结日；`observe` 由服务器取得当前时间和交易日历，不接受调用者传入伪造时间。最新市场缓存日须与观察日一致，要求存在可用 live 报告。新记录保存 8 个模型的前 40 名排序，明确区别于原有逐日动态股票池。`evaluate` 只读匹配冻结且及时保存的观察，拒绝成本或评估实现摘要不符的协议，结果追加保存。

## 现有九类信号

`signals.ts` 的 `trend_up`、`macd_golden_cross`、`rsi_oversold_rebound`、`boll_squeeze_breakout`、`trend_breakdown` 使用边沿或交叉触发；突破、背离与过热条件可连续触发。研究保持原定义，事件 ID 为日期、股票、信号，连续事件并不等于独立交易。原定义的失效条件目前是说明文字，不自动变为回测止损规则。

原 `computeEvidence` 是样本内方向统计：主要分类使用 10 日超额，按日期均值计算普通 t；窗口重叠、多重比较、交易成本、历史 ST/行业及退市覆盖均有限制。它按个股有价 bar 计持有期，停牌会造成跨股期限不一致；本次新研究使用交易所日历及 `evaluateEvents`，不修改原结果冒充同口径改进。

## 成交与分母

事件研究复用 `evaluateEvents`：收盘 t 产生信号，精确 t+1 开盘进场、t+h 收盘退出；h≥2 满足 T+1。停牌、零成交、开盘涨停、收盘跌停和缺失交易约束分别保留状态。可确认的无法卖出按最多 5 个交易日延迟；未知价格/约束不假定日后一定成交。股数、资金约束不在事件收益中模拟。

三种事件基准为信号日已上市集合等权、沪深300价格指数及当前行业等权端点收益。基准是未扣费的观察，不是可投资组合。覆盖不全时明确给定价子集和 unresolved 分母，不能把缺失收益设为 0。策略费用为买入 3bp、卖出 8bp、每侧不利滑点 5bp 的固定情景，不宣称是每个历史订单实际收费。

独立资金模拟使用统一 `portfolio/fees.ts`。无账户配置读取，采用按证券类别默认规则及字段证据；价格含不利滑点，费用函数排除第二次滑点，按整数分记账。只支持可交易沪深主板、100 股整数单位、现金可支付订单和 T+1。开盘买单先于收盘卖单，禁止用当日收盘售出资金支付此前开盘买单。持有期 cohort 不重叠，未退出持仓阻断新 cohort。资金曲线单独报告净收益、每日波动、真实资金曲线回撤、成交费用、双边成交额/初始资金换手。

缺少持仓估值、交易约束或无法重建除权权益时，资金模拟返回 `DATA_INSUFFICIENT`，不输出完整区间收益/回撤。已确认停牌期间沿用最后观察价格并披露该估值假设。资金结果与无资金事件观察分别报告，禁止将事件 synthetic drawdown 解释为真实组合回撤。

## 稳健统计与多重比较

日期 cohort 等权是推断单位。同日几十只股票不会人为扩大独立样本数。使用固定 seed 的 circular moving-block bootstrap，默认 1999 次；置信区间为重抽样均值 2.5%/97.5% 分位，两侧 p 值使用零假设中心化抽样误差并加一修正。至少 20 日期、至少 4 个 block，缺失日期不默默拼接；不足则返回 DATA_INSUFFICIENT。

旧股票池 5 日观察以 5 日期为 block，并同时报告 5 个错位非重叠子序列。新采样研究的 block 长度为 `ceil((horizon+maxExitDelay)/stride)`，包含退出延迟缓冲。信号/环境子集日期可能不规则，该方法是描述性稳健敏感性，不能修复历史选择偏差或保障正确显著性。

预声明 family 包括 8 模型×2 时间段，以及9 信号×3 持有期×4 环境组×2 时间段，合计232项。Holm step-down 校正保留缺失检验在 family 分母中，不通过少报告检验改善显著性。观察结果保留普通分布、完整/未完成数量及分环境表现；不得因样本内 p 值或某一个模型表现较好提升为已验证投资优势。

## 可运行命令

由主 CLI 接入 `runValidationCommand(args)`，或构建后直接导入 helper：

```sh
node --input-type=module -e 'import("./build/ashare/validationCli.js").then(async m=>console.log(JSON.stringify(await m.runValidationCommand(process.argv.slice(1)))))' audit --source /path/to/market.sqlite --as-of 20261020 --output /independent/research
```

将 `audit` 换成 `study` 执行完整历史研究，可配置 `--stride 5 --max-dates N --split 20260331 --initial-cents 7600000`。`--as-of` 为必传，避免未来日期仍悄悄使用固定旧日。限制采样日期时按完整历史等距覆盖，保留早期形成集和晚期验证集；输出保留实际日期，不能声称完整历史。`freeze --research-db PATH --start YYYYMMDD` 注册规则；`observe --research-db PATH --freeze-id ID --as-of YYYYMMDD` 保存真实新判断；`evaluate` 按相同参数评价已保存记录。所有子命令要求 `--source`，市场连接始终只读。研究库与 JSON 只写独立输出目录。

统一数据包可调用只读 `loadValidationSummary({dbPath,id?,asOf})`：打开registry为readOnly/query_only，验证内容ID，拒绝晚于请求日的证据，返回规则/实现版本、时间分割数量、模型区间、Holm和资金结果状态，不重新跑扫描或审计。audit/study同时输出简洁 `run.json`，完整JSON与append-only registry保存可复核细节。证据等级保持UNVERIFIED；摘要可读取不等于策略优势已验证。

可操作前瞻命令（必须使用实际未来日期，不倒填20261020；实际执行后才有freeze ID）：

```sh
node build/ashare/cli.js research-validation freeze --source /path/to/market.sqlite --research-db /independent/validation.sqlite --start YYYYMMDD
node build/ashare/cli.js research-validation observe --source /path/to/market.sqlite --research-db /independent/validation.sqlite --freeze-id FRZ_ID --as-of YYYYMMDD
node build/ashare/cli.js research-validation evaluate --source /path/to/market.sqlite --research-db /independent/validation.sqlite --freeze-id FRZ_ID --as-of YYYYMMDD
```

## 实际验证状态

只读审计代码 SHA：`476bfff3672ec2d20208650edbf8e045e6af12e8`。既有研究评估、引擎、快照与 runner 51 项专项测试通过。新增专项覆盖 bootstrap 重复性、缺数门控、Holm、purge、walk-forward、评分不修改原扫描、冻结不可覆盖、迟到与变规则拒绝、整数资金/手数/费用/T+1、公司行动不可得状态、缺失成员覆盖。新增测试在独立临时构建通过12/12（核心10项、CLI/摘要2项，包含持仓期复权因子缺失门控）；共享构建和最终全套验收由 Lead 集中执行。
