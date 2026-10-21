# 统一费用模型与校准

本次升级把情景、组合决策、日报和被动基准的费用计算统一到 `src/portfolio/fees.ts`。费用以整数分输出，比例计算先将十进制费率转为有理数，再以 BigInt 做分位四舍五入。价格输入仍以整数厘表示。

## 解析与证据

规则优先级为证券代码覆盖、账户/券商类别规则、类别默认值、保守估计。类别包括 `STOCK`、`NORMAL_ETF`、`SUPER_ETF`、`OTHER_ETF`；优惠类别必须由账户配置中的具体代码标记获得，不根据基金公司或交易所推广。

每个费用字段独立保存 `CONFIRMED`、`PUBLIC_REFERENCE`、`ASSUMED` 或 `UNKNOWN` 和来源。`null` 比例只能标记 `UNKNOWN`，计算时使用保守默认，同时保留未知证据状态。最低收费有观察证据，不代表比例佣金已确认。滑点不允许标为已确认券商费用。

| 输出字段 | 含义 |
| --- | --- |
| `commission_cents` | 佣金估计，含当前规则表达的普通最低佣金 |
| `transfer_fee_cents` | 过户费估计 |
| `stamp_duty_cents` | 卖出印花税估计；ETF 与股票规则分开 |
| `slippage_estimate_cents` | 保守滑点估计，独立于实际收费 |
| `actual_fee_estimate_cents` | 佣金、过户费和税费之和，仍是估计而非交割事实 |
| `total_cents` | 上述费用估计加滑点，用于保守资金可行性比较 |
| `fee_model` | 分类、逐字段证据、版本、应用 profile ID 与计费不确定性 |

默认股票佣金和普通 ETF 佣金仍为万 2.5、普通最低佣金 5 元，均为 `ASSUMED`。股票卖出印花税与过户费引用当前公共参考规则；ETF 不套用股票税费。默认模型不是完整历史法规时间表；历史研究必须披露使用恒定费率情景，或提供有效日期覆盖的规则。

`aggregation`（按订单还是成交明细）、`rounding`（券商实际舍入）、`minimum_billing_unit`（隐藏最低计费单位）及 `regulatory_fees_included` 默认保持 `UNKNOWN`。引擎采用的分位四舍五入只描述估计算法，不构成对券商实际规则的确认。无证据时不能自动合并成交明细后声称最低佣金已准确复现。

`SUPER_ETF` 只能由账户配置中的具体代码标记获得。被标记的代码即使没有显式费率字段，也使用观察到的优惠档：佣金万 0.5、无普通 ETF 的 5 元最低门槛，两个字段均为 `ASSUMED`（`fee_model.estimated` 为真），不扩展到其他 ETF。代码或类别规则中显式写入的字段值与证据优先于该档位。12 笔历史成交样本由 `test/upgrade-fees-calibration.test.mjs` 逐笔复现；516080.SH 的比例佣金保持 `UNKNOWN`，159241.SZ、159278.SZ 未标记，按普通 ETF 默认估算。

## 私有持久配置与 API

账户规则只存于私有账户库的 `account_meta`，键为 `fee_profiles:<account_id>`，值为版本化 profile 数组。新规则 ID 只能追加；同 ID 不同内容拒绝覆盖。每条规则含生效起止日期、可选券商维度、证券代码或类别、字段值及证据。未知历史生效日不得回溯推定。

```ts
const context = loadFeeContext(portfolioDb, accountId, asOf, brokerId);
const rules = feeRulesFor(context, code, 'ETF'); // 或 STOCK
const fee = calculateFees(grossCents, 'sell', rules); // buy 或 sell
// 等价便利接口：resolveFeeRules({ db, accountId, code, kind, asOf, brokerId })
```

不传数据库的 `resolveFeeRules` 只使用公共/假设默认值，不读取真实账户。`fee_model.version` 绑定证券类别、最终费用值、字段证据、应用 profile 和计费规则，因此不同股票/ETF 税费不会共享相同模型版本。

场景与决策的买入手数通过包含费用的预算检查向下修正。实际成交价已包含不利滑点的研究模拟应将费用规则的滑点设为零，避免双计，同时保存该覆盖属于假设情景的说明。

## 本地命令

```sh
finance-ashare portfolio-fees-list --account ACCOUNT --date YYYYMMDD --db PRIVATE_DB
finance-ashare portfolio-fees-set --account ACCOUNT --file PROFILE.json --dry-run --db PRIVATE_DB
finance-ashare portfolio-fees-set --account ACCOUNT --file PROFILE.json --confirm --db PRIVATE_DB
finance-ashare portfolio-fees-calibrate --account ACCOUNT --code CODE --date YYYYMMDD --file SAMPLES.json --db PRIVATE_DB
finance-ashare portfolio-benchmarks --account ACCOUNT --start YYYYMMDD --end YYYYMMDD --db PRIVATE_DB --market-db MARKET_DB
```

`PROFILE.json` 为单条 profile。`SAMPLES.json` 是 `{gross_cents, commission_cents, side?}` 数组。管理命令只在本地写私有库，不新增公共 MCP 写接口。导入前由操作者完成私有数据库备份；代码配置文件和逐笔校准结果不提交公共仓库。

## 校准与验证

公开测试使用 12 笔泛化合成样例，覆盖优惠佣金、普通最低收费、字段级未知、规则优先级、生效日期、持久化幂等、股票/ETF 税费差异、零名义金额和精确半分舍入。

任务提供的真实观察样本及待导入规则仅写入操作者私有目录。真实观察校准状态由私有结果文件记录；生产账户规则尚需在备份后由部署操作者导入。观察拟合通过不意味着订单聚合、券商舍入、隐藏最低计费单位或未知比例费率已被确认，也不证明历史任意时点采用同一规则。

定向兼容验证 66/66 通过，包含私有情景与决策的真实函数调用。独立复核的费用/日报专项 22/22 通过，确认股票与 ETF 模型版本已区分且金额保持一致。最终全仓测试计数以集中验收报告为准。
