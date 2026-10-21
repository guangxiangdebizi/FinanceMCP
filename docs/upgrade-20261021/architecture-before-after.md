# 投资研究升级：现状与增量边界

审计日期：2026-10-21。开发分支 `feat/investment-research-20261021`。

## Phase 0：实际基线

- FinanceMCP：`476bfff3672ec2d20208650edbf8e045e6af12e8`。
- AShareInvestor：`d296c34a9dd455ac25a19f74f3fa3c14855d7022`。
- 生产：同一 `finance-mcp-ashare` 容器，OCI revision 与上述 FinanceMCP SHA 一致，`running/healthy`。
- 工作树：FinanceMCP 干净；AShareInvestor 仅新任务书未跟踪。两仓库先 fetch 再建立独立开发分支。
- 数据：`daily`、`fund_daily`、`fund_adj`、`fund_share` 最新为 20261020；市场质量 READY；股票池40只。
- 私有库：账户快照/事件/基线/完整性与市场库物理分离。未取得新的成交完整性确认，不延长历史声明。
- 生产调度：18:40、21:10 市场日频；21:15 账户研究。UTC+8 2026-10-21 开盘前不应判当日收盘同步失败。

## 已有模块与依赖

```text
Tushare -> fetch/ingest/sync/etf -> ashare.sqlite
  -> indicators/signals/fundamentals/analysis -> market/watchlist/report
  -> evidence/evaluation/snapshot -> 独立研究库及历史研究
  -> etfUniverse -> 候选与基准 -> 账户研究

私有快照 + baseline + account_event -> replayAccount -> 账户约束
市场只读缓存 + 账户约束 -> decision/scenario/dailyReport
公共 dispatch -> 市场工具；私有 OAuth dispatch -> 账户工具
```

## 差距及改造范围

1. 分散费用函数缺证券覆盖、字段证据等级和私有规则持久化。增加统一整数分费用接口，保留旧参数兼容。
2. 事件账本已有幂等/撤销/T+1/完整性；增补CSV导入与研究中实际使用事件重建的核验。
3. 信号已有样本内统计、历史回放、股票池评估；增补重叠稳健统计、时间分割、规则冻结和诚实的观察类型。
4. ETF已有24只声明池、全市场价格缓存；增补显式动态范围和可用性，保留持仓。
5. 统一研究包尚无：增加只读私有工具，组合既有计算，同一as-of，局部降级，限制重复明细。
6. 前瞻预案已有plan_tracking接口，但扩展为不可变VPS/外部真实研究记录与到期评估；不编造ChatGPT记录。
7. 组合比较资金/HHI/日期/复权存在需要独立验证的风险；验证后最小修复，绝不以漂亮回测为目标改权重。
8. 部署脚本需验证私有库、研究库、配置备份与恢复路径；沿用原实例和端点。

## 所有权与集成

- fees-ledger：费用引擎、账户导入/重建、相关既有交易计算；dailyReport除外。
- research-audit：信号验证、股票池审计、研究CLI helper。
- etf-bundle-audit：ETF范围/数据、不可变研究日志及评估。
- independent-verifier：日报与组合比较、独立失败先行测试。
- Lead：日期解析、bundle、私有注册、证据边界、部署/文档/最终回归。

所有Agent共享此开发分支，按明确路径提交，禁止全目录git add。构建由Lead集中运行，避免清空build造成假失败。

## 迁移与生产约束

只允许增量、幂等私有表或独立研究表；读取路径不建表。真实账本不覆盖，旧研究不删除。生产切换前使用SQLite一致性备份，验证integrity_check并演练恢复副本；保留原镜像标签。没有用户专属事实就保持UNKNOWN/UNVERIFIED。

## 新数据流

```text
既有市场与账户只读模块 + 统一费用规则 + 验证元数据
  -> 同一已收盘交易日的research bundle
  -> 受OAuth保护的私有MCP / 本地受信任CLI
  -> VPS不可变记录（定时任务显式写入）
  -> 真实取得的ChatGPT/combined记录（显式本地导入）
  -> 5/10/20交易日到期评估（未到期保持PENDING）
```

生产评分不因历史验证收益变差而调整；历史窗口不冒称真正未见样本外。
